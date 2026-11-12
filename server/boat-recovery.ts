// A cloud computer that stopped answering: restarted once, then replaced (its deletion frees the plan's place, and the next
// use creates a new one), and the bot and the person are told once. Nothing here asks the person anything.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import * as boat from "./boat.ts";
import { BOAT_DELETING, BOAT_DELETION_FINISHED } from "./boat-delete-journal.ts";
import { boatHealth, DEAD_COMPUTER, type BoatHealth } from "./boat-health.ts";
import { cloudFailureOf } from "./boat-limit.ts";
import { DATA_DIR, type AppConfig } from "./config.ts";
import {
  CLOUD_COMPUTER_CAPPED, CLOUD_COMPUTER_NOT_RESPONDING, CLOUD_COMPUTER_REPLACED, CLOUD_COMPUTER_REPLACED_BY_PERSON,
  CLOUD_COMPUTER_RESTARTED, CLOUD_COMPUTER_UNREACHABLE, recoveryUnderWay,
  type CloudComputerPersonLine, type CloudComputerRecovery, type CloudComputerRecoveryState,
} from "../shared/cloud-computer-recovery.ts";

const HOUR_MS = 60 * 60_000;
const KEPT_MS = 24 * HOUR_MS;
const STOP_WAIT_MS = 90_000;
const WAKE_BUDGET_MS = 120_000;
const POLL_MS = 2_500;
/** A restart or replacement no longer running after this long has ended where the next start picks it up. */
const STALE_MS = 15 * 60_000;
const READY = new Set(["idle", "ready", "running"]);

/** One replacement, written before its delete is sent: a crash after it still counts against the hourly limit and still
 * owes the bot and the person their line. */
interface Replacement {
  owner: string;
  boxId: string;
  at: number;
  manual?: true;
  toldBot?: true;
  toldPerson?: true;
}

export interface BoatRecoveryDeps {
  cfg(): AppConfig;
  /** Posts the person's line in the owner's chat and Inbox; an owner with no chat of its own (a team's computer) has none. */
  tell(owner: string, line: CloudComputerPersonLine): void;
  changed?(owner: string): void;
  log(line: string): void;
  file?: string;
  now?: () => number;
  health?: BoatHealth;
  pollMs?: number;
}

type Dead = { boxId: string; name: string };
type ReplaceOutcome = "confirmed" | "pending" | "kept" | "capped" | "failed";

