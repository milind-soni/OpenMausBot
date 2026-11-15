// A cloud computer that stopped answering: restarted once, then replaced (its deletion frees the plan's place, and the next
// use creates a new one), and the bot and the person are told once. Nothing here asks the person anything.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import * as boat from "./boat.ts";
import { BOAT_DELETING, BOAT_DELETION_FINISHED, getBoatDeletion } from "./boat-delete-journal.ts";
import { boatHealth, DEAD_COMPUTER, type BoatHealth } from "./boat-health.ts";
import { cloudFailureOf } from "./boat-limit.ts";
import { DATA_DIR, type AppConfig } from "./config.ts";
import {
  CLOUD_COMPUTER_CAPPED, CLOUD_COMPUTER_DEAD_WAITING, CLOUD_COMPUTER_NEEDS_PERSON, CLOUD_COMPUTER_NOT_RESPONDING, CLOUD_COMPUTER_REPLACED,
  CLOUD_COMPUTER_REPLACED_BY_PERSON, CLOUD_COMPUTER_RESTARTED, CLOUD_COMPUTER_TEAM_NOT_RESPONDING, CLOUD_COMPUTER_UNREACHABLE, recoveryUnderWay,
  type CloudComputerPersonLine, type CloudComputerRecovery, type CloudComputerRecoveryState,
} from "../shared/cloud-computer-recovery.ts";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const KEPT_MS = DAY_MS;
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

/** Whether a dead computer is deleted and replaced without the person. Off unless OMB_CLOUD_COMPUTER_AUTO_REPLACE is "1" or
 * config.json has `"features": {"cloudComputerAutoReplace": true}`; the environment, "1" or "0", wins. Off by default until
 * the provider confirms that deleting a computer whose host is unreachable is safe for the rest of the account. */
export function cloudComputerAutoReplace(cfg: Pick<AppConfig, "features">, env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env.OMB_CLOUD_COMPUTER_AUTO_REPLACE?.trim();
  if (override === "1") return true;
  if (override === "0") return false;
  return cfg.features?.cloudComputerAutoReplace === true;
}

export interface BoatRecoveryDeps {
  cfg(): AppConfig;
  /** Posts the person's line: in a bot's chat and Inbox, or for a team's computer where its admins see it (the Team map). */
  tell(owner: string, line: CloudComputerPersonLine): void;
  changed?(owner: string): void;
  log(line: string): void;
  /** Only a bot's own computer is ever restarted or deleted by itself; a team's shared one is only reported. */
  eligible?(owner: string): boolean;
  /** A person is driving or viewing this owner's desktop now. */
  personActive?(owner: string): boolean;
  file?: string;
  now?: () => number;
  health?: BoatHealth;
  pollMs?: number;
  autoReplace?: () => boolean;
}

type Dead = { boxId: string; name: string };
type ReplaceOutcome = "confirmed" | "pending" | "kept" | "held" | "waiting" | "capped" | "failed";

