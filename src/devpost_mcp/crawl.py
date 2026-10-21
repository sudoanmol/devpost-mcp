"""Crawl Devpost and HackMIT's Plume into a local SQLite file, then upload it to the MCP server.

    uv run devpost crawl      # first run takes hours; re-runs only fetch what changed
    uv run devpost index      # rebuild embeddings and topics (crawl does this at the end)
    uv run devpost push       # upload the whole database to the server
    uv run devpost stats

Every phase is resumable: stop it any time and run it again.
"""

import argparse
import gzip
import os
import shutil
import subprocess
import asyncio
import json
import math
import sqlite3
import sys
import tempfile
import time
from collections.abc import Awaitable, Callable
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

import httpx

from . import devpost, plume

ROOT = Path(__file__).resolve().parents[2]
DB = ROOT / "data" / "devpost.db"
CONCURRENCY = 8  # ~10 req/s, which Devpost served without a single error in testing

# Scope: judged hackathons from the AI era that drew a real crowd (registrations is the only size signal
# Devpost exposes; 100+ keeps student and builder events and drops classroom-sized ones). Open and upcoming
# hackathons are always kept, since they're the events people are brainstorming for.
SINCE = "2024-01-01"
MIN_REGISTRATIONS = 100
OUT_OF_SCOPE = f"status = 'ended' AND (ends_on IS NULL OR ends_on < '{SINCE}' OR registrations < {MIN_REGISTRATIONS})"
# runs after every listing, so the uploaded database never holds out-of-scope rows
PRUNE = [
    f"DELETE FROM prizes WHERE hackathon_id IN (SELECT id FROM hackathons WHERE {OUT_OF_SCOPE});",
    f"DELETE FROM submissions WHERE hackathon_id IN (SELECT id FROM hackathons WHERE {OUT_OF_SCOPE});",
    f"DELETE FROM hackathons WHERE {OUT_OF_SCOPE};",
    "DELETE FROM projects WHERE slug NOT IN (SELECT slug FROM submissions);",
    "DELETE FROM embeddings WHERE slug NOT IN (SELECT slug FROM projects);",
]


def in_scope(h: dict) -> bool:
    return h["status"] != "ended" or (h["ends_on"] or "") >= SINCE and h["registrations"] >= MIN_REGISTRATIONS

# local-only bookkeeping: what each hackathon looked like when we last fetched its pages
LOCAL_STATE = """
CREATE TABLE IF NOT EXISTS crawl_state (hackathon_id INTEGER PRIMARY KEY, page_status TEXT, gallery_winners INTEGER);
CREATE TABLE IF NOT EXISTS project_state (slug TEXT PRIMARY KEY);
"""


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    DB.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB)
    conn.executescript((ROOT / "schema.sql").read_text() + LOCAL_STATE)
    return conn


async def run_all(label: str, items: list, work: Callable[[object], Awaitable[None]]) -> None:
    """Run `work` over items with bounded concurrency; skip 404s, stop if Devpost starts refusing us."""
    if not items:
        print(f"{label}: nothing to do")
        return
    queue: asyncio.Queue = asyncio.Queue()
    for item in items:
        queue.put_nowait(item)
    done = skipped = refused_in_a_row = 0
    started = time.monotonic()

    async def worker() -> None:
        nonlocal done, skipped, refused_in_a_row
        while not queue.empty():
            item = queue.get_nowait()
            try:
                await work(item)
                refused_in_a_row = 0
            except httpx.HTTPStatusError as e:
                skipped += 1
                if e.response.status_code == 403:
                    refused_in_a_row += 1
                    if refused_in_a_row >= 25:
                        raise devpost.Blocked("25 refusals in a row; Devpost is blocking this machine for now") from e
            except (httpx.TransportError, ValueError) as e:
                skipped += 1
                print(f"  skip {item!r}: {e!r}", file=sys.stderr)
            done += 1
            if done % 250 == 0 or done == len(items):
                rate = done / (time.monotonic() - started)
                eta = (len(items) - done) / rate / 60 if rate else 0
                print(f"{label}: {done}/{len(items)} ({skipped} skipped) {rate:.1f}/s, ~{eta:.0f} min left", flush=True)

    await asyncio.gather(*(worker() for _ in range(CONCURRENCY)))


