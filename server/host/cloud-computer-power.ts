// A Boat this installation runs is on only while something uses it: a turn or a person wakes it, and it goes to sleep once
// it has been idle for CLOUD_COMPUTER_IDLE_MS and no routine that uses it is due within ROUTINE_DUE_SOON_MS. Boat bills
// while a computer is on, up to its own eight-hour auto-stop.
import * as boat from "../boat.ts";
import { boatCreateRecoverySnapshot } from "../boat-create-idempotency.ts";
import { hasPendingBoatDeletionForBot } from "../boat-delete-journal.ts";
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
}

export function createCloudComputerPower(deps: CloudComputerPowerDeps) {
  const { cfg, broadcast } = deps;
  const timers = new Map<string, ComputerIdleTimer>();
  const turnOwners = new Map<string, { generation: string; owner: string }>();
  /** A start can outlive the turn that asked for it; stopping a computer mid-create would make provisionBoat delete it. */
  const starting = new Map<string, number>();
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

  async function start(bot: BotRecord, turn: TurnOwner) {
    attached(turn, bot.id);
    starting.set(bot.id, (starting.get(bot.id) ?? 0) + 1);
    try {
      return await startBotBoat(bot);
    } finally {
      const left = (starting.get(bot.id) ?? 1) - 1;
      if (left > 0) starting.set(bot.id, left);
      else starting.delete(bot.id);
    }
  }

  async function startBotBoat(bot: BotRecord) {
    let b = await boat.findBoat(cfg, bot.id);
    const lifecycleOf = () => boat.boatTurnLifecycleAction(typeof b?.state === "string" ? b.state : null);
    let lifecycle = lifecycleOf();
    if (lifecycle === "provision") {
      broadcast({ kind: "computer", botId: bot.id, state: "provisioning", place: "cloud" });
      await boat.provisionBoat(cfg, bot.id, bot.name);
      b = await boat.findBoat(cfg, bot.id);
      lifecycle = lifecycleOf();
    }
    // An archived Boat answers every action with an error until it resumes: wake it once here.
    if (lifecycle === "wake") {
      broadcast({ kind: "computer", botId: bot.id, state: "waking", place: "cloud" });
      b = (await boat.readyBoat(cfg, bot.id)) ?? b;
      lifecycle = lifecycleOf();
    }
    return b && lifecycle === "attach" ? b : null;
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

  return {
    start,
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
