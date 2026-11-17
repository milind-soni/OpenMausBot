// A cloud computer that stopped answering: waited for while the provider is still restoring its disk, restarted (which
// keeps its files), and only then, if it is still silent and every guard holds, set aside: stopped with its files,
// renamed so it is no longer the bot's, and kept for DEAD_COMPUTER.setAsideKeepMs while the bot gets a new one
// (boat-set-aside.ts). Nothing here deletes a computer by itself, except a set-aside one whose time is up, and one the
// provider reports broken that cannot even be stopped. A computer woken for a turn that stays silent past the wake's
// patience goes the same way, inside the turn (wakeTimedOut). The bot and the person are told once. Nothing here asks
// the person anything.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import * as boat from "./boat.ts";
import { BOAT_DELETING, BOAT_DELETION_FINISHED, getBoatDeletion } from "./boat-delete-journal.ts";
import { boatHealth, DEAD_COMPUTER, stalledProbe, type BoatHealth } from "./boat-health.ts";
import { boatReadiness, boatSignals, readBoat, READY_WAIT, type BoatReadiness } from "./boat-ready.ts";
import { deleteExpiredSetAside, setAsideBoat, setAsideBoatName, type SetAsideDeps } from "./boat-set-aside.ts";
import { cloudComputerCounters } from "./cloud-computer-counters.ts";
import { cloudFailureOf } from "./boat-limit.ts";
import { DATA_DIR, type AppConfig } from "./config.ts";
import { eventLoopStalls } from "./event-loop-stalls.ts";
import {
  CLOUD_COMPUTER_CAPPED, CLOUD_COMPUTER_DEAD_WAITING, CLOUD_COMPUTER_NEEDS_PERSON, CLOUD_COMPUTER_NOT_RESPONDING, CLOUD_COMPUTER_NOT_RESPONDING_UNANSWERED,
  CLOUD_COMPUTER_REPLACED, CLOUD_COMPUTER_REPLACED_BY_PERSON, CLOUD_COMPUTER_RESTARTED, CLOUD_COMPUTER_RESTARTING, CLOUD_COMPUTER_RESTARTING_UNANSWERED,
  CLOUD_COMPUTER_RESTORING, CLOUD_COMPUTER_STILL_RESTORING, CLOUD_COMPUTER_TEAM_NOT_RESPONDING, CLOUD_COMPUTER_UNREACHABLE, cloudComputerSetAsideNotice, recoveryUnderWay,
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
/** How often a computer that is waited on before a restart (a disk restore, too short a silence, an unread state) is looked at again. */
const RECHECK_MS = 30_000;
/** How often a silent computer that may not be set aside yet is probed and looked at again. */
const SET_ASIDE_RECHECK_MS = 2 * 60_000;
/** After the plan had no room for a new computer, none is tried again for this long. */
const NO_ROOM_BACKOFF_MS = 6 * HOUR_MS;
/** How often set-aside computers whose time is up are looked for. */
const SWEEP_MS = HOUR_MS;
/** With no other computer to compare against, a silent one is restarted only after this long without one answer. */
const SOLO_SILENCE_MS = 5 * 60_000;
/** A restart the person asked for answers the panel within this, however long the disk takes. */
const MANUAL_ANSWER_WAIT_MS = 3 * 60_000;
const READY = new Set(["idle", "ready", "running"]);

/** One replacement, written before it is acted on: a crash after it still counts against the limits and still owes the
 * bot and the person their line. `setAside`: the old computer was set aside under `name`, kept until `until`, and the bot
 * given `newBoxId`; without it the old one was deleted (the person's Replace computer, or a broken one that could not be
 * stopped). `undone`: a set-aside that did not happen or was put back; it still counts against the limits. */
interface Replacement {
  owner: string;
  boxId: string;
  at: number;
  manual?: true;
  toldBot?: true;
  toldPerson?: true;
  setAside?: { name: string; until: number; newBoxId?: string };
  undone?: true;
}

const ON = new Set(["1", "true", "on", "yes"]), OFF = new Set(["0", "false", "off", "no"]);

/** Whether a silent computer is set aside and replaced without the person. On unless OMB_CLOUD_COMPUTER_AUTO_REPLACE is
 * off ("0", "false", "off" or "no") or config.json has `"features": {"cloudComputerAutoReplace": false}`; the
 * environment wins. Off, a silent computer is still restarted, and otherwise waits for the person's Replace computer. */
export function cloudComputerAutoReplace(cfg: Pick<AppConfig, "features">, env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env.OMB_CLOUD_COMPUTER_AUTO_REPLACE?.trim().toLowerCase();
  if (override && ON.has(override)) return true;
  if (override && OFF.has(override)) return false;
  return cfg.features?.cloudComputerAutoReplace !== false;
}

/** The turn a wait is made for, and what it hears meanwhile. */
export interface WakeTimeoutContext {
  turn?: { threadId: string; generation: string };
  onRestarting?(): void;
  /** Called only once every guard passed and the computer is being set aside. */
  onReplacing?(): void;
}

export interface BoatRecoveryDeps {
  cfg(): AppConfig;
  /** Posts the person's line: in a bot's chat and Inbox, or for a team's computer where its admins see it (the Team map). */
  tell(owner: string, line: CloudComputerPersonLine, vars?: Record<string, string>): void;
  changed?(owner: string): void;
  log(line: string): void;
  /** Only a bot's own computer is ever restarted or set aside by itself; a team's shared one is only reported. */
  eligible?(owner: string): boolean;
  /** A person is driving or viewing this owner's desktop now. */
  personActive?(owner: string): boolean;
  /** A running turn other than this bot's own (or than `asking`) holds this computer: it is never set aside then. */
  usedByOther?(owner: string, boxId: string, asking?: { threadId: string; generation: string }): boolean;
  /** A new computer was made for this owner here: its idle window starts, so it does not stay on unused. */
  created?(owner: string): void;
  file?: string;
  now?: () => number;
  health?: BoatHealth;
  pollMs?: number;
  autoReplace?: () => boolean;
  readiness?: Pick<BoatReadiness, "awaitAnswer">;
  /** A turn is waiting for this computer to answer, and goes on to restart it and set it aside itself (wakeTimedOut):
   * the background recovery leaves it alone meanwhile. A scheduled run's wait is not one: it relies on the background. */
  turnWaiting?(boxId: string): boolean;
  /** The provider's sandbox object, for its state and what it says about a disk restore; null when it could not be read. */
  read?(cfg: AppConfig, boxId: string): Promise<unknown>;
  recheckMs?: number;
  /** How long a restart waits for the provider to report the computer ready again (WAKE_BUDGET_MS). */
  wakeBudgetMs?: number;
  /** How often a silent computer that may not be set aside yet is looked at again (SET_ASIDE_RECHECK_MS). */
  setAsideRecheckMs?: number;
  /** This process's event loop stalled between the two times. */
  stalled?(from: number, to: number): boolean;
  provision?: SetAsideDeps["provision"];
}

/** Why a computer that is not answering was left as it is, for a run that waited on it. */
export type RecoveryVerdict = "restart-failed" | "person-busy" | "restart-limited" | "shared";

type Dead = { boxId: string; name: string };
type DeleteOutcome = "confirmed" | "pending" | "failed";
/** What became of an attempt to set a computer aside. */
type SetAsideResult = "set-aside" | "deleted" | "deleting" | "capped" | "held" | "no-room" | "stop-refused" | "rename-failed" | "create-failed" | "lost" | "failed";

/** What became of a computer that was woken for a turn and stayed silent past the wake's patience. `answers`: it answers
 * (a last probe, or a restart). `replaced`: it was set aside and the bot has a new one. `gone`: it no longer exists, so
 * the next start makes a new one. `kept`: it was left the bot's, and `why` says so for the turn: a passing failure. */
export type WakeTimeoutOutcome = { kind: "answers" | "replaced" | "gone" } | { kind: "kept"; why: string };

const LATER = "MausBot keeps trying in the background; trying again later is fine";
const kept = (why: string): WakeTimeoutOutcome => ({ kind: "kept", why });
const silentWhy = (restarted: boolean) =>
  `the cloud computer is still not answering${restarted ? ", even after a restart" : ""}. ${LATER}`;
const KEPT_WHY: Record<Exclude<SetAsideResult, "set-aside" | "deleted" | "deleting">, string> = {
  capped: `the cloud computer is still not answering after a restart, and this bot already got a new computer recently (at most once an hour and three times a day), so the old one was left as it is. ${LATER}`,
  held: `the cloud computer is still not answering after a restart, and it could not be set aside by itself right now (someone is using it, or this installation already replaced a computer in the last hour), so it was left as it is. ${LATER}`,
  "no-room": `the cloud computer is still not answering after a restart, and the plan has no room for a new computer beside it, so MausBot kept it, stopped and with its files. ${LATER}`,
  "stop-refused": `the cloud computer is still not answering after a restart; MausBot asked to set it aside, but the provider would not stop it, so nothing else was changed. ${LATER}`,
  "rename-failed": `the cloud computer is still not answering after a restart; MausBot stopped it to set it aside but could not, so it stays this bot's computer with its files and wakes again on its next use. ${LATER}`,
  "create-failed": `the cloud computer is still not answering after a restart, and MausBot could not make a new one beside it, so the old one stays this bot's computer, stopped and with its files; it wakes again on its next use. ${LATER}`,
  lost: `the cloud computer is still not answering after a restart; MausBot set it aside, with its files, but could not make a new one or give the old one back, so the person finds it in Settings → Desktops & browser → Desktops. ${LATER}`,
  failed: `the cloud computer is still not answering, and replacing it failed: the old computer's deletion was not confirmed. ${LATER}`,
};

export function createBoatRecovery(deps: BoatRecoveryDeps) {
  const health = deps.health ?? boatHealth;
  const now = deps.now ?? Date.now;
  const file = deps.file ?? join(DATA_DIR, "boat-replacements.json");
  const pollMs = deps.pollMs ?? POLL_MS;
  const autoReplace = deps.autoReplace ?? (() => cloudComputerAutoReplace(deps.cfg()));
  const eligible = (owner: string) => deps.eligible?.(owner) ?? true;
  const readiness = deps.readiness ?? boatReadiness;
  const read = deps.read ?? readBoat;
  // Watched from now on, so a stall before the first decision is seen too.
  const stalls = deps.stalled ? null : eventLoopStalls();
  const stalled = deps.stalled ?? ((from: number, to: number) => stalls!.stalledBetween(from, to));
  /** When each computer was first seen not answering with its disk still being restored. */
  const restoringSince = new Map<string, number>();
  const recheckMs = deps.recheckMs ?? RECHECK_MS;
  const setAsideRecheckMs = deps.setAsideRecheckMs ?? SET_ASIDE_RECHECK_MS;
  const verdicts = new Map<string, { boxId: string; why: RecoveryVerdict; at: number }>();
  const judge = (owner: string, boxId: string, why: RecoveryVerdict) => verdicts.set(owner, { boxId, why, at: now() });
  const states = new Map<string, CloudComputerRecovery & { boxId: string }>();
  const lanes = new Map<string, Promise<unknown>>();
  const restarts = new Map<string, number>();
  /** When a restart's own wait for an answer ran out, per computer: only that is a restart that did not help. */
  const restartFailedAt = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const retired = new Set<string>();
  /** Lines already told about a computer still not answering, so a long outage is reported once. */
  const told = new Map<string, Set<CloudComputerPersonLine>>();
  const restartedOwners = new Set<string>();
  const restartToldAt = new Map<string, number>();
  /** When the provider's `error` was first seen for each computer. */
  const errorSeen = new Map<string, number>();
  /** Why each owner's silent computer was last not set aside, so the log says it once. */
  const blockedWhy = new Map<string, string>();
  let lastAutoRestartAt = -Infinity;
  let noRoomAt = -Infinity;
  let closed = false;

  /** A file that cannot be read keeps every automatic replacement off (`unreadable`): its limits cannot be told. */
  let unreadable = false;
  const load = (): Replacement[] => {
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("not a list");
      return parsed.filter((entry): entry is Replacement => typeof entry?.owner === "string" && typeof entry.boxId === "string" && typeof entry.at === "number");
    } catch {
      unreadable = true;
      return [];
    }
  };
  let entries = load();
  if (unreadable) deps.log(`cloud computers: ${file} could not be read, so no computer is set aside or replaced by itself until it can be`);
  // A set-aside computer stays listed until its deletion, however old the entry.
  const keep = (entry: Replacement) => now() - entry.at < KEPT_MS || (entry.setAside !== undefined && !entry.undone);
  const write = (next: Replacement[]) => {
    entries = next.filter(keep);
    if (!unreadable) writeFileAtomic(file, JSON.stringify(entries));
  };
  const update = (boxId: string, patch: Partial<Replacement>) => write(entries.map((entry) => entry.boxId === boxId ? { ...entry, ...patch } : entry));

  const set = (owner: string, boxId: string, state: CloudComputerRecoveryState, manual = false) => {
    states.set(owner, { state, at: now(), boxId, ...(manual ? { manual: true as const } : {}) });
    deps.changed?.(owner);
  };
  const clear = (owner: string, boxId: string) => {
    if (verdicts.get(owner)?.boxId === boxId) verdicts.delete(owner);
    restoringSince.delete(boxId);
    told.delete(boxId);
    errorSeen.delete(boxId);
    blockedWhy.delete(owner);
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
  const needsPerson = (owner: string, boxId: string) => {
    if (!eligible(owner)) judge(owner, boxId, "shared");
    tellOnce(owner, boxId, "needs-person", eligible(owner) ? "needsPerson" : "teamNotResponding");
  };
  const personBusy = (owner: string, boxId: string) =>
    deps.personActive?.(owner) === true || health.personUsedWithin(boxId, DEAD_COMPUTER.personGraceMs);
  /** The provider's `error`, seen now: true once it was also seen at least DEAD_COMPUTER.deadConfirmMs earlier. */
  const deadConfirmed = (boxId: string) => {
    const first = errorSeen.get(boxId);
    if (first === undefined) errorSeen.set(boxId, now());
    return first !== undefined && now() - first >= DEAD_COMPUTER.deadConfirmMs;
  };
  const dateOf = (at: number) => new Date(at).toISOString().slice(0, 10);

  /** One recovery at a time per owner, in the order asked. */
  function lane<T>(owner: string, work: () => Promise<T>): Promise<T> {
    const started = (lanes.get(owner) ?? Promise.resolve()).catch(() => undefined).then(work);
    const settled = started.finally(() => { if (lanes.get(owner) === settled) lanes.delete(owner); });
    lanes.set(owner, settled);
    return started;
  }

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** `no-answer`: it woke, and its wait for an answer ran out, the only restart that did not help. `not-ready`: the
   * provider did not report it ready again in time, which says nothing about the machine. */
  async function restart(owner: string, boxId: string, manual = false): Promise<"answers" | "no-answer" | "not-ready" | "refused"> {
    const cfg = deps.cfg();
    set(owner, boxId, "restarting", manual);
    restarts.set(boxId, now());
    const started = now();
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
    const woken = await boat.readyBoat(cfg, owner, deps.wakeBudgetMs ?? WAKE_BUDGET_MS).catch(() => null);
    if (!woken || woken.id !== boxId) return "not-ready";
    health.woke(boxId);
    // The provider reports a resumed computer ready before it answers, so one probe right after the resume proves nothing.
    const answer = await readiness.awaitAnswer(cfg, boxId, { woke: true, ...(manual ? { deadline: now() + MANUAL_ANSWER_WAIT_MS } : {}) });
    cloudComputerCounters.count(boxId, "restarts", now() - started);
    if (!answer.ok) {
      restartFailedAt.set(boxId, now());
      return "no-answer";
    }
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
    deps.log(`cloud computer ${owner}: ${boxId} is not responding, and the provider can't be shown to be up; nothing was changed`);
  }

  /** A probe whose time is recorded with it: one this process held up past its timeout counts neither way. */
  async function probe(cfg: AppConfig, boxId: string): Promise<boolean | null> {
    const sent = now();
    const answered = await boat.probeBoat(cfg, boxId);
    if (answered === true) health.answered(boxId);
    if (answered !== false) return answered;
    const sample = { elapsedMs: now() - sent, timeoutMs: DEAD_COMPUTER.probeTimeoutMs };
    health.unanswered(boxId, sample);
    return stalledProbe(sample) ? null : false;
  }

  /** Every condition for setting a silent computer aside, the last a fresh probe. `answers` and `unreachable` end the
   * wait; any other reason leaves it for later. */
  async function setAsideBlocked(owner: string, boxId: string, cfg: AppConfig, asking?: WakeTimeoutContext["turn"]): Promise<null | { why: string; answers?: true; unreachable?: true; person?: true }> {
    if (unreadable) return { why: "the record of earlier replacements could not be read" };
    if (now() - noRoomAt < NO_ROOM_BACKOFF_MS) return { why: "the plan had no room for a new computer in the last hours" };
    if (personBusy(owner, boxId) || deps.usedByOther?.(owner, boxId, asking) === true) return { why: "a person or another turn is using it", person: true };
    const silentSince = health.silentSince(boxId), failedAt = restartFailedAt.get(boxId);
    // A restart's own wait that ran out during this silence; a restart the provider never reported ready does not count.
    if (silentSince === null || failedAt === undefined || failedAt < silentSince) return { why: "no restart has been tried and failed during this silence" };
    const box = await read(cfg, boxId);
    const state = box && typeof box === "object" ? (box as { state?: unknown }).state : undefined;
    if (typeof state !== "string" || !READY.has(state)) return { why: `the provider reports it ${typeof state === "string" ? state : "in a state it could not read"}` };
    const restoring = boatSignals(box).restoring, wokeAt = health.wokeAt(boxId);
    if (restoring === true) return { why: "the provider is still restoring its disk" };
    if (restoring === null && (wokeAt === null || now() - wokeAt < DEAD_COMPUTER.unknownRestoreMs)) {
      return { why: "the provider does not say whether its disk is back, and it was resumed less than 30 minutes ago" };
    }
    // Several probes after the patience, spread over minutes: not one sample.
    const probes = health.silencesSince(boxId, wokeAt ?? failedAt);
    if (probes.count < DEAD_COMPUTER.setAsideProbes || probes.last! - probes.first! < DEAD_COMPUTER.setAsideProbeSpanMs) return { why: "too few unanswered probes since its restart" };
    if (stalled(wokeAt ?? failedAt, now())) return { why: "this process stalled while the computer was probed" };
    const witnessed = health.otherAnsweredWithin(boxId, DEAD_COMPUTER.freshWitnessMs);
    if (!witnessed && health.othersSilentWithin(boxId, DEAD_COMPUTER.witnessMs)) return { why: "the installation's other computers are silent too", unreachable: true };
    if (!witnessed && now() - silentSince < DEAD_COMPUTER.loneSilenceMs) {
      return { why: "no other computer answered in the last two minutes, and it has been silent less than 30 minutes" };
    }
    if (!(await listWorks(cfg))) return { why: "the provider's list does not answer", unreachable: true };
    const last = await probe(cfg, boxId);
    if (last === true) return { why: "it answers", answers: true };
    if (last === null) return { why: "a last probe was turned away or held up here" };
    return null;
  }

  /** The limits, counted before anything is done: null when they allow one more. */
  function limited(owner: string, boxId: string): "capped" | "held" | null {
    const automatic = entries.filter((entry) => !entry.manual && entry.boxId !== boxId && now() - entry.at < HOUR_MS);
    const today = entries.filter((entry) => !entry.manual && entry.boxId !== boxId && entry.owner === owner && now() - entry.at < DAY_MS);
    if (automatic.filter((entry) => entry.owner === owner).length >= DEAD_COMPUTER.replacementsPerHour || today.length >= DEAD_COMPUTER.replacementsPerDay) {
      tellOnce(owner, boxId, "capped", "capped");
      deps.log(`cloud computer ${owner}: ${boxId} was already replaced in the last hour, or three times today; left as it is`);
      return "capped";
    }
    if (automatic.length >= DEAD_COMPUTER.installationDeletesPerHour) {
      needsPerson(owner, boxId);
      deps.log(`cloud computer ${owner}: ${boxId} left for the person: this installation already replaced a computer by itself in the last hour`);
      return "held";
    }
    return null;
  }

  /** The DELETE, for the person's Replace computer and a broken computer that cannot be stopped; its entry is written. */
  async function remove(owner: string, target: Dead, manual: boolean): Promise<DeleteOutcome> {
    const cfg = deps.cfg();
    retired.add(target.boxId);
    let outcome: DeleteOutcome;
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
    set(owner, target.boxId, "replaced", manual);
    if (!manual) {
      deps.tell(owner, "replaced");
      update(target.boxId, { toldPerson: true });
    }
    deps.log(`cloud computer ${owner}: deleted ${target.boxId} (${manual ? "asked for" : "the provider reports it broken, and it could not be stopped"})`);
    return outcome;
  }

  /** Sets the computer aside and makes the bot a new one, within the limits, which are written first. `dead`: the
   * provider reports it broken; one that cannot even be stopped is deleted instead, as before. The caller checked the
   * other guards. Never sends a DELETE for a computer that could be stopped. */
  async function setAside(owner: string, target: Dead, opts: { dead?: boolean; onReplacing?: () => void } = {}): Promise<SetAsideResult> {
    const cfg = deps.cfg();
    if (unreadable) { needsPerson(owner, target.boxId); return "held"; }
    const limit = limited(owner, target.boxId);
    if (limit) return limit;
    const at = now(), name = await setAsideBoatName(owner, at), until = at + DEAD_COMPUTER.setAsideKeepMs;
    write([...entries.filter((entry) => entry.boxId !== target.boxId), { owner, boxId: target.boxId, at, setAside: { name, until } }]);
    opts.onReplacing?.();
    set(owner, target.boxId, "replacing");
    deps.log(`cloud computer ${owner}: setting ${target.boxId} aside as ${name}${opts.dead ? " (the provider reports it broken)" : ""}`);
    const result = await setAsideBoat(cfg, owner, target, name, { log: deps.log, provision: deps.provision });
    if (result.kind === "set-aside") {
      retired.add(target.boxId);
      health.forget(target.boxId);
      update(target.boxId, { setAside: { name, until, newBoxId: result.newBoxId }, toldPerson: true });
      set(owner, target.boxId, "replaced");
      deps.tell(owner, "setAside", { date: dateOf(until) });
      deps.created?.(owner);
      deps.log(`cloud computer ${owner}: ${target.boxId} set aside as ${name} until ${dateOf(until)}; the bot's new computer is ${result.newBoxId}`);
      return "set-aside";
    }
    if (result.kind === "stop-refused" && opts.dead) {
      // A broken computer the provider will not even stop: deleted, as before.
      update(target.boxId, { setAside: undefined });
      const deleted = await remove(owner, target, false);
      return deleted === "failed" ? "failed" : deleted === "confirmed" ? "deleted" : "deleting";
    }
    if ((result.kind === "no-room" || result.kind === "create-failed") && !result.restored) {
      // Still set aside, and the bot has no computer: it is never deleted by itself (`undone`), only by the person, who
      // finds it in Settings.
      retired.add(target.boxId);
      update(target.boxId, { undone: true });
      needsPerson(owner, target.boxId);
      return "lost";
    }
    update(target.boxId, { undone: true });
    if (result.kind === "no-room") {
      noRoomAt = now();
      tellOnce(owner, target.boxId, "needs-person", "noRoom");
      deps.log(`cloud computer ${owner}: ${target.boxId} kept: the plan has no room for a new computer beside it (${result.reason})`);
    } else {
      set(owner, target.boxId, "not-responding");
      deps.log(`cloud computer ${owner}: ${target.boxId} was not set aside: ${"reason" in result ? result.reason : result.kind}`);
    }
    return result.kind;
  }

  /** The provider reports this computer broken. It is set aside, or deleted when it cannot be stopped, once that was
   * seen twice DEAD_COMPUTER.deadConfirmMs apart. */
  async function dead(owner: string, target: Dead): Promise<SetAsideResult | "kept" | "waiting"> {
    if (!eligible(owner)) { needsPerson(owner, target.boxId); return "held"; }
    if (health.answeredWithin(target.boxId, DEAD_COMPUTER.answeredGraceMs)) { clear(owner, target.boxId); return "kept"; }
    if (!autoReplace()) {
      needsPerson(owner, target.boxId);
      deps.log(`cloud computer ${owner}: ${target.boxId} is broken; automatic replacement is off, so it waits for the person`);
      return "held";
    }
    if (personBusy(owner, target.boxId) || deps.usedByOther?.(owner, target.boxId) === true) { needsPerson(owner, target.boxId); return "held"; }
    if (!deadConfirmed(target.boxId)) { needsPerson(owner, target.boxId); return "waiting"; }
    if (!(await listWorks(deps.cfg()))) { unreachable(owner, target.boxId); return "held"; }
    return setAside(owner, target, { dead: true });
  }

  /** After the restart: set aside once every condition holds (setAsideBlocked), looked at again every few minutes while
   * the computer stays silent and some condition does not. */
  async function decide(owner: string, boxId: string): Promise<void> {
    timers.delete(owner);
    const cfg = deps.cfg();
    const seen = await boat.inspectBoatIdentity(cfg, boxId);
    if (!seen.available) return unreachable(owner, boxId);
    if (!seen.identity || !(await boat.boatNameMatchesBot(owner, seen.identity.name))) return clear(owner, boxId);
    if (seen.identity.state === "error") return void await dead(owner, seen.identity);
    if (health.notRespondingSince(boxId) === null || !READY.has(seen.identity.state)) return clear(owner, boxId);
    if (!autoReplace()) {
      needsPerson(owner, boxId);
      deps.log(`cloud computer ${owner}: ${boxId} is not responding; automatic replacement is off, so it waits for the person`);
      return;
    }
    const blocked = await setAsideBlocked(owner, boxId, cfg);
    if (blocked?.answers) return clear(owner, boxId);
    if (blocked?.unreachable) return unreachable(owner, boxId);
    if (blocked) {
      if (blockedWhy.get(owner) !== blocked.why) deps.log(`cloud computer ${owner}: ${boxId} is not responding and is not set aside yet: ${blocked.why}`);
      blockedWhy.set(owner, blocked.why);
      if (blocked.person) needsPerson(owner, boxId); else set(owner, boxId, "not-responding");
      const timer = setTimeout(() => {
        timers.delete(owner);
        if (!closed) void lane(owner, () => notResponding(owner, boxId)).catch((error) => deps.log(`cloud computer ${owner}: ${String(error)}`));
      }, setAsideRecheckMs);
      timer.unref?.();
      timers.set(owner, timer);
      return;
    }
    await setAside(owner, seen.identity);
  }

  async function notResponding(owner: string, boxId: string): Promise<void> {
    const cfg = deps.cfg();
    set(owner, boxId, "not-responding");
    const seen = await boat.inspectBoatIdentity(cfg, boxId);
    if (!seen.available) return unreachable(owner, boxId);
    if (!seen.identity || !(await boat.boatNameMatchesBot(owner, seen.identity.name))) return clear(owner, boxId);
    if (seen.identity.state === "error") return void await dead(owner, seen.identity);
    if (!READY.has(seen.identity.state)) {
      health.forget(boxId);
      return clear(owner, boxId);
    }
    /** Looks again shortly instead of restarting now. */
    const later = (state: "restoring" | "not-responding") => {
      set(owner, boxId, state);
      const timer = setTimeout(() => {
        timers.delete(owner);
        if (!closed) void lane(owner, () => notResponding(owner, boxId)).catch((error) => deps.log(`cloud computer ${owner}: ${String(error)}`));
      }, recheckMs);
      timer.unref?.();
      timers.set(owner, timer);
    };
    // A turn waiting for this computer to answer owns it meanwhile: its own patience, restart and set-aside come first.
    if (deps.turnWaiting?.(boxId) === true) return later("not-responding");
    // Every guard before a stop: it closes the person's programs, and three failed probes can be this home's own outage.
    const fresh = await probe(cfg, boxId);
    if (fresh !== false) return clear(owner, boxId);
    if (!(await listWorks(cfg))) return unreachable(owner, boxId);
    const since = Math.min(health.notRespondingSince(boxId) ?? now(), restoringSince.get(boxId) ?? now());
    restoringSince.set(boxId, since);
    // The provider's command gateway can fail for every computer while its API still calls each one ready. Then a
    // restart helps nobody and stops work that is still running, so one is made only when this computer alone is silent.
    const witnessed = health.otherAnsweredWithin(boxId, DEAD_COMPUTER.witnessMs);
    if (!witnessed && health.othersSilentWithin(boxId, DEAD_COMPUTER.witnessMs)) {
      deps.log(`cloud computer ${owner}: ${boxId} is not responding, and neither are this installation's other computers; nothing was restarted`);
      return unreachable(owner, boxId);
    }
    const box = await read(cfg, boxId);
    const state = box && typeof box === "object" ? (box as { state?: unknown }).state : undefined;
    // A state that could not be read is unknown, never a reason to restart.
    if (typeof state !== "string" || !READY.has(state)) return now() - since < DEAD_COMPUTER.replaceAfterMs ? later("not-responding") : decide(owner, boxId);
    if (boatSignals(box).restoring === true && now() - since < READY_WAIT.restorePatienceMs) return later("restoring");
    if (!witnessed && now() - since < SOLO_SILENCE_MS) return later("not-responding");
    const lastRestart = restarts.get(boxId);
    const limitedNow = (lastRestart !== undefined && now() - lastRestart < HOUR_MS) || now() - lastAutoRestartAt < DEAD_COMPUTER.restartGapMs;
    if (limitedNow || personBusy(owner, boxId)) {
      // A restart that just failed stays the reason: it says more than the limit that restart itself set off.
      const failed = verdicts.get(owner);
      if (!(limitedNow && failed?.boxId === boxId && failed.why === "restart-failed")) judge(owner, boxId, limitedNow ? "restart-limited" : "person-busy");
      if (blockedWhy.get(owner) === undefined) deps.log(`cloud computer ${owner}: ${boxId} is not responding and was not restarted: ${limitedNow ? "a restart was made too recently" : "a person is using it"}`);
    } else {
      lastAutoRestartAt = now();
      deps.log(`cloud computer ${owner}: ${boxId} is not responding though the provider reports it ready; restarting it`);
      const restarted = await restart(owner, boxId);
      if (restarted === "answers") return restartedNow(owner, boxId);
      judge(owner, boxId, "restart-failed");
      deps.log(`cloud computer ${owner}: ${boxId} still does not answer after a restart${restarted === "no-answer" ? "" : ` (${restarted}: the restart itself did not finish)`}`);
    }
    return decide(owner, boxId);
  }

  function restartedNow(owner: string, boxId: string): void {
    set(owner, boxId, "restarted");
    told.delete(boxId);
    if (now() - (restartToldAt.get(boxId) ?? -Infinity) >= DAY_MS) {
      restartToldAt.set(boxId, now());
      deps.tell(owner, "restarted");
    }
    restartedOwners.add(owner);
  }

  /** After a turn left its silent computer as it is: the background recovery looks at it again shortly, as the turn was
   * told, unless it already does. */
  function followUp(owner: string, boxId: string): void {
    if (closed || timers.has(owner)) return;
    const timer = setTimeout(() => {
      timers.delete(owner);
      if (!closed) void lane(owner, () => notResponding(owner, boxId)).catch((error) => deps.log(`cloud computer ${owner}: ${String(error)}`));
    }, recheckMs);
    timer.unref?.();
    timers.set(owner, timer);
  }

  /** A computer woken, created or restarted for a turn that did not answer in the wake's patience: restarted (its files
   * kept) and waited for again, then set aside only if every condition holds. Otherwise left as it is, and the turn's
   * claim fails as a passing failure that says MausBot keeps trying, which the background recovery then does. */
  async function wakeTimedOut(owner: string, boxId: string, ctx: WakeTimeoutContext = {}): Promise<WakeTimeoutOutcome> {
    const outcome = await wakeTimedOutOnce(owner, boxId, ctx);
    if (outcome.kind === "kept" && eligible(owner) && !retired.has(boxId)) followUp(owner, boxId);
    return outcome;
  }

  async function wakeTimedOutOnce(owner: string, boxId: string, ctx: WakeTimeoutContext): Promise<WakeTimeoutOutcome> {
    if (!eligible(owner)) { needsPerson(owner, boxId); return kept(silentWhy(false)); }
    const cfg = deps.cfg();
    const seen = await boat.inspectBoatIdentity(cfg, boxId);
    if (!seen.available) { unreachable(owner, boxId); return kept(`the cloud computer service itself can't be reached right now, so nothing was changed. ${LATER}`); }
    if (!seen.identity || !(await boat.boatNameMatchesBot(owner, seen.identity.name))) return { kind: "gone" };
    if (seen.identity.state === "error") {
      const outcome = await dead(owner, seen.identity);
      if (outcome === "set-aside" || outcome === "deleted" || outcome === "deleting") return { kind: "replaced" };
      return kept(outcome === "kept" ? silentWhy(false) : `the provider reports the cloud computer broken, and MausBot left it as it is for now${outcome === "waiting" ? ", until the provider has said so for half an hour" : ""}. ${LATER}`);
    }
    if ((await probe(cfg, boxId)) === true) { clear(owner, boxId); return { kind: "answers" }; }
    if (personBusy(owner, boxId) || deps.usedByOther?.(owner, boxId, ctx.turn) === true) {
      deps.log(`cloud computer ${owner}: ${boxId} did not answer its wake, and someone else is using it; left as it is`);
      return kept(`the cloud computer is still not answering, and someone else is using it, so it was left as it is. ${LATER}`);
    }
    const lastRestart = restarts.get(boxId);
    let restarted = false;
    if (!((lastRestart !== undefined && now() - lastRestart < HOUR_MS) || now() - lastAutoRestartAt < DEAD_COMPUTER.restartGapMs)) {
      lastAutoRestartAt = now();
      deps.log(`cloud computer ${owner}: ${boxId} did not answer within ${Math.round(READY_WAIT.wakePatienceMs / 60_000)} minutes of waking; restarting it`);
      ctx.onRestarting?.();
      const outcome = await restart(owner, boxId);
      if (outcome === "answers") { restartedNow(owner, boxId); return { kind: "answers" }; }
      judge(owner, boxId, "restart-failed");
      restarted = outcome === "no-answer";
      if (!restarted) { set(owner, boxId, "not-responding"); return kept(silentWhy(false)); }
    }
    if (!autoReplace()) { set(owner, boxId, "not-responding"); return kept(silentWhy(restarted)); }
    const blocked = await setAsideBlocked(owner, boxId, cfg, ctx.turn);
    if (blocked?.answers) { clear(owner, boxId); return { kind: "answers" }; }
    if (blocked) {
      if (blocked.unreachable) unreachable(owner, boxId); else set(owner, boxId, "not-responding");
      deps.log(`cloud computer ${owner}: ${boxId} is still silent and was left as it is: ${blocked.why}`);
      return kept(silentWhy(restarted));
    }
    const outcome = await setAside(owner, seen.identity, { onReplacing: ctx.onReplacing });
    if (outcome === "set-aside" || outcome === "deleted" || outcome === "deleting") return { kind: "replaced" };
    return kept(KEPT_WHY[outcome]);
  }

  /** Deletes the set-aside computers whose time is up, one at a time. */
  async function sweep(): Promise<void> {
    if (unreadable || closed) return;
    for (const entry of entries.filter((candidate) => candidate.setAside && !candidate.undone && candidate.setAside.until <= now())) {
      let outcome: Awaited<ReturnType<typeof deleteExpiredSetAside>>;
      try {
        outcome = await deleteExpiredSetAside(deps.cfg(), { boxId: entry.boxId, name: entry.setAside!.name });
      } catch (error) {
        deps.log(`cloud computer ${entry.owner}: the set-aside ${entry.boxId} could not be deleted yet: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (outcome === "kept") continue;
      deps.log(`cloud computer ${entry.owner}: the set-aside ${entry.boxId} ${outcome === "deleted" ? "was deleted after its seven days" : outcome === "gone" ? "is gone" : "was renamed by someone, so it is kept"}`);
      write(entries.filter((candidate) => candidate !== entry));
    }
  }
  const sweeper = setInterval(() => void sweep().catch((error) => deps.log(`cloud computers: ${String(error)}`)), SWEEP_MS);
  sweeper.unref?.();

  const unsubscribe = health.onNotResponding((boxId) => {
    const owner = boat.boatOwnerOf(boxId);
    if (!owner || closed) return;
    if (!eligible(owner)) return needsPerson(owner, boxId);
    if (lanes.has(owner) || timers.has(owner)) return;
    // A turn waiting for this computer owns it meanwhile: looked at again once that wait is over, as the turn may not.
    if (deps.turnWaiting?.(boxId) === true) return followUp(owner, boxId);
    set(owner, boxId, "not-responding");
    void lane(owner, () => notResponding(owner, boxId)).catch((error) => deps.log(`cloud computer ${owner}: recovery failed: ${String(error)}`));
  });

  boat.onDeadBoat(async (_cfg, owner, broken): Promise<never> => {
    if (!eligible(owner)) {
      needsPerson(owner, broken.boxId);
      throw Object.assign(new Error(CLOUD_COMPUTER_TEAM_NOT_RESPONDING), { status: 409 });
    }
    const outcome = await lane(owner, () => dead(owner, broken));
    if (outcome === "capped") {
      throw Object.assign(new Error("it stopped working within an hour of being replaced, and MausBot replaces it at most once an hour; Replace computer in the computer panel tries once more"), { status: 409 });
    }
    if (outcome === "kept") throw Object.assign(new Error(CLOUD_COMPUTER_NOT_RESPONDING), { status: 409 });
    if (outcome === "waiting") throw Object.assign(new Error(CLOUD_COMPUTER_DEAD_WAITING), { status: 409 });
    if (outcome !== "set-aside" && outcome !== "deleted" && outcome !== "deleting") throw Object.assign(new Error(CLOUD_COMPUTER_NEEDS_PERSON), { status: 409 });
    throw Object.assign(new Error("the previous cloud computer was replaced — retry to use the new one"),
      { status: 409, code: outcome === "deleting" ? BOAT_DELETING : BOAT_DELETION_FINISHED });
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
      const silent = phase === "before" ? CLOUD_COMPUTER_NOT_RESPONDING : CLOUD_COMPUTER_NOT_RESPONDING_UNANSWERED;
      if (retired.has(boxId)) return silent;
      const owner = boat.boatOwnerOf(boxId);
      let found = owner ? states.get(owner) : undefined;
      // It answered a command since it was found silent: nothing is under way any more.
      if (found?.boxId === boxId && found.state === "not-responding" && !lanes.has(owner!) && health.answeredWithin(boxId, now() - found.at)) {
        clear(owner!, boxId);
        found = undefined;
      }
      if (found?.boxId === boxId && found.state === "restarting") return phase === "before" ? CLOUD_COMPUTER_RESTARTING : CLOUD_COMPUTER_RESTARTING_UNANSWERED;
      if (found?.boxId === boxId && found.state === "restoring") return phase === "before" ? CLOUD_COMPUTER_RESTORING : CLOUD_COMPUTER_STILL_RESTORING;
      if (found?.boxId === boxId && recoveryUnderWay(found.state)) return silent;
      if (phase === "before") return null;
      if (found?.boxId === boxId && found.state === "unreachable") return CLOUD_COMPUTER_UNREACHABLE;
      if (found?.boxId === boxId && found.state === "capped") return CLOUD_COMPUTER_CAPPED;
      if (found?.boxId === boxId && found.state === "needs-person") return eligible(owner!) ? CLOUD_COMPUTER_NEEDS_PERSON : CLOUD_COMPUTER_TEAM_NOT_RESPONDING;
      return health.notRespondingSince(boxId) === null ? null : silent;
    },
    wakeTimedOut: (owner: string, boxId: string, ctx?: WakeTimeoutContext): Promise<WakeTimeoutOutcome> => lane(owner, () => wakeTimedOut(owner, boxId, ctx)),
    /** Resolves once no restart or replacement of this computer is under way, or at `until`: a call waits that out instead
     * of being refused at once, so a recovery in progress is not taken for one failure after another. */
    async settle(boxId: string, until: number, signal?: AbortSignal): Promise<void> {
      const owner = boat.boatOwnerOf(boxId);
      if (!owner) return;
      const underWay = () => {
        const found = states.get(owner);
        return retired.has(boxId) ? lanes.has(owner) : found?.boxId === boxId && recoveryUnderWay(found.state) && (lanes.has(owner) || timers.has(owner));
      };
      // `until` is the caller's own clock, the wall clock.
      while (underWay() && Date.now() < until && !signal?.aborted && !closed) {
        const running = lanes.get(owner), pause = wait(Math.max(1, Math.min(pollMs, until - Date.now())));
        // Only a lane under way is raced: with none (a timer waits), the pause alone, never a promise already settled.
        await (running ? Promise.race([running.catch(() => undefined), pause]) : pause);
      }
    },
    /** This computer is no longer its bot's (set aside, or deleted): the turn that used it goes on on the owner's new one. */
    replaced: (boxId: string): boolean => retired.has(boxId),
    /** Told once, with the first call on the owner's computer after a replacement or a restart. */
    notice(boxId: string): string | null {
      const owner = boat.boatOwnerOf(boxId);
      if (!owner) return null;
      if (restartedOwners.delete(owner)) return CLOUD_COMPUTER_RESTARTED;
      const owed = entries.filter((entry) => entry.owner === owner && entry.boxId !== boxId && !entry.toldBot && !entry.undone);
      if (!owed.length) return null;
      write(entries.map((entry) => owed.includes(entry) ? { ...entry, toldBot: true as const, toldPerson: true as const } : entry));
      if (owed.some((entry) => !entry.toldPerson && !entry.manual)) deps.tell(owner, "replaced");
      const setAside = [...owed].reverse().find((entry) => entry.setAside);
      if (setAside?.setAside) return cloudComputerSetAsideNotice(dateOf(setAside.setAside.until));
      return owed.every((entry) => entry.manual) ? CLOUD_COMPUTER_REPLACED_BY_PERSON : CLOUD_COMPUTER_REPLACED;
    },
    /** This owner's computer was replaced by itself in the last fifteen minutes: its turns may make the new one even
     * where they would never make a first one. */
    replacedRecently: (owner: string): boolean => entries.some((entry) => entry.owner === owner && !entry.manual && !entry.undone && now() - entry.at < 15 * 60_000),
    /** A start the Admin turned away for computers at once, while a computer this installation set aside still holds a
     * place: what the bot is told, in place of the plan's own sentence. */
    claimSentence(_owner: string, error: unknown): string | undefined {
      if (cloudFailureOf(error).limit?.reason !== "at_once") return undefined;
      const held = entries.filter((entry) => entry.setAside && !entry.undone && entry.setAside.until > now());
      if (!held.length) return undefined;
      return `The plan's cloud computers are all in use, ${held.length === 1 ? "one of them by an old computer" : "some of them by old computers"} MausBot set aside, with their files, `
        + `until ${dateOf(Math.min(...held.map((entry) => entry.setAside!.until)))}. The person can delete ${held.length === 1 ? "it" : "them"} in Settings → Desktops & browser → Desktops to free the place. `
        + "Do not retry computer work in this turn; tell the person.";
    },
    /** Its computer is dead at the provider, has stopped answering, or is being handled here: what lets the person act
     * during a turn. A computer that came back (restarted, or already replaced) is not stuck. */
    stuck(owner: string): boolean {
      const box = boat.boatIdOf(owner), state = states.get(owner)?.state;
      return (state !== undefined && state !== "restarted" && state !== "replaced") || boat.deadBoatOf(owner) !== null
        || (box !== null && health.notRespondingSince(box) !== null);
    },
    /** Why this owner's computer, not answering, was left as it is; null while that is not decided, once it answers, or
     * when it was decided before `since`. Written before the state moves to one that has ended. */
    verdict: (owner: string, since = -Infinity): RecoveryVerdict | null => {
      const found = verdicts.get(owner);
      return found && found.at >= since ? found.why : null;
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
    /** The panel's Replace computer, confirmed by the person: deleted, with no hourly limit, as the person asked. */
    async replace(owner: string): Promise<{ replaced: boolean }> {
      const found = (await boat.findBoat(deps.cfg(), owner)) ?? boat.deadBoatOf(owner);
      if (!found) throw Object.assign(new Error("This bot has no cloud computer to replace."), { status: 409 });
      const target = "boxId" in found ? found as Dead : { boxId: String(found.id), name: String(found.name) };
      const outcome = await lane(owner, async () => {
        set(owner, target.boxId, "replacing", true);
        write([...entries.filter((entry) => entry.boxId !== target.boxId), { owner, boxId: target.boxId, at: now(), manual: true }]);
        return remove(owner, target, true);
      });
      if (outcome === "failed") throw Object.assign(new Error("The old computer's deletion was not confirmed. Try again in a minute."), { status: 503 });
      return { replaced: true };
    },
    /** Deletes set-aside computers whose time is up; runs by itself every hour. */
    sweep,
    close(): void {
      closed = true;
      clearInterval(sweeper);
      unsubscribe();
      boat.onDeadBoat(null);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

export type BoatRecovery = ReturnType<typeof createBoatRecovery>;
