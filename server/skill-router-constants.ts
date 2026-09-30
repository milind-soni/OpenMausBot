// Every guardrail number of the skill router (#1502) lives in this one
// file, so the guardrails stay auditable: change a number here and nowhere
// else. The selector in server/skill-router.ts reads them; it defines none.

/** Similarity floor: a candidate below max(mean + THRESHOLD_SIGMAS·σ, this)
 * never becomes a pointer, however uniform the shard's scores are. */
export const SIMILARITY_FLOOR = 0.35;

/** Adaptive threshold: mean plus this many (sample) standard deviations of
 * the shard's cosine scores. */
export const THRESHOLD_SIGMAS = 1.5;

/** The second-stage rerank runs only when at least this many candidates
 * (shard entries) are in contention. */
export const RERANK_MIN_CANDIDATES = 4;

/** ... and the best candidate score is still under this, meaning no
 * confident first-stage match exists to trust. */
export const RERANK_TOP_SCORE_MAX = 0.65;

/** ... and the candidate spread (max − min cosine) is under this, meaning
 * first-stage order inside the bunch is noise. */
export const RERANK_SPREAD_MAX = 0.10;

/** Weight of the lexical-overlap bonus added to cosine during a rerank.
 * Small on purpose: rerank reorders near-ties, it never rescues a
 * non-match. */
export const RERANK_LEXICAL_WEIGHT = 0.05;

/** A skill already pointed out in the last this many turns is not
 * repeated; the caller supplies the turn history. */
export const DEDUP_TURNS = 4;

/** Hard cap on pointers returned by one select. */
export const MAX_POINTERS = 3;

/** Excerpt budget per indexed skill, in characters of flattened body text.
 * Frontmatter rides in full (name + description); the excerpt is the hint. */
export const SHARD_EXCERPT_MAX_CHARS = 512;
