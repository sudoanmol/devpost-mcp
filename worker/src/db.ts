// Read-only queries over the crawled Devpost index in D1 (schema.sql at the repo root).

type Row = Record<string, unknown>;

const json = (v: unknown) => (typeof v === "string" && v ? JSON.parse(v) : v ?? null);

export const projectUrl = (slug: string) => `https://devpost.com/software/${slug}`;

export function hackathonRoot(url: string): string {
	return `https://${new URL(url.includes("://") ? url : `https://${url}`).host}`;
}

export function projectSlug(urlOrSlug: string): string {
	return urlOrSlug.replace(/\/+$/, "").split("/").pop() ?? urlOrSlug;
}

/** Turn free text into an FTS5 query of quoted terms, so user input can't break MATCH syntax. */
export function ftsQuery(text: string, mode: "all" | "any"): string | null {
	const terms = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#]*/gu) ?? [];
	return terms.length ? terms.map((t) => `"${t}"`).join(mode === "all" ? " " : " OR ") : null;
}

async function all<T = Row>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
	return (await db.prepare(sql).bind(...params).all<T>()).results;
}

function hackathon(h: Row) {
	return {
		title: h.title,
		url: h.url,
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

export async function searchHackathons(db: D1Database, f: HackathonFilters) {
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

export async function getHackathon(db: D1Database, url: string) {
	const root = hackathonRoot(url);
	const [h] = await all(db, "SELECT * FROM hackathons WHERE url = ?", root);
	if (!h) return null;
	const prizes = await all(db, "SELECT title, value, winners, description FROM prizes WHERE hackathon_id = ? ORDER BY id", h.id);
	return {
		...hackathon(h),
		tagline: h.tagline,
		description: h.description,
		judging_criteria: json(h.judging_criteria) ?? [],
		prizes,
	};
}

export async function listProjects(db: D1Database, url: string, winnersOnly: boolean, limit: number, offset: number) {
	const root = hackathonRoot(url);
	const rows = await all(
		db,
		`SELECT p.slug, p.name, p.tagline, p.likes, s.winner, s.prizes FROM submissions s
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
			url: projectUrl(r.slug as string),
			winner: !!r.winner,
			prizes: json(r.prizes),
			likes: r.likes,
		})),
	};
}

type WinnerRow = { slug: string; name: string; tagline: string; built_with: string | null; prizes: string | null };

const winner = (r: WinnerRow, prizes: string[] | null) => ({
	name: r.name,
	tagline: r.tagline,
	url: projectUrl(r.slug),
	built_with: json(r.built_with),
	prizes,
});

export async function getWinners(db: D1Database, url: string, sponsor?: string) {
	const root = hackathonRoot(url);
	const [h] = await all<{ id: number; title: string; dates: string }>(db, "SELECT id, title, dates FROM hackathons WHERE url = ?", root);
	if (!h) return null;
	const winners = await all<WinnerRow>(
		db,
		`SELECT p.slug, p.name, p.tagline, p.built_with, s.prizes FROM submissions s JOIN projects p ON p.slug = s.slug
		 WHERE s.hackathon_id = ? AND s.winner = 1 ORDER BY p.likes DESC`,
		h.id,
	);
	if (!sponsor) {
		return { hackathon: h.title, url: root, dates: h.dates, returned: winners.length, winners: winners.map((w) => winner(w, json(w.prizes))) };
	}
	return { hackathon: h.title, url: root, dates: h.dates, sponsor, tracks: await sponsorTracks(db, h.id, sponsor, winners) };
}

async function sponsorTracks(db: D1Database, hackathonId: number, sponsor: string, winners: WinnerRow[]) {
	const prizes = await all<{ title: string; value: string; winners: string; description: string }>(
		db,
		"SELECT title, value, winners, description FROM prizes WHERE hackathon_id = ? AND title LIKE ? ORDER BY id",
		hackathonId,
		`%${sponsor}%`,
	);
	const norm = (s: string) => s.toLowerCase().replace(/\W+/g, "");
	return prizes.map((p) => ({
		prize: p.title,
		value: p.value,
		winner_slots: p.winners,
		challenge: p.description,
		winners: winners
			.filter((w) => (json(w.prizes) as string[] | null)?.some((won) => norm(won) === norm(p.title)))
			.map((w) => winner(w, [p.title])),
	}));
}

export async function findSponsorWinners(db: D1Database, sponsor: string, endedAfter: string | undefined, limit: number) {
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
				`SELECT p.slug, p.name, p.tagline, p.built_with, s.prizes FROM submissions s JOIN projects p ON p.slug = s.slug
				 WHERE s.hackathon_id = ? AND s.winner = 1`,
				h.id,
			);
			return { hackathon: h.title, url: h.url, dates: h.dates, tracks: await sponsorTracks(db, h.id, sponsor, winners) };
		}),
	);
	return { sponsor, hackathons_returned: results.length, results };
}

export type ProjectHit = {
	slug: string;
	name: string;
	tagline: string;
	likes: number;
	built_with: string | null;
	winner: number;
	hackathons: string | null;
};

export async function searchProjects(
	db: D1Database,
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
		   SELECT p.slug, p.name, p.tagline, p.likes, p.built_with, hits.score,
		     MAX(s.winner) AS winner, MAX(h.ends_on) AS last_ended, GROUP_CONCAT(h.title, ' | ') AS hackathons
		   FROM hits JOIN projects p ON p.rowid = hits.rowid
		   LEFT JOIN submissions s ON s.slug = p.slug LEFT JOIN hackathons h ON h.id = s.hackathon_id
		   GROUP BY p.slug
		 )
		 SELECT slug, name, tagline, likes, built_with, winner, hackathons FROM x ORDER BY score LIMIT ?`,
		...[match, ...(opts.endedAfter ? [opts.endedAfter] : []), opts.limit],
	);
}

export const projectHit = (p: ProjectHit) => ({
	name: p.name,
	tagline: p.tagline,
	url: projectUrl(p.slug),
	winner: !!p.winner,
	built_with: json(p.built_with),
	likes: p.likes,
	hackathons: p.hackathons?.split(" | ") ?? [],
});

export async function getProject(db: D1Database, urlOrSlug: string) {
	const slug = projectSlug(urlOrSlug);
	const [p] = await all(db, "SELECT * FROM projects WHERE slug = ?", slug);
	if (!p) return null;
	const entries = await all(
		db,
		`SELECT h.title, h.url, h.dates, s.winner, s.prizes FROM submissions s JOIN hackathons h ON h.id = s.hackathon_id
		 WHERE s.slug = ? ORDER BY h.ends_on DESC`,
		slug,
	);
	return {
		name: p.name,
		tagline: p.tagline,
		url: projectUrl(slug),
		likes: p.likes,
		built_with: json(p.built_with),
		links: json(p.links),
		// only winners' write-ups are crawled; for others read the page at `url`
		description: p.description ?? null,
		submissions: entries.map((e) => ({ hackathon: e.title, url: e.url, dates: e.dates, winner: !!e.winner, prizes: json(e.prizes) })),
	};
}

export async function indexInfo(db: D1Database) {
	const [row] = await all(
		db,
		`SELECT (SELECT COUNT(*) FROM hackathons) AS hackathons, (SELECT COUNT(*) FROM projects) AS projects,
		   (SELECT COUNT(*) FROM prizes) AS prize_tracks, (SELECT COUNT(*) FROM submissions WHERE winner = 1) AS winning_entries,
		   (SELECT MAX(updated_at) FROM hackathons) AS last_updated`,
	);
	return row;
}
