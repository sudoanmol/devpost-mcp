import { expect, test } from "bun:test";
import { ftsQuery } from "./db";
import { cosine, scaled, tfidf, tokens } from "./scoring";

test("similar ideas score closer than unrelated ones", () => {
	const [a, b, c] = tfidf([tokens("sign language translator glove"), tokens("ASL sign language glove translator"), tokens("crypto wallet for pets")]);
	expect(cosine(a!, b!)).toBeGreaterThan(0.5);
	expect(cosine(a!, c!)).toBeLessThan(0.5);
});

test("tokens split hyphens, keep tech names, singularize plain words only", () => {
	expect(tokens("The robots using OpenCV")).toEqual(["robot", "opencv"]);
	expect(tokens("LLM-driven next.js class")).toEqual(["llm", "driven", "next.js", "class"]);
});

test("scaled clamps to 0..100", () => {
	expect(scaled(0.9, 0.3)).toBe(100);
	expect(scaled(0, 0.3)).toBe(0);
});

test("fts queries quote every term so input can't inject syntax", () => {
	expect(ftsQuery('sign "language" OR NEAR(', "all")).toBe('"sign" "language" "or" "near"');
	expect(ftsQuery("asl glove", "any")).toBe('"asl" OR "glove"');
	expect(ftsQuery("!!!", "any")).toBeNull();
});
