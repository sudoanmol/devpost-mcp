"""Devpost client: JSON endpoints where Devpost has them, HTML scraping where it doesn't.

Devpost pages are server-rendered, so plain HTTP is enough; no headless browser.
"""

import asyncio
import json
import logging
import re

import httpx
from selectolax.lexbor import LexborHTMLParser as HTMLParser, LexborNode as Node

logging.getLogger("httpx").setLevel(logging.WARNING)

BASE = "https://devpost.com"
HEADERS = {"User-Agent": "Mozilla/5.0 (devpost-mcp)", "Accept-Language": "en"}

# ponytail: in-process cache, lives as long as the MCP server; move to disk if restarts get slow
_cache: dict[str, str] = {}
_limit = asyncio.Semaphore(4)  # stay polite to Devpost
_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(headers=HEADERS, timeout=20, follow_redirects=True)
    return _client


async def _get(url: str, params: dict | list | None = None, as_json: bool = False) -> str:
    key = str(httpx.URL(url, params=params))
    if key not in _cache:
        for attempt in range(3):
            async with _limit:
                r = await _http().get(key, headers={"Accept": "application/json"} if as_json else None)
            if r.status_code != 429:
                break
            await asyncio.sleep(float(r.headers.get("Retry-After", 2**attempt)))
        r.raise_for_status()
        _cache[key] = r.text
    return _cache[key]


def _text(node: Node | None) -> str:
    return " ".join(node.text(separator=" ").split()) if node else ""


def _hackathon_root(url: str) -> str:
    u = httpx.URL(url if "://" in url else f"https://{url}")
    return f"https://{u.host}"


# --- hackathons -----------------------------------------------------------


async def search_hackathons(query: str = "", status: str = "", page: int = 1, order_by: str = "") -> dict:
    params: list[tuple[str, str | int]] = [("page", page)]
    if order_by:
        params.append(("order_by", order_by))
    if query:
        params.append(("search", query))
    if status:
        params.append(("status[]", status))
    data = json.loads(await _get(f"{BASE}/api/hackathons", params, as_json=True))
    return {
        "total": data["meta"]["total_count"],
        "page": page,
        "hackathons": [
            {
                "title": h["title"],
                "url": h["url"].rstrip("/"),
                "organization": h.get("organization_name"),
                "dates": h["submission_period_dates"],
                "status": h["open_state"],
                "location": h["displayed_location"]["location"],
                "themes": [t["name"] for t in h["themes"]],
                "prize_total": re.sub(r"<[^>]+>", "", h["prize_amount"]),
                "registrations": h["registrations_count"],
                "winners_announced": h["winners_announced"],
            }
            for h in data["hackathons"]
        ],
    }


async def _list_ended(query: str, order_by: str, page: int) -> list[dict]:
    return (await search_hackathons(query, "ended", page, order_by))["hackathons"]


async def get_hackathon(url: str) -> dict:
    root = _hackathon_root(url)
    tree = HTMLParser(await _get(root))
    prizes = []
    for p in tree.css("#prizes .prize"):
        prizes.append(
            {
                "title": _text(p.css_first(".prize-title")),
                "winners": _text(p.css_first(".prize-winners")),
                "description": _text(p.css_first(".prize-content p")),
            }
        )
    return {
        "url": root,
        "title": next((t for h in tree.css("h1") if (t := _text(h))), ""),
        "tagline": _text(tree.css_first("h1:not(.header-image) + h3")),
        "description": _text(tree.css_first("#challenge-description"))[:4000],
        "sponsors": [img.attributes.get("alt", "") for img in tree.css("#sponsor-tiles img")],
        "prizes": prizes,
        "judging_criteria": [
            {"criterion": _text(li.css_first("strong")), "description": _text(li).removeprefix(_text(li.css_first("strong"))).strip()}
            for li in tree.css("#judging-criteria li")
        ],
    }


# --- projects -------------------------------------------------------------


def _gallery_item(item: Node) -> dict:
    link = item.css_first("a.link-to-software")
    return {
        "name": _text(item.css_first("h5")),
        "tagline": _text(item.css_first(".tagline")),
        "url": link.attributes.get("href") if link else None,
        "winner": item.css_first("img.winner") is not None,
        "likes": int(_text(item.css_first(".like-count")) or 0),
        "team": [img.attributes.get("alt") for img in item.css(".members img")],
    }


