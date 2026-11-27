// A Cloud home's record of engine sign-ins, for support: each attempt's engine, method, start and outcome, as one plain log
// line per event and a small summary on the health report (`signIns`). Kept in sign-in-trace.json in the data folder, so a
// stop (a restart, a stop for sleep) can't wipe the record of what it cut short: an attempt still open in the file when the
// server starts again is recorded as `interrupted`, and the sign-in screen's next read of it says so.
//
// Privacy: engine kinds, method names, fixed outcome codes (shared/sign-in-outcome.ts) and times only. Never a code, a
// token, a link, an account, an instance's name, a session or a flow id: the file keeps a hash of the flow to recognise it.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signInOutcome, type SignInOutcome } from "../shared/sign-in-outcome.ts";
import { writeFileAtomic } from "./atomic.ts";

export const SIGN_IN_TRACE_FILE = "sign-in-trace.json";
/** The methods a sign-in can take (the provider card's `authentication.method`), and `other`. */
export const SIGN_IN_METHODS = ["paste-code", "device-code", "callback-url", "browser-pkce", "browser", "other"] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];
/** Events kept for the report, newest last; engines counted; attempts the file holds open at once. */
const RECENT = 10, ENGINES = 20, OPEN = 20, INTERRUPTED = 20, COUNT_MAX = 1_000_000;
const KIND = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const METHODS: ReadonlySet<string> = new Set(SIGN_IN_METHODS);
/** Why an attempt was cut short, for the log line only. */
export type SignInInterruption = "sleep" | "restart" | "settings" | "session";
const INTERRUPTED_BY: Record<SignInInterruption, string> = {
  sleep: "the server was stopped to sleep", restart: "the server restarted", settings: "the engine's settings changed", session: "the session that started it ended",
};

/** How an instance signs in (what its provider card shows): named, or told apart by the calls it offers. */
export function signInMethodOf(inst: { authenticationMethod?: string; getAuthentication?: unknown; completeAuthentication?: unknown }): Exclude<SignInMethod, "other"> {
  if (inst.authenticationMethod === "browser-pkce" || inst.authenticationMethod === "browser" || inst.authenticationMethod === "callback-url") return inst.authenticationMethod;
  return inst.getAuthentication && inst.completeAuthentication ? "paste-code" : inst.getAuthentication ? "device-code" : "callback-url";
}

type EventOutcome = SignInOutcome | "started";
export interface SignInEvent { kind: string; method: SignInMethod; outcome: EventOutcome; at: number }
interface OpenAttempt { id: string; kind: string; method: SignInMethod; at: number; flow?: string }
interface EngineTotals { attempts: number; completed: number; last: { outcome: EventOutcome; at: number } | null }
interface TraceFile { v: 1; open: OpenAttempt[]; recent: SignInEvent[]; engines: Record<string, EngineTotals> }

/** The health report's `signIns`: counts since the first sign-in, per engine and in all, and the last few events. */
export interface SignInSummary {
  attempts: number; open: number;
  engines: Array<{ kind: string; attempts: number; completed: number; last: { outcome: EventOutcome; at: number } | null }>;
  recent: SignInEvent[];
}

/** One attempt, from the press of the sign-in button to its outcome. Every call after `end` is ignored. */
export interface SignInAttempt {
  /** The engine began the flow: it can be recognised after a restart. */
  opened(instanceId: string, flowId: string): void;
  /** A try inside it that did not end it (a pasted code that is not a code). */
  note(outcome: SignInOutcome): void;
  end(outcome: SignInOutcome, by?: SignInInterruption): void;
  readonly ended: boolean;
}

const flowKey = (instanceId: string, flowId: string) => createHash("sha256").update(`${instanceId}\n${flowId}`).digest("hex").slice(0, 32);
const time = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const count = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? Math.min(value, COUNT_MAX) : 0;
const kindOf = (value: unknown) => typeof value === "string" && KIND.test(value) ? value : "unknown";
const methodOf = (value: unknown): SignInMethod => typeof value === "string" && METHODS.has(value) ? value as SignInMethod : "other";
const eventOutcome = (value: unknown): EventOutcome | null => value === "started" ? "started" : signInOutcome(value);
const seconds = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
};

/** What a file on disk says, with anything that is not ours dropped. */
function parseTrace(text: string): TraceFile {
  const empty: TraceFile = { v: 1, open: [], recent: [], engines: {} };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return empty; }
  if (!raw || typeof raw !== "object") return empty;
  const value = raw as Record<string, unknown>;
  const open = (Array.isArray(value.open) ? value.open : []).flatMap((item): OpenAttempt[] => {
    const entry = item as Record<string, unknown> | null, at = time(entry?.at);
    if (!entry || at === null || typeof entry.id !== "string") return [];
    return [{ id: entry.id.slice(0, 64), kind: kindOf(entry.kind), method: methodOf(entry.method), at, ...(typeof entry.flow === "string" && /^[0-9a-f]{32}$/.test(entry.flow) ? { flow: entry.flow } : {}) }];
  }).slice(-OPEN);
  const recent = (Array.isArray(value.recent) ? value.recent : []).flatMap((item): SignInEvent[] => {
    const entry = item as Record<string, unknown> | null, at = time(entry?.at), outcome = eventOutcome(entry?.outcome);
    return entry && at !== null && outcome ? [{ kind: kindOf(entry.kind), method: methodOf(entry.method), outcome, at }] : [];
  }).slice(-RECENT);
  const engines: Record<string, EngineTotals> = {};
  const stored = value.engines && typeof value.engines === "object" ? value.engines as Record<string, unknown> : {};
  for (const [kind, item] of Object.entries(stored).slice(0, ENGINES)) {
    if (!KIND.test(kind) || !item || typeof item !== "object") continue;
    const totals = item as Record<string, unknown>, last = totals.last as Record<string, unknown> | null, at = time(last?.at), outcome = eventOutcome(last?.outcome);
    engines[kind] = { attempts: count(totals.attempts), completed: count(totals.completed), last: at !== null && outcome ? { outcome, at } : null };
  }
  return { v: 1, open, recent, engines };
}