# --- phases ---------------------------------------------------------------


async def crawl_listing(c: httpx.AsyncClient, conn: sqlite3.Connection) -> None:
    for status in ("ended", "open", "upcoming"):
        total, first = await devpost.list_hackathons(c, status, 1)
        rows = list(first)

        async def page(p: object) -> None:
            rows.extend((await devpost.list_hackathons(c, status, p))[1])

        await run_all(f"listing {status}", list(range(2, math.ceil(total / 9) + 1)), page)
        ts = now()
        for h in filter(in_scope, rows):
            try:
                conn.execute(
                    """INSERT INTO hackathons (id, source, url, title, organization, dates, ends_on, status, location, themes,
                         prize_total, registrations, winners_announced, updated_at)
                       VALUES (:id, 'devpost', :url, :title, :organization, :dates, :ends_on, :status, :location, :themes,
                         :prize_total, :registrations, :winners_announced, :ts)
                       ON CONFLICT (id) DO UPDATE SET url = excluded.url, title = excluded.title,
                         organization = excluded.organization, dates = excluded.dates, ends_on = excluded.ends_on,
                         status = excluded.status, location = excluded.location, themes = excluded.themes,
                         prize_total = excluded.prize_total, registrations = excluded.registrations,
                         winners_announced = excluded.winners_announced, updated_at = excluded.updated_at
                       WHERE (title, dates, status, prize_total, registrations, winners_announced)
                         IS NOT (excluded.title, excluded.dates, excluded.status, excluded.prize_total,
                                 excluded.registrations, excluded.winners_announced)""",
                    h | {"themes": json.dumps(h["themes"]), "ts": ts},
                )
            except sqlite3.IntegrityError:
                pass  # two listings claiming one URL; keep the first
        conn.commit()
    prune(conn)


def prune(conn: sqlite3.Connection) -> None:
    with conn:
        for statement in PRUNE:
            conn.execute(statement)
        conn.execute("DELETE FROM crawl_state WHERE hackathon_id NOT IN (SELECT id FROM hackathons)")
        conn.execute("DELETE FROM project_state WHERE slug NOT IN (SELECT slug FROM projects)")


async def crawl_pages(c: httpx.AsyncClient, conn: sqlite3.Connection) -> None:
    todo = conn.execute(
        """SELECT h.id, h.url, h.status FROM hackathons h LEFT JOIN crawl_state s ON s.hackathon_id = h.id
           WHERE h.source = 'devpost' AND s.page_status IS NOT h.status ORDER BY h.ends_on DESC"""
    ).fetchall()

    async def work(item: object) -> None:
        hid, url, status = item
        page = await devpost.hackathon_page(c, url)
        ts = now()
        with conn:
            conn.execute(
                "UPDATE hackathons SET tagline = ?, description = ?, judging_criteria = ?, updated_at = ? WHERE id = ?",
                (page["tagline"], page["description"], json.dumps(page["judging_criteria"]), ts, hid),
            )
            conn.execute("DELETE FROM prizes WHERE hackathon_id = ?", (hid,))
            conn.executemany(
                "INSERT OR REPLACE INTO prizes (id, hackathon_id, title, value, winners, description, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [(p["id"], hid, p["title"], p["value"], p["winners"], p["description"], ts) for p in page["prizes"]],
            )
            _set_state(conn, hid, page_status=status)

    await run_all("hackathon pages", todo, work)