async def list_hackathon_projects(
    url: str, winners_only: bool = False, max_pages: int = 5, prize_id: int | None = None, terms: str = ""
) -> dict:
    """One hackathon's gallery, optionally narrowed to one prize track or a keyword.

    Galleries list winners first, so winners_only stops at the first non-winner.
    """
    root = _hackathon_root(url)
    path, base_params = f"{root}/project-gallery", {}
    if prize_id or terms:
        path = f"{root}/submissions/search"
        base_params = {"terms": terms} | ({"prize_filter[prizes][]": prize_id} if prize_id else {})
    projects: list[dict] = []
    total = 0
    for page in range(1, max_pages + 1):
        tree = HTMLParser(await _get(path, base_params | {"page": page}))
        if page == 1:
            m = re.search(r"of\s+(\d+)", _text(tree.css_first(".pagination-info")))
            total = int(m.group(1)) if m else len(tree.css(".gallery-item"))
        items = [_gallery_item(i) for i in tree.css(".gallery-item")]
        if not items:
            break
        if winners_only:
            winners = [p for p in items if p["winner"]]
            projects += winners
            if len(winners) < len(items):
                break
        else:
            projects += items
    return {"hackathon": root, "total_submissions": total, "returned": len(projects), "projects": projects}


async def get_prizes(url: str) -> list[dict]:
    """Prize tracks with the ids the gallery filter uses (parsed from the gallery's filter form)."""
    tree = HTMLParser(await _get(f"{_hackathon_root(url)}/project-gallery", {"page": 1}))
    return [
        {"id": int(i.attributes["value"]), "name": _text(i.parent)}
        for i in tree.css('input[name="prize_filter[prizes][]"]')
    ]


async def search_projects(query: str, winners_only: bool = False, pages: int = 4, sort: str = "popular") -> dict:
    """Devpost's search returns 6 results per page; pages are fetched in parallel."""
    pages = 10 if winners_only else max(1, min(pages, 10))
    results = await asyncio.gather(
        *(
            _get(f"{BASE}/software/search", {"query": query, "page": p} | ({"order_by": "popular"} if sort == "popular" else {}), as_json=True)
            for p in range(1, pages + 1)
        ),
        return_exceptions=True,
    )
    # Devpost throttles search for minutes at a time; keep whatever pages made it
    pages_data = [json.loads(r) for r in results if isinstance(r, str)]
    rate_limited = len(pages_data) < len(results)
    projects = [
        {
            "name": s["name"],
            "tagline": s["tagline"],
            "url": s["url"],
            "winner": s["winner"],
            "built_with": s["tags"],
            "likes": s["like_count"],
        }
        for d in pages_data
        for s in d["software"]
        if s["winner"] or not winners_only
    ]
    total = pages_data[0]["total_count"] if pages_data else None
    return {"query": query, "sort": sort, "total_matches": total, "rate_limited": rate_limited, "returned": len(projects), "projects": projects}


async def get_project(url: str) -> dict:
    if "://" not in url:
        url = f"{BASE}/software/{url}"
    tree = HTMLParser(await _get(url))
    details = tree.css_first("#app-details-left")
    built_with = [_text(t) for t in tree.css("#built-with .cp-tag")]
    links = [a.attributes.get("href") for a in tree.css("nav.app-links a")]
    if details:
        for junk in details.css("#gallery, #built-with, nav.app-links"):
            junk.decompose()
    submissions = []
    for li in tree.css("#submissions .software-list-with-thumbnail > li"):
        a = li.css_first(".software-list-content p a")
        prizes = [re.sub(r"^Winner\s*", "", _text(p)) for p in li.css(".software-list-content ul li")]
        submissions.append({"hackathon": _text(a), "url": a.attributes.get("href", "").rstrip("/") if a else None, "prizes": prizes})
    return {
        "url": url,
        "name": _text(tree.css_first("#app-title")),
        "tagline": _text(tree.css_first("#software-header p.large")),
        "description": re.sub(r"\n\s*\n+", "\n", details.text(separator="\n")).strip()[:6000] if details else "",
        "built_with": built_with,
        "links": links,
        "submissions": submissions,
        "winner": any(s["prizes"] for s in submissions),
        "team": [_text(a) for a in tree.css("#app-team .software-team-member .user-profile-link") if _text(a)],
    }


