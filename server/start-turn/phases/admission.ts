// Admission phases for the direct-turn engine (server/start-turn.ts).
import { randomUUID } from "node:crypto";

import { DATA_DIR, maxConcurrentBotThreads, type AppConfig } from "../../config.ts";
import { assertWithinBudget } from "../../spend.ts";
import { type BotRecord, type Message, type Store } from "../../store.ts";
import {
  botAtThreadCapacity,
  directTurnBots,
  directTurnDispatchClaims,
  threadBusy,
  turnResourceOwners,
} from "../../turn-admission.ts";
import {
  beginInternalCapabilityGeneration,
  computerSelectionTurns,
  revokeInternalCapabilitiesForThread,
} from "../../internal-capabilities.ts";
import type { Handoffs } from "../../delta-context.ts";
import type { assembleTurnContext } from "./context.ts";
import type { StartTurnOptions } from "../../start-turn.ts";
import type { Deps } from "./shared.ts";

/** Admission: precondition checks, card-continuation opt rewrite, unattended marks and task binding. */
export function admitDirectTurn({
  botId,
  opts,
  store,
  cfg,
  workspaceMaintenance,
  activeGroupTurnForBot,
  providerTransitionForTurn,
  providerFleet,
  checkpointRestoreLeases,
  boxLifecycleBusyBots,
  routines,
  activeRoutineRunForThread,
  markUnattended,
  clearUnattended,
  delegationWakeBudget,
}: {
  botId: string;
  opts: StartTurnOptions | undefined;
  store: Store;
  cfg: AppConfig;
  workspaceMaintenance: Deps["runtime"]["workspaceMaintenance"];
  activeGroupTurnForBot: Deps["admission"]["activeGroupTurnForBot"];
  providerTransitionForTurn: Deps["admission"]["providerTransitionForTurn"];
  providerFleet: Deps["admission"]["providerFleet"];
  checkpointRestoreLeases: Deps["admission"]["checkpointRestoreLeases"];
  boxLifecycleBusyBots: Deps["admission"]["boxLifecycleBusyBots"];
  routines: Deps["routines"]["routines"];
  activeRoutineRunForThread: Deps["routines"]["activeRoutineRunForThread"];
  markUnattended: Deps["turnMarks"]["markUnattended"];
  clearUnattended: Deps["turnMarks"]["clearUnattended"];
  delegationWakeBudget: Deps["turnMarks"]["delegationWakeBudget"];
}) {
  workspaceMaintenance.assertAvailable();
  const profile = store.bot(botId);
  if (!profile) throw Object.assign(new Error("no such bot"), { status: 404 });
  const threadId = opts?.threadId ?? profile.threadId;
  const continuingRoutine = opts?.cardContinuation ? activeRoutineRunForThread(threadId) : null;
  if (continuingRoutine) {
    const onDispatchError = opts?.onDispatchError;
    opts = {
      ...opts,
      runOn: continuingRoutine.runOn,
      automationSource: continuingRoutine.triggerSource ?? (continuingRoutine.manual ? "manual" : "schedule"),
      onDispatchError: (message) => {
        routines()?.failThread(threadId, message);
        onDispatchError?.(message);
      },
    };
  }
  const bot = store.projectBotForTask(botId, threadId);
  if (!bot) throw Object.assign(new Error("no such task"), { status: 404 });
  // Routines and legacy peer delivery already have their own completion
  // owners. Only ordinary chats opt into this scheduler; its child turns
  // carry an exact node id rather than inheriting a routine's lifetime.
  const boundedCoordination = !opts?.automationSource && (!opts?.commsDepth || Boolean(opts?.coordination));
  if (bot.approvalGrant) {
    throw Object.assign(new Error("this bot's approval level is still being confirmed — try again"), { status: 409 });
  }
  const transitionError = providerTransitionForTurn(bot, opts?.runOn, threadId);
  if (transitionError) throw Object.assign(new Error(transitionError), { status: 409 });
  if (providerFleet().providerFleetReloading) throw Object.assign(new Error("provider settings are being updated — try again shortly"), { status: 409 });
  // A workspace at its monthly spend limit starts no turn of any kind: a
  // person's message, a routine, a peer hop or a webhook all stop here.
  assertWithinBudget(cfg, DATA_DIR);
  if (checkpointRestoreLeases.has(botId)) {
    throw Object.assign(new Error("this bot's project files are being restored — wait for the restore to finish"), {
      status: 409,
    });
  }
  if (boxLifecycleBusyBots.has(botId)) {
    throw Object.assign(new Error("this bot's cloud computer is being changed — wait for it to finish"), { status: 409 });
  }
  if (threadBusy(botId, threadId)) throw Object.assign(new Error("this thread is already working — interrupt it first"), { status: 409, code: "thread_busy" });
  if (activeGroupTurnForBot(botId)) {
    throw Object.assign(new Error("the bot is already working in a channel — wait for it to finish"), { status: 409, code: "thread_busy" });
  }
  if (botAtThreadCapacity(botId)) {
    throw Object.assign(new Error(`this bot has reached its limit of ${maxConcurrentBotThreads(cfg)} parallel threads — wait for one to finish`), { status: 409, code: "thread_limit" });
  }
  // Steering is never a cancel. A message sent while teammates are working
  // runs now, with their assignments still attached: they keep running and
  // their results still return here (outstandingAssignmentsPrompt tells this
  // turn which are still out). Stop, in this conversation, is the gesture
  // that ends coordination — see interruptDirectThread.
  // Retire anything a previous turn left behind before minting this turn's
  // integrations. Completion and interrupt paths do the same; this is the
  // final backstop against a retained proxy process.
  revokeInternalCapabilitiesForThread(threadId);
  // a webhook turn, or one inherited from a bot already running unattended
  if (opts?.automationSource === "webhook" || opts?.unattended) markUnattended(bot.id, threadId);
  // a person typing into this bot ends the unattended window immediately
  else if (opts?.automationSource === undefined && !opts?.commsDepth && !opts?.cardContinuation) {
    clearUnattended(threadId);
    delegationWakeBudget.reset(threadId);
  }
  const task = store.taskByThread(bot.id, threadId);
  if (!task) throw Object.assign(new Error("no such task"), { status: 404 });
  return { threadId, bot, task, boundedCoordination, opts };
}