async def crawl_galleries(c: httpx.AsyncClient, conn: sqlite3.Connection) -> None:
    todo = conn.execute(
        """SELECT h.id, h.url, h.winners_announced FROM hackathons h LEFT JOIN crawl_state s ON s.hackathon_id = h.id
           WHERE h.source = 'devpost' AND h.status = 'ended' AND s.gallery_winners IS NOT h.winners_announced
           ORDER BY h.ends_on DESC"""
    ).fetchall()

    async def work(item: object) -> None:
        hid, url, winners_announced = item
        total, projects = await devpost.gallery(c, url)
        ts = now()
        with conn:
            conn.execute("UPDATE hackathons SET submissions = ?, updated_at = ? WHERE id = ?", (total, ts, hid))
            conn.executemany(
                """INSERT INTO projects (slug, url, name, tagline, likes, updated_at)
                   VALUES (:slug, 'https://devpost.com/software/' || :slug, :name, :tagline, :likes, :ts)
                   ON CONFLICT (slug) DO UPDATE SET name = excluded.name, tagline = excluded.tagline,
                     likes = excluded.likes, updated_at = excluded.updated_at""",
                [p | {"ts": ts} for p in projects],
            )
            conn.executemany(
                """INSERT INTO submissions (slug, hackathon_id, winner, updated_at) VALUES (:slug, :hid, :winner, :ts)
                   ON CONFLICT (slug, hackathon_id) DO UPDATE SET winner = excluded.winner, updated_at = excluded.updated_at""",
                [p | {"hid": hid, "ts": ts} for p in projects],
            )
            _set_state(conn, hid, gallery_winners=winners_announced)

    await run_all("galleries", todo, work)


async def crawl_winners(c: httpx.AsyncClient, conn: sqlite3.Connection) -> None:
    """Winners' own pages: tech stack, write-up, and the exact prizes won at each hackathon."""
    todo = [
        row[0]
        for row in conn.execute(
            """SELECT s.slug FROM submissions s JOIN hackathons h ON h.id = s.hackathon_id
               WHERE h.source = 'devpost' AND s.winner = 1 AND s.slug NOT IN (SELECT slug FROM project_state)
               GROUP BY s.slug ORDER BY MAX(h.ends_on) DESC"""
        )
    ]
    ids_by_url = dict(conn.execute("SELECT url, id FROM hackathons WHERE source = 'devpost'"))

    async def work(item: object) -> None:
        page = await devpost.project_page(c, item)
        ts = now()
        with conn:
            conn.execute(
                "UPDATE projects SET built_with = ?, links = ?, description = ?, updated_at = ? WHERE slug = ?",
                (json.dumps(page["built_with"]), json.dumps(page["links"]), page["description"], ts, item),
            )
            for sub in page["submissions"]:
                if (hid := ids_by_url.get(sub["url"])) and sub["prizes"]:
                    conn.execute(
                        "UPDATE submissions SET prizes = ?, updated_at = ? WHERE slug = ? AND hackathon_id = ?",
                        (json.dumps(sub["prizes"]), ts, item, hid),
                    )
            conn.execute("INSERT OR IGNORE INTO project_state (slug) VALUES (?)", (item,))

    await run_all("winner pages", todo, work)


async def crawl_entrants(c: httpx.AsyncClient, conn: sqlite3.Connection) -> None:
    """How many submissions entered each judged prize track: the competition per winner slot."""
    todo = conn.execute(
        """SELECT p.id, h.url FROM prizes p JOIN hackathons h ON h.id = p.hackathon_id
           WHERE h.source = 'devpost' AND h.status = 'ended' AND h.winners_announced = 1 AND p.entrants IS NULL
           ORDER BY h.ends_on DESC"""
    ).fetchall()

    async def work(item: object) -> None:
        prize_id, url = item
        count = await devpost.entrants(c, url, prize_id)
        with conn:
            conn.execute("UPDATE prizes SET entrants = ?, updated_at = ? WHERE id = ?", (count, now(), prize_id))

    await run_all("track entrants", todo, work)


