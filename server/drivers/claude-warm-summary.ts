// The Claude driver's forks of a conversation's session: the keep-warm ping (claude-keepwarm.ts) and the warm summary.
//
// A warm summary is Claude Code's own `/compact`, run while the conversation is idle and its prompt cache is still warm,
// on a fork of the session (`--resume <session> --fork-session`) launched with the live process's exact contract: the
// same tools, system prompt and model, so the summary reads the cached prompt start instead of writing it again, and the
// conversation's tool list is the same before and after. The fork is a session of its own; the conversation moves to it
// only when no turn started meanwhile, so a person who writes during a summary is not held up by it (the host may still
// choose to wait for one when the turn would summarize anyway: server/warm-summary.ts).
import type { CacheWarmPingResult, IdleCompactResult } from "../contracts.ts";
import { type KeepWarmContract, runForkedPrompt, runKeepWarmPing } from "./claude-keepwarm.ts";
import { USAGE_LIMIT } from "./retry.ts";

/** Writing the summary is most of it: thousands of output tokens, 35 to 60 s on Opus for a 160k conversation. */
export const WARM_SUMMARY_TIMEOUT_MS = 5 * 60_000;
/** A closed process's launch contract is kept this long for a summary after it: the cache it would read lives an hour. */
export const PARKED_FORK_MS = 60 * 60_000;
const PARKED_MAX = 200;
const INSTRUCTIONS_MAX = 1_500;

/** `/compact` takes its custom instructions as the rest of the line. */
export function warmSummaryPrompt(instructions: string): string {
  const line = instructions.replace(/\s+/g, " ").trim().slice(0, INSTRUCTIONS_MAX);
  return line ? `/compact ${line}` : "/compact";
}

const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** The fork's session and usage, plus its running cost for the driver's cost history. */
export type WarmSummaryRun = IdleCompactResult & { costTotal?: number; modelUsage?: unknown };

export function parseWarmSummaryResult(stdout: string, stderr: string, code: number | null, sessionBefore: string): WarmSummaryRun {
  let frame: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(stdout.trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) frame = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: the CLI failed before answering (an unknown flag, a session it cannot resume).
  }
  if (!frame || frame.type !== "result") {
    const said = (stderr.trim() || stdout.trim()).split("\n").pop()?.slice(0, 300) ?? "";
    return { ok: false, reason: said ? `the summary failed: ${said}` : `the summary exited ${code ?? "without a code"}` };
  }
  const text = typeof frame.result === "string" ? frame.result : "";
  if (frame.is_error === true) {
    const limit = frame.api_error === "usage_limit_reached" || USAGE_LIMIT.test(text);
    return { ok: false, reason: limit ? "the account's usage limit refused the summary" : `the summary failed: ${text.slice(0, 300) || "API error"}`, ...(limit ? { limit: true } : {}) };
  }
  const session = typeof frame.session_id === "string" && frame.session_id.trim() ? frame.session_id : null;
  if (!session) return { ok: false, reason: "the summary did not say which session it wrote" };
  const usage = (frame.usage ?? {}) as Record<string, unknown>;
  const models = frame.modelUsage && typeof frame.modelUsage === "object" && !Array.isArray(frame.modelUsage) ? Object.keys(frame.modelUsage) : [];
  return {
    ok: true,
    session,
    sessionBefore,
    input: count(usage.input_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
    output: count(usage.output_tokens),
    costUsd: typeof frame.total_cost_usd === "number" && Number.isFinite(frame.total_cost_usd) ? frame.total_cost_usd : null,
    model: models[0] ?? null,
    ...(typeof frame.total_cost_usd === "number" ? { costTotal: frame.total_cost_usd } : {}),
    ...(frame.modelUsage !== undefined ? { modelUsage: frame.modelUsage } : {}),
  };
}

export function runWarmSummary(opts: {
  cli: string; contract: KeepWarmContract; sessionId: string; instructions: string; signal?: AbortSignal; timeoutMs?: number;
}): Promise<WarmSummaryRun> {
  return runForkedPrompt<WarmSummaryRun>({
    cli: opts.cli, contract: opts.contract, sessionId: opts.sessionId, what: "summary", prompt: warmSummaryPrompt(opts.instructions),
    persist: true, timeoutMs: opts.timeoutMs ?? WARM_SUMMARY_TIMEOUT_MS, signal: opts.signal,
    parse: (stdout, stderr, code) => parseWarmSummaryResult(stdout, stderr, code, opts.sessionId),
    failed: (reason) => ({ ok: false, reason }),
  });
}

