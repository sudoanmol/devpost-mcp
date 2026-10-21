// Read-only queries over the crawled index of Devpost and Plume (schema.sql at the repo root).

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { embed, nearest, type VectorIndex } from "./embeddings";

type Row = Record<string, unknown>;

const json = (v: unknown) => (typeof v === "string" && v ? JSON.parse(v) : v ?? null);

/** The URL a hackathon is stored under, whatever page of it was pasted: a Devpost subdomain, or Plume's gallery for one event. */
export function hackathonRoot(url: string): string {
	const u = new URL(url.includes("://") ? url : `https://${url}`);
	if (u.host === "plume.hackmit.org") return `https://${u.host}/gallery?hackathon_id=${u.searchParams.get("hackathon_id") ?? ""}`;
	return `https://${u.host}`;
}

export function projectSlug(urlOrSlug: string): string {
	return urlOrSlug.replace(/\/+$/, "").split("/").pop() ?? urlOrSlug;
}

/** Turn free text into an FTS5 query of quoted terms, so user input can't break MATCH syntax. */
export function ftsQuery(text: string, mode: "all" | "any"): string | null {
	const terms = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#]*/gu) ?? [];
	return terms.length ? terms.map((t) => `"${t}"`).join(mode === "all" ? " " : " OR ") : null;
}

async function all<T = Row>(db: Database, sql: string, ...params: unknown[]): Promise<T[]> {
	return db.query(sql).all(...(params as SQLQueryBindings[])) as T[];
}

function hackathon(h: Row) {
	return {
		title: h.title,
		url: h.url,
		source: h.source,
		organization: h.organization,
		dates: h.dates,
		ends_on: h.ends_on,
		status: h.status,
		location: h.location,
		themes: json(h.themes),
		prize_total: h.prize_total,
		registrations: h.registrations,
		submissions: h.submissions,
		winners_announced: !!h.winners_announced,
	};
}

export type HackathonFilters = {
	query?: string;
	status?: string;
	sponsor?: string;
	theme?: string;
	ended_after?: string;
	ended_before?: string;
	sort?: "newest" | "largest";
	limit: number;
	offset: number;
};

export async function searchHackathons(db: Database, f: HackathonFilters) {
	const where: string[] = [];
	const params: unknown[] = [];
	const add = (clause: string, ...values: unknown[]) => {
		where.push(clause);
		params.push(...values);
	};
	if (f.query) add("(title LIKE ? OR organization LIKE ?)", `%${f.query}%`, `%${f.query}%`);
	if (f.status) add("status = ?", f.status);
	if (f.theme) add("themes LIKE ?", `%${f.theme}%`);
	if (f.ended_after) add("ends_on >= ?", f.ended_after);
	if (f.ended_before) add("ends_on <= ?", f.ended_before);
	if (f.sponsor) add("id IN (SELECT hackathon_id FROM prizes WHERE title LIKE ?)", `%${f.sponsor}%`);
	const order = f.sort === "largest" ? "registrations DESC" : "ends_on DESC";
	const sql = `SELECT * FROM hackathons ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ? OFFSET ?`;
	const rows = await all(db, sql, ...params, f.limit, f.offset);
	return { returned: rows.length, offset: f.offset, hackathons: rows.map(hackathon) };
}

export type PrizeRow = { title: string; value: string | null; winners: string | null; description: string | null; entrants: number | null };
const PRIZE_COLUMNS = "title, value, winners, description, entrants";

/** "[Creao AI] 2nd Place Best AI-First Disruptor" -> "[Creao AI] Best AI-First Disruptor"; "Education (Winner)" -> "Education" */
export function trackName(title: string): string {
	return title
		.replace(/\s*\([^()]*\b(?:place|winner|runner-up|mention|prize)\b[^()]*\)\s*$/i, "")
		.replace(/\b(?:1st|2nd|3rd|\d+th|first|second|third)\s+place\b/gi, "")
		.replace(/\(\s*\)/g, "")
		.replace(/\s+/g, " ")
		.replace(/\s+([:,])/g, "$1")
		.replace(/[\s:\-–|,]+$/, "")
		.trim();
}

