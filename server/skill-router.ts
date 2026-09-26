// Skill router (skills lane R2, behind features.skillsLibrary).
//
// One shard per bot: the bot's enabled private skills plus its assigned
// library skills — the lane's resolution order, private winning name
// collisions — each reduced to frontmatter plus a short excerpt with one
// precomputed vector. Vectors are batched through the injected embedder;
// R2 defines that seam locally (EmbeddingClient below) and imports no
// embedding provider.
//
// Selection is pure: no filesystem, clock, or randomness inside the
// selector, so the same shard and query always produce the same answer.
// Router state rides the existing skillStateDir pattern (skills.ts):
// per-bot, outside the workspace, beside skills.json. While the flag is
// off nothing here runs at all — no listener, no state, no embed call.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { librarySkillFilePath, readLibrarySkillFile, skillLibraryEvents } from "./skill-library.ts";
import { readSkillFile, resolveBotSkills, skillFilePath, skillStateDir } from "./skills.ts";
import { parseSkillMd } from "../shared/skill-md.ts";
import {
  DEDUP_TURNS,
  MAX_POINTERS,
  RERANK_LEXICAL_WEIGHT,
  RERANK_MIN_CANDIDATES,
  RERANK_SPREAD_MAX,
  RERANK_TOP_SCORE_MAX,
  SHARD_EXCERPT_MAX_CHARS,
  SIMILARITY_FLOOR,
  THRESHOLD_SIGMAS,
} from "./skill-router-constants.ts";

// ── structural embedding seam ─────────────────────────────────────────────

/** Whatever provides vectors implements this. `model` names the vector
 * space: a shard built with one model is meaningless in another, so a
 * model change invalidates every persisted shard. */
