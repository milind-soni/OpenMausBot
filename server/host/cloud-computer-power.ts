// A Boat this installation runs is on only while something uses it: a turn or a person wakes it, and it goes to sleep once
// it has been idle for CLOUD_COMPUTER_IDLE_MS and no routine that uses it is due within ROUTINE_DUE_SOON_MS. Boat bills
// while a computer is on, up to its own eight-hour auto-stop.
import * as boat from "../boat.ts";
import { boatCreateRecoverySnapshot } from "../boat-create-idempotency.ts";
import { BOAT_DELETING, BOAT_DELETION_FINISHED, hasPendingBoatDeletionForBot } from "../boat-delete-journal.ts";
import { boatHealth, type BoatHealth } from "../boat-health.ts";
import { boatReadiness, type BoatAnswer, type BoatReadiness } from "../boat-ready.ts";
import type { WakeTimeoutContext, WakeTimeoutOutcome } from "../boat-recovery.ts";
import { withinBudget } from "../auto-vm-claims.ts";
import { backgroundCommandRunning } from "../cloud-computer-background.ts";
import { ComputerIdleTimer } from "../computer-idle.ts";
import type { AppConfig } from "../config.ts";
import { redactSecretsInText } from "../redact.ts";
import type { Routine } from "../routines.ts";
import type { BotRecord } from "../store.ts";
import type { TurnOwner } from "../turn-resources.ts";

export const CLOUD_COMPUTER_IDLE_MS = Math.max(1_000, Number(process.env.OMB_CLOUD_COMPUTER_IDLE_MS) || 10 * 60_000);
/** A computer stays on while a routine that uses it is due this soon. Longer than the idle window, so a routine every 30
 * minutes or more often never waits on a wake: each wake spends one start from the Boat account's pool, shared by every customer. */
export const ROUTINE_DUE_SOON_MS = 30 * 60_000;
const MAX_LISTING_RETRY_MS = 60 * 60_000;
/** Above a slow first start; Boat's own ready wait is 90 seconds. */
export const CLOUD_COMPUTER_START_BUDGET_MS = Math.max(1_000, Number(process.env.OMB_CLOUD_COMPUTER_START_BUDGET_MS) || 150_000);
export const CLOUD_COMPUTER_STARTING = "The cloud computer is still starting. This call was not performed. Take a fresh screenshot in a moment.";
export const CLOUD_COMPUTER_DID_NOT_START = "the cloud computer didn't start in time";
/** The provider says ready and the computer is silent. Worded apart from a start that failed, and passing: three runs in
 * a row that fail on a start turn their routine off, and a computer that is only slow to answer must not count as one. */
export const CLOUD_COMPUTER_NOT_ANSWERING_YET = "the cloud computer is awake but is not answering yet";
export const CLOUD_COMPUTER_DISK_NOT_BACK_YET = "the cloud computer is awake but still restoring its disk";
const REMOVAL_POLL_MS = 3_000;

type ScheduledRoutine = Pick<Routine, "botId" | "runOn" | "enabled" | "nextRunAt">;

export interface CloudComputerPowerDeps {
  cfg: AppConfig;
  /** Keyed by the computer's owner: a bot id, or a team computer's owner key. True while any turn, routine run, person's
   * control, lifecycle action or provider change still uses it. */
  busy(owner: string): boolean;
  /** Takes the owner's lifecycle lane synchronously, so no turn starts on it until released; throws when it is taken or in use. */
  claim(owner: string): () => void;
  owners(): boat.ManagedBoatOwner[];
  routines(): readonly ScheduledRoutine[];
  /** The owner of the cloud computer this routine's turns use, or null when they use none. */
  routineComputer(routine: ScheduledRoutine): string | null;
  broadcast(payload: Record<string, unknown>): void;
  log(line: string): void;
  readiness?: Pick<BoatReadiness, "awaitAnswer">;
  /** Where a wake or a create is noted, so a computer is never set aside within its first half hour unseen. */
  health?: Pick<BoatHealth, "woke">;
  /** A computer woken or created for a turn stayed silent past the wake's patience: restart it, then set it aside
   * within every guard (server/boat-recovery.ts). Absent, such a computer is only reported. */
  wakeTimedOut?(owner: string, boxId: string, ctx: WakeTimeoutContext): Promise<WakeTimeoutOutcome>;
}

