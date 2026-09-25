// The composio tool router (issue #1667). Composio's on-demand discovery
// already keeps connected-app schemas out of the agent's context, but it
// leaves the choice of which tools to hydrate to the main model guessing
// from names in a long catalog — high-cardinality, off-policy selection,
// where every wrong hydration pays context. This module ranks the
// candidates a COMPOSIO_SEARCH_TOOLS response returned against the turn's
// goal with the calibrated decision model (#1630), keeps full schemas for
// the winners only (fetched through the ordinary
// COMPOSIO_GET_TOOL_SCHEMAS meta tool), and strips them from the rest.
//
// It is a new caller of the decision model, not a new decision path: the
// semantics are the chooser's (server/decision-chooser.ts), mirrored
// rather than imported because that module owns the computer-use loop —
// confidence gate, silent fallback on every failure, a three-error
// breaker, a 12s decide timeout racing an AbortSignal, and one
// decision.chooser event per outcome tagged flow "tool-router" so the
// populations stay separable. A router failure must never break a
// connected-app call: every failure path returns the original bytes.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DecisionModelClient } from "./decision-model.ts";

export const TOOL_ROUTER_FLOW = "tool-router";
/** How many ranked tools keep their schemas. Mirrors the chooser's
 * candidate ceiling: one screen's worth of choices, not a catalog. */
export const TOOL_ROUTER_MAX_WINNERS = 32;
/** The ranking request's wire cap. Goal text plus names and one-liners —
 * the bytes that decide rank — never schemas or full descriptions. */
export const TOOL_ROUTER_MAX_RANKING_BYTES = 65_536;
export const DECIDE_TIMEOUT_MS = 12_000;
const ERROR_BUDGET = 3;
const MIN_CANDIDATES = 2;
const ONE_LINER_MAX = 160;
/** A verified winner set goes stale with the turn that produced it, same
 * horizon as the turn goal: ranking against abandoned work is worse than
 * not ranking. */
const VERIFIED_TTL_MS = 10 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

export type ToolCandidate = { name: string; description: string };

export type ToolRouterReport = {
  outcome: "acted" | "abstained" | "below-threshold" | "error";
  flow: typeof TOOL_ROUTER_FLOW;
  candidateCount: number;
  winnerCount: number;
  latencyMs: number;
  breakerOpen: boolean;
  selectedId?: string;
  confidence?: number;
  model?: string;
  detail?: string;
};

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The first line of a description, bounded: what a ranking should see.
 * Full descriptions belong to the hydration step, not the decision. */
export function oneLiner(description: unknown): string {
  if (typeof description !== "string") return "";
  const line = description.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  return line.length > ONE_LINER_MAX ? line.slice(0, ONE_LINER_MAX - 1) + "…" : line;
}

function candidateFromEntry(name: string, entry: unknown): ToolCandidate | null {
  const description = oneLiner(isRecord(entry) ? entry.description : undefined);
  return name.trim() && description ? { name: name.trim(), description } : null;
}

/** The keyed schema map a search payload carries, in the spelling the
 * rewrite reuses. Only a keyed map can be stripped in place: an
 * array-shaped catalog has no per-tool entry to rewrite, so it is not
 * routable at all and the caller passes those bytes through untouched. */
function schemasMapOf(payload: JsonRecord): { key: "tool_schemas" | "toolSchemas"; map: Record<string, unknown> } | null {
  if (isRecord(payload.tool_schemas)) return { key: "tool_schemas", map: payload.tool_schemas };
  if (isRecord(payload.toolSchemas)) return { key: "toolSchemas", map: payload.toolSchemas };
  return null;
}

/** Candidates from a COMPOSIO_SEARCH_TOOLS payload. The backend owns this
 * shape and has changed it across versions, so both keyed schema-map
 * spellings are accepted; anything else yields nothing, which passes the
 * response through untouched — no decision call, no event. */