export interface EmbeddingClient {
  model: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export type SkillRouterSource = "private" | "library";

/** One indexed skill: frontmatter plus a short excerpt, its precomputed
 * vector, and the path a pointer will name. */
export interface SkillRouterEntry {
  name: string;
  source: SkillRouterSource;
  description: string;
  excerpt: string;
  /** Where the bot reads the SKILL.md: the workspace copy or the library. */
  path: string;
  vector: number[];
}

export interface SkillRouterShard {
  version: 1;
  botId: string;
  /** The embedding model the vectors belong to. */
  model: string;
  builtAt: string;
  entries: SkillRouterEntry[];
}

/** What the router hands back: at most MAX_POINTERS of these. */
export interface SkillPointer {
  name: string;
  source: SkillRouterSource;
  path: string;
  /** First-stage cosine similarity. After a rerank the order may no longer
   * be score order — deciding that order is what the rerank gate is for. */
  score: number;
}

/** Guardrail telemetry, so callers and tests can see every decision the
 * selector made. */
export interface SkillRouterSelection {
  pointers: SkillPointer[];
  /** The threshold actually applied: max(mean + 1.5σ, 0.35). */
  threshold: number;
  /** Best cosine in the shard. */
  topScore: number;
  /** Spread (max − min) among the qualifying candidates. */
  spread: number;
  /** Whether the second-stage rerank ran. */
  reranked: boolean;
}

// ── pure index building ───────────────────────────────────────────────────

/** A skill reduced to what the shard indexes, before it is embedded. */
export interface SkillDocument {
  name: string;
  source: SkillRouterSource;
  description: string;
  excerpt: string;
  path: string;
}

/** The excerpt half of an indexed skill: body text with frontmatter and
 * layout flattened, capped at SHARD_EXCERPT_MAX_CHARS. */
export function excerptFromSkillText(skillText: string, maxChars = SHARD_EXCERPT_MAX_CHARS): string {
  const parsed = parseSkillMd(skillText);
  const body = "error" in parsed ? "" : parsed.body;
  return body.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

/** The text a skill is embedded as: frontmatter first — name and
 * description are what the router must match on — then the excerpt. */
export function shardDocumentText(entry: { name: string; description: string; excerpt: string }): string {
  return `name: ${entry.name}\ndescription: ${entry.description}\n${entry.excerpt}`;
}

/** Read one bot's indexable skills: enabled bot-private skills plus
 * enabled assigned library skills, private winning name collisions (the
 * lane's resolution order: private > library > bundled). Skills whose
 * stored bytes no longer match their reviewed hash are dropped by the
 * readers themselves. */
export function collectBotSkillDocuments(botId: string, assignedLibrary?: readonly string[]): SkillDocument[] {
  const documents: SkillDocument[] = [];
  for (const listing of resolveBotSkills(botId, assignedLibrary).filter((skill) => skill.enabled)) {
    const privateText = readSkillFile(botId, listing.name);
    if (privateText !== null) {
      const path = skillFilePath(botId, listing.name);
      if (path !== null) {
        documents.push({
          name: listing.name,
          source: "private",
          description: listing.description,
          excerpt: excerptFromSkillText(privateText),
          path,
        });
      }
      continue;
    }
    const libraryText = readLibrarySkillFile(listing.name);
    if (libraryText !== null) {
      documents.push({
        name: listing.name,
        source: "library",
        description: listing.description,
        excerpt: excerptFromSkillText(libraryText),
        path: librarySkillFilePath(listing.name),
      });
    }
  }
  return documents.sort((a, b) => compareNames(a.name, b.name));
}

/** Pure assembly: documents plus their vectors become a shard. */
export function assembleShard(
  botId: string,
  model: string,
  documents: readonly SkillDocument[],
  vectors: readonly (readonly number[])[],
  builtAt: string,
): SkillRouterShard {
  return {
    version: 1,
    botId,
    model,
    builtAt,
    entries: documents.map((document, index) => ({ ...document, vector: [...(vectors[index] ?? [])] })),
  };
}

// ── pure selector ─────────────────────────────────────────────────────────

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function meanAndSigma(scores: readonly number[]): { mean: number; sigma: number } {
  if (!scores.length) return { mean: 0, sigma: 0 };
  const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  if (scores.length === 1) return { mean, sigma: 0 };
  const sigma = Math.sqrt(scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (scores.length - 1));
  return { mean, sigma };
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Jaccard overlap of two token sets: 0 shares nothing, 1 is identical. */
function lexicalOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Code-unit order, not locale order, so ordering is identical on every
 * machine — the selector promises determinism. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface ScoredEntry {
  entry: SkillRouterEntry;
  score: number;
  rerank?: number;
}

/** The pure selector — the whole of R2's decision surface.
 *
 * Guardrails (#1502; the numbers live in skill-router-constants.ts):
 *   1. A skill qualifies when its cosine ≥ max(mean + 1.5σ, 0.35), with
 *      mean and sample σ taken over every score in the shard.
 *   2. The second-stage rerank runs only when the shard holds ≥ 4
 *      candidates AND the top score is under 0.65 AND the spread
 *      (max − min over the shard) is under 0.10 — a crowded, unconfident
 *      selection. It reorders the qualifiers by cosine plus a small
 *      lexical-overlap bonus. ("Candidates" are the shard's entries, not
 *      the post-threshold survivors: mean+1.5σ always trims a tight
 *      cluster to its top, so four survivors bunched within 0.10 could
 *      otherwise never occur.)
 *   3. A skill named in the last DEDUP_TURNS entries of `recent` (most
 *      recent last) is not pointed out again.
 *   4. At most MAX_POINTERS come back. */
export function selectFromShard(input: {
  queryText: string;
  queryVector: readonly number[];
  shard: SkillRouterShard;
  recent?: readonly string[];
}): SkillRouterSelection {
  const scored: ScoredEntry[] = input.shard.entries.map((entry) => ({
    entry,
    score: cosine(input.queryVector, entry.vector),
  }));
  const scores = scored.map((candidate) => candidate.score);
  const { mean, sigma } = meanAndSigma(scores);
  const threshold = Math.max(mean + THRESHOLD_SIGMAS * sigma, SIMILARITY_FLOOR);
  const topScore = scores.length ? Math.max(...scores) : 0;
  const spread = scores.length ? Math.max(...scores) - Math.min(...scores) : 0;

  let ordered = scored.filter((candidate) => candidate.score >= threshold);
  let reranked = false;
  if (
    scored.length >= RERANK_MIN_CANDIDATES &&
    topScore < RERANK_TOP_SCORE_MAX &&
    spread < RERANK_SPREAD_MAX
  ) {
    reranked = true;
    const queryTokens = tokens(input.queryText);
    ordered = ordered
      .map((candidate) => ({
        ...candidate,
        rerank: candidate.score
          + RERANK_LEXICAL_WEIGHT * lexicalOverlap(queryTokens, tokens(shardDocumentText(candidate.entry))),
      }))
      .sort((a, b) => (b.rerank ?? 0) - (a.rerank ?? 0) || compareNames(a.entry.name, b.entry.name));
  } else {
    ordered = [...ordered].sort((a, b) => b.score - a.score || compareNames(a.entry.name, b.entry.name));
  }

  const recentNames = new Set(input.recent?.slice(-DEDUP_TURNS) ?? []);
  const pointers = ordered
    .filter((candidate) => !recentNames.has(candidate.entry.name))
    .slice(0, MAX_POINTERS)
    .map(({ entry, score }) => ({ name: entry.name, source: entry.source, path: entry.path, score }));
  return { pointers, threshold, topScore, spread, reranked };
}

// ── persistence (the skillStateDir pattern) ───────────────────────────────

const shardEntrySchema = z.object({
  name: z.string(),
  source: z.enum(["private", "library"]),
  description: z.string(),
  excerpt: z.string(),
  path: z.string(),
  vector: z.array(z.number()),
});
const shardSchema = z.object({
  version: z.literal(1),
  botId: z.string(),
  model: z.string(),
  builtAt: z.string(),
  entries: z.array(shardEntrySchema),
});

/** Router state rides the existing skillStateDir pattern: per bot, outside
 * the workspace, beside skills.json — never a new state root. */
export function routerShardPath(botId: string): string {
  return join(skillStateDir(botId), "router-shard.json");
}

export function saveRouterShard(shard: SkillRouterShard): void {
  mkdirSync(skillStateDir(shard.botId), { recursive: true, mode: 0o700 });
  writeFileAtomic(routerShardPath(shard.botId), `${JSON.stringify(shard, null, 2)}\n`, { mode: 0o600 });
}

/** Null when absent, malformed, or built by a different embedding model —
 * a stale shard is simply rebuilt, never trusted. */
export function loadRouterShard(botId: string, model: string): SkillRouterShard | null {
  try {
    const parsed = shardSchema.safeParse(JSON.parse(readFileSync(routerShardPath(botId), "utf8")));
    return parsed.success && parsed.data.model === model ? parsed.data : null;
  } catch {
    return null;
  }
}

// ── shard build orchestration ─────────────────────────────────────────────

/** Build one bot's shard: collect the documents, embed them in one batched
 * call (precomputed vectors are the point of the shard), persist, return. */
export async function buildSkillRouterShard(input: {
  botId: string;
  assignedLibrary?: readonly string[];
  embed: EmbeddingClient;
}): Promise<SkillRouterShard> {
  const documents = collectBotSkillDocuments(input.botId, input.assignedLibrary);
  const vectors = documents.length
    ? await input.embed.embed(documents.map((document) => shardDocumentText(document)))
    : [];
  const shard = assembleShard(
    input.botId,
    input.embed.model,
    documents,
    vectors,
    new Date().toISOString(),
  );
  saveRouterShard(shard);
  return shard;
}

// ── service ───────────────────────────────────────────────────────────────

interface HeldShard {
  shard: SkillRouterShard;
  /** Assignments captured when the shard was built or adopted, so an
   * invalidation event can rebuild it with the same view. */
  assignedLibrary?: readonly string[];
  stale: boolean;
}

export interface SkillRouterService {
  select(input: {
    botId: string;
    assignedLibrary?: readonly string[];
    text: string;
    recent?: readonly string[];
  }): Promise<SkillRouterSelection>;
  rebuild(botId: string, assignedLibrary?: readonly string[]): Promise<SkillRouterShard>;
  shard(botId: string): SkillRouterShard | null;
  close(): void;
}

const EMPTY_SELECTION: SkillRouterSelection = {
  pointers: [],
  threshold: SIMILARITY_FLOOR,
  topScore: 0,
  spread: 0,
  reranked: false,
};

/** The per-process router. Enabled, it holds one shard per bot, rebuilds
 * them when S1 library invalidation events fire, and answers selects
 * through the pure selector. Disabled (features.skillsLibrary off), it
 * runs nothing: no listener, no state, no embed call — every select
 * returns empty, so app behavior stays byte-identical. */
export function createSkillRouter(options: { embed: EmbeddingClient; enabled: boolean }): SkillRouterService {
  if (!options.enabled) {
    return {
      select: async () => EMPTY_SELECTION,
      // A no-op that embeds and persists nothing, for callers that rebuild
      // unconditionally: the flag-off contract is "nothing new runs".
      rebuild: async (botId) => assembleShard(botId, options.embed.model, [], [], ""),
      shard: () => null,
      close: () => {},
    };
  }

  const held = new Map<string, HeldShard>();

  const rebuildEntry = async (botId: string, entry: HeldShard): Promise<void> => {
    try {
      entry.shard = await buildSkillRouterShard({
        botId,
        assignedLibrary: entry.assignedLibrary,
        embed: options.embed,
      });
      entry.stale = false;
    } catch {
      // Rebuild lazily on the next select instead of losing the shard.
      entry.stale = true;
    }
  };

  // S1's invalidation bus: every library write emits here. Assignments are
  // not evented yet, so any library write rebuilds every held shard — one
  // batched embed call each, and only for shards this process actually
  // built or served.
  const onInvalidate = (): void => {
    for (const [botId, entry] of held) void rebuildEntry(botId, entry);
  };
  skillLibraryEvents.on("invalidate", onInvalidate);

  const ensureShard = async (botId: string, assignedLibrary?: readonly string[]): Promise<SkillRouterShard> => {
    // Freshness check on every use: a held or persisted shard must still
    // cover exactly the bot's current enabled skills. Library writes are
    // evented, but assignments and private-skill writes are not — this
    // catches both without re-embedding unless the set really changed.
    const covers = (shard: SkillRouterShard): boolean => {
      const names = new Set(collectBotSkillDocuments(botId, assignedLibrary).map((document) => document.name));
      return shard.entries.length === names.size && shard.entries.every((entry) => names.has(entry.name));
    };
    const current = held.get(botId);
    if (current && !current.stale && covers(current.shard)) return current.shard;
    if (!current) {
      // A persisted shard is adopted only when it still covers exactly the
      // bot's current enabled skills — otherwise it is rebuilt. Adoption
      // records the assignments so later events can rebuild it correctly.
      const persisted = loadRouterShard(botId, options.embed.model);
      if (persisted && covers(persisted)) {
        held.set(botId, { shard: persisted, assignedLibrary, stale: false });
        return persisted;
      }
    }
    const shard = await buildSkillRouterShard({ botId, assignedLibrary, embed: options.embed });
    held.set(botId, { shard, assignedLibrary, stale: false });
    return shard;
  };

  return {
    select: async ({ botId, assignedLibrary, text, recent }) => {
      try {
        const shard = await ensureShard(botId, assignedLibrary);
        const [queryVector] = await options.embed.embed([text]);
        if (!queryVector) return EMPTY_SELECTION;
        return selectFromShard({ queryText: text, queryVector, shard, recent });
      } catch {
        // The router is advisory: a failed embed or build must never break
        // a turn. Answer with no pointers.
        return EMPTY_SELECTION;
      }
    },
    rebuild: async (botId, assignedLibrary) => {
      const shard = await buildSkillRouterShard({ botId, assignedLibrary, embed: options.embed });
      held.set(botId, { shard, assignedLibrary, stale: false });
      return shard;
    },
    shard: (botId) => held.get(botId)?.shard ?? null,
    close: () => {
      skillLibraryEvents.removeListener("invalidate", onInvalidate);
      held.clear();
    },
  };
}
