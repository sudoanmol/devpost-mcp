// Score a hackathon idea against what already exists on Devpost.
//
// The score covers only what past data can measure: how novel the idea is, how crowded its space is,
// whether projects like it tend to win, and how well it fits the target hackathon's prize tracks.
// Feasibility, demo quality and impact stay with the agent, which gets the hackathon's own judging
// criteria and the targeted sponsors' briefs to rate them against.

import { getHackathon, projectHit, searchProjects, type ProjectHit } from "./db";

// ponytail: lexical TF-IDF misses paraphrases ("ASL" vs "sign language"); swap in embeddings if that bites
const STOP = new Set(
	("a an and are as at be by for from has have in into is it its of on or our that the their this to " +
		"using use uses with we you your can will app platform tool help helps based which who what users user " +
		"built build make makes made new more also all not via any one through").split(" "),
);

const singular = (w: string) => (w.length > 4 && /^[a-z]+$/.test(w) && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

export function tokens(text: string): string[] {
	return (text.toLowerCase().match(/[a-z0-9][a-z0-9.+#]*/g) ?? []).filter((w) => !STOP.has(w) && w.length > 1).map(singular);
}

type Vec = Map<string, number>;

export function tfidf(docs: string[][]): Vec[] {
	const df = new Map<string, number>();
	for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
	const n = docs.length;
	return docs.map((d) => {
		const tf = new Map<string, number>();
		for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
		const v: Vec = new Map();
		for (const [t, c] of tf) v.set(t, (c / d.length) * (Math.log((1 + n) / (1 + df.get(t)!)) + 1));
		const norm = Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0)) || 1;
		for (const [t, x] of v) v.set(t, x / norm);
		return v;
	});
}

export function cosine(a: Vec, b: Vec): number {
	let s = 0;
	for (const [t, x] of a) s += x * (b.get(t) ?? 0);
	return s;
}

/** TF-IDF similarity between an idea and short taglines rarely passes ~0.4; map [0, fullAt] onto [0, 100]. */
export const scaled = (sim: number, fullAt: number) => Math.round(100 * Math.min(1, sim / fullAt));

const projectText = (p: ProjectHit) => `${p.name} ${p.tagline ?? ""} ${(p.built_with ? JSON.parse(p.built_with) : []).join(" ")}`;
const matches = (sponsor: string, title: string) => title.toLowerCase().includes(sponsor.toLowerCase());

export async function scoreIdea(db: D1Database, idea: string, queries: string[], hackathonUrl?: string, sponsors?: string[]) {
	if (sponsors?.length && !hackathonUrl) throw new Error("sponsors needs hackathon_url: sponsor tracks are read from that hackathon's prizes");
	const searches = queries.length ? queries : [tokens(idea).slice(0, 4).join(" ")];
	// "any" mode casts a wide net; TF-IDF below decides what is actually close
	const hits = (await Promise.all(searches.map((q) => searchProjects(db, q, { mode: "any", winnersOnly: false, limit: 100 })))).flat();
	const corpus = [...new Map(hits.map((p) => [p.slug, p])).values()];
	const hackathon = hackathonUrl ? await getHackathon(db, hackathonUrl) : null;
	if (hackathonUrl && !hackathon) throw new Error(`no hackathon at ${hackathonUrl} in the index; find it with search_hackathons`);

	let prizes = (hackathon?.prizes ?? []) as { title: string; value: string; description: string }[];
	const unmatched = sponsors?.filter((sp) => !prizes.some((p) => matches(sp, p.title))) ?? [];
	// the user is targeting these sponsors, so fit and criteria come from their tracks only
	if (sponsors?.length) prizes = prizes.filter((p) => sponsors.some((sp) => matches(sp, p.title)));

	const vecs = tfidf([tokens(idea), ...corpus.map((p) => tokens(projectText(p))), ...prizes.map((p) => tokens(`${p.title} ${p.description}`))]);
	const ideaVec = vecs[0]!;
	const ranked = corpus.map((p, i) => ({ sim: cosine(ideaVec, vecs[1 + i]!), p })).sort((a, b) => b.sim - a.sim);
	const top = ranked.slice(0, 10);
	const top5 = top.slice(0, 5);

	// closest match and the next four both count: one twin hurts, a crowd of near-twins hurts more
	const closeness = top.length ? 0.5 * top[0]!.sim + (0.5 * top5.reduce((s, x) => s + x.sim, 0)) / top5.length : 0;
	const novelty = 100 - scaled(closeness, 0.3);
	const provenSpace = top.length ? Math.round((100 * top.filter((x) => x.p.winner).length) / top.length) : 0;
	const fits = prizes.map((p, i) => ({ sim: cosine(ideaVec, vecs[1 + corpus.length + i]!), p })).sort((a, b) => b.sim - a.sim);
	const sponsorFit = fits.length ? scaled(fits[0]!.sim, 0.3) : null;

	const weights = { novelty: 0.5, proven_space: 0.3, sponsor_fit: 0.2 };
	const parts = { novelty, proven_space: provenSpace, sponsor_fit: sponsorFit };
	const used = Object.entries(weights).filter(([k]) => parts[k as keyof typeof parts] !== null);
	const total = used.reduce((s, [, w]) => s + w, 0);
	const signalScore = Math.round(used.reduce((s, [k, w]) => s + (parts[k as keyof typeof parts] ?? 0) * w, 0) / total);

	return {
		signal_score: signalScore,
		components: { ...parts, weights: Object.fromEntries(used) },
		interpretation: {
			novelty: "100 = nothing close on Devpost; low = near-duplicate exists (see closest_projects)",
			proven_space: "share of the 10 closest projects that won a prize",
			sponsor_fit: "match against the best-fitting prize track (the given sponsors' tracks if any; null if no hackathon)",
			sweet_spot: "high novelty with high proven_space: an under-built angle in a space judges reward",
		},
		crowding: {
			similar_projects: ranked.filter((x) => x.sim >= 0.15).length,
			corpus_size: corpus.length,
			corpus_winner_rate: corpus.length ? Math.round((100 * corpus.filter((p) => p.winner).length) / corpus.length) / 100 : 0,
		},
		closest_projects: top5.map((x) => ({ ...projectHit(x.p), similarity: Math.round(x.sim * 100) / 100 })),
		best_prize_tracks: (sponsors?.length ? fits : fits.slice(0, 3)).map((x) => ({
			prize: x.p.title,
			value: x.p.value,
			fit: scaled(x.sim, 0.3),
			brief: x.p.description,
		})),
		judge_yourself: {
			hackathon_criteria: hackathon?.judging_criteria ?? [],
			sponsor_criteria: sponsors?.length
				? "each best_prize_tracks brief is the sponsor's own challenge and judging criteria"
				: "pass sponsors=[...] to get the full brief of every track those sponsors run",
			unmatched_sponsors: unmatched,
			note: "Rate feasibility in the time limit, demo-ability, and impact against both sets of criteria; past data can't.",
		},
		queries_used: searches,
	};
}
