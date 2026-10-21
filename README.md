# devpost-mcp

An MCP server that gives AI agents live, structured access to Devpost: past hackathons, their prize tracks and judging criteria, projects that won them, and an idea scorer. It's meant for brainstorming new hackathon ideas based on what has already been built and what has won.

It runs locally over stdio and fetches from Devpost on demand. Devpost pages are server-rendered and some endpoints already return JSON, so plain HTTP is enough and no headless browser is needed. Responses are cached in memory for the life of the server.

## Install

```bash
uv sync
```

Claude Code:

```bash
claude mcp add devpost -- uv --directory /absolute/path/to/devpost-mcp run devpost-mcp
```

Any other MCP client (Claude Desktop, Cursor, ...):

```json
{
  "mcpServers": {
    "devpost": {
      "command": "uv",
      "args": ["--directory", "/absolute/path/to/devpost-mcp", "run", "devpost-mcp"]
    }
  }
}
```

## Tools

| Tool | What it returns |
| --- | --- |
| `search_hackathons` | Hackathons by keyword, status (`upcoming`/`open`/`ended`), and sort order |
| `get_hackathon` | Description, sponsors, every prize with its challenge brief, judging criteria |
| `get_prizes` | Prize tracks with the IDs used for filtering |
| `list_hackathon_projects` | One hackathon's gallery, filterable by winners, prize track, or keyword |
| `get_winners` | A hackathon's winners and the exact prizes they won; with `sponsor`, grouped by that sponsor's tracks with challenge brief and entrant count |
| `find_sponsor_winners` | The same per-track view across many recent judged hackathons |
| `search_projects` | Keyword search across all of Devpost, sorted by popularity or recency |
| `get_project` | Full write-up, tech stack, links, team, hackathons entered, prizes won |
| `score_idea` | Novelty, winning track record, and prize fit for a draft idea, with the closest existing projects as evidence |

### Sponsor search

Devpost has no index of sponsors. Sponsors show up as prize tracks, which are usually named like `Fetch.ai: Smartest AI Agent Prize`. `find_sponsor_winners` pages through ended hackathons that have announced winners and keeps the ones with a matching prize track. For each match it reads the gallery filtered to that track. For every track you get:

- `challenge`: the brief for that track at that event. Sponsors often change the challenge between events, so compare the briefs instead of assuming they match.
- `entrants`: how many teams entered the track, which tells you how crowded it was.
- `winners`: who won that specific track, confirmed on each project's page.

Use `query` to narrow which hackathons get scanned, for example `query="AI"`, or the sponsor's name to include events the sponsor ran itself.

### Idea scoring

`score_idea` searches Devpost for projects similar to the idea and scores only what past data can measure:

- `novelty` (weight 0.5): distance from the closest projects. One near-twin lowers it; several lower it more.
- `proven_space` (weight 0.3): share of the 10 closest projects that won a prize.
- `sponsor_fit` (weight 0.2): match against the target hackathon's best-fitting prize track.

These combine into `signal_score`. The best ideas usually have high novelty and high `proven_space`: an angle nobody has built yet, in a space judges reward. Feasibility, demo quality, and impact are left to the agent, which receives the hackathon's own judging criteria to rate them against.

Pass `sponsors=["Fetch.ai", "Intel"]` with `hackathon_url` when the user is targeting specific sponsors. Sponsor fit is then scored against only those sponsors' tracks, and every one of their tracks comes back with its full brief. The brief is where sponsors state their own challenge and judging criteria, for example a Roblox track's "Award Criteria" list. The agent should judge the idea against both the hackathon's criteria and these. Sponsors with no matching track at that hackathon come back in `unmatched_sponsors`.

The similarity is lexical TF-IDF, so it misses paraphrases ("ASL" vs "sign language"). Passing 2-4 `queries` with different wordings makes up for most of that.

## Suggested agent workflow

1. `search_hackathons(query="<target>")` to find the upcoming event and its past editions.
2. `get_hackathon(<upcoming>)` to read its prize tracks and judging criteria.
3. `get_winners(<past edition>)` and `find_sponsor_winners(<sponsor>)` to see what has won and what each sponsor rewards.
4. Brainstorm, then run `score_idea(idea, queries, hackathon_url=<upcoming>, sponsors=[<targeted sponsors>])` on each draft. Drop the near-duplicates and refine the rest.
5. `get_project(<closest match>)` to see how the nearest existing project did it, and find a different angle.

## Limits

- Devpost rate-limits its search endpoint. The client retries with backoff, but heavy `search_projects` or `score_idea` use can still slow down.
- `find_sponsor_winners` covers recent judged events (up to 60 per call), not all of Devpost history.
- This is scraping. If Devpost changes its markup, the selectors in `devpost.py` will need updating.
