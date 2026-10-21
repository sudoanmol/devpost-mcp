"""Fetch HackMIT's Plume (plume.hackmit.org): HackMIT and Blueprint since 2025, which aren't on Devpost.

Plume's public JSON API has every event, its tracks, and a gallery of every project with its write-up,
the tracks it entered and the prizes it won. A whole crawl is about 40 requests, so it's refetched in full
each time. Gallery rows also carry each team's join link; it's a secret and is never stored.
"""

import json
import re
import zlib
from datetime import UTC, datetime
from urllib.parse import urlencode

import httpx

API = "https://plume.hackmit.org/api/v3"
SITE = "https://plume.hackmit.org"
PAGE = 24  # the gallery's fixed page size
WRITE_UP = [
    ("inspiration", "Inspiration"),
    ("what_it_does", "What it does"),
    ("how_we_built_it", "How we built it"),
    ("challenges_we_ran_into", "Challenges we ran into"),
    ("accomplishments", "Accomplishments"),
    ("what_we_learned", "What we learned"),
    ("whats_next", "What's next"),
]


def local_id(key: str) -> int:
    """A stable negative id: Devpost's ids are positive, so the two sources can share tables. A prize of the
    event gets id * 1000 + n, a block no other event overlaps."""
    return -(zlib.crc32(f"plume:{key}".encode()) or 1)


def gallery_url(hackathon: str, search: str | None = None) -> str:
    return f"{SITE}/gallery?{urlencode({'hackathon_id': hackathon} | ({'search': search} if search else {}))}"


def tagline(meta: dict) -> str:
    """Plume has no tagline field: the short description, else the start of 'what it does'."""
    short, does = (" ".join((meta.get(k) or "").split()) for k in ("description", "what_it_does"))
    text = short if len(short) >= 30 or not does else does
    if len(text) <= 200:
        return text
    cut = text[:200]
    end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    return cut[: end + 1] if end > 60 else cut.rsplit(" ", 1)[0] + "…"


def match_track(tracks: list[str], designation: str, detail: str) -> str:
    """('OpenAI', '1st Place - The Fifth Teammate') -> 'OpenAI: The Fifth Teammate', the track it was won in."""
    named = detail.split(" - ", 1)[1].strip().lower() if " - " in detail else ""
    candidates = [t for t in tracks if t.lower() == designation.lower() or t.lower().startswith(designation.lower())]
    best = next((t for t in candidates if named and named.rstrip(".!") in t.lower()), None)
    return best or (candidates[0] if candidates else designation)


def placement(detail: str) -> str:
    """'1st Place - The Fifth Teammate' -> '1st Place'; 'Winner' -> 'Winner'."""
    return detail.split(" - ", 1)[0].strip() or "Winner"


async def hackathons(c: httpx.AsyncClient) -> list[dict]:
    meta = (await c.get(f"{API}/hackathons/metadata")).raise_for_status().json()
    timings = {t["hackathon_id"]: t for t in (await c.get(f"{API}/timing/hackathons/timings")).raise_for_status().json()}
    out = []
    for h in meta:
        t = timings.get(h["id"])
        if not t or not h["numProjects"]:
            continue
        start, end = datetime.fromisoformat(t["start_time"]), datetime.fromisoformat(t["end_time"])
        themes = [x["name"] for x in (await c.get(f"{API}/hackathons/{h['id']}/tracks")).raise_for_status().json()]
        tracks = [x["name"] for x in (await c.get(f"{API}/hackathons/{h['id']}/categories")).raise_for_status().json()]
        out.append({
            "key": h["id"],
            "id": local_id(h["id"]),
            "url": gallery_url(h["id"]),
            "title": f"{h['name']} {h['year']}",
            "dates": f"{start:%b %d} - {end:%b %d, %Y}" if start.month != end.month else f"{start:%b %d} - {end:%d, %Y}",
            "ends_on": end.date().isoformat(),
            "status": "ended" if end < datetime.now(UTC) else "upcoming",
            "registrations": h["numUserHackathonRoles"],
            "submissions": h["numProjects"],
            "themes": themes,
            "tracks": tracks,
        })
    return out


