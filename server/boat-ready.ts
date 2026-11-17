// Boat's `state` says a sandbox is ready; it does not say that its command agent answers. Its gateway answers 502 after
// about 40 s when a sandbox is too slow to answer, which was seen on sandboxes that had just been resumed, with
// `hydrated: false` and a snapshot `in_progress`. So the provider's state alone never means ready here: a short `true`
// has to come back as well.
// Unverified: that `hydrated`, `hydration`, `lastSnapshotStatus`, `health` and `degradedSince` are sent on every read. They
// only lengthen the wait when present; absent, the wait is the short one.
import { setTimeout as delay } from "node:timers/promises";

import { transientClaimFailure } from "./auto-vm-claims.ts";
import { boatAccount, boatFetch, runCommand } from "./boat.ts";
import { boatHealth, type BoatHealth } from "./boat-health.ts";
import { relayBody } from "./boat-relay.ts";
import { cloudComputerCounters, type CloudComputerCounters } from "./cloud-computer-counters.ts";
import { cloudComputerDisk } from "./cloud-computer-disk.ts";
import type { AppConfig } from "./config.ts";

export const READY_WAIT = {
  /** A live machine answers `true` in about 0.2 s. Eight seconds is forty times that, and well under the 40 s the provider's
   * gateway holds a command to a sandbox that does not answer, so a probe that hangs costs a turn seconds, not most of a minute. */
  probeTimeoutMs: 8_000,
  /** Between probes that got no answer. */
  probeGapMs: 3_000,
  /** A computer that answered a command this recently is not probed again. Shorter than any stop and resume takes
   * (about 13 s at the fastest) plus the ten idle minutes before this app stops one. */
  freshMs: 60_000,
  /** With the provider saying ready and giving no reason for the silence: a resume takes about 8 s, so this is ten of them. */
  answerPatienceMs: 90_000,
  /** Right after a wake, a create or a restart, the same silence is given longer: resumed computers were seen to time
   * out every command for several minutes and then answer. Past this the computer may be replaced (boat-recovery.ts). */
  wakePatienceMs: 3 * 60_000,
  /** Between probes after a wake, longer as the silence goes on; the last one repeats. */
  wakeGapsMs: [3_000, 5_000, 8_000, 13_000, 20_000],
  /** With the provider saying the disk is still being restored. Restores of 5 to 30 minutes were seen; past ten the
   * computer is restarted instead, once. */
  restorePatienceMs: 10 * 60_000,
  readTimeoutMs: 10_000,
} as const;

export type BoatWaitPhase = "waking" | "restoring";

/** What the provider says about a sandbox beyond its state; null where it says nothing. */
export interface BoatSignals {
  restoring: boolean | null;
  degraded: boolean | null;
}

const UNDER_WAY = /^(in[_-]?progress|pending|running|hydrating|restoring)$/i;
const statusOf = (value: unknown): string | null =>
  typeof value === "string" ? value : value && typeof value === "object" && typeof (value as { status?: unknown }).status === "string"
    ? (value as { status: string }).status : null;

export function boatSignals(sandbox: unknown): BoatSignals {
  const box = (sandbox && typeof sandbox === "object" ? sandbox : {}) as Record<string, unknown>;
  const hydration = statusOf(box.hydration), snapshot = statusOf(box.lastSnapshotStatus);
  const restoring = box.hydrated === false || (hydration !== null && UNDER_WAY.test(hydration)) || (snapshot !== null && UNDER_WAY.test(snapshot))
    ? true : box.hydrated === true ? false : null;
  const degraded = (typeof box.health === "string" && box.health !== "ok") || Boolean(box.degradedSince)
    ? true : box.health === "ok" ? false : null;
  return { restoring, degraded };
}

export type BoatAnswer =
  | { ok: true; waitedMs: number }
  | { ok: false; phase: BoatWaitPhase; waitedMs: number };

