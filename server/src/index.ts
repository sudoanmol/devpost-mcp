import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import * as db from "./db";
import { embed, loadIndex, type VectorIndex } from "./embeddings";
import { findGaps } from "./gaps";
import { DEFAULT_WEIGHTS, scoreIdeas } from "./scoring";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });
const notFound = (what: string) => fail(`${what} is not in the index. Find the right URL with search_hackathons or search_projects.`);

const limit = (max: number, fallback: number) => z.number().int().min(1).max(max).default(fallback);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

function createServer({ database, vectors }: Loaded) {
	const server = new McpServer(
		{ name: "devpost", version: "4.0.0" },
		{
			instructions:
				"An index of Devpost: every hackathon, its prize tracks (with each sponsor's challenge brief and criteria), " +
				"all submissions, and which projects won which prizes. Typical flow: search_hackathons to find the target " +
				"event and past editions, get_hackathon for its tracks and judging criteria, get_winners and " +
				"find_sponsor_winners to see what wins and how crowded each track was, find_gaps for rewarded areas few " +
				"teams build, search_projects to check if an idea exists, score_ideas to rank drafts in one batch. Data comes from a periodic crawl; index_info says how fresh it is.",
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
		async (args) => ok(await db.searchHackathons(database, args)),
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
			const h = await db.getHackathon(database, url);
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
		async ({ url, winners_only, limit, offset }) => ok(await db.listProjects(database, url, winners_only, limit, offset)),
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
			const w = await db.getWinners(database, url, sponsor);
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
		async ({ sponsor, ended_after, limit }) => ok(await db.findSponsorWinners(database, sponsor, ended_after, limit)),
	);

	server.registerTool(
		"search_projects",
		{
			description:
				"Search every crawled project. mode meaning (default) matches by what a project does: describe the product or " +
				"solution in plain words ('voice-controlled assistant for people working with their hands'), since the small " +
				"model latches onto concrete nouns more than abstract situations; results carry a similarity. mode all/any are " +
				"keyword searches over name, tagline and tech stack, for exact names like a sponsor's SDK (all = every word, any = at least one).",
			inputSchema: z.object({
				query: z.string(),
				mode: z.enum(["meaning", "all", "any"]).default("meaning"),
				winners_only: z.boolean().default(false),
				ended_after: date.optional().describe("only projects from hackathons that ended on or after this date"),
				limit: limit(100, 25),
			}),
		},
		async ({ query, mode, winners_only, ended_after, limit }) => {
			const opts = { winnersOnly: winners_only, endedAfter: ended_after, limit };
			const projects =
				mode === "meaning"
					? await db.searchByMeaning(database, vectors, query, opts)
					: (await db.searchProjects(database, query, { mode, ...opts })).map(db.projectHit);
			return ok({ query, mode, returned: projects.length, projects });
		},
	);

	server.registerTool(
		"find_gaps",
		{
			description:
				"Open spaces to brainstorm into. Every project is grouped into ~300 topics by meaning; each topic comes with " +
				"its size, winner rate vs baseline, growth over the last year, distinctive words and example projects. " +
				"sort underbuilt (default) = rewarded topics few teams attempt; best_odds = highest winner rate; rising = " +
				"growing fastest; crowded = most built (to avoid). theme narrows to topics near a problem area; sponsor " +
				"narrows to topics where that sponsor's prizes were won.",
			inputSchema: z.object({
				theme: z.string().optional().describe("a problem area in plain words, e.g. 'healthcare for elderly people'"),
				sponsor: z.string().optional().describe("matched against won prize names, e.g. 'Fetch.ai'"),
				sort: z.enum(["underbuilt", "best_odds", "rising", "crowded"]).default("underbuilt"),
				limit: limit(30, 10),
			}),
		},
		async (args) => ok(await findGaps(database, args)),
	);

	server.registerTool(
		"get_project",
		{
			description: "One project: tech stack, links, every hackathon it entered and the prizes it won. Winners also include the full write-up.",
			inputSchema: z.object({ url: z.string().describe("devpost.com/software/... URL or slug") }),
		},
		async ({ url }) => {
			const p = await db.getProject(database, url);
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
				return ok(await scoreIdeas(database, vectors, { ideas, hackathonUrl: hackathon_url, sponsors, extraTracks: extra_tracks, weights }));
			} catch (e) {
				return fail((e as Error).message);
			}
		},
	);

	server.registerTool(
		"index_info",
		{ description: "How much the index holds and when it was last updated.", inputSchema: z.object({}) },
		async () => ok(await db.indexInfo(database)),
	);

	return server;
}

function authorized(request: Request, token: string | undefined): boolean {
	if (!token) return false;
	const given = Buffer.from(request.headers.get("Authorization") ?? "");
	const expected = Buffer.from(`Bearer ${token}`);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

const DB_PATH = process.env.DB_PATH ?? "devpost.db";
type Loaded = { database: Database; vectors: VectorIndex };
const open = (): Loaded | null => {
	if (!existsSync(DB_PATH)) return null;
	const database = new Database(DB_PATH, { readonly: true });
	return { database, vectors: loadIndex(database) };
};
let current = open();
void embed(["warm up"]); // load the model now rather than on the first search

const mcp = createMcpHandler(() => createServer(current!));

/** The crawler uploads a fresh gzipped database; it replaces the live one only if it opens and has stats. */
async function replaceDatabase(request: Request): Promise<Response> {
	if (!request.body) return new Response("Expected a gzipped SQLite file", { status: 400 });
	const upload = `${DB_PATH}.upload`;
	try {
		// a FileSink loop: Bun.write(path, new Response(stream)) never settles for request streams in Bun 1.4
		const file = Bun.file(upload).writer();
		for await (const chunk of request.body.pipeThrough(new DecompressionStream("gzip"))) file.write(chunk);
		await file.end();
		const check = new Database(upload, { readonly: true });
		const stats = check.query("SELECT key, value FROM stats").all();
		const embedded = (check.query("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number }).n;
		check.close();
		if (!stats.length) throw new Error("stats table is empty");
		if (!embedded) throw new Error("no embeddings; run `uv run devpost crawl` so it builds them");
	} catch (e) {
		rmSync(upload, { force: true });
		return new Response(`Rejected upload: ${(e as Error).message}`, { status: 400 });
	}
	// rename is atomic on one volume; the old handle keeps reading the old file until closed
	renameSync(upload, DB_PATH);
	const previous = current;
	current = open();
	previous?.database.close();
	return Response.json(await db.indexInfo(current!.database));
}

const unauthorized = () => new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

const server = Bun.serve({
	port: Number(process.env.PORT ?? 3000),
	maxRequestBodySize: 2 ** 30,
	idleTimeout: 120,
	routes: {
		"/health": () => new Response(current ? "ok" : "no data uploaded yet"),
		"/db": {
			PUT: (request) => (authorized(request, process.env.UPLOAD_TOKEN) ? replaceDatabase(request) : unauthorized()),
		},
		"/mcp": (request) => {
			if (!authorized(request, process.env.TEAM_TOKEN)) return unauthorized();
			if (!current) return new Response("No data uploaded yet; run `uv run devpost push`", { status: 503 });
			return mcp.fetch(request);
		},
	},
	fetch: () => new Response("Not found", { status: 404 }),
});

console.log(`devpost-mcp listening on ${server.url} with ${current ? DB_PATH : "no database yet"}`);
