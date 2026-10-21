import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import * as db from "./db";
import { DEFAULT_WEIGHTS, scoreIdeas } from "./scoring";

interface Env {
	DB: D1Database;
	TEAM_TOKEN: string;
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });
const notFound = (what: string) => fail(`${what} is not in the index. Find the right URL with search_hackathons or search_projects.`);

const limit = (max: number, fallback: number) => z.number().int().min(1).max(max).default(fallback);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

function createServer(env: Env) {
	const server = new McpServer(
		{ name: "devpost", version: "3.0.0" },
		{
			instructions:
				"An index of Devpost: every hackathon, its prize tracks (with each sponsor's challenge brief and criteria), " +
				"all submissions, and which projects won which prizes. Typical flow: search_hackathons to find the target " +
				"event and past editions, get_hackathon for its tracks and judging criteria, get_winners and " +
				"find_sponsor_winners to see what wins and how crowded each track was, search_projects to check if an " +
				"idea exists, score_ideas to rank drafts in one batch. Data comes from a periodic crawl; index_info says how fresh it is.",
		},
	);

	server.registerTool(
		"search_hackathons",
		{
			description:
				"Find hackathons. All filters combine. sponsor matches prize-track names (e.g. 'Gemini', 'Fetch.ai'), " +
				"so it finds every hackathon where that sponsor ran a track. sort: newest (by end date) or largest (registrations).",
			inputSchema: z.object({
				query: z.string().optional().describe("words in the title or organizer"),
				status: z.enum(["ended", "open", "upcoming"]).optional(),
				sponsor: z.string().optional(),
				theme: z.string().optional().describe("Devpost theme, e.g. 'Machine Learning/AI', 'Health', 'Beginner Friendly'"),
				ended_after: date.optional(),
				ended_before: date.optional(),
				sort: z.enum(["newest", "largest"]).default("newest"),
				limit: limit(50, 20),
				offset: z.number().int().min(0).default(0),
			}),
		},
		async (args) => ok(await db.searchHackathons(env.DB, args)),
	);

	server.registerTool(
		"get_hackathon",
		{
			description:
				"One hackathon: description, judging criteria, and every prize track (placements collapsed) with its full brief " +
				"(where sponsors state their own criteria), winner slots, and entrants per slot once judged.",
			inputSchema: z.object({ url: z.string().describe("e.g. https://treehacks-2024.devpost.com") }),
		},
		async ({ url }) => {
			const h = await db.getHackathon(env.DB, url);
			return h ? ok(h) : notFound(url);
		},
	);

	server.registerTool(
		"list_hackathon_projects",
		{
			description: "Submissions to one hackathon, winners first then by likes.",
			inputSchema: z.object({
				url: z.string(),
				winners_only: z.boolean().default(false),
				limit: limit(200, 50),
				offset: z.number().int().min(0).default(0),
			}),
		},
		async ({ url, winners_only, limit, offset }) => ok(await db.listProjects(env.DB, url, winners_only, limit, offset)),
	);

	server.registerTool(
		"get_winners",
		{
			description:
				"Winners of one hackathon with the prizes each won and its tech stack. With sponsor, grouped per matching " +
				"prize track, each with its challenge brief, entrants, and winners with the write-up sentences that mention the sponsor.",
			inputSchema: z.object({ url: z.string(), sponsor: z.string().optional() }),
		},
		async ({ url, sponsor }) => {
			const w = await db.getWinners(env.DB, url, sponsor);
			return w ? ok(w) : notFound(url);
		},
	);

	server.registerTool(
		"find_sponsor_winners",
		{
			description:
				"What one sponsor rewards across hackathons, newest first: for each hackathon, every matching prize track with " +
				"its challenge brief (sponsors change challenges between events, so compare them), entrants per winner slot, and the " +
					"winners of that exact track with the write-up sentences showing how they used the sponsor.",
			inputSchema: z.object({
				sponsor: z.string().describe("matched against prize-track names, e.g. 'Fetch.ai', 'Gemini', 'MLH'"),
				ended_after: date.optional(),
				limit: limit(50, 15).describe("number of hackathons"),
			}),
		},
		async ({ sponsor, ended_after, limit }) => ok(await db.findSponsorWinners(env.DB, sponsor, ended_after, limit)),
	);

	server.registerTool(
		"search_projects",
		{
			description:
				"Full-text search over every crawled project's name, tagline and tech stack. mode all = every word must " +
				"match; any = at least one (wider net). Results ranked by relevance.",
			inputSchema: z.object({
				query: z.string(),
				mode: z.enum(["all", "any"]).default("all"),
				winners_only: z.boolean().default(false),
				ended_after: date.optional().describe("only projects from hackathons that ended on or after this date"),
				limit: limit(100, 25),
			}),
		},
		async ({ query, mode, winners_only, ended_after, limit }) => {
			const hits = await db.searchProjects(env.DB, query, { mode, winnersOnly: winners_only, endedAfter: ended_after, limit });
			return ok({ query, returned: hits.length, projects: hits.map(db.projectHit) });
		},
	);

	server.registerTool(
		"get_project",
		{
			description: "One project: tech stack, links, every hackathon it entered and the prizes it won. Winners also include the full write-up.",
			inputSchema: z.object({ url: z.string().describe("devpost.com/software/... URL or slug") }),
		},
		async ({ url }) => {
			const p = await db.getProject(env.DB, url);
			return p ? ok(p) : notFound(url);
		},
	);

	server.registerTool(
		"score_ideas",
		{
			description:
				"Score and rank up to 10 draft ideas in one call against past projects: novelty (distance from the closest " +
				"existing projects), proven_space (how much more often similar projects win than projects in general), " +
				"sponsor_fit (best-matching prize track). Returns a ranking with evidence per idea, plus the target " +
				"hackathon's judging criteria and track briefs once for the whole batch, so you can rate feasibility/demo/impact yourself.",
			inputSchema: z.object({
				ideas: z
					.array(
						z.object({
							idea: z.string().describe("a few sentences: problem, solution, key tech"),
							queries: z
								.array(z.string())
								.max(6)
								.default([])
								.describe("2-4 differently worded searches that would find similar projects, e.g. ['sign language translator', 'asl glove']"),
						}),
					)
					.min(1)
					.max(10),
				hackathon_url: z.string().optional().describe("the target hackathon, for prize-track fit and judging criteria"),
				sponsors: z
					.array(z.string())
					.default([])
					.describe("sponsors the user is targeting there; fit and briefs come from only their tracks"),
				extra_tracks: z
					.array(z.object({ title: z.string(), brief: z.string() }))
					.max(10)
					.default([])
					.describe("tracks not on Devpost yet (from emails, Discord, the event site), scored like Devpost tracks"),
				weights: z
					.object({ novelty: z.number().min(0), proven_space: z.number().min(0), sponsor_fit: z.number().min(0) })
					.default(DEFAULT_WEIGHTS)
					.describe("relative weights; e.g. raise sponsor_fit when prize money matters most"),
			}),
		},
		async ({ ideas, hackathon_url, sponsors, extra_tracks, weights }) => {
			try {
				return ok(await scoreIdeas(env.DB, { ideas, hackathonUrl: hackathon_url, sponsors, extraTracks: extra_tracks, weights }));
			} catch (e) {
				return fail((e as Error).message);
			}
		},
	);

	server.registerTool(
		"index_info",
		{ description: "How much the index holds and when it was last updated.", inputSchema: z.object({}) },
		async () => ok(await db.indexInfo(env.DB)),
	);

	return server;
}

async function authorized(request: Request, token: string): Promise<boolean> {
	const given = new TextEncoder().encode(request.headers.get("Authorization") ?? "");
	const expected = new TextEncoder().encode(`Bearer ${token}`);
	return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
}

export default {
	async fetch(request, env, ctx) {
		if (!env.TEAM_TOKEN || !(await authorized(request, env.TEAM_TOKEN))) {
			return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
		}
		return createMcpHandler(() => createServer(env))(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
