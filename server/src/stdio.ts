// MCP over stdio for one person's machine: Claude Desktop or Claude Code starts this when it needs the tools and
// stops it when it quits. It reads the crawl database directly, so there's no upload, token or port.
//   bun /path/to/server/src/stdio.ts        (DB_PATH overrides ../data/devpost.db)

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { embed } from "./embeddings";
import { createServer, open } from "./tools";

const path = process.env.DB_PATH ?? Bun.fileURLToPath(new URL("../../data/devpost.db", import.meta.url));
const loaded = open(path);
if (!loaded) throw new Error(`no database at ${path}; run \`uv run devpost crawl\` first`);
void embed(["warm up"]); // load the model now rather than on the first search
serveStdio(() => createServer(loaded));
