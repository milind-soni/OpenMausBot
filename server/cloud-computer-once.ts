// A call that got no answer when it was sent (a gateway's 502, a dropped connection) may or may not have reached the
// machine, and a copy that hung can still be delivered after the caller gave up. A long command is followed by its
// processId once it has started (boat-command.ts), which settles whether it ran; a short one, and the start of a long
// one, return nothing to look up, and this app knows of no idempotency key for them (unverified against Boat's own
// docs; nothing here depends on one). So each call carries its own key and claims it on the computer with `mkdir`,
// which is atomic: whichever copy arrives first runs, and every other copy, however late, stops before the command.
// A call is sent again only on that footing.
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { transientClaimFailure } from "./auto-vm-claims.ts";
import { runCommand } from "./boat.ts";
import type { CommandOutcome } from "./boat-command.ts";
import { boatReadiness, type BoatAnswer, type BoatWaitPhase } from "./boat-ready.ts";
import { cloudComputerCounters, type CloudComputerCounters } from "./cloud-computer-counters.ts";
import type { AppConfig } from "./config.ts";

export const RESEND = {
  /** A call is sent again at most this many times. */
  max: 3,
  /** Before each resend, after the computer answered a probe; each varies by a quarter either way. */
  backoffMs: [1_000, 3_000, 8_000],
  jitter: 0.25,
  /** Left of the call's own time for the answer to reach the bot. */
  reserveMs: 5_000,
} as const;

const STOP_MS = 10_000;
const TAKEN_EXIT = 75;
const UNCLAIMED_EXIT = 76;
const KEY = /^[0-9a-f]{16}$/;
const takenMark = (key: string) => `omb-once:${key}:taken`;
const unclaimedMark = (key: string) => `omb-once:${key}:unclaimed`;

/** Shell words, expanded on the computer. */
const CLAIM_DIRS = { disk: "${HOME:-/tmp}/.cache/omb-once", memory: "/dev/shm/omb-once" };

export const newCallKey = (): string => randomBytes(8).toString("hex");

/** `command` behind its claim. The claim lives on the computer's disk, which outlasts a stop and resume, and in
 * /dev/shm when the disk refuses it (full, read-only). A first send runs even with no claim, as it always did; a
 * resend that cannot claim does not run. */
export function onceCommand(key: string, attempt: number, command: string, dirs: { disk: string; memory: string } = CLAIM_DIRS): string {
  if (!KEY.test(key)) throw new RangeError("a call key is 16 hex characters");
  return [
    `k=${key}; a="${dirs.disk}"; b="${dirs.memory}"`,
    `taken() { echo ${takenMark(key)}; exit ${TAKEN_EXIT}; }`,
    'if [ -d "$a/$k" ] || [ -d "$b/$k" ]; then taken; fi',
    'mkdir -p "$a" 2>/dev/null',
    'if ! mkdir "$a/$k" 2>/dev/null; then',
    '  if [ -d "$a/$k" ]; then taken; fi',
    '  mkdir -p "$b" 2>/dev/null',
    '  if ! mkdir "$b/$k" 2>/dev/null; then',
    '    if [ -d "$b/$k" ]; then taken; fi',
    attempt > 1 ? `    echo ${unclaimedMark(key)}; exit ${UNCLAIMED_EXIT}` : "    :",
    "  fi",
    "fi",
    // The shell's own process id, kept beside the claim: `exec` below keeps it, so it names the command.
    'echo $$ > "$a/$k/pid" 2>/dev/null || echo $$ > "$b/$k/pid" 2>/dev/null',
    ...(key.endsWith("0") ? ['find "$a" "$b" -mindepth 1 -maxdepth 1 -type d -mmin +1440 -exec rmdir {} + 2>/dev/null'] : []),
    command,
  ].join("\n");
}

/** Ends the command a call started and everything it started, by the process id the call recorded: Boat has no call
 * this app knows of that stops a command by its processId (unverified). Only that process and its descendants are
 * signalled, never a process group, which could hold the computer's own agent. */
export function stopCommand(key: string, dirs: { disk: string; memory: string } = CLAIM_DIRS): string {
  if (!KEY.test(key)) throw new RangeError("a call key is 16 hex characters");
  return [
    `k=${key}; p=; for d in "${dirs.disk}" "${dirs.memory}"; do if [ -f "$d/$k/pid" ]; then p=$(cat "$d/$k/pid"); break; fi; done`,
    '[ -n "$p" ] || exit 0',
    'stop() { for c in $(pgrep -P "$1" 2>/dev/null); do stop "$c"; done; kill -TERM "$1" 2>/dev/null; }',
    'stop "$p"; exit 0',
  ].join("\n");
}

type CommandResult = CommandOutcome;

export type OnceOutcome =
  /** The command ran in this call and this is its own result. `stop()` ends it, for a result that says it still runs. */
  | { kind: "ran"; result: CommandResult; resent: number; stop(): Promise<void> }
  /** A send got no reply at all and the call's time is up: the command may have started. */
  | { kind: "late" }
  /** An earlier copy of this call ran (or is still running); its answer never came back. */
  | { kind: "lost" }
  /** No copy of this call is known to have run, and the computer did not answer in time to send it again. */
  | { kind: "unanswered"; phase: BoatWaitPhase | "unreachable" };