export function createBoatRecovery(deps: BoatRecoveryDeps) {
  const health = deps.health ?? boatHealth;
  const now = deps.now ?? Date.now;
  const file = deps.file ?? join(DATA_DIR, "boat-replacements.json");
  const pollMs = deps.pollMs ?? POLL_MS;
  const states = new Map<string, CloudComputerRecovery & { boxId: string }>();
  const lanes = new Map<string, Promise<unknown>>();
  const restarts = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const retired = new Set<string>();
  /** Lines already told about a computer still not answering, so a long outage is reported once. */
  const told = new Map<string, Set<CloudComputerPersonLine>>();
  const restartedOwners = new Set<string>();
  let closed = false;

  const read = (): Replacement[] => {
    try {
      const parsed = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
      return Array.isArray(parsed) ? parsed.filter((entry): entry is Replacement => typeof entry?.owner === "string"
        && typeof entry.boxId === "string" && typeof entry.at === "number") : [];
    } catch {
      return [];
    }
  };
  const write = (entries: Replacement[]) => writeFileAtomic(file, JSON.stringify(entries.filter((entry) => now() - entry.at < KEPT_MS)));
  const update = (boxId: string, patch: Partial<Replacement>) => write(read().map((entry) => entry.boxId === boxId ? { ...entry, ...patch } : entry));

  const set = (owner: string, boxId: string, state: CloudComputerRecoveryState, manual = false) => {
    states.set(owner, { state, at: now(), boxId, ...(manual ? { manual: true as const } : {}) });
    deps.changed?.(owner);
  };
  const clear = (owner: string, boxId: string) => {
    told.delete(boxId);
    if (states.get(owner)?.boxId !== boxId) return;
    states.delete(owner);
    deps.changed?.(owner);
  };
  const tellOnce = (owner: string, boxId: string, state: CloudComputerRecoveryState, line: CloudComputerPersonLine) => {
    set(owner, boxId, state);
    const lines = told.get(boxId) ?? new Set<CloudComputerPersonLine>();
    told.set(boxId, lines);
    if (lines.has(line)) return;
    lines.add(line);
    deps.tell(owner, line);
  };

  /** One recovery at a time per owner, in the order asked. */
  function lane<T>(owner: string, work: () => Promise<T>): Promise<T> {
    const started = (lanes.get(owner) ?? Promise.resolve()).catch(() => undefined).then(work);
    const settled = started.finally(() => { if (lanes.get(owner) === settled) lanes.delete(owner); });
    lanes.set(owner, settled);
    return started;
  }

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function restart(owner: string, boxId: string, manual = false): Promise<"answers" | "no-answer" | "refused"> {
    const cfg = deps.cfg();
    set(owner, boxId, "restarting", manual);
    restarts.set(boxId, now());
    try {
      const stopped = await boat.boatFetch(cfg, `/sandboxes/${boxId}/stop`, { method: "POST", signal: AbortSignal.timeout(30_000) });
      await stopped.body?.cancel().catch(() => undefined);
      if (!stopped.ok && stopped.status !== 409) return "refused";
    } catch {
      return "refused";
    }
    for (const deadline = Date.now() + STOP_WAIT_MS; Date.now() < deadline && !closed;) {
      const seen = await boat.inspectBoatIdentity(cfg, boxId);
      const state = seen.identity?.state;
      if (seen.available && (!seen.identity || state === "error" || (state && boat.SLEEPING_BOAT_STATES.has(state) && state !== "archiving"))) break;
      await wait(pollMs);
    }
    const woken = await boat.readyBoat(cfg, owner, WAKE_BUDGET_MS).catch(() => null);
    if (!woken || woken.id !== boxId) return "no-answer";
    if (!(await boat.probeBoat(cfg, boxId))) return "no-answer";
    health.answered(boxId);
    return "answers";
  }

  /** `dead` is the provider's word that the machine is gone; otherwise this computer only stopped answering. */
  async function replace(owner: string, target: Dead, opts: { manual?: boolean; dead?: boolean } = {}): Promise<ReplaceOutcome> {
    const cfg = deps.cfg();
    const entries = read();
    const recorded = entries.find((entry) => entry.boxId === target.boxId);
    if (!opts.manual && !recorded) {
      if (health.answeredWithin(target.boxId, DEAD_COMPUTER.answeredGraceMs)) {
        clear(owner, target.boxId);
        return "kept";
      }
      const recent = entries.filter((entry) => entry.owner === owner && !entry.manual && now() - entry.at < HOUR_MS);
      if (recent.length >= DEAD_COMPUTER.replacementsPerHour) {
        tellOnce(owner, target.boxId, "capped", "capped");
        deps.log(`cloud computer ${owner}: ${target.boxId} is ${opts.dead ? "dead" : "not responding"}, but it was already replaced in the last hour; left as it is`);
        return "capped";
      }
    }
    set(owner, target.boxId, "replacing", opts.manual);
    if (!recorded) write([...entries, { owner, boxId: target.boxId, at: now(), ...(opts.manual ? { manual: true as const } : {}) }]);
    retired.add(target.boxId);
    let outcome: ReplaceOutcome;
    try {
      const deleted = await boat.requestRecordedBoatDeletion(cfg, { boxId: target.boxId, name: target.name, ownerBotId: owner });
      outcome = deleted === "confirmed" ? "confirmed" : "pending";
    } catch (error) {
      deps.log(`cloud computer ${owner}: deleting ${target.boxId} was not confirmed; its next start finishes it: ${error instanceof Error ? error.message : String(error)}`);
      outcome = "failed";
    }
    boat.forgetBoatId(target.boxId);
    health.forget(target.boxId);
    if (outcome === "failed") return outcome;
    set(owner, target.boxId, "replaced", opts.manual);
    if (!opts.manual) {
      deps.tell(owner, "replaced");
      update(target.boxId, { toldPerson: true });
    }
    deps.log(`cloud computer ${owner}: replaced ${target.boxId} (${opts.manual ? "asked for" : opts.dead ? "the provider reports it in error" : "not responding"})`);
    return outcome;
  }

  const listWorks = async (cfg: AppConfig) => {
    try {
      const listed = await boat.boatFetch(cfg, "/sandboxes?limit=1", { signal: AbortSignal.timeout(20_000) });
      await listed.body?.cancel().catch(() => undefined);
      return listed.ok;
    } catch {
      return false;
    }
  };

  function unreachable(owner: string, boxId: string): void {
    tellOnce(owner, boxId, "unreachable", "unreachable");
    deps.log(`cloud computer ${owner}: ${boxId} is not responding, and the provider can't be shown to be up; nothing was deleted`);
  }

  /** After the restart: replaced once the provider says the machine is gone, or after DEAD_COMPUTER.replaceAfterMs of no
   * answers while another computer of this installation answers (else the provider itself may be down). */
  async function decide(owner: string, boxId: string): Promise<void> {
    timers.delete(owner);
    const cfg = deps.cfg();
    const since = health.notRespondingSince(boxId);
    const seen = await boat.inspectBoatIdentity(cfg, boxId);
    if (!seen.available) return unreachable(owner, boxId);
    if (!seen.identity || !(await boat.boatNameMatchesBot(owner, seen.identity.name))) return clear(owner, boxId);
    if (seen.identity.state === "error") return void await replace(owner, seen.identity, { dead: true });
    if (since === null || !READY.has(seen.identity.state)) return clear(owner, boxId);
    const left = since + DEAD_COMPUTER.replaceAfterMs - now();
    if (left > 0) {
      set(owner, boxId, "not-responding");
      const timer = setTimeout(() => void lane(owner, () => decide(owner, boxId)).catch((error) => deps.log(`cloud computer ${owner}: ${String(error)}`)), left);
      timer.unref?.();
      timers.set(owner, timer);
      return;
    }
    if (await boat.probeBoat(cfg, boxId)) {
      health.answered(boxId);
      return clear(owner, boxId);
    }
    if (!(await listWorks(cfg)) || !health.otherAnsweredWithin(boxId, DEAD_COMPUTER.witnessMs)) return unreachable(owner, boxId);
    await replace(owner, seen.identity);
  }

  async function notResponding(owner: string, boxId: string): Promise<void> {
    const cfg = deps.cfg();
    set(owner, boxId, "not-responding");
    const seen = await boat.inspectBoatIdentity(cfg, boxId);
    if (!seen.available) return unreachable(owner, boxId);
    if (!seen.identity || !(await boat.boatNameMatchesBot(owner, seen.identity.name))) return clear(owner, boxId);
    if (seen.identity.state === "error") return void await replace(owner, seen.identity, { dead: true });
    if (!READY.has(seen.identity.state)) {
      health.forget(boxId);
      return clear(owner, boxId);
    }
    const lastRestart = restarts.get(boxId);
    if (lastRestart === undefined || now() - lastRestart >= HOUR_MS) {
      const restarted = await restart(owner, boxId);
      if (restarted === "answers") {
        told.delete(boxId);
        tellOnce(owner, boxId, "restarted", "restarted");
        told.delete(boxId);
        restartedOwners.add(owner);
        return;
      }
    }
    return decide(owner, boxId);
  }

  const unsubscribe = health.onNotResponding((boxId) => {
    const owner = boat.boatOwnerOf(boxId);
    if (!owner || closed) return;
    if (lanes.has(owner) || timers.has(owner)) return;
    set(owner, boxId, "not-responding");
    void lane(owner, () => notResponding(owner, boxId)).catch((error) => deps.log(`cloud computer ${owner}: recovery failed: ${String(error)}`));
  });

  boat.onDeadBoat(async (_cfg, owner, dead): Promise<never> => {
    const outcome = await lane(owner, () => replace(owner, dead, { dead: true }));
    if (outcome === "capped") {
      throw Object.assign(new Error("it stopped working within an hour of being replaced, and MausBot replaces it at most once an hour; Replace computer in the computer panel tries once more"), { status: 409 });
    }
    if (outcome === "kept") throw Object.assign(new Error(CLOUD_COMPUTER_NOT_RESPONDING), { status: 409 });
    throw Object.assign(new Error("the previous cloud computer deletion finished — retry to create a new computer"),
      { status: 409, code: outcome === "confirmed" ? BOAT_DELETION_FINISHED : BOAT_DELETING });
  });

  return {
    /** What the computer panel shows; ended states for an hour. */
    status(owner: string): CloudComputerRecovery | null {
      const found = states.get(owner);
      if (!found) return null;
      const age = now() - found.at;
      const over = recoveryUnderWay(found.state)
        ? !lanes.has(owner) && !timers.has(owner) && age >= STALE_MS
        : age >= HOUR_MS || ((found.state === "unreachable" || found.state === "capped") && health.answeredWithin(found.boxId, age));
      if (over) {
        clear(owner, found.boxId);
        return null;
      }
      return { state: found.state, at: found.at, ...(found.manual ? { manual: true as const } : {}) };
    },
    /** In place of a computer call: `before` it runs, while the computer is being restarted or replaced; `after` it got no
     * answer, what is known about why. */
    refusal(boxId: string, phase: "before" | "after"): string | null {
      if (retired.has(boxId)) return CLOUD_COMPUTER_NOT_RESPONDING;
      const owner = boat.boatOwnerOf(boxId);
      const found = owner ? states.get(owner) : undefined;
      if (found?.boxId === boxId && recoveryUnderWay(found.state)) return CLOUD_COMPUTER_NOT_RESPONDING;
      if (phase === "before") return null;
      if (found?.boxId === boxId && found.state === "unreachable") return CLOUD_COMPUTER_UNREACHABLE;
      if (found?.boxId === boxId && found.state === "capped") return CLOUD_COMPUTER_CAPPED;
      return health.notRespondingSince(boxId) === null ? null : CLOUD_COMPUTER_NOT_RESPONDING;
    },
    /** Told once, with the first call on the owner's computer after a replacement or a restart. */
    notice(boxId: string): string | null {
      const owner = boat.boatOwnerOf(boxId);
      if (!owner) return null;
      if (restartedOwners.delete(owner)) return CLOUD_COMPUTER_RESTARTED;
      const entries = read();
      const owed = entries.filter((entry) => entry.owner === owner && entry.boxId !== boxId && !entry.toldBot);
      if (!owed.length) return null;
      write(entries.map((entry) => owed.includes(entry) ? { ...entry, toldBot: true as const, toldPerson: true as const } : entry));
      if (owed.some((entry) => !entry.toldPerson && !entry.manual)) deps.tell(owner, "replaced");
      return owed.every((entry) => entry.manual) ? CLOUD_COMPUTER_REPLACED_BY_PERSON : CLOUD_COMPUTER_REPLACED;
    },
    /** A start the Admin turned away for computers at once, right after this owner's computer was replaced: the old one's
     * place is still being given back. */
    claimSentence(owner: string, error: unknown): string | undefined {
      const recent = read().some((entry) => entry.owner === owner && now() - entry.at < 15 * 60_000);
      return recent && cloudFailureOf(error).limit?.reason === "at_once" ? CLOUD_COMPUTER_NOT_RESPONDING : undefined;
    },
    /** Its computer is being handled here, is dead at the provider, or has stopped answering. */
    stuck(owner: string): boolean {
      const box = boat.boatIdOf(owner);
      return states.has(owner) || boat.deadBoatOf(owner) !== null || (box !== null && health.notRespondingSince(box) !== null);
    },
    /** The panel's Restart computer: the same restart the automatic path tries first. */
    async restart(owner: string): Promise<{ answers: boolean }> {
      const found = await boat.findBoat(deps.cfg(), owner);
      if (!found) throw Object.assign(new Error(boat.deadBoatOf(owner) ? "This computer can't be restarted; replace it instead." : "This bot has no cloud computer to restart."), { status: 409 });
      const outcome = await lane(owner, () => restart(owner, found.id, true));
      if (outcome === "answers") {
        set(owner, found.id, "restarted", true);
        return { answers: true };
      }
      clear(owner, found.id);
      return { answers: false };
    },
    /** The panel's Replace computer, confirmed by the person: the same deletion the automatic path makes, with no hourly limit. */
    async replace(owner: string): Promise<{ replaced: boolean }> {
      const found = (await boat.findBoat(deps.cfg(), owner)) ?? boat.deadBoatOf(owner);
      if (!found) throw Object.assign(new Error("This bot has no cloud computer to replace."), { status: 409 });
      const target = "boxId" in found ? found as Dead : { boxId: String(found.id), name: String(found.name) };
      const outcome = await lane(owner, () => replace(owner, target, { manual: true }));
      if (outcome === "failed") throw Object.assign(new Error("The old computer's deletion was not confirmed. Try again in a minute."), { status: 503 });
      return { replaced: true };
    },
    close(): void {
      closed = true;
      unsubscribe();
      boat.onDeadBoat(null);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

export type BoatRecovery = ReturnType<typeof createBoatRecovery>;