export function parseSearchToolsCandidates(payload: unknown): ToolCandidate[] {
  if (!isRecord(payload)) return [];
  const map = schemasMapOf(payload)?.map;
  if (!map) return [];
  const candidates: ToolCandidate[] = [];
  for (const [name, entry] of Object.entries(map)) {
    const candidate = candidateFromEntry(name, entry);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export type RankingRequest = {
  state: { goal: string; catalog: Array<{ name: string; description: string }>; candidate_count: number; truncated_count: number };
  criteria: Record<string, string>;
  truncatedCount: number;
};

/** The decision request: criteria maps every tool id to its one-liner
 * plus the mandatory abstain escape; the state carries the goal and the
 * same name/one-liner catalog. If the catalog outgrows the wire cap the
 * tail is dropped deterministically (input order), never silently
 * reweighted. Null means too few candidates to rank. */
export function buildRankingRequest(goal: string, candidates: ToolCandidate[]): RankingRequest | null {
  const seen = new Set<string>();
  const unique: ToolCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.name)) continue;
    seen.add(candidate.name);
    unique.push(candidate);
  }
  if (unique.length < MIN_CANDIDATES) return null;
  const abstain = "Decline to rank; let the main model choose from the full list.";
  let kept = unique;
  let truncatedCount = 0;
  for (;;) {
    const criteria = Object.fromEntries([
      ...kept.map((candidate) => [candidate.name, candidate.description] as const),
      ["abstain", abstain] as const,
    ]);
    const state = {
      goal: goal.slice(0, 4_000),
      catalog: kept.map((candidate) => ({ name: candidate.name, description: candidate.description })),
      candidate_count: kept.length,
      truncated_count: truncatedCount,
    };
    const bytes = Buffer.byteLength(JSON.stringify({ state, criteria }), "utf8");
    if (bytes <= TOOL_ROUTER_MAX_RANKING_BYTES) {
      return { state, criteria, truncatedCount };
    }
    if (kept.length <= MIN_CANDIDATES) {
      // Even the minimum catalog overflows the cap — names or one-liners
      // far larger than any real backend sends. Refuse to rank rather
      // than ship an oversized wire.
      return null;
    }
    const nextLength = Math.max(MIN_CANDIDATES, Math.floor(kept.length * 0.9));
    truncatedCount += kept.length - nextLength;
    kept = kept.slice(0, nextLength);
  }
}

/** The tools/call frame a provider bridge posts, or null for anything
 * else on the relay. */
export function jsonRpcToolCall(body: unknown): { name: string; arguments: unknown } | null {
  if (!isRecord(body) || body.method !== "tools/call" || !isRecord(body.params)) return null;
  const name = body.params.name;
  if (typeof name !== "string" || !name.trim()) return null;
  return { name: name.trim(), arguments: body.params.arguments };
}

export type ToolSchemaOutcome = { schemas: Map<string, JsonRecord>; missing: string[] };

type PayloadLocation = { kind: "structured" } | { kind: "text"; index: number };

/** Locate the Composio tool payload inside an MCP result envelope:
 * structured content first, then a JSON text item. The location comes
 * back too, so a rewrite can replace exactly the item that carried the
 * payload and leave any other text items alone. */
function toolPayloadAt(frame: unknown): { payload: JsonRecord; from: PayloadLocation } | null {
  if (!isRecord(frame) || !isRecord(frame.result)) return null;
  const result = frame.result;
  if (isRecord(result.structuredContent)) return { payload: result.structuredContent, from: { kind: "structured" } };
  if (Array.isArray(result.content)) {
    for (let index = 0; index < result.content.length; index += 1) {
      const item = result.content[index];
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
      const trimmed = item.text.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isRecord(parsed)) return { payload: parsed, from: { kind: "text", index } };
      } catch {
        // not JSON after all
      }
    }
  }
  return null;
}

function toolPayload(frame: unknown): JsonRecord | null {
  return toolPayloadAt(frame)?.payload ?? null;
}

/** Rewrite a search response so schemas ride only with the ranked
 * winners. Winner entries are re-ordered to rank and hydrated; every
 * other tool keeps its name and one-liner with the schema stripped, so
 * the fallback path — the model fetching a schema itself — stays open.
 * Null means the frame held nothing rewriteable; callers pass the
 * original bytes through. */