export interface OnceDeps {
  run(cfg: AppConfig, boxId: string, command: string, opts: { timeoutMs?: number; signal?: AbortSignal }): Promise<CommandResult>;
  awaitAnswer(cfg: AppConfig, boxId: string, opts: { woke: true; deadline: number; signal?: AbortSignal }): Promise<BoatAnswer>;
  counters: CloudComputerCounters;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random(): number;
  key(): string;
}

const defaults: OnceDeps = {
  run: runCommand, awaitAnswer: (cfg, boxId, opts) => boatReadiness.awaitAnswer(cfg, boxId, opts), counters: cloudComputerCounters,
  now: Date.now, sleep: (ms, signal) => delay(ms, undefined, { signal }).catch(() => undefined), random: Math.random, key: newCallKey,
};

export interface OnceOptions {
  signal: AbortSignal;
  /** When the call this command belongs to must have answered. */
  deadline: number;
  /** The most one send may take, when that is less than what is left of the call. */
  timeoutMs?: number;
  /** Aborts when the person stops the turn, as opposed to the call's own time running out. */
  stopped?: AbortSignal;
}

const backoff = (resend: number, random: () => number): number => {
  const base = RESEND.backoffMs[Math.min(resend, RESEND.backoffMs.length - 1)]!;
  return Math.round(base * (1 - RESEND.jitter + 2 * RESEND.jitter * random()));
};

/** Runs `command` at most once on the computer. A gateway's 502, 503 or 504, a 52x, or no reply at all is waited out
 * and the call sent again; a command that ran and failed is returned as it is. */
export async function runOnce(cfg: AppConfig, boxId: string, command: string, opts: OnceOptions, overrides: Partial<OnceDeps> = {}): Promise<OnceOutcome> {
  const deps = { ...defaults, ...overrides };
  const key = deps.key();
  const lastSend = () => opts.deadline - RESEND.reserveMs;
  /** Best effort, on its own short clock: the caller that asks has usually given up already. */
  const stop = async () => { await deps.run(cfg, boxId, stopCommand(key), { timeoutMs: STOP_MS }).catch(() => undefined); };
  for (let resent = 0; ; resent++) {
    let result: CommandResult | null = null;
    try {
      // The command's own limit ends before the call's, so a long one is handed back still running instead of cut off.
      result = await deps.run(cfg, boxId, onceCommand(key, resent + 1, command), {
        signal: opts.signal, timeoutMs: Math.max(1_000, Math.min(opts.timeoutMs ?? Infinity, lastSend() - deps.now())),
      });
    } catch (error) {
      // The person stopped the turn: its foreground command is stopped with it, as Ctrl-C would, since nobody is left to follow it.
      if (opts.stopped?.aborted) void stop();
      if (opts.signal.aborted || !transientClaimFailure(error)) throw error;
      if (deps.now() >= lastSend()) return { kind: "late" };
    }
    if (result && !result.unanswered && !result.busy) {
      if (result.exitCode === TAKEN_EXIT && result.stdout.includes(takenMark(key))) {
        deps.counters.count(boxId, "lostAnswers");
        return { kind: "lost" };
      }
      if (result.exitCode === UNCLAIMED_EXIT && result.stdout.includes(unclaimedMark(key))) return { kind: "unanswered", phase: "waking" };
      return { kind: "ran", result, resent, stop };
    }
    deps.counters.count(boxId, "unanswered");
    if (resent >= RESEND.max) return { kind: "unanswered", phase: result?.busy ? "unreachable" : "waking" };
    const answer = await deps.awaitAnswer(cfg, boxId, { woke: true, deadline: lastSend(), signal: opts.signal });
    opts.signal.throwIfAborted();
    if (!answer.ok) return { kind: "unanswered", phase: answer.phase };
    const pause = backoff(resent, deps.random);
    if (deps.now() + pause >= lastSend()) return { kind: "unanswered", phase: "waking" };
    await deps.sleep(pause, opts.signal);
    opts.signal.throwIfAborted();
    deps.counters.count(boxId, "resent");
  }
}

/** For a read that changes nothing on the computer (a screenshot): tried again whenever `unanswered(error)` says the
 * computer gave no answer, once it answers a probe. */
export async function retryRead<T>(
  cfg: AppConfig, boxId: string, read: () => Promise<T>, unanswered: (error: unknown) => boolean, opts: OnceOptions, overrides: Partial<OnceDeps> = {},
): Promise<{ value: T } | { phase: BoatWaitPhase }> {
  const deps = { ...defaults, ...overrides };
  const lastSend = () => opts.deadline - RESEND.reserveMs;
  for (let resent = 0; ; resent++) {
    try {
      return { value: await read() };
    } catch (error) {
      if (opts.signal.aborted || !unanswered(error)) throw error;
    }
    deps.counters.count(boxId, "unanswered");
    if (resent >= RESEND.max) return { phase: "waking" };
    const answer = await deps.awaitAnswer(cfg, boxId, { woke: true, deadline: lastSend(), signal: opts.signal });
    opts.signal.throwIfAborted();
    if (!answer.ok) return { phase: answer.phase };
    const pause = backoff(resent, deps.random);
    if (deps.now() + pause >= lastSend()) return { phase: "waking" };
    await deps.sleep(pause, opts.signal);
    opts.signal.throwIfAborted();
    deps.counters.count(boxId, "resent");
  }
}
