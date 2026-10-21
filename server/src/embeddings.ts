// Meaning-based similarity: every project's name and tagline as a bge-small vector.
//
// build-index.ts writes the vectors into the database; the server loads them into memory once per database
// and compares by brute force. Vectors are unit length, so a dot product is the cosine similarity.

import type { Database } from "bun:sqlite";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const MODEL = "Xenova/bge-small-en-v1.5";
// the model lives in server/models, which deploys with the server: Vercel's filesystem is read-only, so it can't download at runtime
env.cacheDir = Bun.fileURLToPath(new URL("../models", import.meta.url));
export const DIMS = 384;
// bge's instruction for short queries matched against longer passages; ideas and briefs are embedded as-is
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

let extractor: Promise<FeatureExtractionPipeline> | null = null;
const model = () => (extractor ??= pipeline("feature-extraction", MODEL, { dtype: "q8" }));

export async function embed(texts: string[], kind: "query" | "document" = "document"): Promise<Float32Array[]> {
	if (!texts.length) return [];
	const input = kind === "query" ? texts.map((t) => QUERY_PREFIX + t) : texts;
	const out = await (await model())(input, { pooling: "cls", normalize: true });
	const flat = out.data as Float32Array;
	return texts.map((_, i) => flat.slice(i * DIMS, (i + 1) * DIMS));
}

/** Stored as int8 (x * 127): a quarter of the size, and ranking is unaffected. */
export const quantize = (v: Float32Array) => Int8Array.from(v, (x) => Math.round(x * 127));

export type VectorIndex = {
	slugs: string[];
	vectors: Int8Array; // slugs.length * DIMS
	winner: Uint8Array;
	lastEnded: (string | null)[];
	position: Map<string, number>;
};

export function loadIndex(db: Database): VectorIndex {
	const rows = db
		.query(
			`SELECT e.slug, e.vec, MAX(s.winner) AS winner, MAX(h.ends_on) AS last_ended FROM embeddings e
			 LEFT JOIN submissions s ON s.slug = e.slug LEFT JOIN hackathons h ON h.id = s.hackathon_id GROUP BY e.slug`,
		)
		.all() as { slug: string; vec: Uint8Array; winner: number | null; last_ended: string | null }[];
	const vectors = new Int8Array(rows.length * DIMS);
	rows.forEach((r, i) => vectors.set(new Int8Array(r.vec.buffer, r.vec.byteOffset, DIMS), i * DIMS));
	return {
		slugs: rows.map((r) => r.slug),
		vectors,
		winner: Uint8Array.from(rows, (r) => r.winner ?? 0),
		lastEnded: rows.map((r) => r.last_ended),
		position: new Map(rows.map((r, i) => [r.slug, i])),
	};
}

export function similarity(index: VectorIndex, i: number, q: Float32Array): number {
	let s = 0;
	const o = i * DIMS;
	for (let d = 0; d < DIMS; d++) s += index.vectors[o + d]! * q[d]!;
	return s / 127;
}

/** The k projects closest to q, best first. */
// ponytail: brute-force scan, ~50ms over 127k projects; swap in an ANN index if the corpus grows 10x
export function nearest(index: VectorIndex, q: Float32Array, k: number, keep?: (i: number) => boolean) {
	const top: { i: number; sim: number }[] = [];
	for (let i = 0; i < index.slugs.length; i++) {
		if (keep && !keep(i)) continue;
		const sim = similarity(index, i, q);
		if (top.length < k) {
			top.push({ i, sim });
			if (top.length === k) top.sort((a, b) => b.sim - a.sim);
		} else if (sim > top[k - 1]!.sim) {
			let j = k - 1;
			while (j > 0 && top[j - 1]!.sim < sim) j--;
			top.splice(j, 0, { i, sim });
			top.pop();
		}
	}
	return top.sort((a, b) => b.sim - a.sim).map(({ i, sim }) => ({ slug: index.slugs[i]!, sim }));
}

export const dot = (a: Float32Array, b: Float32Array) => {
	let s = 0;
	for (let d = 0; d < a.length; d++) s += a[d]! * b[d]!;
	return s;
};
