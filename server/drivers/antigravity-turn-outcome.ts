// Whether an Antigravity turn that ended like a normal reply was an upstream failure, read from the runtime's own
// session log.
//
// Adapted from pingdotgg/t3code@b732621b51, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified:
//   - apps/server/src/provider/acp/AntigravityTurnOutcome.ts (the error step,
//     the quota and reset patterns, and the before and after reads of the
//     session's own unlinked log);
//   - apps/server/src/provider/acp/AntigravityProfilePaths.ts (the proof that
//     no component of a path below the profile is a link).
// The failure is a plain error for the shared ACP runtime to throw, worded as every engine's usage limit is. A reset
// time is taken only inside the coming eight days, and a log or step too large to read quickly is not read.
import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { AcpReportedFailure } from "./acp/failure-words.ts";
import { engineFailure } from "./engine-errors.ts";

// CORTEX_STEP_TYPE_ERROR_MESSAGE in the native trajectory.
const ERROR_STEP_TYPE = 17;
// The harness error text leads the payload; a Go stack trace follows it.
const MAX_ERROR_PAYLOAD_BYTES = 16_384;
// The Go harness's rendering of a Google API error, as the agent's api_errors.py reads it.
const API_ERROR = /Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)/s;
const QUOTA_EXHAUSTED = /\breason:QUOTA_EXHAUSTED\b/;
const RESET_TIMESTAMP = /\bquotaResetTimeStamp:([^\s\]]+)/;
const RESET_DELAY = /\bquotaResetDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/;
// google.rpc.RetryInfo, which plain rate limits carry instead of a quota reset.
const RETRY_DELAY = /\bretryDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/;
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g;
const GO_DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};
const NATIVE_SESSION_ID = /^[\w-]+$/;
// A log or an error step past these sizes is not read: the turn then ends as the runtime reported it.
const MAX_LOG_BYTES = 256 * 1024 * 1024;
const MAX_STEP_BYTES = 1024 * 1024;
// Google's longest window is a week; a reset further off, or not in the future, is not a reset time.
const MAX_RESET_AHEAD_MS = 8 * 24 * 3_600_000;
const CONVERSATION_SEGMENTS = ["antigravity-acp", "conversations"];

interface LastStep {
  type: number;
  payload: Uint8Array | null;
}

export type AntigravityPromptCheck = (result: unknown) => Promise<AcpReportedFailure | undefined>;

/** Proves a native runtime entry is at its literal path below the canonical profile: every component exists with the
 * expected type and none is a link. A link could point at another session's database under the same profile. */
async function managedPath(
  profileRoot: string,
  segments: readonly string[],
  kind: "file" | "directory",
): Promise<{ path: string; info: Stats } | undefined> {
  let current = profileRoot;
  let info: Stats | undefined;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    info = await lstat(current).catch(() => undefined);
    const expectFile = kind === "file" && index === segments.length - 1;
    if (info === undefined || info.isSymbolicLink() || (expectFile ? !info.isFile() : !info.isDirectory())) return undefined;
  }
  if (info === undefined) return undefined;
  return (await realpath(current).catch(() => undefined)) === current ? { path: current, info } : undefined;
}

function readSteps<A>(file: string, read: (database: DatabaseSync) => A): A | undefined {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 100");
    const hasSteps = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'").get() !== undefined;
    return hasSteps ? read(database) : undefined;
  } finally {
    database.close();
  }
}

function lastStepIndex(database: DatabaseSync): number {
  const index = database.prepare("SELECT max(idx) AS idx FROM steps").get()?.idx;
  return typeof index === "number" ? index : -1;
}

// `length()` reads a blob's size from its record header; `substr()` loads the whole blob, so it runs only for an
// error step of a size worth loading.
const lastStepAfter = (index: number) => (database: DatabaseSync): LastStep | undefined => {
  const row = database.prepare("SELECT idx, step_type AS type, length(step_payload) AS bytes FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1").get(index);
  if (typeof row?.type !== "number") return undefined;
  if (row.type !== ERROR_STEP_TYPE || typeof row.bytes !== "number" || row.bytes > MAX_STEP_BYTES) return { type: row.type, payload: null };
  const payload = database.prepare("SELECT substr(step_payload, 1, ?) AS payload FROM steps WHERE idx = ?").get(MAX_ERROR_PAYLOAD_BYTES, row.idx)?.payload;
  return { type: row.type, payload: payload instanceof Uint8Array ? payload : null };
};

function resetAtFrom(text: string, now: number): number | undefined {
  const within = (at: number) => Number.isFinite(at) && at > now && at <= now + MAX_RESET_AHEAD_MS;
  const timestamp = RESET_TIMESTAMP.exec(text)?.[1];
  // A bare number is no timestamp, though Date.parse reads "5" as a year.
  const at = timestamp === undefined || !/^\d{4}-\d{2}-\d{2}T/u.test(timestamp) ? Number.NaN : Date.parse(timestamp);
  if (within(at)) return at;
  const delay = RESET_DELAY.exec(text)?.[1] ?? RETRY_DELAY.exec(text)?.[1];
  if (delay === undefined) return undefined;
  let delayMs = 0;
  for (const [, amount, unit] of delay.matchAll(GO_DURATION_PART)) delayMs += Number(amount) * (GO_DURATION_UNIT_MS[unit!] ?? 0);
  const after = Math.round(now + delayMs);
  return within(after) ? after : undefined;
}

