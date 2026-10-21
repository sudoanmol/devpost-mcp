import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cashInBrief, ftsQuery, mentions, namesSponsor, sponsorKey, sponsorSql, titleSponsor, trackName, tracks } from "./db";
import { DIMS, nearest, quantize, type VectorIndex } from "./embeddings";
import { scaled, tokens, winnerLift } from "./scoring";

test("tokens split hyphens, keep tech names, singularize plain words only", () => {
	expect(tokens("The robots using OpenCV")).toEqual(["robot", "opencv"]);
	expect(tokens("LLM-driven next.js class")).toEqual(["llm", "driven", "next.js", "class"]);
	expect(tokens("autonomous analysis agents")).toEqual(["autonomous", "analysis", "agent"]);
});

test("scaled maps [zeroAt, fullAt] onto 0..100 and clamps", () => {
	expect(scaled(0.75, 0.6, 0.9)).toBe(50);
	expect(scaled(0.95, 0.6, 0.9)).toBe(100);
	expect(scaled(0.3, 0.6, 0.9)).toBe(0);
});

test("nearest ranks by similarity and honours the filter", () => {
	const unit = (d: number) => Float32Array.from({ length: DIMS }, (_, i) => (i === d ? 1 : 0));
	const mixed = Float32Array.from({ length: DIMS }, (_, i) => (i < 2 ? Math.SQRT1_2 : 0));
	const vecs = [unit(0), mixed, unit(1)];
	const vectors = new Int8Array(vecs.length * DIMS);
	vecs.forEach((v, i) => vectors.set(quantize(v), i * DIMS));
	const index: VectorIndex = { slugs: ["a", "b", "c"], vectors, winner: Uint8Array.from([0, 1, 0]), lastEnded: [null, null, null], position: new Map() };
	expect(nearest(index, unit(0), 2).map((h) => h.slug)).toEqual(["a", "b"]);
	expect(nearest(index, unit(0), 3, (i) => !!index.winner[i]).map((h) => h.slug)).toEqual(["b"]);
});

test("fts queries quote every term so input can't inject syntax", () => {
	expect(ftsQuery('sign "language" OR NEAR(', "all")).toBe('"sign" "language" "or" "near"');
	expect(ftsQuery("asl glove", "any")).toBe('"asl" OR "glove"');
	expect(ftsQuery("!!!", "any")).toBeNull();
});

test("placements of one track collapse into one row", () => {
	expect(trackName("[Creao AI] 2nd Place Best AI-First Disruptor")).toBe("[Creao AI] Best AI-First Disruptor");
	expect(trackName("Best Use of Fetch.ai - 1st Place")).toBe("Best Use of Fetch.ai");
	// Plume prizes are "<track> (<placement>)"
	expect(trackName("OpenAI: The Fifth Teammate (Runner-Up)")).toBe("OpenAI: The Fifth Teammate");
	expect(trackName("Givecampus: Fundraising (2nd Place + Most Production Ready)")).toBe("Givecampus: Fundraising");
	expect(trackName("Espressif: Hardware (In AIoT) (Winner)")).toBe("Espressif: Hardware (In AIoT)");
	const row = (title: string, entrants: number | null) => ({ title, value: "$ 500 in cash", winners: "1 winner", description: "brief", entrants });
	const [t, ...rest] = tracks([row("[X] 1st Place Agents", 40), row("[X] 2nd Place Agents", 38), row("[X] 3rd Place Agents", null)]);
	expect(rest).toEqual([]);
	expect(t).toMatchObject({ track: "[X] Agents", winner_slots: 3, entrants: 40, entrants_per_slot: 13.3 });
});

test("cash stated in the brief is flagged only when it disagrees with the listed value", () => {
	expect(cashInBrief({ value: "$ 10,760 in cash", description: "$1,500 cash / 1 year of Pro ($1,440 value)" })).toBe("$1,500");
	expect(cashInBrief({ value: "$ 1,500 in cash", description: "$1,500 cash" })).toBeNull();
	expect(cashInBrief({ value: "$ 500", description: "credits worth $2,000" })).toBeNull();
});

test("sponsor names normalize across spellings", () => {
	expect(sponsorKey("Fetch.ai")).toBe("Fetch");
	expect(titleSponsor("[Fetch.ai] 1st Place Best Use of Fetch.ai")).toBe("Fetch.ai");
	expect(titleSponsor("Fetch AI: Best Deployment of Agentverse")).toBe("Fetch AI");
	expect(titleSponsor("Best Overall")).toBeNull();
	expect(mentions("We built a game. SpacetimeDB holds the live state.\nIt rocks.", "SpacetimeDB")).toEqual(["SpacetimeDB holds the live state."]);
});

test("winner lift compares weighted winner rate to the baseline", () => {
	const near = [{ sim: 0.4, winner: true }, ...Array(4).fill({ sim: 0.1, winner: false })];
	expect(winnerLift(near, 0.25)).toBeCloseTo(2);
	expect(winnerLift(near.slice(0, 4), 0.25)).toBeNull();
});

test("sponsors match whole words only, in SQL and in JS", () => {
	const db = new Database(":memory:");
	const titles = ["Most Philanthropic Hack - Bloomberg", "Anthropic: Best Use Of Claude", "[Fetch.ai] Best Agent", "Best Metaverse Hack", "Meta: Llama Track"];
	const hits = (sponsor: string) => {
		const [match, pattern] = sponsorSql("t", sponsor);
		return titles.filter((t) => db.query(`SELECT 1 FROM (SELECT ? AS t) WHERE ${match}`).get(t, pattern));
	};
	expect(hits("anthropic")).toEqual(["Anthropic: Best Use Of Claude"]);
	expect(hits("Fetch.ai")).toEqual(["[Fetch.ai] Best Agent"]);
	expect(hits("Meta")).toEqual(["Meta: Llama Track"]);
	for (const sponsor of ["anthropic", "Fetch.ai", "Meta"]) expect(titles.filter((t) => namesSponsor(t, sponsor))).toEqual(hits(sponsor));
	expect(mentions("We gave to philanthropic causes. We used Anthropic's API.", "Anthropic")).toEqual(["We used Anthropic's API."]);
});