const dollars = (s: string | null | undefined) => {
	const m = s?.match(/\$\s?([\d,]+)/);
	return m ? Number(m[1]!.replace(/,/g, "")) : null;
};

/** Devpost's listed value is whatever the organizer typed; flag it when the brief states a different cash amount. */
export function cashInBrief(p: Pick<PrizeRow, "value" | "description">): string | null {
	const stated = p.description?.match(/\$\s?[\d,]+(?=\s*(?:usd\s*)?(?:in\s+)?cash)/i)?.[0] ?? null;
	return stated && dollars(stated) !== dollars(p.value) ? stated.replace(/\s/g, "") : null;
}

const slots = (winners: string | null) => parseInt(winners ?? "") || 1;

/** One row per track: the 1st/2nd/3rd place prizes of a track share a brief, so they collapse together. */
export function tracks(prizes: PrizeRow[]) {
	const groups = new Map<string, PrizeRow[]>();
	for (const p of prizes) groups.set(trackName(p.title), [...(groups.get(trackName(p.title)) ?? []), p]);
	return [...groups].map(([track, ps]) => {
		const winnerSlots = ps.reduce((s, p) => s + slots(p.winners), 0);
		// each placement is its own opt-in prize on Devpost; teams usually tick all of a track's placements
		const entrants = ps.some((p) => p.entrants !== null) ? Math.max(...ps.map((p) => p.entrants ?? 0)) : null;
		return {
			track,
			prizes: ps.map((p) => {
				const cash = cashInBrief(p);
				return { title: p.title, value: p.value || null, ...(cash ? { cash_in_brief: cash } : {}) };
			}),
			winner_slots: winnerSlots,
			entrants,
			entrants_per_slot: entrants ? Math.round((10 * entrants) / winnerSlots) / 10 : null,
			challenge: ps.find((p) => p.description)?.description ?? "",
		};
	});
}

export type Track = ReturnType<typeof tracks>[number];

export async function getHackathon(db: Database, url: string) {
	const root = hackathonRoot(url);
	const [h] = await all(db, "SELECT * FROM hackathons WHERE url = ?", root);
	if (!h) return null;
	const prizes = await all<PrizeRow>(db, `SELECT ${PRIZE_COLUMNS} FROM prizes WHERE hackathon_id = ? ORDER BY id`, h.id);
	return {
		...hackathon(h),
		tagline: h.tagline,
		description: h.description,
		judging_criteria: (json(h.judging_criteria) ?? []) as { criterion: string; description: string }[],
		tracks: tracks(prizes),
	};
}

export async function listProjects(db: Database, url: string, winnersOnly: boolean, limit: number, offset: number) {
	const root = hackathonRoot(url);
	const rows = await all(
		db,
		`SELECT p.url, p.name, p.tagline, p.likes, s.winner, s.prizes FROM submissions s
		 JOIN hackathons h ON h.id = s.hackathon_id JOIN projects p ON p.slug = s.slug
		 WHERE h.url = ? ${winnersOnly ? "AND s.winner = 1" : ""}
		 ORDER BY s.winner DESC, p.likes DESC LIMIT ? OFFSET ?`,
		root,
		limit,
		offset,
	);
	return {
		hackathon: root,
		returned: rows.length,
		offset,
		projects: rows.map((r) => ({
			name: r.name,
			tagline: r.tagline,
			url: r.url,
			winner: !!r.winner,
			prizes: json(r.prizes),
			likes: r.likes,
		})),
	};
}

type WinnerRow = { url: string; name: string; tagline: string; built_with: string | null; prizes: string | null; description: string | null };
const WINNER_COLUMNS = "p.url, p.name, p.tagline, p.built_with, p.description, s.prizes";