/** Which of the account's separately metered allowances a model draws on: Gemini's own, a separately metered Gemini
 * family, or the one every other model shares. */
export function antigravityQuotaFamily(model: string): string {
  if (!/^gemini-/iu.test(model)) return "shared";
  return /(?:^|-)argon(?:-|$)/iu.test(model) ? "gemini-argon" : /(?:^|-)carbon(?:-|$)/iu.test(model) ? "gemini-carbon" : "gemini";
}

/** A quota belongs to one allowance, not the account: it holds the models that draw on the same one as `model`, and
 * leaves the account's other models running. */
export function antigravityLimitFacts(model: string | undefined, known: Iterable<string>): { limit: "model"; limitModels?: string[] } {
  if (!model) return { limit: "model" };
  const family = antigravityQuotaFamily(model);
  return { limit: "model", limitModels: [...new Set([model, ...[...known].filter((id) => antigravityQuotaFamily(id) === family)])] };
}

function usageLimit(provider: string, text: string, now: number, timeZone?: string): AcpReportedFailure {
  const resetsAt = resetAtFrom(text, now);
  const failure = engineFailure(provider, "", { kind: "usage_limit", status: null, resetsAt, timeZone })!;
  return new AcpReportedFailure({ ...failure, ...(resetsAt === undefined ? {} : { limitResetsAt: resetsAt }) }, true);
}

/** The failure a prompt's result and the last step it added stand for; undefined for a normal reply. */
export function antigravityTurnFailure(
  provider: string,
  stopReason: unknown,
  step: LastStep | undefined,
  now: number,
  timeZone?: string,
): AcpReportedFailure | undefined {
  const errorText = step?.type === ERROR_STEP_TYPE ? new TextDecoder().decode(step.payload ?? new Uint8Array()) : undefined;
  // The agent maps only the SDK's QUOTA_EXHAUSTED stop reason to `refusal`.
  if (errorText === undefined && stopReason !== "refusal") return undefined;
  const text = errorText ?? "";
  const apiError = API_ERROR.exec(text);
  if (stopReason === "refusal" || QUOTA_EXHAUSTED.test(text)) return usageLimit(provider, text, now, timeZone);
  if (apiError === null) return new AcpReportedFailure(engineFailure(provider, "", { kind: "refused", status: null })!, false);
  const [, httpStatus, message, status] = apiError;
  if (httpStatus === "429" || status === "RESOURCE_EXHAUSTED") return usageLimit(provider, text, now, timeZone);
  const http = Number(httpStatus);
  return new AcpReportedFailure(engineFailure(provider, message!.trim(), { kind: http >= 500 ? "server" : "refused", status: http })!, false);
}

/**
 * Antigravity reports an upstream API failure as a chat message and `end_turn`. Its session log ends that turn with an
 * error step, so the check reads only steps the current prompt added, read-only, from this session's own unlinked
 * database. Without that evidence a typed `refusal` still fails the turn. Call it before `session/prompt`; it never
 * throws.
 */
export async function watchAntigravityPromptOutcome(
  provider: string,
  profileDirectory: string,
  sessionId: string,
  now: () => number = Date.now,
): Promise<AntigravityPromptCheck> {
  const stopReasonOf = (result: unknown) => (result as { stopReason?: unknown } | null)?.stopReason;
  const typedOnly: AntigravityPromptCheck = async (result) => antigravityTurnFailure(provider, stopReasonOf(result), undefined, now());
  if (!NATIVE_SESSION_ID.test(sessionId)) return typedOnly;
  const segments = [...CONVERSATION_SEGMENTS, `${sessionId}.db`];
  const before = await (async () => {
    const root = await realpath(profileDirectory).catch(() => undefined);
    if (root === undefined) return undefined;
    if ((await managedPath(root, CONVERSATION_SEGMENTS, "directory")) === undefined) return undefined;
    const database = await managedPath(root, segments, "file");
    // A path that exists but fails the proof is a link or other foreign entry.
    if (database === undefined) {
      const present = await lstat(join(root, ...segments)).then(() => true, () => false);
      return present ? undefined : { root, identity: undefined, startIndex: -1 };
    }
    return { root, identity: database.info, startIndex: undefined };
  })().catch(() => undefined);
  if (before === undefined) return typedOnly;
  let startIndex = before.startIndex;
  if (startIndex === undefined) {
    if ((before.identity?.size ?? 0) > MAX_LOG_BYTES) return typedOnly;
    try {
      startIndex = readSteps(join(before.root, ...segments), lastStepIndex) ?? -1;
    } catch {
      return typedOnly;
    }
  }
  const from = startIndex;
  return async (result) => {
    // The same file as before the prompt, or one this prompt created, still unlinked.
    const after = await managedPath(before.root, segments, "file").catch(() => undefined);
    const sameFile = after !== undefined
      && (before.identity === undefined || (after.info.dev === before.identity.dev && after.info.ino === before.identity.ino));
    let step: LastStep | undefined;
    if (sameFile && after.info.size <= MAX_LOG_BYTES) {
      try {
        step = readSteps(after.path, lastStepAfter(from));
      } catch {
        step = undefined;
      }
    }
    return antigravityTurnFailure(provider, stopReasonOf(result), step, now());
  };
}