export function rewriteSearchResult(
  frameText: string,
  winners: string[],
  schemas: Map<string, JsonRecord>,
): string | null {
  let frame: unknown;
  try {
    frame = JSON.parse(frameText);
  } catch {
    return null;
  }
  if (!isRecord(frame) || !isRecord(frame.result)) return null;
  const located = toolPayloadAt(frame);
  if (!located) return null;
  const payload = located.payload;
  const keyed = schemasMapOf(payload);
  // Array-shaped catalogs cannot be stripped here; the caller passes the
  // original bytes through instead of ranking them.
  if (!keyed) return null;
  const schemasKey = keyed.key;
  const original = keyed.map;
  const ranked: JsonRecord = {};
  const omitted: JsonRecord = {};
  const winnerSet = new Set(winners);
  for (const [name, entry] of Object.entries(original)) {
    if (winnerSet.has(name)) continue;
    omitted[name] = isRecord(entry)
      ? {
          ...(typeof entry.tool_slug === "string" ? { tool_slug: entry.tool_slug } : {}),
          ...(typeof entry.toolSlug === "string" ? { toolSlug: entry.toolSlug } : {}),
          ...(typeof entry.toolkit === "string" ? { toolkit: entry.toolkit } : {}),
          ...(oneLiner(entry.description) ? { description: entry.description } : {}),
          schema_omitted: true,
        }
      : { schema_omitted: true };
  }
  for (const name of winners) {
    const fetched = schemas.get(name);
    const base = isRecord(original[name]) ? original[name] : {};
    const full = fetched ?? base;
    const inputSchema = isRecord(full.input_schema) ? full.input_schema : isRecord(full.inputSchema) ? full.inputSchema : undefined;
    ranked[name] = {
      ...base,
      ...(typeof base.tool_slug === "string" ? {} : { tool_slug: name }),
      ...(inputSchema ? { input_schema: inputSchema } : {}),
      rank_verified: true,
    };
  }
  const next: JsonRecord = { ...payload };
  next[schemasKey] = { ...ranked, ...omitted };
  next.tool_router = {
    flow: TOOL_ROUTER_FLOW,
    ranked_winners: winners,
    schema_omitted_count: Object.keys(omitted).length,
    note:
      "A calibrated decision model ranked these tools for the current goal; full schemas are kept for the top " +
      winners.length +
      ". Tools marked schema_omitted kept their name and description only — fetch a schema with COMPOSIO_GET_TOOL_SCHEMAS only if the winners cannot do the job.",
  };
  const result: JsonRecord = { ...frame.result };
  if (located.from.kind === "structured" && isRecord(result.structuredContent)) result.structuredContent = next;
  if (Array.isArray(result.content)) {
    // Rewrite the text item that carried the payload — and, when the
    // payload came from structuredContent, any text mirror of the same
    // payload — while unrelated JSON-looking items keep their bytes.
    result.content = result.content.map((item, index) => {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return item;
      if (located.from.kind === "text") {
        return located.from.index === index ? { ...item, text: JSON.stringify(next) } : item;
      }
      const trimmed = item.text.trim();
      if (!trimmed.startsWith("{")) return item;
      try {
        const mirrored: unknown = JSON.parse(trimmed);
        return isDeepStrictEqual(mirrored, located.payload) ? { ...item, text: JSON.stringify(next) } : item;
      } catch {
        return item; // not JSON after all
      }
    });
  }
  return JSON.stringify({ ...frame, result });
}

/** The executed tool slugs of a COMPOSIO_MULTI_EXECUTE_TOOL call, if the
 * frame is one. */
export function multiExecuteSlugs(arguments_: unknown): string[] {
  if (!isRecord(arguments_) || !Array.isArray(arguments_.tools)) return [];
  const slugs: string[] = [];
  for (const item of arguments_.tools) {
    if (isRecord(item) && typeof item.tool_slug === "string" && item.tool_slug.trim()) slugs.push(item.tool_slug.trim());
  }
  return slugs;
}

export interface ToolRouter {
  /** Rank a search response. Returns replacement bytes, or null to
   * return the original response untouched. */
  routeSearch(options: {
    threadId: string;
    responseBytes: Uint8Array;
    contentType: string;
    transportSessionId?: string;
    signal?: AbortSignal;
  }): Promise<Uint8Array | null>;
  /** Telemetry for an execute against the thread's verified winners.
   * Never blocks the call. */
  observeExecute(threadId: string, slugs: string[]): ToolRouterReport | null;
  breakerOpen(): boolean;
}

