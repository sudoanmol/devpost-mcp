// The shared server on Railway: MCP over HTTP for the team, plus PUT /db for the crawler's uploads.

import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { renameSync, rmSync } from "node:fs";
import { createMcpHandler } from "@modelcontextprotocol/server";
import * as db from "./db";
import { embed } from "./embeddings";
import { createServer, open } from "./tools";

function authorized(request: Request, token: string | undefined): boolean {
	if (!token) return false;
	const given = Buffer.from(request.headers.get("Authorization") ?? "");
	const expected = Buffer.from(`Bearer ${token}`);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

const DB_PATH = process.env.DB_PATH ?? "devpost.db";
let current = open(DB_PATH);
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
	current = open(DB_PATH);
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
