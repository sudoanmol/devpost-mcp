// The shared server on Vercel: MCP over HTTP for the team. The database ships inside each deployment
// (`uv run devpost push` snapshots it and redeploys), so the server only ever reads.

import { timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { embed } from "./embeddings";
import { createServer, open } from "./tools";

function authorized(request: Request, token: string | undefined): boolean {
	if (!token) return false;
	const given = Buffer.from(request.headers.get("Authorization") ?? "");
	const expected = Buffer.from(`Bearer ${token}`);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Vercel caps deployed files at 100 MB, so data/ holds the database as parts; they're joined into /tmp once per instance. */
function databasePath(): string {
	if (process.env.DB_PATH) return process.env.DB_PATH;
	const dir = Bun.fileURLToPath(new URL("../data/", import.meta.url));
	const parts = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("devpost.db.part")).sort() : [];
	if (!parts.length) throw new Error(`no database parts in ${dir}; run \`uv run devpost push\``);
	const joined = "/tmp/devpost.db";
	if (!existsSync(joined)) {
		for (const part of parts) appendFileSync(`${joined}.partial`, readFileSync(dir + part));
		renameSync(`${joined}.partial`, joined);
	}
	return joined;
}

const loaded = open(databasePath())!;
void embed(["warm up"]); // load the model now rather than on the first search
const mcp = createMcpHandler(() => createServer(loaded));

Bun.serve({
	port: Number(process.env.PORT ?? 3000),
	routes: {
		"/health": () => new Response("ok"),
		"/mcp": (request) =>
			authorized(request, process.env.TEAM_TOKEN)
				? mcp.fetch(request)
				: new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } }),
	},
	fetch: () => new Response("Not found", { status: 404 }),
});
