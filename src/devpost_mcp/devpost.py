"""Devpost client: JSON endpoints where Devpost has them, HTML scraping where it doesn't.

Devpost pages are server-rendered, so plain HTTP is enough; no headless browser.
"""

import asyncio
import json
import re

import httpx
from selectolax.lexbor import LexborHTMLParser as HTMLParser, LexborNode as Node

BASE = "https://devpost.com"
HEADERS = {"User-Agent": "Mozilla/5.0 (devpost-mcp)", "Accept-Language": "en"}

# ponytail: in-process cache, lives as long as the MCP server; move to disk if restarts get slow
_cache: dict[str, str] = {}
_limit = asyncio.Semaphore(6)  # stay polite to Devpost
_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(headers=HEADERS, timeout=20, follow_redirects=True)
    return _client


async def _get(url: str, params: dict | list | None = None, as_json: bool = False) -> str:
    key = str(httpx.URL(url, params=params))
    if key not in _cache:
        async with _limit:
            r = await _http().get(key, headers={"Accept": "application/json"} if as_json else None)
        r.raise_for_status()
        _cache[key] = r.text
    return _cache[key]


def _text(node: Node | None) -> str:
    return " ".join(node.text(separator=" ").split()) if node else ""


def _hackathon_root(url: str) -> str:
    u = httpx.URL(url if "://" in url else f"https://{url}")
    return f"https://{u.host}"


# --- hackathons -----------------------------------------------------------


async def search_hackathons(query: str = "", status: str = "", page: int = 1) -> dict:
    params: list[tuple[str, str | int]] = [("page", page)]
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


async def list_hackathon_projects(url: str, winners_only: bool = False, max_pages: int = 5) -> dict:
    """Gallery pages list winners first, so winners_only can stop at the first non-winner."""
    root = _hackathon_root(url)
    projects: list[dict] = []
    total = 0
    for page in range(1, max_pages + 1):
        tree = HTMLParser(await _get(f"{root}/project-gallery", {"page": page}))
        if page == 1:
            m = re.search(r"of\s+(\d+)", _text(tree.css_first(".pagination-info")))
            total = int(m.group(1)) if m else 0
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


async def search_projects(query: str, winners_only: bool = False, pages: int = 4) -> dict:
    """Devpost's search returns 6 results per page; pages are fetched in parallel."""
    pages = max(1, min(pages, 10))
    results = await asyncio.gather(
        *(_get(f"{BASE}/software/search", {"query": query, "page": p}, as_json=True) for p in range(1, pages + 1))
    )
    pages_data = [json.loads(r) for r in results]
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
    return {"query": query, "total_matches": pages_data[0]["total_count"], "returned": len(projects), "projects": projects}


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


async def get_winners(url: str, sponsor: str = "") -> dict:
    """Winners of one hackathon with the prizes each won; `sponsor` filters on prize name text."""
    root = _hackathon_root(url)
    gallery = await list_hackathon_projects(root, winners_only=True, max_pages=10)
    details = await asyncio.gather(*(get_project(p["url"]) for p in gallery["projects"]))
    winners = []
    for d in details:
        prizes = [p for s in d["submissions"] if s["url"] == root for p in s["prizes"]]
        if sponsor and not any(sponsor.lower() in p.lower() for p in prizes):
            continue
        winners.append({k: d[k] for k in ("name", "tagline", "url", "built_with")} | {"prizes": prizes})
    return {"hackathon": root, "sponsor_filter": sponsor or None, "returned": len(winners), "winners": winners}