async def crawl_plume(c: httpx.AsyncClient, conn: sqlite3.Connection) -> None:
    """HackMIT's own events, refetched in full: Plume has every track's opt-ins, so entrants come free."""
    events = await plume.hackathons(c)
    for h in events:
        projects = [plume.project(p, h["tracks"]) for p in await plume.gallery(c, h["key"])]
        ts = now()
        with conn:
            conn.execute(
                """INSERT OR REPLACE INTO hackathons (id, source, url, title, organization, dates, ends_on, status, location,
                     themes, registrations, submissions, winners_announced, judging_criteria, updated_at)
                   VALUES (:id, 'plume', :url, :title, 'HackMIT', :dates, :ends_on, :status, 'MIT, Cambridge, MA',
                     :themes, :registrations, :submissions, :winners, '[]', :ts)""",
                h | {"themes": json.dumps(h["themes"]), "winners": any(p["prizes"] for p in projects), "ts": ts},
            )
            conn.execute("DELETE FROM prizes WHERE hackathon_id = ?", (h["id"],))
            conn.executemany(
                "INSERT INTO prizes (id, hackathon_id, title, winners, entrants, updated_at) VALUES (:id, :hid, :title, :winners, :entrants, :ts)",
                [r | {"hid": h["id"], "ts": ts} for r in plume.prizes(h, projects)],
            )
            conn.execute("DELETE FROM submissions WHERE hackathon_id = ?", (h["id"],))
            for p in projects:
                conn.execute(
                    """INSERT INTO projects (slug, url, name, tagline, description, links, updated_at)
                       VALUES (:slug, :url, :name, :tagline, :description, :links, :ts)
                       ON CONFLICT (slug) DO UPDATE SET url = excluded.url, name = excluded.name, tagline = excluded.tagline,
                         description = excluded.description, links = excluded.links, updated_at = excluded.updated_at""",
                    p | {"links": json.dumps(p["links"]), "ts": ts},
                )
                conn.execute(
                    "INSERT INTO submissions (slug, hackathon_id, winner, prizes, updated_at) VALUES (?, ?, ?, ?, ?)",
                    (p["slug"], h["id"], bool(p["prizes"]), json.dumps(p["prizes"]) if p["prizes"] else None, ts),
                )
        print(f"plume: {h['title']}, {len(projects)} projects, {sum(bool(p['prizes']) for p in projects)} winners", flush=True)
    prune(conn)


def _set_state(conn: sqlite3.Connection, hid: int, **state: object) -> None:
    conn.execute("INSERT OR IGNORE INTO crawl_state (hackathon_id) VALUES (?)", (hid,))
    for column, value in state.items():
        conn.execute(f"UPDATE crawl_state SET {column} = ? WHERE hackathon_id = ?", (value, hid))


async def crawl(winners: bool) -> None:
    conn = connect()
    async with devpost.client() as c:
        await crawl_listing(c, conn)
        await crawl_pages(c, conn)
        await crawl_galleries(c, conn)
        await crawl_entrants(c, conn)
        if winners:
            await crawl_winners(c, conn)
        try:
            await crawl_plume(c, conn)
        except httpx.HTTPError as e:
            print(f"plume: skipped this run, {e!r}", file=sys.stderr)  # keeps the last good copy
    conn.close()
    build_index()
    stats()


def build_index() -> None:
    """Embeddings and topics for meaning-based search; lives in the server so both use one model."""
    connect().close()  # applies schema.sql, so the index tables exist
    subprocess.run(["bun", "run", "index", str(DB)], cwd=ROOT / "server", check=True)
    with closing(connect()) as conn:
        refresh_stats(conn)  # the local stdio server reads this file directly


# --- push -----------------------------------------------------------------

SERVER = os.environ.get("DEVPOST_SERVER", "https://devpost-mcp-production.up.railway.app")
UPLOAD_TOKEN = ROOT / "server" / ".upload-token"

# what index_info reports; counted here so the server never scans whole tables
STATS = {
    "hackathons": "SELECT COUNT(*) FROM hackathons",
    "projects": "SELECT COUNT(*) FROM projects",
    "prize_tracks": "SELECT COUNT(*) FROM prizes",
    "winning_entries": "SELECT COUNT(*) FROM submissions WHERE winner = 1",
    "tracks_with_entrant_counts": "SELECT COUNT(*) FROM prizes WHERE entrants IS NOT NULL",
    "projects_embedded": "SELECT COUNT(*) FROM embeddings",
    "topics": "SELECT COUNT(*) FROM topics",
    "winner_baseline": "SELECT ROUND((SELECT COUNT(DISTINCT slug) FROM submissions WHERE winner = 1) * 1.0 / COUNT(*), 4) FROM projects",
    "last_updated": "SELECT MAX(updated_at) FROM hackathons",
}


