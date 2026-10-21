"""Score a hackathon idea against what already exists on Devpost.

The score covers only what past data can measure: how novel the idea is, how crowded its space is,
whether projects like it tend to win, and how well it fits the target hackathon's prize tracks.
Feasibility, demo quality and impact stay with the agent, which gets the hackathon's own judging
criteria to rate them against.
"""

import asyncio
import math
import re
from collections import Counter

from mcp.server.mcpserver.exceptions import ToolError

from . import devpost

# ponytail: lexical TF-IDF misses paraphrases ("ASL" vs "sign language"); swap in embeddings if that bites
STOP = set(
    "a an and are as at be by for from has have in into is it its of on or our that the their this to "
    "using use uses with we you your can will app platform tool help helps based which who what users user "
    "built build make makes made new more also all not via any one through".split()
)


def _singular(w: str) -> str:
    return w[:-1] if len(w) > 4 and w.isalpha() and w.endswith("s") and not w.endswith("ss") else w


def tokens(text: str) -> list[str]:
    return [_singular(w) for w in re.findall(r"[a-z0-9][a-z0-9.+#]*", text.lower()) if w not in STOP and len(w) > 1]


def tfidf(docs: list[list[str]]) -> list[dict[str, float]]:
    df = Counter(t for d in docs for t in set(d))
    n = len(docs)
    vecs = []
    for d in docs:
        tf = Counter(d)
        v = {t: (c / len(d)) * (math.log((1 + n) / (1 + df[t])) + 1) for t, c in tf.items()} if d else {}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1
        vecs.append({t: x / norm for t, x in v.items()})
    return vecs


def cosine(a: dict[str, float], b: dict[str, float]) -> float:
    return sum(x * b.get(t, 0) for t, x in a.items())


def _project_text(p: dict) -> str:
    return f"{p['name']} {p['tagline']} {' '.join(p.get('built_with', []))}"


def _scaled(sim: float, full_at: float) -> float:
    """TF-IDF similarity between an idea and short taglines rarely passes ~0.4; map [0, full_at] onto [0, 100]."""
    return round(100 * min(1.0, sim / full_at))


async def score_idea(
    idea: str, queries: list[str] | None = None, hackathon_url: str = "", sponsors: list[str] | None = None
) -> dict:
    if sponsors and not hackathon_url:
        raise ToolError("sponsors needs hackathon_url: sponsor tracks are read from that hackathon's prizes")
    queries = queries or [" ".join(tokens(idea)[:4])]
    searches = await asyncio.gather(*(devpost.search_projects(q, pages=4) for q in queries))
    corpus = list({p["url"]: p for s in searches for p in s["projects"]}.values())
    hackathon = await devpost.get_hackathon(hackathon_url) if hackathon_url else None
    prizes = hackathon["prizes"] if hackathon else []
    if sponsors:
        # the user is targeting these sponsors, so fit and criteria come from their tracks only
        unmatched = [sp for sp in sponsors if not any(devpost._matches(sp, p["title"]) for p in prizes)]
        prizes = [p for p in prizes if any(devpost._matches(sp, p["title"]) for sp in sponsors)]

    docs = [tokens(idea)] + [tokens(_project_text(p)) for p in corpus] + [tokens(f"{p['title']} {p['description']}") for p in prizes]
    vecs = tfidf(docs)
    idea_vec, project_vecs, prize_vecs = vecs[0], vecs[1 : 1 + len(corpus)], vecs[1 + len(corpus) :]

    ranked = sorted(((cosine(idea_vec, v), p) for v, p in zip(project_vecs, corpus)), key=lambda x: -x[0])
    top = ranked[:10]
    max_sim = top[0][0] if top else 0.0
    winner_rate = sum(p["winner"] for _, p in top) / len(top) if top else 0.0
    base_rate = sum(p["winner"] for p in corpus) / len(corpus) if corpus else 0.0

    # closest match and the next four both count: one twin hurts, a crowd of near-twins hurts more
    closeness = 0.5 * max_sim + 0.5 * sum(s for s, _ in top[:5]) / max(1, len(top[:5]))
    novelty = 100 - _scaled(closeness, 0.3)
    proven_space = round(100 * winner_rate)
    fits = sorted(((cosine(idea_vec, v), p) for v, p in zip(prize_vecs, prizes)), key=lambda x: -x[0])
    sponsor_fit = _scaled(fits[0][0], 0.3) if fits else None

    weights = {"novelty": 0.5, "proven_space": 0.3, "sponsor_fit": 0.2}
    parts = {"novelty": novelty, "proven_space": proven_space, "sponsor_fit": sponsor_fit}
    used = {k: w for k, w in weights.items() if parts[k] is not None}
    signal_score = round(sum(parts[k] * w for k, w in used.items()) / sum(used.values()))

    return {
        "signal_score": signal_score,
        "components": parts | {"weights": used},
        "interpretation": {
            "novelty": "100 = nothing close on Devpost; low = near-duplicate exists (see closest_projects)",
            "proven_space": "share of the 10 closest projects that won a prize",
            "sponsor_fit": "match against the best-fitting prize track (the given sponsors' tracks if any; null if no hackathon)",
            "sweet_spot": "high novelty with high proven_space: an under-built angle in a space judges reward",
        },
        "crowding": {
            "similar_projects": sum(s >= 0.15 for s, _ in ranked),
            "corpus_size": len(corpus),
            "corpus_winner_rate": round(base_rate, 2),
        },
        "closest_projects": [p | {"similarity": round(s, 2)} for s, p in top[:5]],
        "best_prize_tracks": [
            {"prize": p["title"], "value": p["value"], "fit": _scaled(s, 0.3), "brief": p["description"]}
            for s, p in (fits if sponsors else fits[:3])
        ],
        "judge_yourself": {
            "hackathon_criteria": hackathon["judging_criteria"] if hackathon else [],
            "sponsor_criteria": "each best_prize_tracks brief is the sponsor's own challenge and judging criteria"
            if sponsors
            else "pass sponsors=[...] to get the full brief of every track those sponsors run",
            "unmatched_sponsors": unmatched if sponsors else [],
            "note": "Rate feasibility in the time limit, demo-ability, and impact against both sets of criteria; past data can't.",
        },
        "queries_used": queries,
        "rate_limited": any(s["rate_limited"] for s in searches),
    }


if __name__ == "__main__":
    a, b, c = tfidf([tokens("sign language translator glove"), tokens("ASL sign language glove translator"), tokens("crypto wallet for pets")])
    assert cosine(a, b) > 0.5 > cosine(a, c), (cosine(a, b), cosine(a, c))
    assert tokens("The robots using OpenCV") == ["robot", "opencv"]
    assert tokens("LLM-driven next.js class") == ["llm", "driven", "next.js", "class"]
    assert _scaled(0.9, 0.3) == 100 and _scaled(0.0, 0.3) == 0
    print("ok")
