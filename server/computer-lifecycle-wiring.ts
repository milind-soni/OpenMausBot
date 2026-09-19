// The computer lifecycle wiring cluster -- the createComputerLifecycle
// and createScreenPollers rebinding, the shared-computer control surface,
// the turn cleanup with bindTurnComputer and the direct-thread
// interruptors, the ask_bot waiter, the team-computer store, the send
// sequencer and the browser-cleanup profile reconciliation -- extracted
// verbatim from index.ts. index.ts calls createComputerLifecycleWiring at
// the region's original site (the "computer / VM lifecycle" banner) and
// rebinds the names from its result. The names index.ts declares after
// that site -- roomHandoffs, broadcast, startTurn, the events pipeline's
// timeout constants, isUnattended, routines and the local-VM busy flags --
// cross as thunks resolved at call time; followupsReady is reassigned by
// the listen and shutdown handlers, so it returns as a { get, set }
// accessor.
import { join } from "node:path";
import { SharedComputerControl } from "./shared-computer-control.ts";
import { TeamComputers } from "./team-computers.ts";
import { SendSequencer } from "./send-idempotency.ts";
import { createComputerLifecycle } from "./computer-lifecycle.ts";
import { createScreenPollers } from "./screen-pollers.ts";
import { createTurnCleanup } from "./turn-cleanup.ts";
import { computerWaitingText, computerFreeText, computerWaitEndedText, computerStillBusyText, type ComputerHolder } from "./computer-wait.ts";
import { store, teamComputerTurns, ENVIRONMENT_ID } from "./runtime.ts";
import { DATA_DIR } from "./config.ts";
import {
  activeInternalGenerationByThread,
  revokeInternalCapabilitiesForThread,
} from "./internal-capabilities.ts";
import { closeOpenApprovals } from "./turn-fold.ts";
import {
  botAtThreadCapacity,
  botForThread,
  claimTurnResource,
  directTurnDispatchClaims,
  turnComputerResources,
  turnResourceOwners,
  turnResources,
} from "./turn-admission.ts";
import type { Message } from "./store.ts";
import type { TurnOwner } from "./turn-resources.ts";
import type { RuntimeEvent } from "./contracts.ts";
import type { AskBotOutcome } from "./routes/internal.ts";
import type { EventBus } from "./harness/bus.ts";
import type { BrowserCleanupCoordinator } from "./browser-lifecycle-cleanup.ts";
import type { RoutineManager } from "./routines.ts";
import type { RoomHandoffs } from "./room-handoffs.ts";
import type { createTurnIntegrations } from "./turn-integrations.ts";
import type { createGroupTurnOperations } from "./group-turn-operations.ts";
import type { createEventsPipeline } from "./events-pipeline.ts";
import type { createTurnDispatch } from "./turn-dispatch.ts";

type TurnIntegrations = ReturnType<typeof createTurnIntegrations>;
type GroupTurnOperations = ReturnType<typeof createGroupTurnOperations>;
type EventsPipeline = ReturnType<typeof createEventsPipeline>;
type TurnDispatch = ReturnType<typeof createTurnDispatch>;

/** Everything the computer lifecycle wiring reads from its host. The
 * helpers slice arrives by value from factories and declarations wired
 * above the region's site; the lateBound slice reads index.ts state that
 * is reassigned or declared after that site, resolved at call time. */
export interface ComputerLifecycleWiringDeps {
  helpers: {
    bus: EventBus;
    browserCleanup: BrowserCleanupCoordinator;
    activeGroupTurnForBot: GroupTurnOperations["activeGroupTurnForBot"];
    controlIntegration: TurnIntegrations["controlIntegration"];
    computerControl: TurnIntegrations["computerControl"];
    computerControlRevision: TurnIntegrations["computerControlRevision"];
    currentBrowserSession: TurnIntegrations["currentBrowserSession"];
    cancelDirectTurnDispatch: TurnIntegrations["cancelDirectTurnDispatch"];
    shouldIgnoreProviderEvent: TurnIntegrations["shouldIgnoreProviderEvent"];
    DirectTurnSetupCancelled: new (message?: string) => Error;
    directTurnGenerationByThread: Map<string, string>;
  };
  lateBound: {
    routines(): RoutineManager | null;
    localVmImageBusy(): boolean;
    startTurn: TurnDispatch["startTurn"];
    roomHandoffs(): RoomHandoffs;
    broadcast(): EventsPipeline["broadcast"];
    ASK_BOT_TIMEOUT_MS(): number;
    GROUP_GOAL_WAIT_MAX_MS(): number;
    isUnattended(botId?: string | null, threadId?: string): boolean;
  };
}

