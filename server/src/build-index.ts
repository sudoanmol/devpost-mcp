// Adds meaning-based search data to the crawl database: run by `uv run devpost crawl`, or directly with
//   bun run index ../data/devpost.db
//
// 1. Embeds every project not embedded yet, or embedded by an older recipe.
// 2. Groups all projects into topics with spherical k-means and records, per topic, how many projects it
//    has, how many won, how many are recent, its most distinctive words, and example projects.
//    Topics are rebuilt from scratch each run, so their ids change between runs.

import { Database } from "bun:sqlite";
import { DIMS, embed, loadIndex, quantize } from "./embeddings";
import { tokens } from "./scoring";

const TOPICS = 300;
const SAMPLE = 25_000; // k-means is fit on a sample, then every project is assigned
const ITERATIONS = 12;
const BATCH = 256;
// bump when embedText changes, so every project is re-embedded with the new recipe
const RECIPE = 2;

/** The tagline says what a project does; names ("Lumina", "SignBridge") mostly add noise unless the tagline is thin. */
function embedText(name: string, tagline: string | null): string | null {
	const text = (tagline ?? "").trim().length >= 20 ? tagline!.trim() : `${name}. ${tagline ?? ""}`.trim();
	return tokens(text).length >= 3 ? text : null; // placeholder entries ("." / "test") would form a junk topic
}

const path = process.argv[2];
if (!path) throw new Error("usage: bun run index <path to devpost.db>");
const db = new Database(path);
db.run("PRAGMA journal_mode = DELETE");

// --- 1. embeddings ---------------------------------------------------------

db.run("DELETE FROM embeddings WHERE version != ?", [RECIPE]);
const todo = (
	db.query("SELECT slug, name, tagline FROM projects WHERE slug NOT IN (SELECT slug FROM embeddings)").all() as {
		slug: string;
		name: string;
		tagline: string | null;
	}[]
).flatMap((p) => {
	const text = embedText(p.name, p.tagline);
	return text ? [{ slug: p.slug, text }] : [];
});
const insert = db.prepare("INSERT OR REPLACE INTO embeddings (slug, vec, version) VALUES (?, ?, ?)");
const started = performance.now();
for (let at = 0; at < todo.length; at += BATCH) {
	const batch = todo.slice(at, at + BATCH);
	const vecs = await embed(batch.map((p) => p.text));
	db.transaction(() => batch.forEach((p, i) => insert.run(p.slug, quantize(vecs[i]!), RECIPE)))();
	if ((at / BATCH) % 40 === 0 || at + BATCH >= todo.length) {
		const done = Math.min(at + BATCH, todo.length);
		const rate = done / ((performance.now() - started) / 1000);
		console.log(`embeddings: ${done}/${todo.length}, ${rate.toFixed(0)}/s, ~${((todo.length - done) / rate / 60).toFixed(0)} min left`);
	}
}
if (!todo.length) console.log("embeddings: nothing new");

// --- 2. topics -------------------------------------------------------------

const index = loadIndex(db);
const n = index.slugs.length;
const vectors = Float32Array.from(index.vectors, (x) => x / 127);

// seeded so a re-run on the same data gives the same topics
let seed = 42;
const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
const order = Array.from({ length: n }, (_, i) => i);
for (let i = n - 1; i > 0; i--) {
	const j = Math.floor(random() * (i + 1));
	[order[i], order[j]] = [order[j]!, order[i]!];
}
const sample = order.slice(0, Math.min(SAMPLE, n));
const k = Math.min(TOPICS, sample.length);
const centroids = new Float32Array(k * DIMS);
sample.slice(0, k).forEach((p, c) => centroids.set(vectors.subarray(p * DIMS, (p + 1) * DIMS), c * DIMS));

function closest(p: number): number {
	let best = 0;
	let bestSim = -Infinity;
	for (let c = 0; c < k; c++) {
		let s = 0;
		for (let d = 0; d < DIMS; d++) s += vectors[p * DIMS + d]! * centroids[c * DIMS + d]!;
		if (s > bestSim) [best, bestSim] = [c, s];
	}
	return best;
}