def _matches(sponsor: str, text: str) -> bool:
    return sponsor.lower() in text.lower()


def _norm(title: str) -> str:
    return re.sub(r"\W+", "", title.lower())


def _winner(d: dict, prizes: list[str]) -> dict:
    return {k: d[k] for k in ("name", "tagline", "url", "built_with")} | {"prizes": prizes}


def _prizes_won(project: dict, root: str) -> list[str]:
    # the gallery ribbon means "won something here", so the project page is the source of truth
    return [p for s in project["submissions"] if s["url"] == root for p in s["prizes"]]


async def get_winners(url: str, sponsor: str = "") -> dict:
    """Winners of one hackathon with the prizes each won.

    With `sponsor`, results are grouped by that sponsor's prize tracks: each track carries its
    challenge brief (the prize description), how many projects entered it, and who won it. Only those
    tracks are scanned, via the gallery's prize filter.
    """
    root = _hackathon_root(url)
    if not sponsor:
        gallery = await list_hackathon_projects(root, winners_only=True, max_pages=10)
        details = await asyncio.gather(*(get_project(p["url"]) for p in gallery["projects"]))
        winners = [_winner(d, won) for d in details if (won := _prizes_won(d, root))]
        return {"hackathon": root, "returned": len(winners), "winners": winners}

    prizes, overview = await asyncio.gather(get_prizes(root), get_hackathon(root))
    prizes = [p for p in prizes if _matches(sponsor, p["name"])]
    briefs = {_norm(p["title"]): p["description"] for p in overview["prizes"]}
    galleries = await asyncio.gather(*(list_hackathon_projects(root, winners_only=True, prize_id=p["id"]) for p in prizes))
    urls = {proj["url"] for g in galleries for proj in g["projects"]}
    details = {u: d for u, d in zip(urls, await asyncio.gather(*(get_project(u) for u in urls)))}
    tracks = []
    for prize, gallery in zip(prizes, galleries):
        winners = [
            _winner(d, won)
            for proj in gallery["projects"]
            if (d := details[proj["url"]]) and (won := [w for w in _prizes_won(d, root) if _norm(w) == _norm(prize["name"])])
        ]
        tracks.append(
            {
                "prize": prize["name"],
                "challenge": briefs.get(_norm(prize["name"]), ""),
                "entrants": gallery["total_submissions"],
                "winners": winners,
            }
        )
    return {"hackathon": root, "sponsor": sponsor, "tracks": tracks}


async def find_sponsor_winners(
    sponsor: str, query: str = "", order_by: str = "submission-date", max_hackathons: int = 25
) -> dict:
    """Winners of `sponsor`'s prize tracks across many judged hackathons, with each track's challenge.

    Devpost has no sponsor index, so this pages through ended hackathons (newest first by default),
    keeps the ones with winners announced, checks their prize tracks for the sponsor, and only digs
    into the matches.
    """
    max_hackathons = max(1, min(max_hackathons, 60))
    hackathons: list[dict] = []
    page = 1
    # ponytail: ~90% of fresh listings are unjudged, so this pages up to 40 deep; a prebuilt index removes the scan
    while len(hackathons) < max_hackathons and page <= 40:
        batch = await asyncio.gather(*(_list_ended(query, order_by, p) for p in range(page, page + 5)))
        page += 5
        listings = [h for b in batch for h in b]
        if not listings:
            break
        seen = {h["url"] for h in hackathons}
        hackathons += [h for h in listings if h["winners_announced"] and h["url"] not in seen]
    hackathons = hackathons[:max_hackathons]
    prize_lists = await asyncio.gather(*(get_prizes(h["url"]) for h in hackathons), return_exceptions=True)
    matched = [
        h for h, prizes in zip(hackathons, prize_lists)
        if not isinstance(prizes, BaseException) and any(_matches(sponsor, p["name"]) for p in prizes)
    ]
    results = await asyncio.gather(*(get_winners(h["url"], sponsor) for h in matched))
    return {
        "sponsor": sponsor,
        "hackathons_scanned": len(hackathons),
        "hackathons_with_sponsor_prize": len(matched),
        "results": [
            {"hackathon": h["title"], "url": h["url"], "dates": h["dates"], "tracks": r["tracks"]}
            for h, r in zip(matched, results)
        ],
    }