/** How a turn's start went, for the line the bot hears meanwhile. */
export interface CloudComputerReadyHooks {
  onRestoring?(): void;
  /** Woken and silent: the wait goes on. */
  onWaking?(): void;
  /** Silent past the wake's patience, and being restarted; its files are kept. */
  onRestarting?(): void;
  /** Still silent after that, every guard passed, and being set aside for a new computer. */
  onReplacing?(): void;
}

export function createCloudComputerPower(deps: CloudComputerPowerDeps) {
  const { cfg, broadcast } = deps;
  const timers = new Map<string, ComputerIdleTimer>();
  const turnOwners = new Map<string, { generation: string; owner: string }>();
  /** A start can outlive the turn that asked for it; stopping a computer mid-create would make provisionBoat delete it. */
  const starting = new Map<string, number>();
  const readiness = deps.readiness ?? boatReadiness;
  const health = deps.health ?? boatHealth;
  /** Computers this process created or woke and has not yet heard answer. */
  const unheard = new Set<string>();
  /** Computers a turn's start is waiting on (ready): the background recovery leaves them to it. */
  const waits = new Map<string, number>();
  let listingRetry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  /** A paused routine, or one whose next run cannot be worked out, has no next run and keeps nothing on. */
  const routineDueSoon = (owner: string) => deps.routines().some(routine => routine.enabled && routine.nextRunAt !== null &&
    routine.nextRunAt - Date.now() <= ROUTINE_DUE_SOON_MS && deps.routineComputer(routine) === owner);
  const busy = (owner: string) => (starting.get(owner) ?? 0) > 0 || deps.busy(owner) || routineDueSoon(owner);

  function forget(owner: string): void {
    timers.get(owner)?.cancel();
    timers.delete(owner);
  }

  /** The claim is the last step before the stop, after every await: work that arrived meanwhile keeps the computer on. */
  async function sleepIfIdle(owner: string): Promise<void | "busy"> {
    if (!boat.boatConfigured(cfg) || hasPendingBoatDeletionForBot(owner)) return forget(owner);
    if (boatCreateRecoverySnapshot().some((entry) => entry.botId === owner && !entry.resolved)) return "busy";
    const machine = await boat.findBoat(cfg, owner);
    if (closed) return;
    const state = typeof machine?.state === "string" ? machine.state : null;
    if (!state || boat.SLEEPING_BOAT_STATES.has(state)) return forget(owner);
    if (boat.boatTurnLifecycleAction(state) !== "attach" || busy(owner)) return "busy";
    if (typeof machine?.id === "string" && await backgroundCommandRunning(cfg, machine.id)) return "busy";
    if (closed) return;
    let release: () => void;
    try {
      release = deps.claim(owner);
    } catch {
      return "busy";
    }
    try {
      await boat.sleepBoat(cfg, owner);
    } finally {
      release();
    }
    forget(owner);
    deps.log(`cloud computer ${owner}: asleep after ${Math.round(CLOUD_COMPUTER_IDLE_MS / 1_000)}s idle`);
  }

  /** Starts, or restarts, this owner's idle window. */
  function used(owner: string): void {
    if (closed || !boat.boatConfigured(cfg)) return;
    let timer = timers.get(owner);
    if (!timer) {
      timer = new ComputerIdleTimer(CLOUD_COMPUTER_IDLE_MS, () => busy(owner), () => sleepIfIdle(owner), (error, retryInMs) => {
        const reason = redactSecretsInText(error instanceof Error ? error.message : String(error));
        deps.log(`cloud computer ${owner}: could not go to sleep, retrying in ${Math.ceil(retryInMs / 60_000)} min: ${reason}`);
      });
      timers.set(owner, timer);
    }
    timer.touch();
  }

  /** Before the wake, so a start that fails or outlives its turn still leaves the computer timed. */
  function attached(turn: TurnOwner, owner: string): void {
    turnOwners.set(turn.threadId, { generation: turn.generation, owner });
    used(owner);
  }

  function released(turn: TurnOwner): void {
    const held = turnOwners.get(turn.threadId);
    if (held?.generation !== turn.generation) return;
    turnOwners.delete(turn.threadId);
    used(held.owner);
  }

  /** `existingOnly`: wake or attach the bot's computer, but never create one (null when it has none). Every wait inside
   * fits `budgetMs`. */
  async function start(bot: BotRecord, turn: TurnOwner, opts: { existingOnly?: boolean; budgetMs?: number } = {}) {
    attached(turn, bot.id);
    starting.set(bot.id, (starting.get(bot.id) ?? 0) + 1);
    try {
      return await startBotBoat(bot, opts.existingOnly === true, Date.now() + (opts.budgetMs ?? CLOUD_COMPUTER_START_BUDGET_MS));
    } finally {
      const left = (starting.get(bot.id) ?? 1) - 1;
      if (left > 0) starting.set(bot.id, left);
      else starting.delete(bot.id);
    }
  }

  async function startBotBoat(bot: BotRecord, existingOnly: boolean, deadline: number) {
    let b = await boat.findBoat(cfg, bot.id);
    const lifecycleOf = () => boat.boatTurnLifecycleAction(typeof b?.state === "string" ? b.state : null);
    let lifecycle = lifecycleOf();
    if (lifecycle === "provision" && existingOnly) return null;
    if (lifecycle === "provision") {
      broadcast({ kind: "computer", botId: bot.id, state: "provisioning", place: "cloud" });
      await provisionOnceRemoved(bot, deadline);
      b = await boat.findBoat(cfg, bot.id);
      lifecycle = lifecycleOf();
      if (typeof b?.id === "string") { unheard.add(b.id); health.woke(b.id, true); }
    }
    // An archived Boat answers every action with an error until it resumes: wake it once here.
    if (lifecycle === "wake") {
      broadcast({ kind: "computer", botId: bot.id, state: "waking", place: "cloud" });
      b = (await boat.readyBoat(cfg, bot.id, Math.max(1_000, deadline - Date.now()))) ?? b;
      lifecycle = lifecycleOf();
      if (typeof b?.id === "string") { unheard.add(b.id); health.woke(b.id, true); }
    }
    return b && lifecycle === "attach" ? b : null;
  }

  /** A start that failed removes the computer it created, so the next one can meet that removal still under way. */
  async function provisionOnceRemoved(bot: BotRecord, deadline: number): Promise<void> {
    for (;;) {
      try {
        await boat.provisionBoat(cfg, bot.id, bot.name);
        return;
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if ((code !== BOAT_DELETING && code !== BOAT_DELETION_FINISHED) || closed || Date.now() + REMOVAL_POLL_MS >= deadline) throw error;
        if (code === BOAT_DELETING) await new Promise(resolve => setTimeout(resolve, REMOVAL_POLL_MS));
      }
    }
  }

  /** At startup: what a previous run left on gets the same window. Orphans (no owner left) stay for Settings → Computers. */
  async function armRunning(retryInMs = CLOUD_COMPUTER_IDLE_MS): Promise<void> {
    if (closed || !boat.boatConfigured(cfg)) return;
    const inventory = await boat.listManagedBoats(cfg, deps.owners(), { adoptLegacy: false }).catch(() => null);
    if (closed) return;
    if (!inventory?.available) {
      deps.log(`cloud computers: could not list them to time the ones left on, retrying in ${Math.ceil(retryInMs / 60_000)} min: ${inventory?.problem ?? "listing failed"}`);
      listingRetry = setTimeout(() => void armRunning(Math.min(retryInMs * 2, MAX_LISTING_RETRY_MS)), retryInMs);
      listingRetry.unref?.();
      return;
    }
    for (const instance of inventory.instances) {
      if (instance.ownerBotId && !boat.SLEEPING_BOAT_STATES.has(instance.state) && instance.state !== "removing") used(instance.ownerBotId);
    }
  }

  const notAnswering = (answer: Extract<BoatAnswer, { ok: false }>) =>
    Object.assign(new Error(answer.phase === "restoring" ? CLOUD_COMPUTER_DISK_NOT_BACK_YET : CLOUD_COMPUTER_NOT_ANSWERING_YET), { status: 503, transient: true });

  /** Waits for the computer to answer a command, not only be reported ready; one that answered moments ago is not asked
   * again. After a wake the wait is patient (READY_WAIT.wakePatienceMs, longer while the provider says its disk is restored). */
  async function awaitAnswer(boxId: string, opts: { woke?: boolean } & CloudComputerReadyHooks): Promise<BoatAnswer & { woke: boolean }> {
    const woke = opts.woke === true || unheard.has(boxId);
    const answer = await readiness.awaitAnswer(cfg, boxId, {
      woke,
      onPhase: (phase) => { if (phase === "restoring") opts.onRestoring?.(); else opts.onWaking?.(); },
    });
    if (answer.ok) unheard.delete(boxId);
    return { ...answer, woke };
  }

  /** After a start, before the turn's first call is sent. The failure is passing, so the turn's next call tries again. */
  async function answering(boxId: string, opts: { woke?: boolean; onRestoring?: () => void } = {}): Promise<void> {
    const answer = await awaitAnswer(boxId, opts);
    if (!answer.ok) throw notAnswering(answer);
  }

  /** A passing failure: the turn's next computer call claims again, however often (`keepsTrying`), since MausBot keeps
   * bringing the computer back meanwhile. */
  const passing = (why: string) => Object.assign(new Error(why), { status: 503, transient: true, keepsTrying: true });

  /** A bot's own computer for a turn: started (woken, or created) within `budgetMs`, then waited on until it answers. One
   * woken or created here that stays silent past the wake's patience is restarted (its files kept) and waited for again;
   * only if it is still silent and every guard holds is it set aside, with its files, for a new one, and the turn goes on
   * on that. Otherwise the turn's claim fails as a passing failure, and the computer is left as it is. Null when
   * `existingOnly` and the bot has none. */
  async function ready(bot: BotRecord, turn: TurnOwner, opts: { existingOnly?: boolean; budgetMs: number } & CloudComputerReadyHooks) {
    for (let replaced = false; ; replaced = true) {
      // The replacement stands in for the computer the bot already had, so it is made even where a first one would not be.
      const machine = await withinBudget(start(bot, turn, { existingOnly: !replaced && opts.existingOnly, budgetMs: opts.budgetMs }), opts.budgetMs, CLOUD_COMPUTER_DID_NOT_START);
      if (!machine) {
        if (replaced) throw passing("the cloud computer was set aside, with its files, for a new one, but the new one could not be found yet. Trying again later is fine");
        return null;
      }
      const boxId = machine.id as string;
      if (replaced) { unheard.add(boxId); health.woke(boxId, true); }
      waits.set(boxId, (waits.get(boxId) ?? 0) + 1);
      let outcome: WakeTimeoutOutcome;
      try {
        const answer = await awaitAnswer(boxId, opts);
        if (answer.ok) return machine;
        // A computer this process did not wake keeps today's short wait: the recovery restarts it, then may set it aside.
        if (!answer.woke || !deps.wakeTimedOut) throw notAnswering(answer);
        if (replaced) throw passing("the cloud computer was set aside, with its files, for a new one, but the new one did not answer in time either. Trying again later is fine");
        outcome = await deps.wakeTimedOut(bot.id, boxId, { turn, onRestarting: opts.onRestarting, onReplacing: opts.onReplacing });
      } finally {
        const left = (waits.get(boxId) ?? 1) - 1;
        if (left > 0) waits.set(boxId, left); else waits.delete(boxId);
      }
      if (outcome.kind === "answers") return machine;
      if (outcome.kind === "kept") throw passing(outcome.why);
      deps.log(`cloud computer ${bot.id}: ${boxId} ${outcome.kind === "gone" ? "is gone" : "was set aside"} after it did not answer its wake; starting the new one for the turn`);
    }
  }

  return {
    start,
    answering,
    ready,
    /** A turn's start is waiting on this computer to answer, or deciding what to do about it. */
    waiting: (boxId: string): boolean => waits.has(boxId),
    attached,
    released,
    used,
    /** A computer is on (its idle window runs here) or starting: a Cloud home on a plan that sleeps stays awake for it,
     * since its idle timer lives in this process. */
    awake: () => timers.size > 0 || starting.size > 0,
    /** For activity that only matters to a computer already on, such as a person handing back control. */
    renew: (owner: string) => timers.get(owner)?.touch(),
    armRunning,
    close(): void {
      closed = true;
      if (listingRetry) clearTimeout(listingRetry);
      for (const timer of timers.values()) timer.cancel();
      timers.clear();
    },
  };
}