export function createSignInTrace(options: {
  dataDir: string; now?: () => number; log?: (line: string) => void;
  /** This boot follows a stop for sleep: an attempt it cut short says so in its log line. */
  wokeFromSleep?: () => boolean;
}) {
  const now = options.now ?? Date.now, log = options.log ?? ((line: string) => console.log(line));
  const path = join(options.dataDir, SIGN_IN_TRACE_FILE);
  let state: TraceFile | null = null;
  /** The server is shutting down: whatever ends attempts now (engines torn down, settings cleared) is the stop itself, so
   * they stay open in the file and the next boot records them as interrupted. */
  let stopping = false;
  /** Flows open when the server last stopped, by hash: the sign-in screen's next read of one hears `interrupted`. */
  const interruptedFlows = new Set<string>();
  /** Each engine kind's newest attempt in this process: an older one that ends later (a late expiry) never becomes its `last`. */
  const newest = new Map<string, string>();

  const save = () => {
    try { writeFileAtomic(path, `${JSON.stringify(state)}\n`, { durable: false }); }
    catch (error) { log(`sign-in: the record could not be saved: ${error instanceof Error ? error.name : "error"}`); }
  };
  const record = (file: TraceFile, event: SignInEvent, isLast = true) => {
    file.recent = [...file.recent, event].slice(-RECENT);
    const totals = file.engines[event.kind] ?? (Object.keys(file.engines).length < ENGINES ? (file.engines[event.kind] = { attempts: 0, completed: 0, last: null }) : null);
    if (!totals) return;
    if (event.outcome === "started") totals.attempts = Math.min(totals.attempts + 1, COUNT_MAX);
    if (event.outcome === "completed") totals.completed = Math.min(totals.completed + 1, COUNT_MAX);
    if (isLast) totals.last = { outcome: event.outcome, at: event.at };
  };
  const line = (event: SignInEvent, startedAt: number | null, by?: SignInInterruption) =>
    log(`sign-in: ${event.kind} ${event.method} ${event.outcome}${startedAt !== null && event.outcome !== "started" ? ` after ${seconds(event.at - startedAt)}` : ""}${by ? ` (${INTERRUPTED_BY[by]})` : ""}`);

  /** Loads the file once; attempts it holds open were cut short by the server's stop. */
  const recover = (): TraceFile => {
    if (state) return state;
    let text: string | null = null;
    try { text = readFileSync(path, "utf8"); } catch {}
    const file = state = text === null ? { v: 1, open: [], recent: [], engines: {} } : parseTrace(text);
    if (!file.open.length) return file;
    const by: SignInInterruption = options.wokeFromSleep?.() ? "sleep" : "restart", at = now();
    for (const attempt of file.open) {
      const event: SignInEvent = { kind: attempt.kind, method: attempt.method, outcome: "interrupted", at };
      record(file, event);
      line(event, attempt.at, by);
      if (attempt.flow && interruptedFlows.size < INTERRUPTED) interruptedFlows.add(attempt.flow);
    }
    file.open = [];
    save();
    return file;
  };

  return {
    recover: () => { recover(); },
    /** The server began shutting down (a restart, a stop for sleep or an update). */
    stopping: () => { stopping = true; },
    /** The person pressed sign-in for an engine of this kind. */
    begin(kind: string | undefined, method: SignInMethod): SignInAttempt {
      const file = recover();
      const attempt: OpenAttempt = { id: randomUUID(), kind: kindOf(kind), method: methodOf(method), at: now() };
      const started: SignInEvent = { kind: attempt.kind, method: attempt.method, outcome: "started", at: attempt.at };
      file.open = [...file.open, attempt].slice(-OPEN);
      newest.set(attempt.kind, attempt.id);
      record(file, started);
      save();
      line(started, null);
      let ended = false;
      const event = (outcome: SignInOutcome): SignInEvent => ({ kind: attempt.kind, method: attempt.method, outcome, at: now() });
      return {
        get ended() { return ended; },
        opened(instanceId, flowId) {
          if (ended || !flowId) return;
          attempt.flow = flowKey(instanceId, flowId);
          if (file.open.includes(attempt)) save();
        },
        note(outcome) {
          if (ended) return;
          const noted = event(outcome);
          record(file, noted, newest.get(attempt.kind) === attempt.id);
          save();
          line(noted, attempt.at);
        },
        end(outcome, by) {
          if (ended) return;
          ended = true;
          if (stopping && outcome !== "completed") return;
          const done = event(outcome);
          file.open = file.open.filter((open) => open !== attempt);
          record(file, done, newest.get(attempt.kind) === attempt.id);
          save();
          line(done, attempt.at, by);
        },
      };
    },
    /** This flow was open when the server last stopped. */
    interrupted(instanceId: string, flowId: string): boolean {
      recover();
      return Boolean(flowId) && interruptedFlows.has(flowKey(instanceId, flowId));
    },
    summary(): SignInSummary {
      const file = recover();
      const engines = Object.entries(file.engines).map(([kind, totals]) => ({ kind, ...totals }));
      return { attempts: engines.reduce((sum, engine) => Math.min(sum + engine.attempts, COUNT_MAX), 0), open: file.open.length, engines, recent: file.recent.map((event) => ({ ...event })) };
    },
  };
}

export type SignInTrace = ReturnType<typeof createSignInTrace>;
