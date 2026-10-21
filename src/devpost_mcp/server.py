from mcp.server import MCPServer

from . import devpost, scoring

mcp = MCPServer(
    "devpost",
    instructions=(
        "Live Devpost data for hackathon ideation. Typical flow: search_hackathons to find the target "
        "event and its past editions, get_hackathon for its prizes/sponsors, get_winners on past editions "
        "to see what wins, find_sponsor_winners to see what a sponsor rewards across many events, "
        "search_projects to check whether an idea already exists, get_project for full write-ups, and "
        "score_idea to test a draft idea for novelty and prize fit before committing to it."
    ),
)


@mcp.tool()
async def search_hackathons(query: str = "", status: str = "", page: int = 1, order_by: str = "") -> dict:
    """Search Devpost hackathons by name/keyword.

    status: "" (any), "upcoming", "open", or "ended". order_by: "" (relevance), "submission-date",
    "recently-added", or "prize-amount". 9 results per page.
    """
    return await devpost.search_hackathons(query, status, page, order_by)


@mcp.tool()
async def get_hackathon(url: str) -> dict:
    """Hackathon overview: description, sponsors, and every prize with its description.

    url: the hackathon's devpost URL, e.g. https://treehacks-2024.devpost.com
    """
    return await devpost.get_hackathon(url)


@mcp.tool()
async def list_hackathon_projects(
    url: str, winners_only: bool = False, max_pages: int = 5, prize_id: int | None = None, terms: str = ""
) -> dict:
    """Projects submitted to one hackathon (name, tagline, winner flag, likes, team). 24 per page.

    prize_id: only projects entered in that prize track (ids from get_prizes).
    terms: keyword search within this hackathon's submissions.
    """
    return await devpost.list_hackathon_projects(url, winners_only, max_pages, prize_id, terms)


@mcp.tool()
async def get_prizes(url: str) -> dict:
    """A hackathon's prize tracks with ids usable as list_hackathon_projects(prize_id=...)."""
    return {"prizes": await devpost.get_prizes(url)}


@mcp.tool()
async def get_winners(url: str, sponsor: str = "") -> dict:
    """Winning projects of one hackathon with the exact prizes each won and its tech stack.

    sponsor: optional case-insensitive match on prize names, e.g. "Google", "Gemini", "Grand". When set,
    results are grouped per matching prize track with the track's challenge brief and entrant count.
    """
    return await devpost.get_winners(url, sponsor)


@mcp.tool()
async def find_sponsor_winners(
    sponsor: str, query: str = "", order_by: str = "submission-date", max_hackathons: int = 25
) -> dict:
    """Winners of one sponsor's prizes across many judged hackathons (newest first by default).

    For each hackathon: every matching prize track with its challenge brief (challenges differ between
    events, so compare them), entrant count, and winners. sponsor matches prize names, e.g. "Fetch.ai".
    query narrows which hackathons are scanned (e.g. "AI", or the sponsor name for sponsor-run events).
    Scans at most 60 hackathons; takes ~5-20s.
    """
    return await devpost.find_sponsor_winners(sponsor, query, order_by, max_hackathons)


@mcp.tool()
async def search_projects(query: str, winners_only: bool = False, pages: int = 4, sort: str = "popular") -> dict:
    """Keyword search across every project on Devpost (6 results per page, max 10 pages).

    sort: "popular" (most liked; ~1 in 3 is a winner) or "newest" (latest trends, mostly unjudged).
    winners_only always scans the full 10 pages. For winners of a known event prefer get_winners; for a
    sponsor prefer find_sponsor_winners.
    """
    return await devpost.search_projects(query, winners_only, pages, sort)


@mcp.tool()
async def get_project(url: str) -> dict:
    """Full project write-up: description, built-with tags, links, team, hackathons and prizes won.

    url: a devpost.com/software/... URL or just the slug.
    """
    return await devpost.get_project(url)


@mcp.tool()
async def score_idea(idea: str, queries: list[str] | None = None, hackathon_url: str = "") -> dict:
    """Score a hackathon idea against past Devpost projects.

    Returns novelty (distance from the closest existing project), proven_space (how often the closest
    projects won), sponsor_fit (best-matching prize track of hackathon_url), the closest projects as
    evidence, and the hackathon's judging criteria for you to rate feasibility/demo/impact yourself.

    idea: a few sentences: problem, solution, key tech.
    queries: 2-4 short keyword searches that would find similar projects, e.g. ["sign language
    translator", "asl glove", "gesture recognition accessibility"]. Better queries = better score.
    hackathon_url: the target hackathon, for prize-track fit and judging criteria.
    """
    return await scoring.score_idea(idea, queries, hackathon_url)