def refresh_stats(conn: sqlite3.Connection) -> None:
    with conn:
        conn.executemany("INSERT OR REPLACE INTO stats (key, value) VALUES (?, ?)", [(k, conn.execute(q).fetchone()[0]) for k, q in STATS.items()])


def push() -> None:
    """Upload a gzipped snapshot of the whole database; the server swaps it in atomically."""
    with tempfile.TemporaryDirectory() as tmp:
        snapshot, packed = Path(tmp) / "devpost.db", Path(tmp) / "devpost.db.gz"
        with closing(connect()) as conn:
            refresh_stats(conn)
            conn.execute("VACUUM INTO ?", (str(snapshot),))  # consistent even while a crawl is writing
        with snapshot.open("rb") as raw, gzip.open(packed, "wb", compresslevel=6) as gz:
            shutil.copyfileobj(raw, gz)
        print(f"push: uploading {packed.stat().st_size / 1e6:.0f} MB to {SERVER}", flush=True)
        with packed.open("rb") as body:
            r = httpx.put(
                f"{SERVER}/db",
                content=body,
                headers={"Authorization": f"Bearer {UPLOAD_TOKEN.read_text().strip()}", "Content-Type": "application/gzip"},
                timeout=httpx.Timeout(30, write=None, read=300),
            )
    r.raise_for_status()
    print(f"push: done, server now holds {r.json()}")


def stats() -> None:
    with closing(connect()) as conn:
        q = lambda sql: conn.execute(sql).fetchone()[0]  # noqa: E731
        print(
            f"hackathons {q('SELECT COUNT(*) FROM hackathons')} "
            f"(pages {q('SELECT COUNT(*) FROM crawl_state WHERE page_status IS NOT NULL')}, "
            f"galleries {q('SELECT COUNT(*) FROM crawl_state WHERE gallery_winners IS NOT NULL')}) | "
            f"prizes {q('SELECT COUNT(*) FROM prizes')} (entrants counted {q('SELECT COUNT(*) FROM prizes WHERE entrants IS NOT NULL')}) | projects {q('SELECT COUNT(*) FROM projects')} | "
            f"winning entries {q('SELECT COUNT(*) FROM submissions WHERE winner = 1')} "
            f"(detailed {q('SELECT COUNT(*) FROM project_state')}) | "
            f"embedded {q('SELECT COUNT(*) FROM embeddings')}, topics {q('SELECT COUNT(*) FROM topics')} | "
            f"db {DB.stat().st_size / 1e6:.0f} MB"
        )


def main() -> None:
    parser = argparse.ArgumentParser(prog="devpost", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    crawl_cmd = sub.add_parser("crawl", help="fetch new and changed data from Devpost and Plume into data/devpost.db")
    crawl_cmd.add_argument("--skip-winners", action="store_true", help="skip winners' project pages (the slowest phase)")
    sub.add_parser("index", help="rebuild embeddings and topics only (crawl runs this at the end)")
    sub.add_parser("push", help="upload the database to the MCP server")
    sub.add_parser("stats", help="show what the local database holds")
    args = parser.parse_args()
    try:
        if args.command == "crawl":
            asyncio.run(crawl(winners=not args.skip_winners))
        elif args.command == "index":
            build_index()
        elif args.command == "push":
            push()
        else:
            stats()
    except devpost.Blocked as e:
        sys.exit(f"stopped: {e}. Progress is saved; run the same command again later.")


if __name__ == "__main__":
    assert in_scope({"status": "ended", "ends_on": "2024-03-01", "registrations": 100})
    assert not in_scope({"status": "ended", "ends_on": "2023-12-31", "registrations": 5000})
    assert not in_scope({"status": "ended", "ends_on": "2025-01-01", "registrations": 99})
    assert not in_scope({"status": "ended", "ends_on": None, "registrations": 500})
    assert in_scope({"status": "upcoming", "ends_on": "2026-12-01", "registrations": 3})
    print("ok")