const winner = (r: WinnerRow, prizes: string[] | null) => ({
	name: r.name,
	tagline: r.tagline,
	url: r.url,
	built_with: json(r.built_with),
	prizes,
});

export async function getWinners(db: Database, url: string, sponsor?: string) {
	const root = hackathonRoot(url);
	const [h] = await all<{ id: number; title: string; dates: string }>(db, "SELECT id, title, dates FROM hackathons WHERE url = ?", root);
	if (!h) return null;
	const winners = await all<WinnerRow>(
		db,
		`SELECT ${WINNER_COLUMNS} FROM submissions s JOIN projects p ON p.slug = s.slug
		 WHERE s.hackathon_id = ? AND s.winner = 1 ORDER BY p.likes DESC`,
		h.id,
	);
	if (!sponsor) {
		return { hackathon: h.title, url: root, dates: h.dates, returned: winners.length, winners: winners.map((w) => winner(w, json(w.prizes))) };
	}
	return { hackathon: h.title, url: root, dates: h.dates, sponsor, tracks: await sponsorTracks(db, h.id, sponsor, winners) };
}

/** "Fetch.ai" -> "Fetch": the part every spelling of a sponsor shares ("Fetch AI", "[Fetch.ai]"). */
export function sponsorKey(sponsor: string): string {
	return sponsor.split(/[\s.:[\]()]+/).find((w) => w.length >= 3) ?? sponsor;
}

/** The sponsor a track title names: "[Creao AI] ..." or "Fetch AI: ..."; null for "Best Overall". */
export function titleSponsor(title: string): string | null {
	return title.match(/^\[([^\]]+)\]/)?.[1] ?? title.match(/^([^:]{2,40}):/)?.[1] ?? null;
}

/** Sentences of a write-up that mention the sponsor: how the project actually used it. */
export function mentions(text: string | null, sponsor: string): string[] {
	const key = sponsorKey(sponsor).toLowerCase();
	return (text ?? "")
		.split(/(?<=[.!?])\s+|\n+/)
		.filter((s) => s.toLowerCase().includes(key))
		.slice(0, 3)
		.map((s) => s.trim().slice(0, 300));
}

async function sponsorTracks(db: Database, hackathonId: number, sponsor: string, winners: WinnerRow[]) {
	const prizes = await all<PrizeRow>(
		db,
		`SELECT ${PRIZE_COLUMNS} FROM prizes WHERE hackathon_id = ? AND title LIKE ? ORDER BY id`,
		hackathonId,
		`%${sponsor}%`,
	);
	const norm = (s: string) => s.toLowerCase().replace(/\W+/g, "");
	return tracks(prizes).map((t) => ({
		...t,
		winners: winners.flatMap((w) => {
			const won = (json(w.prizes) as string[] | null)?.filter((p) => t.prizes.some((prize) => norm(prize.title) === norm(p))) ?? [];
			return won.length ? [{ ...winner(w, won), sponsor_usage: mentions(w.description, sponsor) }] : [];
		}),
	}));
}

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)]! : null;
};

/** What a sponsor has asked for and rewarded before, and how crowded its tracks were. */
export async function sponsorProfile(db: Database, sponsor: string) {
	// one pass over prizes, then winners through the (hackathon_id, winner) index
	const past = await all<PrizeRow & { hackathon_id: number }>(
		db,
		`SELECT p.title, p.value, p.winners, p.description, p.entrants, p.hackathon_id FROM prizes p JOIN hackathons h ON h.id = p.hackathon_id
		 WHERE p.title LIKE ? AND h.winners_announced = 1 ORDER BY h.ends_on DESC LIMIT 30`,
		`%${sponsorKey(sponsor)}%`,
	);
	const ids = [...new Set(past.map((p) => p.hackathon_id))];
	const winners = ids.length
		? await all<{ name: string; tagline: string | null; prizes: string | null }>(
				db,
				`SELECT pr.name, pr.tagline, s.prizes FROM submissions s JOIN projects pr ON pr.slug = s.slug
				 WHERE s.winner = 1 AND s.hackathon_id IN (${ids.map(() => "?").join(", ")})`,
				...ids,
			)
		: [];
	const titles = new Set(past.map((p) => p.title));
	const briefs = [...new Set(past.flatMap((p) => (p.description && p.description.length > 80 ? [p.description] : [])))].slice(0, 6);
	const won = winners.filter((w) => (json(w.prizes) as string[] | null)?.some((t) => titles.has(t))).slice(0, 20);
	const counted = past.filter((p) => p.entrants);
	return {
		text: [...briefs, ...won.map((w) => `${w.name} ${w.tagline ?? ""}`)].join("\n"),
		past_tracks_counted: counted.length,
		past_entrants_per_slot: median(counted.map((p) => Math.round((10 * p.entrants!) / slots(p.winners)) / 10)),
	};
}