async def gallery(c: httpx.AsyncClient, hackathon: str) -> list[dict]:
    projects, page = [], 1
    while True:
        r = await c.get(f"{API}/projects/gallery", params={"hackathon_id": hackathon, "items_per_page": PAGE, "page": page})
        batch = r.raise_for_status().json()["projects"]
        projects += [p for p in batch if p["hackathon_id"] == hackathon]
        if len(batch) < PAGE:
            return projects
        page += 1


def project(p: dict, tracks: list[str]) -> dict:
    meta = json.loads(p["project_metadata"] or "{}")
    sections = [f"{title}\n{meta[k].strip()}" for k, title in WRITE_UP if (meta.get(k) or "").strip()]
    links = [x for x in [meta.get("code_link"), *re.split(r"[\s,]+", meta.get("links") or ""), meta.get("video_demo")] if x and x.strip()]
    won = [f"{match_track(tracks, w['designation'], w['detail'])} ({placement(w['detail'])})" for w in p["prize_winners"]]
    name = " ".join(p["name"].split())
    return {
        "slug": f"plume:{p['id']}",
        "url": gallery_url(p["hackathon_id"], name),
        "name": name,
        "tagline": tagline(meta),
        "description": "\n\n".join([(meta.get("description") or "").strip(), *sections]).strip() or None,
        "links": links,
        "entered": p["preferences"],
        "prizes": won,
    }


def prizes(h: dict, projects: list[dict]) -> list[dict]:
    """One prize per (track, placement) won, plus each unwon track; entrants are the projects that opted in."""
    entered = {t: sum(t in p["entered"] for p in projects) for t in h["tracks"]}
    won: dict[str, int] = {}
    for p in projects:
        for title in p["prizes"]:
            won[title] = won.get(title, 0) + 1
    # a prize outside every track ("Overall") was open to every project
    rows = [{"title": title, "winners": n, "entrants": entered.get(title.rsplit(" (", 1)[0], len(projects))} for title, n in won.items()]
    rows += [{"title": t, "winners": None, "entrants": n} for t, n in entered.items() if not any(w.startswith(f"{t} (") for w in won)]
    # ids count up inside the event's own block, so prizes read back in title order (1st, 2nd, 3rd place)
    return [r | {"id": h["id"] * 1000 + i} for i, r in enumerate(sorted(rows, key=lambda r: r["title"]))]


if __name__ == "__main__":
    tracks = ["OpenAI: The Fifth Teammate", "Warp: Best Financial Visualization Agent", "Warp Dev: Best Developer Tool", "Education", "ElevenLabs Challenge"]
    assert match_track(tracks, "OpenAI", "1st Place - The Fifth Teammate") == "OpenAI: The Fifth Teammate"
    assert match_track(tracks, "Warp Dev", "Winner - Best Developer Tool") == "Warp Dev: Best Developer Tool"
    assert match_track(tracks, "Warp", "Winner - Best Financial Visualization Agent") == "Warp: Best Financial Visualization Agent"
    assert match_track(tracks, "ElevenLabs", "Runner-Up - ElevenLabs Challenge") == "ElevenLabs Challenge"
    assert match_track(tracks, "Education", "Winner") == "Education"
    assert match_track(tracks, "Overall", "1st Place") == "Overall"
    assert placement("1st Place + Grand Prize - Fundraising") == "1st Place + Grand Prize"
    assert tagline({"description": "x" * 30}) == "x" * 30
    assert len(tagline({"description": "word " * 100})) <= 201
    assert local_id("hack-2025") < 0 and local_id("hack-2025") == local_id("hack-2025")
    print("ok")