export function createComputerLifecycleWiring(deps: ComputerLifecycleWiringDeps) {
  const {
    bus, browserCleanup, activeGroupTurnForBot, controlIntegration, computerControl, computerControlRevision,
    currentBrowserSession, cancelDirectTurnDispatch, shouldIgnoreProviderEvent,
    DirectTurnSetupCancelled, directTurnGenerationByThread,
  } = deps.helpers;
  const {
    routines, localVmImageBusy, startTurn, roomHandoffs, broadcast,
    ASK_BOT_TIMEOUT_MS, GROUP_GOAL_WAIT_MAX_MS, isUnattended,
  } = deps.lateBound;

// The computer/VM lifecycle cluster lives in ./computer-lifecycle.ts: the
// local-VM lease/idle/thread registries, the Box/VPS provider busy-sets and
// claim lanes, team-computer control accounting, and the surface/provider
// resolution a turn or route asks for. It is wired here because the
// screen-pollers factory just below is the earliest module-level by-value
// consumer (botComputerControlSnapshot); thunks cover the consts this file
// declares after this site.
const {
  localVmOwnerBusy, localVmLeases, localVmLifecycleBusy, localVmThreadTargets, localVmActiveThreads,
  localVmSeen, noteLocalVmSeen, activeVpsThreads, vpsThreadStarted, vpsThreadEnded, boxLifecycleBusyBots, vpsPreviewRequests,
  orphanBoxLifecycleBusyIds, computerProviderConfigTransitions,
  checkpointRestoreLeases, LOCAL_VM_IDLE_MS, LOCAL_VM_DESKTOP_WAIT_MS, localVmIdles,
  inheritedTeamComputer, teamComputerPrompt, botComputerControlKey, botComputerControlSnapshot,
  teamComputerInUse, assertTeamControlCanBeTaken, claimTeamComputerLifecycle, assertTeamComputerChangeIdle,
  teamComputersPayload, attachTeamBox, managedBoxOwners, botHasActiveTurn, providerTransitionMessage,
  providerOperationConflict, turnSurfacePlan, turnProvider, turnInstance, computerPreviewBot,
  computerPreviewSurface, selectableComputers, continueComputerSelection, runningTurnEngines,
  runningTurnInstance, providerTransitionForTurn, claimBoxInventoryRequest, claimManagedBoxMutation,
  claimBotComputerLifecycle, claimManagedVpsMutation, localVmTargetForBot, localVmLeaseFor, localVmIdleFor,
  releaseLocalVmThread, localVmInventoryPayload,
} = createComputerLifecycle({
  lateBound: {
    routines: () => routines(),
    computerControl: () => computerControl,
    teamComputers: () => teamComputers,
    autoVmClaims: () => autoVmClaims,
    localVmImageBusy: () => localVmImageBusy(),
    startTurn: (botId, text, opts) => startTurn(botId, text, opts),
  },
  helpers: {
    bindTurnComputer, controlIntegration, activeGroupTurnForBot,
  },
  state: {
    directTurnGenerationByThread,
  },
});

// The live-screen pollers live in ./screen-pollers.ts. Their functions were
// hoisted declarations here — usable from module start — so the factory is
// wired before the first consumer (turnCleanup below) with thunks for the
// consts declared after this site.
const {
  screenPollers, SCREEN_SETTLE_TIMEOUT_MS,
  startScreenPoller, pokeScreenPoller, stopScreenPoller, finalScreenFrame,
} = createScreenPollers({
  lateBound: {
    broadcast: () => broadcast(),
    computerControlRevision: () => computerControlRevision,
  },
  helpers: {
    currentBrowserSession,
    botComputerControlSnapshot,
  },
});
const sharedComputerControl = new SharedComputerControl(turnResources, () => store.bots.some(bot => botComputerControlSnapshot(bot.id).held));
const turnCleanup = createTurnCleanup({
  store,
  turnResources,
  turnResourceOwners,
  turnComputerResources,
  teamComputerTurns,
  directTurnGenerationByThread,
  stopScreenPoller,
    roomHandoffs: () => roomHandoffs(),
  botForThread,
  cancelDirectTurnDispatch,
  revokeInternalCapabilitiesForThread,
  runningTurnInstance,
  closeOpenApprovals,
});
const { releaseTurnResources, interruptDirectThread, settlingResourceOwners, autoVmClaims } = turnCleanup;

async function bindTurnComputer(owner: TurnOwner, resource: string, exclusive = false): Promise<void> {
  const active = () => activeInternalGenerationByThread.get(owner.threadId) === owner.generation &&
    turnResourceOwners.get(owner.threadId)?.generation === owner.generation;
  let waitingMessage: Message | undefined;
  // Who holds the desktop, as the chip and the give-up error name them: a
  // bot running a titled thread, or a room. Read once, when the wait begins.
  let holder: ComputerHolder | undefined;
  const deadline = Date.now() + GROUP_GOAL_WAIT_MAX_MS();
  try {
    while (true) {
      if (!active()) throw new DirectTurnSetupCancelled("Computer wait cancelled");
      if (!exclusive || claimTurnResource(owner, resource)) break;
      if (!waitingMessage) {
        const blocker = turnResources.blocker(resource, owner);
        const holderBot = blocker && store.botByThread(blocker.threadId);
        const holderTask = holderBot && blocker && store.taskByThread(holderBot.id, blocker.threadId);
        const holderRoom = !holderBot && blocker ? store.groupByThread(blocker.threadId) : null;
        holder = holderBot
          ? { name: holderBot.name, ...(holderTask?.title ? { task: holderTask.title } : {}) }
          : holderRoom ? { name: holderRoom.name } : undefined;
        waitingMessage = store.appendMessage(owner.threadId, {
          role: "bot", kind: "activity",
          tool: { name: computerWaitingText(holder) },
          ...(holderBot && holderTask ? { threadRef: { botId: holderBot.id, threadId: holderTask.threadId, title: holderTask.title } } : {}),
        });
      }
      if (Date.now() >= deadline) throw new Error(computerStillBusyText(holder, GROUP_GOAL_WAIT_MAX_MS()));
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  } finally {
    if (waitingMessage) store.patchMessage(owner.threadId, waitingMessage.id, {
      tool: { name: active() && turnResources.owns(resource, owner) ? computerFreeText() : computerWaitEndedText(), ok: true },
    });
  }
  turnResourceOwners.set(owner.threadId, owner);
  turnComputerResources.set(owner.threadId, { owner, resource });
}

/** Opt-in direct-chat parking (#1194): when this bot's person chose to queue
 * messages behind running work, a message that arrives while delegated
 * assignments are still out waits in the steer queue — room-style parking —
 * instead of steering the conversation immediately. */
function parksBehindCoordination(botId: string, threadId: string): boolean {
  if (!roomHandoffs().activeDirect(threadId)) return false;
  return (store.projectBotForTask(botId, threadId) ?? store.bot(botId))?.parkDirectMessages === true;
}

/** Routine and webhook dispatch shares startTurn's admission preconditions
 * instead of waiting for whole-bot idleness: a free thread slot and no
 * active group turn. A group turn blocks scheduled starts the same way it
 * blocks every other turn kind; it does not consume a capacity slot. */
function unattendedDispatchState(botId: string): "ready" | "busy" | "missing" {
  const bot = store.bot(botId);
  return !bot ? "missing" : botAtThreadCapacity(botId) || activeGroupTurnForBot(botId) ? "busy" : "ready";
}

async function interruptAllDirectThreads(botId: string): Promise<void> {
  const threads = store.tasks(botId).filter((task) => task.busy || directTurnDispatchClaims.has(task.threadId) || roomHandoffs().activeDirect(task.threadId));
  // Revoke every sibling before yielding to any provider teardown.
  for (const task of threads) {
    cancelDirectTurnDispatch(botId, task.threadId);
    revokeInternalCapabilitiesForThread(task.threadId);
  }
  await Promise.all(threads.map((task) => interruptDirectThread(botId, task.threadId)));
}

/** Run a turn on `targetBotId` and resolve with its assistant text — the
 * synchronous half of ask_bot. Subscribes to the bus, folds assistant_text
 * for that thread, resolves on turn.completed (or a 4-min ceiling). */
function askBotAndWait(targetBotId: string, message: string, depth: number, fromBotId?: string, fromThreadId?: string, targetThreadId?: string): Promise<AskBotOutcome> {
  const target = store.bot(targetBotId);
  if (!target) return Promise.resolve({ status: "error", text: "(no such bot)" });
  const threadId = targetThreadId ?? target.threadId;
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    const finish = (out: AskBotOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve(out);
    };
    const unsub = bus.subscribe((e: RuntimeEvent) => {
      // A cancelled provider may flush text/completion after its replacement
      // has started on the same thread. Retired turn ids must never satisfy a
      // newer ask_bot waiter with the old partial reply.
      if (shouldIgnoreProviderEvent(e)) return;
      if (e.threadId !== threadId) return;
      if (e.type === "item.completed" && e.itemType === "assistant_text") {
        text += (text ? "\n" : "") + e.text;
      } else if (e.type === "turn.completed") {
        if (e.ok) finish({ status: "reply", text: text || "(the bot finished without a text reply)" });
        else finish({ status: "failed", text, stopReason: e.stopReason ?? null });
      }
    });
    // Timing out does NOT stop the peer's turn — the caller decides whether
    // the still-running work becomes a delegation claim ticket instead.
    const timer = setTimeout(() => finish({ status: "timeout", text }), ASK_BOT_TIMEOUT_MS());
    // The asker's identity rides on the stored line as well as in the note
    // prefixed to it: the wording is for the model reading this turn, the
    // field is for anything that reads the transcript later.
    const asker = fromBotId ? store.bot(fromBotId) : undefined;
    const unattended = isUnattended(fromBotId, fromThreadId);
    startTurn(targetBotId, message, {
      threadId,
      commsDepth: depth + 1,
      unattended,
      peerAsk: asker
        ? unattended
          ? { botId: asker.id, name: asker.name, unattended: true }
          : { botId: asker.id, name: asker.name }
        : undefined,
      onDispatchError: (reason) => finish({ status: "error", text: `(couldn't start that bot: ${reason})` }),
    }).catch((err) =>
      finish({ status: "error", text: `(couldn't start that bot: ${err instanceof Error ? err.message : String(err)})` }),
    );
  });
}
// The checked-input validators live in ./checked-inputs.ts: the pure ones
// (checkedExportSkillNames, collectExportSkills) are imported directly,
// checkedGroupResponder and checkedMemberIds by ./group-state.ts, while
// checkedModelSelection and
// checkedTaskModelSwitch come from the createCheckedInputs factory wired near
// the top of this file — they read the providerInstancesChanging set this
// file destructures from providerFleet far below. askBotAndWait stays here:
// it orchestrates turns over the module bus and the late-bound startTurn.
const teamComputers = new TeamComputers(join(DATA_DIR, "team-computers.json"), ENVIRONMENT_ID);
let followupsReady = false;
const sendSequencer = new SendSequencer();
// A committed profile cleanup means both its config deletion and bot-reference
// cleanup were intended to be durable. Reconcile stale secondary references
// before Electron can ACK and remove the journal: a crash between those writes
// in an older build must not let id reuse attach a bot to somebody else's new
// account. Prepared entries remain untouched because their deletion is
// ambiguous and must never authorize either mutation or a wipe.
let browserCleanupReferencesReconciled = true;
try {
  const committedProfileIds = new Set(browserCleanup.committedProfileIds());
  for (const bot of store.bots) {
    if (bot.browserProfile && committedProfileIds.has(bot.browserProfile)) {
      store.patchBot(bot.id, { browserProfile: undefined });
    }
  }
} catch (error) {
  browserCleanupReferencesReconciled = false;
  console.error(
    `browser cleanup: could not reconcile committed profile references: ${error instanceof Error ? error.message : String(error)}`,
  );
}
// Replay only after the secondary write above is durable. If reconciliation
// failed, leave the committed journal in place and profile reuse blocked.
if (browserCleanupReferencesReconciled) browserCleanup.startPending();
  return {
    localVmOwnerBusy, localVmLeases, localVmLifecycleBusy, localVmThreadTargets, localVmActiveThreads,
    localVmSeen, noteLocalVmSeen, activeVpsThreads, vpsThreadStarted, vpsThreadEnded, boxLifecycleBusyBots, vpsPreviewRequests,
    orphanBoxLifecycleBusyIds, computerProviderConfigTransitions,
    checkpointRestoreLeases, LOCAL_VM_IDLE_MS, LOCAL_VM_DESKTOP_WAIT_MS, localVmIdles,
    inheritedTeamComputer, teamComputerPrompt, botComputerControlKey, botComputerControlSnapshot,
    teamComputerInUse, assertTeamControlCanBeTaken, claimTeamComputerLifecycle, assertTeamComputerChangeIdle,
    teamComputersPayload, attachTeamBox, managedBoxOwners, botHasActiveTurn, providerTransitionMessage,
    providerOperationConflict, turnSurfacePlan, turnProvider, turnInstance, computerPreviewBot,
    computerPreviewSurface, selectableComputers, continueComputerSelection, runningTurnEngines,
    runningTurnInstance, providerTransitionForTurn, claimBoxInventoryRequest, claimManagedBoxMutation,
    claimBotComputerLifecycle, claimManagedVpsMutation, localVmTargetForBot, localVmLeaseFor, localVmIdleFor,
    releaseLocalVmThread, localVmInventoryPayload,
    turnResources, turnComputerResources,
    screenPollers, SCREEN_SETTLE_TIMEOUT_MS, startScreenPoller, pokeScreenPoller, stopScreenPoller, finalScreenFrame,
    sharedComputerControl, turnCleanup, releaseTurnResources, interruptDirectThread, settlingResourceOwners,
    autoVmClaims, bindTurnComputer, parksBehindCoordination, unattendedDispatchState, interruptAllDirectThreads,
    askBotAndWait, teamComputers, sendSequencer,
    followupsReady: { get: () => followupsReady, set: (value: boolean) => { followupsReady = value; } },
  };
}
