// Score a hackathon idea against what already exists on Devpost.
//
// The score covers only what past data can measure: how novel the idea is, whether projects like it
// win more often than projects in general, and how well it fits the target hackathon's prize tracks.
// Feasibility, demo quality and impact stay with the agent, which gets the hackathon's own judging
// criteria and the targeted sponsors' briefs to rate them against.

import type { Database } from "bun:sqlite";
import { getHackathon, projectHit, projectsBySlug, searchProjects, sponsorKey, sponsorProfile, titleSponsor, winnerBaseline, type Track } from "./db";
import { dot, embed, nearest, similarity, type VectorIndex } from "./embeddings";

// words that say nothing about what a project does: dropped from keyword searches and topic labels
const STOP = new Set(
	("a an and are as at be by for from has have in into is it its of on or our that the their this to " +
		"using use uses with we you your can will app platform tool help helps based which who what users user " +
		"built build make makes made new more also all not via any one through").split(" "),
);

const singular = (w: string) => (w.length > 4 && /^[a-z]+$/.test(w) && /[^su]s$/.test(w) && !w.endsWith("is") ? w.slice(0, -1) : w);

export function tokens(text: string): string[] {
	return (text.toLowerCase().match(/[a-z0-9][a-z0-9.+#]*/g) ?? []).filter((w) => !STOP.has(w) && w.length > 1).map(singular);
}

/** Map a similarity in [zeroAt, fullAt] onto 0..100. */
export const scaled = (sim: number, zeroAt: number, fullAt: number) => Math.round(100 * Math.min(1, Math.max(0, (sim - zeroAt) / (fullAt - zeroAt))));

// bge-small packs cosine similarity into a narrow band. Measured on the index: random project pairs have a
// median of 0.52 (99% under 0.69), same-domain projects 0.72-0.76, the same idea from another angle 0.78-0.82,
// near-twins 0.84-0.89. Idea vs a track brief: a real sponsor match ~0.80, an unrelated idea's best track ~0.58.
const NOVELTY = { zeroAt: 0.72, fullAt: 0.87 }; // closeness: 0.72 or less = novelty 100, 0.87 or more = novelty 0
const SIMILAR = 0.78; // what counts as "a similar project" for crowding and winner lift
const FIT = { zeroAt: 0.55, fullAt: 0.8 };
const NEIGHBOURS = 200; // similar_projects counts at most this many

const matches = (sponsor: string, t: { track: string; prizes: Pick<Track["prizes"][number], "title">[] }) =>
	[t.track, ...t.prizes.map((p) => p.title)].some((title) => title.toLowerCase().includes(sponsor.toLowerCase()));

export type IdeaInput = { idea: string; queries: string[] };
export type Weights = { novelty: number; proven_space: number; sponsor_fit: number };
export type ExtraTrack = { title: string; brief: string };

export const DEFAULT_WEIGHTS: Weights = { novelty: 0.5, proven_space: 0.3, sponsor_fit: 0.2 };
const THIN_BRIEF = 150; // shorter than this and the brief can't carry a text match on its own

/** Similarity-weighted winner rate of the nearest projects, as a multiple of the index-wide rate. */
export function winnerLift(near: { sim: number; winner: boolean }[], baseline: number): number | null {
	const weight = near.reduce((s, x) => s + x.sim, 0);
	if (near.length < 5 || !weight || !baseline) return null;
	return near.reduce((s, x) => s + x.sim * (x.winner ? 1 : 0), 0) / weight / baseline;
}

/** Every track the ideas are scored against, with the text fit is measured on. */
async function targetTracks(db: Database, hackathonUrl: string | undefined, sponsors: string[], extra: ExtraTrack[]) {
	const hackathon = hackathonUrl ? await getHackathon(db, hackathonUrl) : null;
	if (hackathonUrl && !hackathon) throw new Error(`no hackathon at ${hackathonUrl} in the index; find it with search_hackathons`);
	const all = hackathon?.tracks ?? [];
	const chosen = sponsors.length ? all.filter((t) => sponsors.some((sp) => matches(sp, t))) : all;
	const listed = [
		...chosen.map((t) => ({ ...t, source: "devpost" as const })),
		...extra.map((x) => ({ track: x.title, prizes: [], winner_slots: null, entrants: null, entrants_per_slot: null, challenge: x.brief, source: "user" as const })),
	];
	// a sponsor's past briefs and winners stand in for a brief that's empty or one line long
	const profiles = new Map<string, Promise<Awaited<ReturnType<typeof sponsorProfile>>>>();
	const profile = (sponsor: string) => {
		const key = sponsorKey(sponsor).toLowerCase();
		if (!profiles.has(key)) profiles.set(key, sponsorProfile(db, sponsor));
		return profiles.get(key)!;
	};
	const withText = await Promise.all(
		listed.map(async (t) => {
			const targeted = sponsors.find((sp) => matches(sp, t));
			const sponsor = targeted ?? titleSponsor(t.track);
			// profiles cost a scan of prizes, so fetch one only when it's asked for or the brief needs it
			const p = sponsor && (targeted || t.challenge.length < THIN_BRIEF) ? await profile(sponsor) : null;
			const thin = t.challenge.length < THIN_BRIEF && !!p?.text;
			return {
				...t,
				past_entrants_per_slot: p?.past_entrants_per_slot ?? null,
				fit_basis: thin ? "this sponsor's past briefs and winners (this brief is too short to match on)" : "this brief",
				text: `${t.track} ${t.challenge} ${thin ? p!.text : ""}`,
			};
		}),
	);
	const vecs = await embed(withText.map((t) => t.text.slice(0, 2000)));
	return {
		hackathon,
		tracks: withText.map((t, i) => ({ ...t, vec: vecs[i]! })),
		unmatched: sponsors.filter((sp) => !all.some((t) => matches(sp, t)) && !extra.some((x) => x.title.toLowerCase().includes(sp.toLowerCase()))),
	};
}

type Target = Awaited<ReturnType<typeof targetTracks>>["tracks"][number];

async function scoreOne(db: Database, index: VectorIndex, input: IdeaInput, targets: Target[], baseline: number, weights: Weights) {
	const [ideaVec] = await embed([input.idea]);
	// neighbours by meaning, plus keyword hits for exact names (a sponsor's SDK, a niche device) the vectors may blur
	const close = new Map(nearest(index, ideaVec!, NEIGHBOURS).map((x) => [x.slug, x.sim]));
	const keywordHits = (
		await Promise.all(input.queries.map((q) => searchProjects(db, tokens(q).join(" "), { mode: "any", winnersOnly: false, limit: 50 })))
	).flat();
	for (const p of keywordHits) {
		const i = index.position.get(p.slug);
		if (i !== undefined && !close.has(p.slug)) close.set(p.slug, similarity(index, i, ideaVec!));
	}
	const ranked = [...close].map(([slug, sim]) => ({ slug, sim, winner: !!index.winner[index.position.get(slug)!] })).sort((a, b) => b.sim - a.sim);
	const top5 = ranked.slice(0, 5);

	// closest match and the next four both count: one twin hurts, a crowd of near-twins hurts more
	const closeness = top5.length ? 0.5 * top5[0]!.sim + (0.5 * top5.reduce((s, x) => s + x.sim, 0)) / top5.length : 0;
	const novelty = 100 - scaled(closeness, NOVELTY.zeroAt, NOVELTY.fullAt);
	const similar = ranked.filter((x) => x.sim >= SIMILAR);
	const lift = winnerLift(similar.slice(0, 20), baseline);
	const provenSpace = lift === null ? null : Math.min(100, Math.round(50 * lift));
	const fits = targets.map((t) => ({ fit: scaled(dot(ideaVec!, t.vec), FIT.zeroAt, FIT.fullAt), track: t.track })).sort((a, b) => b.fit - a.fit);
	const sponsorFit = fits.length ? fits[0]!.fit : null;

	const parts = { novelty, proven_space: provenSpace, sponsor_fit: sponsorFit };
	const used = (Object.keys(weights) as (keyof Weights)[]).filter((k) => parts[k] !== null && weights[k] > 0);
	const total = used.reduce((s, k) => s + weights[k], 0);
	const signalScore = total ? Math.round(used.reduce((s, k) => s + parts[k]! * weights[k], 0) / total) : 0;

	// a cluster from one themed event is a different signal from the same idea at many general hackathons
	const rows = await projectsBySlug(db, [...new Set([...top5, ...similar.slice(0, 40)].map((x) => x.slug))]);
	const byEvent = new Map<string, number>();
	for (const x of similar.slice(0, 40)) for (const h of new Set(rows.get(x.slug)?.hackathons?.split(" | ") ?? [])) byEvent.set(h, (byEvent.get(h) ?? 0) + 1);
	const [cluster] = [...byEvent].sort((a, b) => b[1] - a[1]);

	return {
		idea: input.idea.length > 140 ? `${input.idea.slice(0, 140)}…` : input.idea,
		signal_score: signalScore,
		components: parts,
		winner_lift: lift === null ? null : Math.round(lift * 10) / 10,
		crowding: {
			similar_projects: similar.length,
			distinct_hackathons: byEvent.size,
			biggest_cluster: cluster && cluster[1] > 1 ? { hackathon: cluster[0], projects: cluster[1] } : null,
		},
		closest_projects: ranked.slice(0, 3).flatMap((x) => {
			const row = rows.get(x.slug);
			return row ? [{ ...projectHit(row), similarity: Math.round(x.sim * 100) / 100 }] : [];
		}),
		best_tracks: fits.slice(0, 3),
	};
}

export async function scoreIdeas(
	db: Database,
	index: VectorIndex,
	opts: { ideas: IdeaInput[]; hackathonUrl?: string; sponsors: string[]; extraTracks: ExtraTrack[]; weights: Weights },
) {
	if (opts.sponsors.length && !opts.hackathonUrl) throw new Error("sponsors needs hackathon_url: sponsor tracks are read from that hackathon's prizes");
	const [{ hackathon, tracks, unmatched }, baseline] = await Promise.all([
		targetTracks(db, opts.hackathonUrl, opts.sponsors, opts.extraTracks),
		winnerBaseline(db),
	]);
	const ranking = (await Promise.all(opts.ideas.map((i) => scoreOne(db, index, i, tracks, baseline, opts.weights)))).sort((a, b) => b.signal_score - a.signal_score);

	// briefs go out once for the whole batch: every targeted track, or just the ones some idea fits best
	const shown = new Set(opts.sponsors.length || opts.extraTracks.length ? tracks.map((t) => t.track) : ranking.flatMap((r) => r.best_tracks.map((b) => b.track)));
	return {
		ranking,
		context: {
			hackathon: hackathon ? { title: hackathon.title, url: hackathon.url, judging_criteria: hackathon.judging_criteria } : null,
			tracks: tracks.filter((t) => shown.has(t.track)).map(({ text: _, vec: __, ...t }) => t),
			unmatched_sponsors: unmatched,
			baseline_winner_rate: Math.round(baseline * 1000) / 1000,
			weights: opts.weights,
			interpretation: {
				novelty: "100 = nothing close on Devpost by meaning; low = a near-duplicate exists (see closest_projects)",
				proven_space: "50 = projects like this win at the index-wide rate, 100 = at twice that or more; null = fewer than 5 similar projects, too few to say",
				winner_lift: "similarity-weighted winner rate of the similar projects divided by baseline_winner_rate",
				sponsor_fit: "meaning match against the best-fitting track (fit_basis says what it was matched on); null without tracks",
				crowding: "similar_projects counts projects at similarity 0.78+ (capped at 200); biggest_cluster set means many came from one event, often a themed one",
				competition: "entrants_per_slot is from Devpost's per-prize opt-ins; past_entrants_per_slot is the median over this sponsor's past tracks",
				sweet_spot: "high novelty with high proven_space: an under-built angle in a space judges reward",
			},
			judge_yourself:
				"Each track's challenge is the sponsor's own brief and criteria. Rate feasibility in the time limit, demo-ability and impact against those and the hackathon's judging_criteria; past data can't.",
		},
	};
}