/** Dispatch claim: busy flip, generation/claim registration and per-turn state reset. Runs synchronously so the composer locks immediately. */
export function claimDirectTurn({
  botId,
  text,
  opts,
  bot,
  threadId,
  commsDepth,
  userMessage,
  agentsMounted,
  dispatchContext,
  handoffs,
  store,
  directTurnGenerationByThread,
  directFollowupSettlers,
  directCoordinationSettlers,
  turnUsage,
  turnContext,
  inheritedTeamComputer,
}: {
  botId: string;
  text: string;
  opts: StartTurnOptions | undefined;
  bot: BotRecord;
  threadId: string;
  commsDepth: number;
  userMessage: Message;
  agentsMounted: boolean;
  dispatchContext: ReturnType<typeof assembleTurnContext>["dispatchContext"];
  handoffs: Handoffs;
  store: Store;
  directTurnGenerationByThread: Deps["dispatch"]["directTurnGenerationByThread"];
  directFollowupSettlers: Deps["dispatch"]["directFollowupSettlers"];
  directCoordinationSettlers: Deps["dispatch"]["directCoordinationSettlers"];
  turnUsage: Deps["fold"]["turnUsage"];
  turnContext: Deps["fold"]["turnContext"];
  inheritedTeamComputer: Deps["prompts"]["inheritedTeamComputer"];
}) {
  // busy flips immediately so the composer locks; the dispatch itself runs
  // in the background — box provisioning can take ~90s and must never
  // hang the HTTP request
  const dispatchClaimId = randomUUID();
  const resourceOwner = { threadId, generation: dispatchClaimId };
  turnResourceOwners.set(threadId, resourceOwner);
  directTurnGenerationByThread.set(threadId, dispatchClaimId);
  if (opts?.coordination) directCoordinationSettlers.set(dispatchClaimId, opts.coordination.settle);
  // Ordinary sources need the same exact completion ownership as queued
  // follow-ups: any normal turn may ask teammates to coordinate work.
  directFollowupSettlers.set(dispatchClaimId, { threadId, settle: opts?.onTurnSettled });
  directTurnDispatchClaims.set(threadId, { id: dispatchClaimId, botId, threadId, phase: "setup" });
  if (dispatchContext.handoff) handoffs.begin(threadId, dispatchClaimId, dispatchContext.handoff);
  directTurnBots.set(threadId, bot);
  beginInternalCapabilityGeneration(threadId, dispatchClaimId);
  if (!opts?.computerSelectionContinuation && !opts?.cardContinuation && !opts?.automationSource && !opts?.unattended &&
      !opts?.commsDepth && !opts?.coordination && !inheritedTeamComputer(bot) && bot.computer !== "off" && agentsMounted) {
    const source = store.activePath(threadId).findLast(message => message.id === userMessage?.id && message.role === "user" && !message.peerAsk);
    if (source) computerSelectionTurns.set(threadId, { generation: dispatchClaimId, botId: bot.id, source, text });
  }
  store.setTaskActivity(bot.id, threadId, "working");
  // A closed thread that gets a new turn is open again: the person (or the
  // opener) picked it back up, so its row returns to the sidebar and
  // list_threads stops calling it closed. No-op on an open thread.
  store.setTaskClosedBy(bot.id, threadId, null);
  // The badge is "this bot answered you, and you have not looked yet". A
  // person starting a turn has looked; a teammate's hop has not — the fold
  // never re-marks an internal turn, so clearing here would silently spend
  // a signal the person still owes a glance to.
  if (commsDepth === 0) store.patchTask(bot.id, threadId, { unread: false });
  turnUsage.delete(threadId);
  turnContext.delete(threadId);
  return { dispatchClaimId, resourceOwner };
}

