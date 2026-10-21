"""Fetch and parse Devpost: the JSON hackathon listing plus server-rendered HTML pages.

Devpost answers plain HTTP from a normal machine, so no headless browser. It returns 403 to
Cloudflare Workers, which is why crawling happens locally and the Worker only reads D1.
"""

import asyncio
import logging
import re
from datetime import date

import httpx
from selectolax.lexbor import LexborHTMLParser as HTMLParser, LexborNode as Node

logging.getLogger("httpx").setLevel(logging.WARNING)

BASE = "https://devpost.com"
HEADERS = {"User-Agent": "Mozilla/5.0 (devpost-mcp)", "Accept-Language": "en"}
MONTHS = {m: i for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(), 1)}


class Blocked(Exception):
    """Devpost keeps refusing us; stop the crawl instead of hammering it."""


async def fetch(client: httpx.AsyncClient, url: str, params: dict | None = None) -> httpx.Response:
    """Retries throttling and server errors; other 4xx (deleted page, private gallery) raise at once."""
    for attempt in range(6):
        r = await client.get(url, params=params)
        if r.status_code != 429 and r.status_code < 500:
            r.raise_for_status()
            return r
        await asyncio.sleep(float(r.headers.get("Retry-After", 2 ** attempt)))
    if r.status_code == 429:
        raise Blocked(f"still throttled after retries at {r.url}")
    r.raise_for_status()
    return r


def client() -> httpx.AsyncClient:
    return httpx.AsyncClient(headers=HEADERS, timeout=30, follow_redirects=True)


def _text(node: Node | None) -> str:
    return " ".join(node.text(separator=" ").split()) if node else ""


def ends_on(dates: str) -> str | None:
    """'Sep 25 - Oct 15, 2026' / 'Apr 05 - 06, 2024' / 'Oct 18, 2026' / 'Dec 28, 2025 - Jan 05, 2026' -> ISO end date."""
    m = re.search(r"(?:([A-Z][a-z]{2}) )?(\d{1,2}), (\d{4})$", dates.strip())
    if not m:
        return None
    month = m.group(1) or re.match(r"([A-Z][a-z]{2})", dates).group(1)
    return date(int(m.group(3)), MONTHS[month], int(m.group(2))).isoformat()


def slug(url: str) -> str:
    return url.rstrip("/").rsplit("/", 1)[-1]


# --- listing --------------------------------------------------------------


async def list_hackathons(c: httpx.AsyncClient, status: str, page: int) -> tuple[int, list[dict]]:
    data = (await fetch(c, f"{BASE}/api/hackathons", {"status[]": status, "page": page})).json()
    return data["meta"]["total_count"], [
        {
            "id": h["id"],
            "url": h["url"].rstrip("/"),
            "title": h["title"],
            "organization": h.get("organization_name"),
            "dates": h["submission_period_dates"],
            "ends_on": ends_on(h["submission_period_dates"]),
            "status": h["open_state"],
            "location": h["displayed_location"]["location"],
            "themes": [t["name"] for t in h["themes"]],
            "prize_total": re.sub(r"<[^>]+>", "", h["prize_amount"]),
            "registrations": h["registrations_count"],
            "winners_announced": int(h["winners_announced"]),
        }
        for h in data["hackathons"]
    ]


# --- pages ----------------------------------------------------------------