export async function findSponsorWinners(db: Database, sponsor: string, endedAfter: string | undefined, limit: number) {
	const hackathons = await all<{ id: number; title: string; url: string; dates: string }>(
		db,
		`SELECT id, title, url, dates FROM hackathons
		 WHERE winners_announced = 1 AND id IN (SELECT hackathon_id FROM prizes WHERE title LIKE ?) ${endedAfter ? "AND ends_on >= ?" : ""}
		 ORDER BY ends_on DESC LIMIT ?`,
		...[`%${sponsor}%`, ...(endedAfter ? [endedAfter] : []), limit],
	);
	const results = await Promise.all(
		hackathons.map(async (h) => {
			const winners = await all<WinnerRow>(
				db,
				`SELECT ${WINNER_COLUMNS} FROM submissions s JOIN projects p ON p.slug = s.slug
				 WHERE s.hackathon_id = ? AND s.winner = 1`,
				h.id,
			);
			return { hackathon: h.title, url: h.url, dates: h.dates, tracks: await sponsorTracks(db, h.id, sponsor, winners) };
		}),
	);
	const perSlot = results.flatMap((r) => r.tracks.flatMap((t) => (t.entrants_per_slot ? [t.entrants_per_slot] : [])));
	return { sponsor, hackathons_returned: results.length, median_entrants_per_slot: median(perSlot), results };
}

export type ProjectHit = {
	slug: string;
	url: string;
	name: string;
	tagline: string;
	likes: number;
	built_with: string | null;
	winner: number;
	hackathons: string | null;
	last_ended: string | null;
};

export async function searchProjects(
	db: Database,
	query: string,
	opts: { mode: "all" | "any"; winnersOnly: boolean; endedAfter?: string; limit: number },
): Promise<ProjectHit[]> {
	const match = ftsQuery(query, opts.mode);
	if (!match) return [];
	// filters go inside the ranked shortlist so a broad query can't push every winner past the cutoff
	const conditions = [opts.winnersOnly ? "s.winner = 1" : "", opts.endedAfter ? "h.ends_on >= ?" : ""].filter(Boolean);
	const eligible = conditions.length
		? `AND rowid IN (SELECT p.rowid FROM projects p JOIN submissions s ON s.slug = p.slug JOIN hackathons h ON h.id = s.hackathon_id
		   WHERE ${conditions.join(" AND ")})`
		: "";
	// rank first inside FTS, then attach winner flags and hackathon names to that shortlist
	return all<ProjectHit>(
		db,
		`WITH hits AS (
		   SELECT rowid, bm25(projects_fts, 4.0, 2.0, 1.0) AS score FROM projects_fts
		   WHERE projects_fts MATCH ? ${eligible} ORDER BY score LIMIT 500
		 ), x AS (
		   SELECT p.slug, p.url, p.name, p.tagline, p.likes, p.built_with, hits.score,
		     MAX(s.winner) AS winner, MAX(h.ends_on) AS last_ended, GROUP_CONCAT(h.title, ' | ') AS hackathons
		   FROM hits JOIN projects p ON p.rowid = hits.rowid
		   LEFT JOIN submissions s ON s.slug = p.slug LEFT JOIN hackathons h ON h.id = s.hackathon_id
		   GROUP BY p.slug
		 )
		 SELECT slug, url, name, tagline, likes, built_with, winner, hackathons, last_ended FROM x ORDER BY score LIMIT ?`,
		...[match, ...(opts.endedAfter ? [opts.endedAfter] : []), opts.limit],
	);
}