export function createToolRouter(options: {
  client: () => DecisionModelClient | null;
  threshold: () => number;
  goal: (threadId: string) => string | null;
  fetchSchemas: (slugs: string[], transportSessionId?: string, signal?: AbortSignal) => Promise<ToolSchemaOutcome>;
  report: (threadId: string, report: ToolRouterReport) => void;
}): ToolRouter {
  let consecutiveErrors = 0;
  let disabled = false;
  const verified = new Map<string, { winners: Set<string>; at: number }>();

  const rememberWinners = (threadId: string, winners: string[]) => {
    if (verified.size >= 256) {
      const now = Date.now();
      for (const [key, entry] of verified) {
        if (now - entry.at > VERIFIED_TTL_MS) verified.delete(key);
      }
      if (verified.size >= 256) {
        const oldest = [...verified.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) verified.delete(oldest[0]);
      }
    }
    verified.set(threadId, { winners: new Set(winners), at: Date.now() });
  };

  return {
    breakerOpen: () => disabled,
    observeExecute(threadId, slugs) {
      const entry = verified.get(threadId);
      if (!entry || Date.now() - entry.at > VERIFIED_TTL_MS) {
        verified.delete(threadId);
        return null;
      }
      const executedWinners = new Set(slugs.filter((slug) => entry.winners.has(slug)));
      const outside = [...new Set(slugs.filter((slug) => !entry.winners.has(slug)))];
      if (!outside.length) return null;
      return {
        outcome: "abstained",
        flow: TOOL_ROUTER_FLOW,
        candidateCount: entry.winners.size,
        winnerCount: executedWinners.size,
        latencyMs: 0,
        breakerOpen: disabled,
        detail: "executed " + outside.length + " tool(s) outside the router's verified winner set: " + outside.slice(0, 8).join(", "),
      };
    },
    async routeSearch(input) {
      const { threadId, responseBytes, contentType, transportSessionId, signal } = input;
      if (disabled) return null;
      if (!/application\/json/i.test(contentType)) return null;
      const started = Date.now();
      const fail = (detail: string, candidates: number): null => {
        consecutiveErrors += 1;
        if (consecutiveErrors >= ERROR_BUDGET) {
          const first = !disabled;
          disabled = true;
          if (first) {
            options.report(threadId, {
              outcome: "error", flow: TOOL_ROUTER_FLOW, candidateCount: candidates, winnerCount: 0,
              latencyMs: Date.now() - started, breakerOpen: true,
              detail: detail + "; router disabled for the rest of this process after repeated errors",
            });
          }
          return null;
        }
        options.report(threadId, {
          outcome: "error", flow: TOOL_ROUTER_FLOW, candidateCount: candidates, winnerCount: 0,
          latencyMs: Date.now() - started, breakerOpen: disabled, detail,
        });
        return null;
      };
      const goal = options.goal(threadId);
      if (!goal || !goal.trim()) return null;
      const client = options.client();
      if (!client) return null;
      let candidates = 0;
      try {
        const frameText = Buffer.from(responseBytes).toString("utf8");
        let frame: unknown;
        try {
          frame = JSON.parse(frameText);
        } catch {
          // Not a JSON-RPC frame (or a truncated one). Nothing to rank:
          // the original bytes pass through without touching the breaker.
          return null;
        }
        const parsed = toolPayload(frame);
        if (!parsed || parsed.isError === true) return null;
        const found = parseSearchToolsCandidates(parsed);
        candidates = found.length;
        if (candidates < MIN_CANDIDATES) return null;
        const ranking = buildRankingRequest(goal, found);
        if (!ranking) return null;
        // A new search replaces the thread's catalog: winners remembered
        // from an earlier response are stale the moment this one starts
        // ranking, and only a successful rewrite remembers fresh ones.
        verified.delete(threadId);
        const decideAbort = new AbortController();
        // A caller cancellation must stay a non-malfunction even when the
        // client ignores its signal: record it before aborting so a later
        // timer expiry on the same abandoned decision cannot tick the breaker.
        let callerAborted = false;
        const onExternalAbort = () => {
          callerAborted = true;
          decideAbort.abort(signal?.reason);
        };
        signal?.addEventListener("abort", onExternalAbort, { once: true });
        if (signal?.aborted) onExternalAbort();
        const callerGone = new Promise<never>((_, reject) => {
          if (!signal) return;
          if (signal.aborted) {
            reject(signal.reason ?? new Error("caller aborted"));
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("caller aborted")), { once: true });
        });
        let decision;
        let timedOut = false;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          decision = await Promise.race([
            client.decide({
              state: ranking.state,
              criteria: ranking.criteria,
              instructions: "Rank the candidate tools for the goal. Select the single best tool id.",
              signal: decideAbort.signal,
            }),
            callerGone,
            new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => {
                timedOut = true;
                decideAbort.abort();
                reject(new Error("decision timed out"));
              }, DECIDE_TIMEOUT_MS);
              timeoutId.unref?.();
            }),
          ]);
        } catch (error) {
          if (callerAborted || (decideAbort.signal.aborted && !timedOut)) {
            // The caller went away mid-decision — the timer sets timedOut
            // before aborting, so a client that rejects synchronously on
            // abort is still a timeout. Not a malfunction: no schema
            // fetch, no execute endorsement, no breaker tick.
            options.report(threadId, {
              outcome: "error", flow: TOOL_ROUTER_FLOW, candidateCount: candidates, winnerCount: 0,
              latencyMs: Date.now() - started, breakerOpen: disabled, detail: "ranking aborted: " + messageOf(error),
            });
            return null;
          }
          return fail("decision failed: " + messageOf(error), candidates);
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
          signal?.removeEventListener("abort", onExternalAbort);
        }
        const note = (outcome: "abstained" | "below-threshold", winners: number, detail?: string): null => {
          consecutiveErrors = 0;
          options.report(threadId, {
            outcome, flow: TOOL_ROUTER_FLOW, candidateCount: candidates, winnerCount: winners,
            latencyMs: Date.now() - started, breakerOpen: disabled,
            selectedId: decision.selectedId,
            ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
            ...(decision.model ? { model: decision.model } : {}),
            ...(detail ? { detail } : {}),
          });
          return null;
        };
        if (decision.selectedId === "abstain") {
          return note("abstained", 0, "the decision model declined to rank; falling back to the full list");
        }
        if (!Object.hasOwn(ranking.criteria, decision.selectedId)) {
          return fail("decision selected an unknown candidate: " + decision.selectedId, candidates);
        }
        if (decision.confidence < options.threshold()) {
          return note("below-threshold", 0);
        }
        const winners = Object.entries(decision.probabilities)
          .filter(([id]) => id !== "abstain" && Object.hasOwn(ranking.criteria, id))
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, TOOL_ROUTER_MAX_WINNERS)
          .map(([id]) => id);
        if (!winners.length) return fail("decision returned no usable winners", candidates);
        let schemas: ToolSchemaOutcome;
        let hydrationTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          // The relay's own timeout is minutes long; a search response
          // cannot wait out a stalled upstream. Hydration gets the same
          // budget as the decision, and expiry falls through to the failure
          // path below — a stalled fetch is a malfunction, so it ticks the
          // breaker like any other, unlike a caller that simply went away.
          schemas = await Promise.race([
            options.fetchSchemas(winners, transportSessionId, signal),
            callerGone,
            new Promise<never>((_, reject) => {
              hydrationTimer = setTimeout(() => reject(new Error("schema hydration timed out")), DECIDE_TIMEOUT_MS);
              hydrationTimer.unref?.();
            }),
          ]);
        } catch (error) {
          if (signal?.aborted) {
            options.report(threadId, {
              outcome: "error", flow: TOOL_ROUTER_FLOW, candidateCount: candidates, winnerCount: 0,
              latencyMs: Date.now() - started, breakerOpen: disabled, detail: "ranking aborted: " + messageOf(error),
            });
            return null;
          }
          return fail("schema fetch failed: " + messageOf(error), candidates);
        } finally {
          if (hydrationTimer) clearTimeout(hydrationTimer);
        }
        const missing = winners.filter((slug) => {
          const entry = schemas.schemas.get(slug);
          return schemas.missing.includes(slug) || !isRecord(entry?.input_schema ?? entry?.inputSchema);
        });
        if (missing.length) {
          // Verification failed: without every winner's schema the ranked
          // list is a guess, so the discovery flow stays exactly today's.
          return fail("schema verification failed for: " + missing.slice(0, 8).join(", "), candidates);
        }
        const rewritten = rewriteSearchResult(frameText, winners, schemas.schemas);
        if (!rewritten) return fail("search response held nothing rewriteable", candidates);
        rememberWinners(threadId, winners);
        consecutiveErrors = 0;
        options.report(threadId, {
          outcome: "acted", flow: TOOL_ROUTER_FLOW, candidateCount: candidates, winnerCount: winners.length,
          latencyMs: Date.now() - started, breakerOpen: false,
          selectedId: decision.selectedId,
          ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
          ...(decision.model ? { model: decision.model } : {}),
          ...(ranking.truncatedCount
            ? { detail: "catalog truncated to " + ranking.state.catalog.length + " of " + candidates + " candidates for the ranking payload cap" }
            : {}),
        });
        return Buffer.from(rewritten, "utf8");
      } catch (error) {
        return fail("routing failed: " + messageOf(error), candidates);
      }
    },
  };
}