export interface BoatReadinessDeps {
  /** true: answered; false: no answer; null: turned away (a limit, a missing computer), which says nothing about the machine. */
  probe(cfg: AppConfig, boxId: string, signal?: AbortSignal): Promise<boolean | null>;
  /** The provider's sandbox object, or null when it could not be read. */
  read(cfg: AppConfig, boxId: string): Promise<unknown>;
  health: BoatHealth;
  counters: CloudComputerCounters;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface AwaitAnswerOptions {
  /** The computer was just created, woken or restarted, so an earlier answer says nothing about it now. */
  woke?: boolean;
  /** Never waits past this, whatever the provider says. */
  deadline?: number;
  signal?: AbortSignal;
  onPhase?(phase: BoatWaitPhase): void;
}

async function probeOnce(cfg: AppConfig, boxId: string, signal?: AbortSignal): Promise<boolean | null> {
  try {
    const disk = cloudComputerDisk.probeCommand(boxId);
    const out = await runCommand(cfg, boxId, disk ?? "true", { timeoutMs: READY_WAIT.probeTimeoutMs, probe: true, signal });
    if (disk && out.ok) cloudComputerDisk.probed(cfg, boxId, out.stdout);
    return out.ok ? true : out.unanswered ? false : null;
  } catch (error) {
    return transientClaimFailure(error) ? false : null;
  }
}

/** The provider's own object for one sandbox, or null when it could not be read. */
export async function readBoat(cfg: AppConfig, boxId: string): Promise<unknown> {
  try {
    const res = await boatFetch(cfg, `/sandboxes/${boxId}`, { signal: AbortSignal.timeout(READY_WAIT.readTimeoutMs) });
    const body = relayBody(boatAccount(cfg), await res.json().catch(() => null));
    return res.ok ? body?.sandbox ?? null : null;
  } catch {
    return null;
  }
}

export function createBoatReadiness(overrides: Partial<BoatReadinessDeps> = {}) {
  const deps: BoatReadinessDeps = {
    probe: probeOnce, read: readBoat, health: boatHealth, counters: cloudComputerCounters, now: Date.now,
    sleep: (ms, signal) => delay(ms, undefined, { signal }).catch(() => undefined),
    ...overrides,
  };
  const waiting = new Map<string, { phase: BoatWaitPhase; since: number }>();

  /** Resolves once the computer answers a command, or says which wait ran out. A probe that is turned away counts as
   * an answer: the call that follows gets the provider's own refusal. */
  async function awaitAnswer(cfg: AppConfig, boxId: string, opts: AwaitAnswerOptions = {}): Promise<BoatAnswer> {
    if (!opts.woke && deps.health.answeredWithin(boxId, READY_WAIT.freshMs)) return { ok: true, waitedMs: 0 };
    const started = deps.now();
    const hardStop = opts.deadline ?? Infinity;
    let phase = "waking" as BoatWaitPhase;
    let failures = 0;
    const enter = (next: BoatWaitPhase) => {
      if (next === phase && waiting.has(boxId)) return;
      phase = next;
      waiting.set(boxId, { phase, since: started });
      opts.onPhase?.(phase);
    };
    const done = (answer: BoatAnswer): BoatAnswer => {
      waiting.delete(boxId);
      if (failures > 0 || opts.woke) deps.counters.count(boxId, phase === "restoring" ? "restoreWaits" : "wakes", answer.waitedMs);
      return answer;
    };
    for (;;) {
      const sent = deps.now();
      const answered = await deps.probe(cfg, boxId, opts.signal);
      if (opts.signal?.aborted) return done({ ok: false, phase, waitedMs: deps.now() - started });
      if (answered !== false) {
        if (answered) deps.health.answered(boxId);
        return done({ ok: true, waitedMs: deps.now() - started });
      }
      failures += 1;
      // Timed: a probe that ran far past its timeout was held up here, not by the computer, and is not counted against it.
      deps.health.unanswered(boxId, { elapsedMs: deps.now() - sent, timeoutMs: READY_WAIT.probeTimeoutMs });
      enter(boatSignals(await deps.read(cfg, boxId)).restoring === true ? "restoring" : phase);
      const patience = phase === "restoring" ? READY_WAIT.restorePatienceMs : opts.woke ? READY_WAIT.wakePatienceMs : READY_WAIT.answerPatienceMs;
      const gap = opts.woke ? READY_WAIT.wakeGapsMs[Math.min(failures, READY_WAIT.wakeGapsMs.length) - 1]! : READY_WAIT.probeGapMs;
      // The patience may be overrun by one probe; the caller's deadline never is.
      const next = deps.now() + gap;
      if (next >= started + patience || next + READY_WAIT.probeTimeoutMs > hardStop) return done({ ok: false, phase, waitedMs: deps.now() - started });
      await deps.sleep(gap, opts.signal);
    }
  }

  return {
    awaitAnswer,
    /** What a wait under way is waiting for, for the computer's own state line. */
    waitingOn: (boxId: string): { phase: BoatWaitPhase; since: number } | null => waiting.get(boxId) ?? null,
  };
}

export type BoatReadiness = ReturnType<typeof createBoatReadiness>;

export const boatReadiness = createBoatReadiness();
