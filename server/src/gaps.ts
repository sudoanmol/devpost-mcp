// Open spaces: topics (groups of projects with similar meaning, built by build-index.ts) where winners are
// common but few teams build, topics that are growing, and topics that are crowded.

import type { Database } from "bun:sqlite";
import { sponsorKey, sponsorSql, winnerBaseline } from "./db";
import { DIMS, embed } from "./embeddings";

const MIN_SIZE = 20; // smaller topics are too few projects for a winner rate to mean anything

type TopicRow = { id: number; size: number; winners: number; recent: number; label: string; centroid: Uint8Array; examples: string; top_winners: string };

export type GapSort = "underbuilt" | "best_odds" | "rising" | "crowded";

export async function findGaps(db: Database, opts: { theme?: string; sponsor?: string; sort: GapSort; limit: number }) {
	const rows = db.query("SELECT * FROM topics").all() as TopicRow[];
	const baseline = await winnerBaseline(db);
	const projects = rows.reduce((s, t) => s + t.size, 0);
	const recentShare = rows.reduce((s, t) => s + t.recent, 0) / (projects || 1);

	let topics = rows.map((t) => ({
		topic: t.id,
		label: t.label,
		projects: t.size,
		winners: t.winners,
		winner_lift: t.size >= MIN_SIZE && baseline ? Math.round((t.winners / t.size / baseline) * 10) / 10 : null,
		growth: t.size >= MIN_SIZE && recentShare ? Math.round((t.recent / t.size / recentShare) * 10) / 10 : null,
		theme_similarity: null as number | null,
		sponsor_wins: null as number | null,
		examples: JSON.parse(t.examples),
		top_winners: JSON.parse(t.top_winners),
		centroid: t.centroid,
	}));

	if (opts.theme) {
		const [q] = await embed([opts.theme], "query");
		for (const t of topics) {
			const c = new Int8Array(t.centroid.buffer, t.centroid.byteOffset, DIMS);
			t.theme_similarity = Math.round((c.reduce((s, x, d) => s + x * q![d]!, 0) / 127) * 100) / 100;
		}
		// ponytail: the 25 closest topics count as "about this theme"; widen if themes feel too narrow
		topics = topics.sort((a, b) => b.theme_similarity! - a.theme_similarity!).slice(0, 25);
	}

	if (opts.sponsor) {
		const [match, pattern] = sponsorSql("s.prizes", sponsorKey(opts.sponsor));
		const wins = new Map(
			(
				db
					.query(
						`SELECT pt.topic, COUNT(*) AS wins FROM submissions s JOIN project_topics pt ON pt.slug = s.slug
						 WHERE s.winner = 1 AND ${match} GROUP BY pt.topic`,
					)
					.all(pattern) as { topic: number; wins: number }[]
			).map((r) => [r.topic, r.wins]),
		);
		topics = topics.filter((t) => wins.has(t.topic));
		for (const t of topics) t.sponsor_wins = wins.get(t.topic)!;
	}

	const by = (f: (t: (typeof topics)[number]) => number | null) => (a: (typeof topics)[number], b: (typeof topics)[number]) => (f(b) ?? -1) - (f(a) ?? -1);
	const sorted =
		opts.sort === "underbuilt"
			? topics.filter((t) => (t.winner_lift ?? 0) >= 1.2).sort((a, b) => a.projects - b.projects)
			: opts.sort === "best_odds"
				? topics.sort(by((t) => t.winner_lift))
				: opts.sort === "rising"
					? topics.sort(by((t) => t.growth))
					: topics.sort((a, b) => b.projects - a.projects);

	return {
		baseline_winner_rate: Math.round(baseline * 1000) / 1000,
		topics_considered: topics.length,
		sort: opts.sort,
		topics: sorted.slice(0, opts.limit).map(({ centroid: _, ...t }) => t),
		interpretation: {
			label: "the topic's most distinctive words; read examples and top_winners for what it really is",
			winner_lift: "how often projects in this topic win, as a multiple of baseline_winner_rate; null under 20 projects",
			growth: "share of this topic's projects from the last 12 months vs the index-wide share; above 1 = growing",
			underbuilt: "topics winning at 1.2x baseline or better, smallest first: rewarded spaces few teams attempt",
			sponsor_wins: "wins in this topic of prizes whose title names the sponsor",
		},
	};
}