interface LiveSession { sessionId: string | null; turn: boolean; busy: boolean }

/** The driver's `cacheKeepWarm` adapter (ping, hold, compact) over its own sessions, and the bookkeeping for a closed one. */
export function claudeForks(deps: {
  cli: string;
  contracts: Map<string, KeepWarmContract>;
  holds: Map<string, number>;
  /** The thread's open process, if any. */
  live(threadId: string): LiveSession | null;
  armIdle(threadId: string): void;
  supports(flag: "--fork-session" | "--no-session-persistence"): boolean;
  /** The conversation moves to `run.session`: the driver records its cost and closes the old process. */
  summarized(threadId: string, run: Extract<WarmSummaryRun, { ok: true }>): void;
  now?: () => number;
  runSummary?: typeof runWarmSummary;
}) {
  const now = deps.now ?? Date.now;
  /** An idle-closed process's contract and session: a summary can still fork it while its cache is warm. */
  const parked = new Map<string, { contract: KeepWarmContract; sessionId: string; at: number }>();
  const forkOf = (threadId: string, live: LiveSession | null) => {
    const contract = deps.contracts.get(threadId);
    if (live && contract && live.sessionId) return { contract, sessionId: live.sessionId };
    const kept = parked.get(threadId);
    if (!kept) return null;
    if (now() - kept.at < PARKED_FORK_MS) return kept;
    parked.delete(threadId);
    return null;
  };
  return {
    /** A process closed: an idle close parks its contract for a summary, any other forgets it. */
    closed(threadId: string, why: string, sessionId: string | null): void {
      const contract = deps.contracts.get(threadId);
      deps.contracts.delete(threadId);
      deps.holds.delete(threadId);
      parked.delete(threadId);
      if (why !== "idle" || !contract || !sessionId) return;
      parked.set(threadId, { contract, sessionId, at: now() });
      if (parked.size > PARKED_MAX) parked.delete(parked.keys().next().value!);
    },
    adapter: {
      ping: async (threadId: string, options?: { signal?: AbortSignal }): Promise<CacheWarmPingResult> => {
        const live = deps.live(threadId);
        const contract = deps.contracts.get(threadId);
        if (!live || !contract || !live.sessionId) return { ok: false, reason: "the conversation's Claude session has closed" };
        if (live.busy) return { ok: false, reason: "a turn is running", busy: true };
        if (!deps.supports("--fork-session") || !deps.supports("--no-session-persistence")) {
          return { ok: false, reason: "this Claude Code is too old to fork a session; update Claude Code" };
        }
        return runKeepWarmPing({ cli: deps.cli, contract, sessionId: live.sessionId, signal: options?.signal });
      },
      hold: (threadId: string, until: number | null): boolean => {
        if (until === null) deps.holds.delete(threadId);
        else deps.holds.set(threadId, until);
        const live = deps.live(threadId);
        if (!live) return false;
        if (!live.turn) deps.armIdle(threadId);
        return true;
      },
      compact: async (threadId: string, options: { instructions: string; session?: string; signal?: AbortSignal }): Promise<IdleCompactResult> => {
        const live = deps.live(threadId);
        if (live?.busy) return { ok: false, reason: "a turn is running", busy: true };
        const fork = forkOf(threadId, live);
        if (!fork) return { ok: false, reason: "the conversation's Claude session has closed" };
        if (options.session !== undefined && fork.sessionId !== options.session) return { ok: false, reason: "the conversation moved to another session" };
        if (!deps.supports("--fork-session")) return { ok: false, reason: "this Claude Code is too old to fork a session; update Claude Code" };
        const run = await (deps.runSummary ?? runWarmSummary)({ cli: deps.cli, contract: fork.contract, sessionId: fork.sessionId, instructions: options.instructions, signal: options.signal });
        if (!run.ok) return run;
        // A turn that began meanwhile ran on the old session: the fork no longer holds the whole conversation.
        if (options.signal?.aborted || deps.live(threadId)?.busy) return { ok: false, reason: "a turn started while summarizing", busy: true };
        // A CLI that summarized the session in place (same id) is handled the same way: the old process holds the
        // unsummarized conversation in memory either way, and the next turn reopens the session from disk.
        parked.delete(threadId);
        deps.summarized(threadId, run);
        const { costTotal: _total, modelUsage: _usage, ...result } = run;
        return result;
      },
    },
  };
}