/** Projects with their winner flag and hackathons, keyed by slug (order is the caller's). */
export async function projectsBySlug(db: Database, slugs: string[]): Promise<Map<string, ProjectHit>> {
	if (!slugs.length) return new Map();
	const rows = await all<ProjectHit>(
		db,
		`SELECT p.slug, p.url, p.name, p.tagline, p.likes, p.built_with, MAX(s.winner) AS winner,
		   GROUP_CONCAT(h.title, ' | ') AS hackathons, MAX(h.ends_on) AS last_ended
		 FROM projects p LEFT JOIN submissions s ON s.slug = p.slug LEFT JOIN hackathons h ON h.id = s.hackathon_id
		 WHERE p.slug IN (${slugs.map(() => "?").join(", ")}) GROUP BY p.slug`,
		...slugs,
	);
	return new Map(rows.map((r) => [r.slug, r]));
}

/** Projects closest in meaning to a description of a problem, product or idea. */
export async function searchByMeaning(
	db: Database,
	index: VectorIndex,
	query: string,
	opts: { winnersOnly: boolean; endedAfter?: string; limit: number },
) {
	const [q] = await embed([query], "query");
	const hits = nearest(index, q!, opts.limit, (i) => (!opts.winnersOnly || !!index.winner[i]) && (!opts.endedAfter || (index.lastEnded[i] ?? "") >= opts.endedAfter));
	const rows = await projectsBySlug(db, hits.map((h) => h.slug));
	return hits.flatMap((h) => {
		const row = rows.get(h.slug);
		return row ? [{ ...projectHit(row), similarity: Math.round(h.sim * 100) / 100 }] : [];
	});
}

export const projectHit = (p: ProjectHit) => ({
	name: p.name,
	tagline: p.tagline,
	url: p.url,
	winner: !!p.winner,
	built_with: json(p.built_with),
	likes: p.likes,
	hackathons: p.hackathons?.split(" | ") ?? [],
	last_ended: p.last_ended,
});

export async function getProject(db: Database, urlOrSlug: string) {
	// Devpost URLs end in the slug; Plume's are gallery searches, so match those whole
	const [p] = await all(db, "SELECT * FROM projects WHERE slug = ? OR url = ?", projectSlug(urlOrSlug), urlOrSlug);
	if (!p) return null;
	const entries = await all(
		db,
		`SELECT h.title, h.url, h.dates, s.winner, s.prizes FROM submissions s JOIN hackathons h ON h.id = s.hackathon_id
		 WHERE s.slug = ? ORDER BY h.ends_on DESC`,
		p.slug,
	);
	return {
		name: p.name,
		tagline: p.tagline,
		url: p.url,
		likes: p.likes,
		built_with: json(p.built_with),
		links: json(p.links),
		// Devpost write-ups are crawled for winners only; for others read the page at `url`
		description: p.description ?? null,
		submissions: entries.map((e) => ({ hackathon: e.title, url: e.url, dates: e.dates, winner: !!e.winner, prizes: json(e.prizes) })),
	};
}

// counted by the crawler before upload, so no call scans whole tables
export async function indexInfo(db: Database): Promise<Record<string, string | number>> {
	const rows = await all<{ key: string; value: string | number }>(db, "SELECT key, value FROM stats");
	return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Share of indexed projects that won something: the baseline "proven space" is measured against. */
export async function winnerBaseline(db: Database): Promise<number> {
	const [r] = await all<{ value: number }>(db, "SELECT value FROM stats WHERE key = 'winner_baseline'");
	return r?.value ?? 0;
}
