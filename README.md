# devpost-mcp

A shared MCP server for brainstorming hackathon ideas based on what has already been built and what has won on Devpost. It covers every Devpost hackathon, each prize track (with the sponsor's challenge brief and criteria), every submission, and which projects won which prizes. It also includes an idea scorer.

It has two parts:

- **Crawler** (`src/devpost_mcp`, Python): runs on your machine, crawls Devpost into `data/devpost.db`, and pushes changes to Cloudflare D1. Devpost returns 403 to Cloudflare Workers, so crawling can't happen in the cloud.
- **MCP server** (`worker/`, TypeScript): a Cloudflare Worker that answers MCP requests from D1. It never contacts Devpost, so there are no rate limits while brainstorming.

There's no scheduled crawling. You run the update yourself when you want fresher data.

## Connect (teammates)

You need the server URL and the team token from whoever runs the crawler. Then:

```bash
claude mcp add --transport http --scope user devpost https://devpost-mcp.sudonamol.workers.dev/mcp --header "Authorization: Bearer <team-token>"
```

Other MCP clients take the same URL and `Authorization` header.

## Tools

| Tool | What it returns |
| --- | --- |
| `search_hackathons` | Hackathons filtered by title, status, sponsor, theme, and end date, sorted by newest or largest |
| `get_hackathon` | Description, judging criteria, and every prize track with its full brief |
| `list_hackathon_projects` | One hackathon's submissions, winners first |
| `get_winners` | A hackathon's winners and the prizes they won; with `sponsor`, grouped by that sponsor's tracks with each track's brief |
| `find_sponsor_winners` | One sponsor's tracks across hackathons, newest first: each event's brief and the winners of that exact track |
| `search_projects` | Full-text search over every project's name, tagline, and tech stack, optionally winners-only or recent-only |
| `get_project` | Tech stack, links, hackathons entered, and prizes won; winners also include their full write-up |
| `score_idea` | Novelty, winning track record, and prize-track fit for a draft idea, with the closest existing projects as evidence |
| `index_info` | How much the index holds and when it was last updated |

### Sponsor search

Sponsors show up on Devpost as prize tracks, usually named like `Fetch.ai: Smartest AI Agent Prize`. `search_hackathons(sponsor=...)` and `find_sponsor_winners` match on those names across all of Devpost. Each track includes its `challenge` brief, because sponsors often change the challenge from one event to the next, so compare the briefs instead of assuming they match.

### Idea scoring

`score_idea` pulls projects similar to the idea from the index and scores only what past data can measure:

- `novelty` (weight 0.5): distance from the closest projects. One near-twin lowers it; several lower it more.
- `proven_space` (weight 0.3): share of the 10 closest projects that won a prize.
- `sponsor_fit` (weight 0.2): match against the target hackathon's best-fitting prize track.

These combine into `signal_score`. The best ideas usually have high novelty and high `proven_space`: an angle nobody has built yet, in a space judges reward. Feasibility, demo quality, and impact are left to the agent, which receives the hackathon's judging criteria to rate them against.

Pass `sponsors=["Fetch.ai", "Intel"]` with `hackathon_url` when the user is targeting specific sponsors. Sponsor fit is then scored against only those sponsors' tracks, and every one of their tracks comes back with its full brief. The brief is where sponsors state their own challenge and judging criteria, so the agent should judge the idea against both those and the hackathon's criteria. Sponsors with no matching track at that hackathon come back in `unmatched_sponsors`.

The similarity is lexical TF-IDF, so it misses paraphrases ("ASL" vs "sign language"). Passing 2-4 `queries` with different wordings makes up for most of that.

## Suggested agent workflow

1. `search_hackathons(query="<target>")` to find the upcoming event and its past editions.
2. `get_hackathon(<upcoming>)` to read its prize tracks and judging criteria.
3. `get_winners(<past edition>)` and `find_sponsor_winners(<sponsor>)` to see what has won and what each sponsor rewards.
4. Brainstorm, then run `score_idea(idea, queries, hackathon_url=<upcoming>, sponsors=[<targeted sponsors>])` on each draft. Drop the near-duplicates and refine the rest.
5. `get_project(<closest match>)` to see how the nearest existing project did it, and find a different angle.

## Updating the data (maintainer)

```bash
uv sync
uv run devpost crawl
uv run devpost push
```

`crawl` only fetches what changed since the last run: new hackathons, status changes, newly announced winners, and those winners' project pages. The first run takes a few hours. Every phase is resumable, so if it stops, run it again. `push` uploads only rows changed since the last push. `uv run devpost stats` shows what the local database holds.

Keep `data/devpost.db`, because it's what makes updates incremental. If it's lost, run the full crawl again.

## Deploying the Worker (maintainer)

```bash
cd worker
bun install
bun test
bun run deploy
wrangler secret put TEAM_TOKEN < .team-token
```

`.team-token` is gitignored. To revoke access, put a new token there, run the `secret put` again, and send teammates the new token.

## Limits

- Write-ups are stored only for winners. For other projects, `get_project` returns the Devpost URL to read.
- Per-track entrant counts (how many teams entered a sponsor's track) aren't crawled. They would cost one extra request per prize, about 100k more.
- The crawler scrapes HTML, so if Devpost changes its markup, the selectors in `src/devpost_mcp/devpost.py` will need updating.