export function createBoatRecovery(deps: BoatRecoveryDeps) {
  const health = deps.health ?? boatHealth;
  const now = deps.now ?? Date.now;
  const file = deps.file ?? join(DATA_DIR, "boat-replacements.json");
  const pollMs = deps.pollMs ?? POLL_MS;
  const autoReplace = deps.autoReplace ?? (() => cloudComputerAutoReplace(deps.cfg()));
  const eligible = (owner: string) => deps.eligible?.(owner) ?? true;
  const states = new Map<string, CloudComputerRecovery & { boxId: string }>();
  const lanes = new Map<string, Promise<unknown>>();
  const restarts = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const retired = new Set<string>();
  /** Lines already told about a computer still not answering, so a long outage is reported once. */
  const told = new Map<string, Set<CloudComputerPersonLine>>();
  const restartedOwners = new Set<string>();
  const restartToldAt = new Map<string, number>();
  /** When the provider's `error` was first seen for each computer. */
  const errorSeen = new Map<string, number>();
  let lastAutoRestartAt = -Infinity;
  let closed = false;

  const load = (): Replacement[] => {
    try {
      const parsed = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
      return Array.isArray(parsed) ? parsed.filter((entry): entry is Replacement => typeof entry?.owner === "string"
        && typeof entry.boxId === "string" && typeof entry.at === "number") : [];
    } catch {
      return [];
    }
  };
  let entries = load();
  const write = (next: Replacement[]) => {
    entries = next.filter((entry) => now() - entry.at < KEPT_MS);
    writeFileAtomic(file, JSON.stringify(entries));
  };
  const update = (boxId: string, patch: Partial<Replacement>) => write(entries.map((entry) => entry.boxId === boxId ? { ...entry, ...patch } : entry));

  const set = (owner: string, boxId: string, state: CloudComputerRecoveryState, manual = false) => {
    states.set(owner, { state, at: now(), boxId, ...(manual ? { manual: true as const } : {}) });
    deps.changed?.(owner);
  };
  const clear = (owner: string, boxId: string) => {
    told.delete(boxId);
    errorSeen.delete(boxId);
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
  const needsPerson = (owner: string, boxId: string) =>
    tellOnce(owner, boxId, "needs-person", eligible(owner) ? "needsPerson" : "teamNotResponding");
  const personBusy = (owner: string, boxId: string) =>
    deps.personActive?.(owner) === true || health.personUsedWithin(boxId, DEAD_COMPUTER.personGraceMs);
  /** The provider's `error`, seen now: true once it was also seen at least DEAD_COMPUTER.deadConfirmMs earlier. */
  const deadConfirmed = (boxId: string) => {
    const first = errorSeen.get(boxId);
    if (first === undefined) errorSeen.set(boxId, now());
    return first !== undefined && now() - first >= DEAD_COMPUTER.deadConfirmMs;
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
    if ((await boat.probeBoat(cfg, boxId)) !== true) return "no-answer";
    health.answered(boxId);
    return "answers";
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

  /** `dead` is the provider's word that the machine is gone; otherwise this computer only stopped answering. */
  async function replace(owner: string, target: Dead, opts: { manual?: boolean; dead?: boolean } = {}): Promise<ReplaceOutcome> {
    const cfg = deps.cfg();
    const recorded = entries.find((entry) => entry.boxId === target.boxId);
    // Only a delete already fenced on disk is finished without asking again.
    const fenced = Boolean(recorded && getBoatDeletion(target.boxId));
    if (!opts.manual) {
      if (!eligible(owner)) { needsPerson(owner, target.boxId); return "held"; }
      if (!fenced && health.answeredWithin(target.boxId, DEAD_COMPUTER.answeredGraceMs)) { clear(owner, target.boxId); return "kept"; }
      if (!autoReplace()) {
        needsPerson(owner, target.boxId);
        deps.log(`cloud computer ${owner}: ${target.boxId} is ${opts.dead ? "dead" : "not responding"}; automatic replacement is off, so it waits for the person`);
        return "held";
      }
      if (!fenced) {
        if (personBusy(owner, target.boxId)) { needsPerson(owner, target.boxId); return "held"; }
        if (opts.dead && !deadConfirmed(target.boxId)) { needsPerson(owner, target.boxId); return "waiting"; }
        if (!(await listWorks(cfg))) { unreachable(owner, target.boxId); return "held"; }
        const automatic = entries.filter((entry) => !entry.manual && entry.boxId !== target.boxId && now() - entry.at < HOUR_MS);
        if (automatic.filter((entry) => entry.owner === owner).length >= DEAD_COMPUTER.replacementsPerHour) {
          tellOnce(owner, target.boxId, "capped", "capped");
          deps.log(`cloud computer ${owner}: ${target.boxId} was already replaced in the last hour; left as it is`);
          return "capped";
        }
        if (automatic.length >= DEAD_COMPUTER.installationDeletesPerHour) {
          needsPerson(owner, target.boxId);
          deps.log(`cloud computer ${owner}: ${target.boxId} left for the person: this installation already deleted a computer by itself in the last hour`);
          return "held";
        }
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
    if (outcome === "failed") {
      if (!getBoatDeletion(target.boxId)) retired.delete(target.boxId);
      return outcome;
    }
    set(owner, target.boxId, "replaced", opts.manual);
    if (!opts.manual) {
      deps.tell(owner, "replaced");
      update(target.boxId, { toldPerson: true });
    }
    deps.log(`cloud computer ${owner}: replaced ${target.boxId} (${opts.manual ? "asked for" : opts.dead ? "the provider reports it in error" : "not responding"})`);
    return outcome;
  }

  /** A fresh probe that got no answer, with the provider's list working; null when that is not so (the outcome is reported). */
  async function stillDown(owner: string, boxId: string, cfg: AppConfig): Promise<boolean> {
    const probe = await boat.probeBoat(cfg, boxId);
    if (probe !== false) {
      if (probe) health.answered(boxId);
      clear(owner, boxId);
      return false;
    }
    if (!(await listWorks(cfg))) { unreachable(owner, boxId); return false; }
    // An installation whose other computers do not answer either cannot tell a dead machine from its own outage.
    if (!health.otherAnsweredWithin(boxId, DEAD_COMPUTER.witnessMs)) { needsPerson(owner, boxId); return false; }
    return true;
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
    if (!(await stillDown(owner, boxId, cfg))) return;
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
    // Every guard before a stop: it closes the person's programs, and three failed probes can be this home's own outage.
    if (!(await stillDown(owner, boxId, cfg))) return;
    const lastRestart = restarts.get(boxId);
    if ((lastRestart === undefined || now() - lastRestart >= HOUR_MS) && now() - lastAutoRestartAt >= DEAD_COMPUTER.restartGapMs && !personBusy(owner, boxId)) {
      lastAutoRestartAt = now();
      const restarted = await restart(owner, boxId);
      if (restarted === "answers") {
        set(owner, boxId, "restarted");
        told.delete(boxId);
        if (now() - (restartToldAt.get(boxId) ?? -Infinity) >= DAY_MS) {
          restartToldAt.set(boxId, now());
          deps.tell(owner, "restarted");
        }
        restartedOwners.add(owner);
        return;
      }
    }
    return decide(owner, boxId);
  }

  const unsubscribe = health.onNotResponding((boxId) => {
    const owner = boat.boatOwnerOf(boxId);
    if (!owner || closed) return;
    if (!eligible(owner)) return needsPerson(owner, boxId);
    if (lanes.has(owner) || timers.has(owner)) return;
    set(owner, boxId, "not-responding");
    void lane(owner, () => notResponding(owner, boxId)).catch((error) => deps.log(`cloud computer ${owner}: recovery failed: ${String(error)}`));
  });

  boat.onDeadBoat(async (_cfg, owner, dead): Promise<never> => {
    if (!eligible(owner)) {
      needsPerson(owner, dead.boxId);
      throw Object.assign(new Error(CLOUD_COMPUTER_TEAM_NOT_RESPONDING), { status: 409 });
    }
    const outcome = await lane(owner, () => replace(owner, dead, { dead: true }));
    if (outcome === "capped") {
      throw Object.assign(new Error("it stopped working within an hour of being replaced, and MausBot replaces it at most once an hour; Replace computer in the computer panel tries once more"), { status: 409 });
    }
    if (outcome === "kept") throw Object.assign(new Error(CLOUD_COMPUTER_NOT_RESPONDING), { status: 409 });
    if (outcome === "waiting") throw Object.assign(new Error(CLOUD_COMPUTER_DEAD_WAITING), { status: 409 });
    if (outcome === "held") throw Object.assign(new Error(CLOUD_COMPUTER_NEEDS_PERSON), { status: 409 });
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
        : age >= HOUR_MS || (["unreachable", "capped", "needs-person"].includes(found.state) && health.answeredWithin(found.boxId, age));
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
      if (found?.boxId === boxId && found.state === "needs-person") return eligible(owner!) ? CLOUD_COMPUTER_NEEDS_PERSON : CLOUD_COMPUTER_TEAM_NOT_RESPONDING;
      return health.notRespondingSince(boxId) === null ? null : CLOUD_COMPUTER_NOT_RESPONDING;
    },
    /** Told once, with the first call on the owner's computer after a replacement or a restart. */
    notice(boxId: string): string | null {
      const owner = boat.boatOwnerOf(boxId);
      if (!owner) return null;
      if (restartedOwners.delete(owner)) return CLOUD_COMPUTER_RESTARTED;
      const owed = entries.filter((entry) => entry.owner === owner && entry.boxId !== boxId && !entry.toldBot);
      if (!owed.length) return null;
      write(entries.map((entry) => owed.includes(entry) ? { ...entry, toldBot: true as const, toldPerson: true as const } : entry));
      if (owed.some((entry) => !entry.toldPerson && !entry.manual)) deps.tell(owner, "replaced");
      return owed.every((entry) => entry.manual) ? CLOUD_COMPUTER_REPLACED_BY_PERSON : CLOUD_COMPUTER_REPLACED;
    },
    /** A start the Admin turned away for computers at once, right after this owner's computer was replaced: the old one's
     * place is still being given back. */
    claimSentence(owner: string, error: unknown): string | undefined {
      const recent = entries.some((entry) => entry.owner === owner && now() - entry.at < 15 * 60_000);
      return recent && cloudFailureOf(error).limit?.reason === "at_once" ? CLOUD_COMPUTER_NOT_RESPONDING : undefined;
    },
    /** Its computer is dead at the provider, has stopped answering, or is being handled here: what lets the person act
     * during a turn. A computer that came back (restarted, or already replaced) is not stuck. */
    stuck(owner: string): boolean {
      const box = boat.boatIdOf(owner), state = states.get(owner)?.state;
      return (state !== undefined && state !== "restarted" && state !== "replaced") || boat.deadBoatOf(owner) !== null
        || (box !== null && health.notRespondingSince(box) !== null);
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