async def hackathon_page(c: httpx.AsyncClient, url: str) -> dict:
    tree = HTMLParser((await fetch(c, url)).text)
    prizes = []
    for p in tree.css("#prizes .prize"):
        winners = _text(p.css_first(".prize-winners"))
        value = _text(p.css_first(".prize-value"))
        content = p.css_first(".prize-content")
        if content:
            for meta in content.css(".prize-value, .prize-winners"):
                meta.decompose()
        # sponsors put their own judging criteria in here, often several paragraphs down
        brief = "\n".join(" ".join(line.split()) for line in content.text(separator="\n").splitlines() if line.strip()) if content else ""
        prize_id = p.attributes.get("id", "").removeprefix("prize_")
        if prize_id.isdigit():
            prizes.append({"id": int(prize_id), "title": _text(p.css_first(".prize-title")), "value": value, "winners": winners, "description": brief})
    return {
        "tagline": _text(tree.css_first("h1:not(.header-image) + h3")),
        "description": _text(tree.css_first("#challenge-description"))[:4000],
        "prizes": prizes,
        "judging_criteria": [
            {"criterion": _text(li.css_first("strong")), "description": _text(li).removeprefix(_text(li.css_first("strong"))).strip()}
            for li in tree.css("#judging-criteria li")
        ],
    }


def _total(tree: HTMLParser) -> int:
    """Result count from a gallery page's "1 - 24 of 77"; 0 when there's a single page."""
    m = re.search(r"of\s+([\d,]+)", _text(tree.css_first(".pagination-info")))
    return int(m.group(1).replace(",", "")) if m else 0


async def entrants(c: httpx.AsyncClient, url: str, prize_id: int) -> int:
    """How many submissions entered one prize track."""
    tree = HTMLParser((await fetch(c, f"{url}/submissions/search", {"prize_filter[prizes][]": prize_id})).text)
    return _total(tree) or len(tree.css(".gallery-item"))


def _gallery_item(item: Node) -> dict | None:
    link = item.css_first("a.link-to-software")
    if not link or not link.attributes.get("href"):
        return None
    return {
        "slug": slug(link.attributes["href"]),
        "name": _text(item.css_first("h5")),
        "tagline": _text(item.css_first(".tagline")),
        "winner": int(item.css_first("img.winner") is not None),
        "likes": int(_text(item.css_first(".like-count")) or 0),
    }


async def gallery(c: httpx.AsyncClient, url: str) -> tuple[int, list[dict]]:
    """Every submission in a hackathon's gallery (24 per page)."""
    projects: list[dict] = []
    total = 0
    page = 1
    while True:
        tree = HTMLParser((await fetch(c, f"{url}/project-gallery", {"page": page})).text)
        if page == 1:
            total = _total(tree)
        items = [p for i in tree.css(".gallery-item") if (p := _gallery_item(i))]
        projects += items
        if len(items) < 24 or len(projects) >= total:
            return max(total, len(projects)), projects
        page += 1


async def project_page(c: httpx.AsyncClient, project_slug: str) -> dict:
    tree = HTMLParser((await fetch(c, f"{BASE}/software/{project_slug}")).text)
    details = tree.css_first("#app-details-left")
    built_with = [_text(t) for t in tree.css("#built-with .cp-tag")]
    links = [a.attributes.get("href") for a in tree.css("nav.app-links a")]
    if details:
        for junk in details.css("#gallery, #built-with, nav.app-links"):
            junk.decompose()
    submissions = []
    for li in tree.css("#submissions .software-list-with-thumbnail > li"):
        a = li.css_first(".software-list-content p a")
        if a:
            prizes = [re.sub(r"^Winner\s*", "", _text(p)) for p in li.css(".software-list-content ul li")]
            submissions.append({"url": a.attributes.get("href", "").rstrip("/"), "prizes": prizes})
    return {
        "built_with": built_with,
        "links": links,
        "description": re.sub(r"\n\s*\n+", "\n", details.text(separator="\n")).strip()[:6000] if details else "",
        "submissions": submissions,
    }


if __name__ == "__main__":
    assert ends_on("Sep 25 - Oct 15, 2026") == "2026-10-15"
    assert ends_on("Apr 05 - 06, 2024") == "2024-04-06"
    assert ends_on("Oct 18, 2026") == "2026-10-18"
    assert ends_on("Dec 28, 2025 - Jan 05, 2026") == "2026-01-05"
    assert slug("https://devpost.com/software/baymax-bot/") == "baymax-bot"
    print("ok")