function refit(points: number[], assigned: Int32Array) {
	centroids.fill(0);
	const counts = new Int32Array(k);
	points.forEach((p, i) => {
		const c = assigned[i]!;
		counts[c]!++;
		for (let d = 0; d < DIMS; d++) centroids[c * DIMS + d]! += vectors[p * DIMS + d]!;
	});
	for (let c = 0; c < k; c++) {
		// an emptied topic restarts at a random sample point
		if (!counts[c]) {
			const p = sample[Math.floor(random() * sample.length)]!;
			centroids.set(vectors.subarray(p * DIMS, (p + 1) * DIMS), c * DIMS);
		}
		const v = centroids.subarray(c * DIMS, (c + 1) * DIMS);
		const norm = Math.hypot(...v) || 1;
		for (let d = 0; d < DIMS; d++) v[d]! /= norm;
	}
}

for (let it = 0; it < ITERATIONS; it++) {
	const assigned = Int32Array.from(sample, closest);
	refit(sample, assigned);
	console.log(`topics: iteration ${it + 1}/${ITERATIONS}`);
}
const topicOf = Int32Array.from({ length: n }, (_, p) => closest(p));

const projects = new Map(
	(db.query("SELECT slug, url, name, tagline, likes FROM projects").all() as { slug: string; url: string; name: string; tagline: string | null; likes: number }[]).map(
		(p) => [p.slug, p],
	),
);
const recentCutoff = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
const members: number[][] = Array.from({ length: k }, () => []);
topicOf.forEach((c, p) => members[c]!.push(p));

// distinctive words: common inside the topic, rare across all projects
const words = (p: number) => new Set(tokens(`${projects.get(index.slugs[p]!)?.name ?? ""} ${projects.get(index.slugs[p]!)?.tagline ?? ""}`));
const df = new Map<string, number>();
const projectWords = Array.from({ length: n }, (_, p) => words(p));
for (const ws of projectWords) for (const w of ws) df.set(w, (df.get(w) ?? 0) + 1);

const show = (p: number) => {
	const slug = index.slugs[p]!;
	const proj = projects.get(slug);
	return { name: proj?.name, tagline: proj?.tagline, url: proj?.url, winner: !!index.winner[p] };
};

db.transaction(() => {
	db.run("DELETE FROM topics; DELETE FROM project_topics;");
	const topicRow = db.prepare("INSERT INTO topics (id, size, winners, recent, label, centroid, examples, top_winners) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
	const memberRow = db.prepare("INSERT INTO project_topics (slug, topic) VALUES (?, ?)");
	members.forEach((ps, c) => {
		if (!ps.length) return;
		const tf = new Map<string, number>();
		for (const p of ps) for (const w of projectWords[p]!) tf.set(w, (tf.get(w) ?? 0) + 1);
		const label = [...tf]
			.filter(([, count]) => count >= 3)
			.map(([w, count]) => [w, (count / ps.length) * Math.log(n / df.get(w)!)] as const)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 6)
			.map(([w]) => w);
		const centroid = centroids.subarray(c * DIMS, (c + 1) * DIMS);
		const central = [...ps]
			.map((p) => ({ p, sim: vectors.subarray(p * DIMS, (p + 1) * DIMS).reduce((s, x, d) => s + x * centroid[d]!, 0) }))
			.sort((a, b) => b.sim - a.sim)
			.slice(0, 5)
			.map(({ p }) => show(p));
		const topWinners = ps
			.filter((p) => index.winner[p])
			.sort((a, b) => (projects.get(index.slugs[b]!)?.likes ?? 0) - (projects.get(index.slugs[a]!)?.likes ?? 0))
			.slice(0, 3)
			.map(show);
		topicRow.run(
			c,
			ps.length,
			ps.filter((p) => index.winner[p]).length,
			ps.filter((p) => (index.lastEnded[p] ?? "") >= recentCutoff).length,
			label.join(", "),
			quantize(centroid),
			JSON.stringify(central),
			JSON.stringify(topWinners),
		);
		for (const p of ps) memberRow.run(index.slugs[p]!, c);
	});
})();
console.log(`topics: ${members.filter((m) => m.length).length} topics over ${n} projects`);
