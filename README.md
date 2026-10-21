# devpost-mcp

A shared MCP server for brainstorming hackathon ideas based on what has already been built and what has won on Devpost. It covers every Devpost hackathon, each prize track (with the sponsor's challenge brief and criteria), every submission, and which projects won which prizes. It also includes an idea scorer.

It has two parts:

- **Crawler** (`src/devpost_mcp`, Python): runs on your machine, crawls Devpost into `data/devpost.db`, and uploads that SQLite file to the server. Devpost blocks requests from cloud hosts, so crawling can't happen there.
- **MCP server** (`server/`, Bun + TypeScript): runs on Railway and answers MCP requests from the uploaded SQLite file, kept on a Railway volume. It never contacts Devpost, so there are no rate limits while brainstorming.

There's no scheduled crawling. You run the update yourself when you want fresher data.

**Scope:** hackathons that ended on or after 2024-01-01 with at least 100 registrations, plus every open and upcoming hackathon. Registrations are the only size signal Devpost exposes, and the 100 cutoff keeps student and builder events while dropping classroom-sized ones. Both thresholds are `SINCE` and `MIN_REGISTRATIONS` in `src/devpost_mcp/crawl.py`. If you change them, the next `crawl` and `push` remove whatever falls out of scope.

## Connect (teammates)

You need the server URL and the team token from whoever runs the crawler. Then:

```bash
claude mcp add --transport http --scope user devpost https://devpost-mcp-production.up.railway.app/mcp --header "Authorization: Bearer <team-token>"
```

Other MCP clients take the same URL and `Authorization` header.

**Claude desktop app (Chat tab):** custom connectors there can't send an `Authorization` header, so bridge through `mcp-remote` instead. Add this to `~/Library/Application Support/Claude/claude_desktop_config.json` (on Windows, `%APPDATA%\Claude\claude_desktop_config.json`), then restart the app:

```json
{
  "mcpServers": {
    "devpost": {
      "command": "npx",
      "args": ["-y", "mcp-remote@0.14.3", "https://devpost-mcp-production.up.railway.app/mcp", "--header", "Authorization: Bearer <team-token>"]
    }
  }
}
```

This needs Node.js. If you installed Node with nvm or another version manager, the app won't find `npx` on its own. Set `command` to the absolute path from `which npx`, and add `"env": {"PATH": "<that directory>:/usr/bin:/bin"}`. This works in the desktop app only, not on claude.ai or mobile.

## Tools

| Tool | What it returns |
| --- | --- |
| `search_hackathons` | Hackathons filtered by title, status, sponsor, theme, and end date, sorted by newest or largest |
| `get_hackathon` | Description, judging criteria, and every prize track with its full brief, winner slots, and entrants |
| `list_hackathon_projects` | One hackathon's submissions, winners first |
| `get_winners` | A hackathon's winners and the prizes they won; with `sponsor`, grouped by that sponsor's tracks with each track's brief and how each winner used the sponsor |
| `find_sponsor_winners` | One sponsor's tracks across hackathons, newest first: each event's brief, entrants per winner slot, and the winners of that exact track |
| `search_projects` | Search every project by meaning (describe a problem in plain words) or by keyword, optionally winners-only or recent-only |
| `find_gaps` | Topics where winners are common but few teams build, topics that are growing, and topics that are crowded |
| `get_project` | Tech stack, links, hackathons entered, and prizes won; winners also include their full write-up |
| `score_ideas` | Ranks up to 10 draft ideas by novelty, winning track record, and prize-track fit, with the closest existing projects as evidence |
| `index_info` | How much the index holds and when it was last updated |

### Sponsor search

Sponsors show up on Devpost as prize tracks, usually named like `Fetch.ai: Smartest AI Agent Prize`. `search_hackathons(sponsor=...)` and `find_sponsor_winners` match on those names across all of Devpost. Each track includes its `challenge` brief, because sponsors often change the challenge from one event to the next, so compare the briefs instead of assuming they match.

1st, 2nd and 3rd place prizes of one track are grouped into a single row. Each row includes:

- `entrants`: how many submissions opted into the track.
- `winner_slots`: how many prizes it awards.
- `entrants_per_slot`: the competition per prize.

`find_sponsor_winners` also returns the sponsor's median entrants per slot. Winners include `sponsor_usage`, the sentences of their write-up that mention the sponsor.

When the brief states a cash amount different from Devpost's listed value, the prize includes `cash_in_brief`. Organizers sometimes put perks into the listed value.

### Search by meaning

Every project's name and tagline is embedded with [bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5), a small open model that runs inside both the crawler and the server, so there are no API keys or per-query costs. `search_projects` defaults to `mode="meaning"`, which finds projects by what they do, even when they share no words with the query: "regulated paperwork for small businesses" finds regulatory-report drafting and policy-tracking tools. Describe the product rather than the situation. The model is small and latches onto concrete nouns, so "voice-controlled assistant for people working with their hands" works better than "jobs where people's hands are busy". `mode="all"` and `mode="any"` are keyword searches, better for exact names such as a sponsor's SDK.

### Finding gaps

The crawler also groups all projects into about 300 topics by meaning. `find_gaps` returns, for each topic, how many projects it has, how often they win compared with the baseline, how fast it grew over the last year, its most distinctive words, and example projects and winners. Sort by:

- `underbuilt` (default): topics winning at 1.2x the baseline or better, smallest first. These are rewarded spaces few teams attempt.
- `best_odds`: highest winner rate.
- `rising`: growing fastest.
- `crowded`: most built, to know what to avoid.

`theme="healthcare for elderly people"` narrows to topics near a problem area. `sponsor="Fetch.ai"` narrows to topics where that sponsor's prizes were won. Topics under 20 projects get no winner rate, since a handful of projects can't support one.

### Idea scoring

`score_ideas` scores up to 10 ideas in one call and returns them ranked. The hackathon's judging criteria and track briefs come back once for the whole batch, under `context`. It scores only what past data can measure:

- `novelty` (default weight 0.5): distance in meaning from the closest projects. One near-twin lowers it; several lower it more.
- `proven_space` (0.3): how often projects similar to the idea won, compared with how often indexed projects win overall. 50 means they win at the usual rate, and 100 means twice that or more. This is `winner_lift`. It's null when fewer than 5 projects are similar enough to count (similarity 0.78 or more).
- `sponsor_fit` (0.2): match in meaning against the best-fitting prize track. When a track's brief is empty or a single line, the match uses that sponsor's past briefs and winners instead (see `fit_basis`).

These combine into `signal_score`. Pass `weights` to change the mix, for example to favour sponsor fit when prize money matters most. The best ideas usually have high novelty and high `proven_space`: an angle nobody has built yet, in a space judges reward.

`crowding.biggest_cluster` flags when many similar projects came from one event, such as a themed hackathon. That's a different signal from the same idea showing up at many general hackathons.

Options:

- `sponsors=["Fetch.ai", "Intel"]` (with `hackathon_url`) scores fit against only those sponsors' tracks, and returns each one with its brief and `past_entrants_per_slot`.
- `extra_tracks=[{title, brief}]` adds tracks that aren't on Devpost yet, for example ones announced by email.
- Sponsors that match no track come back in `unmatched_sponsors`.

Feasibility, demo quality and impact are left to the agent, which rates them against the briefs and the judging criteria.

Similarity is by meaning, so rewordings match ("ASL glove" and "sign language translator"). Each idea's optional `queries` add keyword searches on top, which help with exact names the model may blur, such as a sponsor's SDK.

## Suggested agent workflow

1. `search_hackathons(query="<target>")` to find the upcoming event and its past editions.
2. `get_hackathon(<upcoming>)` to read its prize tracks and judging criteria.
3. `get_winners(<past edition>)` and `find_sponsor_winners(<sponsor>)` to see what has won and what each sponsor rewards.
4. `find_gaps(theme=..., sponsor=...)` to find rewarded areas few teams have built, and `search_projects` to look around them.
5. Brainstorm, then run `score_ideas(ideas=[...], hackathon_url=<upcoming>, sponsors=[<targeted sponsors>])` on the drafts together. Drop the near-duplicates and refine the rest.
6. `get_project(<closest match>)` to see how the nearest existing project did it, and find a different angle.

## Updating the data (maintainer)

```bash
uv sync
uv run devpost crawl
uv run devpost push
```

`crawl` only fetches what changed since the last run: new hackathons, status changes, newly announced winners, entrant counts for newly judged tracks, and winners' project pages. It then embeds new projects and rebuilds the topics, which needs [Bun](https://bun.sh) and takes about 10 minutes the first time and about 1 minute after that. `uv run devpost index` runs just that step. The first run takes a few hours. Every phase is resumable, so if it stops, run it again. `push` snapshots the database, gzips it (about 60 MB), and uploads it. The server checks the file and swaps it in, so in-flight requests are never interrupted. `uv run devpost stats` shows what the local database holds.

Keep `data/devpost.db`, because it's what makes updates incremental. If it's lost, run the full crawl again.

## Deploying the server (maintainer)

```bash
cd server
bun install
bun test
railway up
```

The service runs from `server/Dockerfile` with a volume mounted at `/data` and three variables:

| Variable | Purpose |
| --- | --- |
| `TEAM_TOKEN` | Bearer token teammates send to `/mcp`; local copy in `server/.team-token` |
| `UPLOAD_TOKEN` | Bearer token `push` sends to `/db`; local copy in `server/.upload-token` |
| `DB_PATH` | `/data/devpost.db` |

Both token files are gitignored. Keep the upload token to yourself: anyone holding it can replace the data. To revoke teammates' access, put a new token in `.team-token`, run `railway variables --set "TEAM_TOKEN=$(cat .team-token)"`, and send them the new one. `push` uploads to `https://devpost-mcp-production.up.railway.app` unless `DEVPOST_SERVER` is set.

To run the server locally, start it with `DB_PATH=../data/devpost.db TEAM_TOKEN=... bun run dev`.

## Limits

- Write-ups are stored only for winners. For other projects, `get_project` returns the Devpost URL to read.
- Entrant counts come from Devpost's per-prize opt-ins. Prizes an organizer added after judging show 0 entrants.
- Tech stacks are crawled only for winners, so embeddings and scoring use project names and taglines.
- Topic labels are the most distinctive words, not summaries, and short taglines make topics a little noisy. The examples show what a topic actually covers.
- The crawler scrapes HTML, so if Devpost changes its markup, the selectors in `src/devpost_mcp/devpost.py` will need updating.