/** One batched COMPOSIO_GET_TOOL_SCHEMAS frame for the winners. */
export function schemaFetchRequest(slugs: string[]): {
  jsonrpc: "2.0";
  id: string;
  method: "tools/call";
  params: { name: "COMPOSIO_GET_TOOL_SCHEMAS"; arguments: { tool_slugs: string[] } };
} {
  return {
    jsonrpc: "2.0",
    id: "tool-router-" + randomUUID(),
    method: "tools/call",
    params: { name: "COMPOSIO_GET_TOOL_SCHEMAS", arguments: { tool_slugs: slugs } },
  };
}

/** Decode relayed answer bytes into their JSON-RPC frame according to the
 * upstream content type. JSON answers are the frame itself; SSE answers
 * carry it in data: lines, possibly after streamed notifications, so the
 * last frame bearing a result or error wins. Throws when nothing decodes,
 * which callers treat as a schema-fetch failure. */
export function decodeJsonRpcFrame(bytes: Uint8Array, contentType: string): unknown {
  const text = Buffer.from(bytes).toString("utf8");
  if (!/text\/event-stream/i.test(contentType)) return JSON.parse(text);
  const frames: JsonRecord[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      const frame: unknown = JSON.parse(data);
      if (isRecord(frame)) frames.push(frame);
    } catch {
      // A malformed event is skipped; the answer may arrive in a later one.
    }
  }
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if ("result" in frame || "error" in frame) return frame;
  }
  const last = frames.at(-1);
  if (!last) throw new Error("SSE answer carried no JSON-RPC frame");
  return last;
}

/** Parse a COMPOSIO_GET_TOOL_SCHEMAS answer into per-slug records. The
 * backend may wrap the payload in data and reports misses separately;
 * both spellings are accepted. */
export function parseSchemaResponse(frame: unknown): ToolSchemaOutcome {
  const schemas = new Map<string, JsonRecord>();
  const missing: string[] = [];
  const payload = toolPayload(frame) ?? (isRecord(frame) ? frame : {});
  const data = isRecord(payload.data) ? payload.data : undefined;
  const map = isRecord(payload.tool_schemas)
    ? payload.tool_schemas
    : isRecord(data?.tool_schemas)
      ? data.tool_schemas
      : isRecord(payload.toolSchemas)
        ? payload.toolSchemas
        : isRecord(data?.toolSchemas)
          ? data.toolSchemas
          : undefined;
  if (map) {
    for (const [slug, entry] of Object.entries(map)) {
      if (isRecord(entry)) schemas.set(slug, entry);
    }
  }
  const notFound = Array.isArray(payload.not_found) ? payload.not_found : Array.isArray(data?.not_found) ? data.not_found : undefined;
  if (notFound) {
    for (const slug of notFound) if (typeof slug === "string") missing.push(slug);
  }
  return { schemas, missing };
}
