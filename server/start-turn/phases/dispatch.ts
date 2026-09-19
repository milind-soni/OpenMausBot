// Dispatch preparation, provider dispatch and failure-settlement phases
// for the direct-turn engine (server/start-turn.ts).
import { builtInBrowserEnabled, claudeUserMcpEnabled, type AppConfig } from "../../config.ts";
import { setupModeActive } from "../../setup-mode.ts";
import { buildSystemPrompt } from "../../system-prompt.ts";
import { agentBrowserFrame } from "../../browser-engine.ts";
import { guardTurnDispatch } from "../../turn-dispatch-guard.ts";
import { directTurnBots, threadBusy } from "../../turn-admission.ts";
import { type BotRecord, type Store } from "../../store.ts";
import {
  bindInternalCapabilityToProviderTurn,
  computerSelectionTurns,
  revokeInternalCapabilityGeneration,
} from "../../internal-capabilities.ts";
import { redactSecretsInText } from "../../redact.ts";
import { handoffs } from "../../delta-handoffs.ts";
import type { Handoff } from "../../delta-context.ts";
import { buildNotification } from "../../notify.ts";
import { reportIncident } from "../../incident-report.ts";
import { surfaceOfComputerKind, type SurfacePlan } from "../../surface.ts";
import type { TurnOwner } from "../../turn-resources.ts";
import type { ProviderInstance } from "../../contracts.ts";
import type { TeamComputerRecord } from "../../team-computers.ts";
import type { StartTurnOptions } from "../../start-turn.ts";
import type { CaptureFn, ComputerKind, Deps, SendTurnInput, Task, TurnIntegrations } from "./shared.ts";

/** The context decision a turn dispatches under: the text it sends, the
 * session it resumes, and the handoff a strict-resume engine records. */
export type TurnDispatchContext = {
  turnText: SendTurnInput["text"];
  resumeCursor: SendTurnInput["resumeCursor"];
  recoveryText: string | undefined;
  recoveryIsReplay: boolean;
  handoff: Handoff | undefined;
};

/** Dispatch preparation: browser mint, surface recording and the cancellation/handshake gates. */
export async function prepareTurnDispatch({
  bot,
  opts,
  threadId,
  plan,
  instance,
  computerKind,
  teamComputer,
  integrations,
  dispatchClaimId,
  providerText,
  agentsMounted,
  store,
  cfg,
  browserIntegration,
  browserRuntime,
  pendingCancelledProviderHandshakes,
  markDirectTurnDispatching,
  DirectTurnSetupCancelled,
  watchdog,
}: {
  bot: BotRecord;
  opts: StartTurnOptions | undefined;
  threadId: string;
  plan: SurfacePlan;
  instance: ProviderInstance;
  computerKind: ComputerKind;
  teamComputer: TeamComputerRecord | undefined;
  integrations: TurnIntegrations;
  dispatchClaimId: string;
  providerText: string;
  agentsMounted: boolean;
  store: Store;
  cfg: AppConfig;
  browserIntegration: Deps["computers"]["browserIntegration"];
  browserRuntime: Deps["computers"]["browserRuntime"];
  pendingCancelledProviderHandshakes: Deps["dispatch"]["pendingCancelledProviderHandshakes"];
  markDirectTurnDispatching: Deps["dispatch"]["markDirectTurnDispatching"];
  DirectTurnSetupCancelled: Deps["dispatch"]["DirectTurnSetupCancelled"];
  watchdog: Deps["events"]["watchdog"];
}) {
  let browser: Awaited<ReturnType<typeof browserIntegration>> = null;
  let browserCapture: (() => Promise<{ png: string; format: string }>) | null = null;
  // Mint the browser bearer at the last possible moment. The desktop
  // registration is asynchronous, so validate this exact setup claim
  // again inside browserIntegration before the capability is published.
  // Also the one bot snapshot setupModeActive and the prompt's soul
  // (below) share, so a soul saved mid-dispatch is seen by both instead
  // of the two disagreeing about whether setup mode is still active.
  const liveBot = store.bot(bot.id);
  const setupMode =
    agentsMounted &&
    setupModeActive({
      soul: liveBot?.soul ?? bot.soul,
      description: liveBot?.description ?? bot.description,
      text: providerText,
    });
  // One place per turn. On Auto the branches above may have reached a
  // computer; then the built-in browser stays unmounted and web work
  // happens in that computer's own browser, where the person can see it.
  const mountedComputer = surfaceOfComputerKind(computerKind);
  if (
    liveBot &&
    plan.browser &&
    !(plan.computer === undefined && mountedComputer) &&
    builtInBrowserEnabled(cfg) &&
    liveBot.browser !== false &&
    instance.adapter.capabilities.browserMcp === true
  ) {
    const selectedProfile = liveBot.browserProfile;
    browser = await browserIntegration(bot.id, selectedProfile, { threadId, generation: dispatchClaimId });
    if (browser) integrations.browser = browser.integration;
    // The browser lost its frame source when the Electron surface was
    // removed: previewCapture is set by the computer branches above, and
    // nothing replaced it here. A bot with only a browser was pictured
    // not at all; a bot with both was pictured on its desktop even while
    // the work was a web page, because agent-browser runs its own headless
    // Chrome on the host rather than inside that desktop.
    if (browser) {
      const frame = { binaryPath: browser.spec.command, env: browser.spec.env };
      const session = browser.session;
      browserCapture = () => browserRuntime.withAgentAction(session, () => agentBrowserFrame(frame));
    }
  }
  // An Auto conversation remembers where its first turn landed, so later
  // turns stay there and the composer can show it. Explicit settings are
  // not recorded: changing the bot's Works on should move its threads.
  if (bot.computer === undefined && !teamComputer && opts?.runOn !== "cloud" && !plan.pinned) {
    const used = mountedComputer ?? (integrations.browser ? "browser" : null);
    if (used) store.patchTask(bot.id, threadId, { surface: used });
  }
  const computerSelection = computerSelectionTurns.get(threadId);
  if (computerSelection) computerSelection.mounted = mountedComputer ?? (integrations.browser ? "browser" : undefined);
  // A cancelled adapter can be between accepting sendTurn and revealing
  // its provider turn id. Never overlap a replacement with that ambiguous
  // pre-id window: wait for the old handshake to settle or for its bounded
  // quarantine to expire, then revalidate this exact claim before launch.
  await pendingCancelledProviderHandshakes.waitForClear(threadId);
  if (!markDirectTurnDispatching(bot.id, dispatchClaimId, threadId)) {
    throw new DirectTurnSetupCancelled("turn stopped before dispatch");
  }
  watchdog.watch(threadId, bot.id);
  return { liveBot, setupMode, mountedComputer, browserCapture };
}


/** Dispatch and settlement: sendTurn under the dispatch guard, early-completion reconciliation, screen poller and the sync-completion drains. */
export async function dispatchProviderTurn({
  bot,
  threadId,
  instance,
  instanceId,
  turnImages,
  commsDepth,
  model,
  effort,
  variant,
  plannedContext,
  decideContext,
  sessionConfig,
  strictResume,
  liveBot,
  transcript,
  prompt,
  integrations,
  cwd,
  dispatchClaimId,
  resourceOwner,
  rewound,
  task,
  externalContextMarker,
  isExternalContextMarker,
  previewCapture,
  browserCapture,
  store,
  cfg,
  runningTurnEngines,
  directTurnGenerationByThread,
  directFollowupSettlers,
  directFollowupTurns,
  settleDirectCoordination,
  settleDirectFollowup,
  directTurnClaimExists,
  clearDirectTurnDispatch,
  retireProviderTurn,
  DirectTurnSetupCancelled,
  approvalModeForTurn,
  retryDelegationsWaitingOn,
  drainQueuedSends,
  drainConnectorResumes,
  drainSecretResumes,
  drainTeamSetupResumes,
  drainDelegationWakes,
  releaseTurnResources,
  settlingResourceOwners,
  startScreenPoller,
}: {
  bot: BotRecord;
  threadId: string;
  instance: ProviderInstance;
  instanceId: string;
  turnImages: SendTurnInput["images"];
  commsDepth: number;
  model: SendTurnInput["model"];
  effort: SendTurnInput["effort"];
  variant: SendTurnInput["variant"];
  plannedContext: TurnDispatchContext;
  decideContext: (config: string) => TurnDispatchContext;
  sessionConfig: (soul: string | undefined) => string;
  strictResume: boolean;
  liveBot: BotRecord | undefined;
  transcript: SendTurnInput["transcript"];
  prompt: ReturnType<typeof buildSystemPrompt>;
  integrations: TurnIntegrations;
  cwd: string | undefined;
  dispatchClaimId: string;
  resourceOwner: TurnOwner;
  rewound: boolean;
  task: Task;
  externalContextMarker: string | undefined;
  isExternalContextMarker: Deps["admission"]["isExternalContextMarker"];
  previewCapture: CaptureFn | null;
  browserCapture: CaptureFn | null;
  store: Store;
  cfg: AppConfig;
  runningTurnEngines: Deps["dispatch"]["runningTurnEngines"];
  directTurnGenerationByThread: Deps["dispatch"]["directTurnGenerationByThread"];
  directFollowupSettlers: Deps["dispatch"]["directFollowupSettlers"];
  directFollowupTurns: Deps["dispatch"]["directFollowupTurns"];
  settleDirectCoordination: Deps["dispatch"]["settleDirectCoordination"];
  settleDirectFollowup: Deps["dispatch"]["settleDirectFollowup"];
  directTurnClaimExists: Deps["dispatch"]["directTurnClaimExists"];
  clearDirectTurnDispatch: Deps["dispatch"]["clearDirectTurnDispatch"];
  retireProviderTurn: Deps["dispatch"]["retireProviderTurn"];
  DirectTurnSetupCancelled: Deps["dispatch"]["DirectTurnSetupCancelled"];
  approvalModeForTurn: Deps["prompts"]["approvalModeForTurn"];
  retryDelegationsWaitingOn: Deps["fold"]["retryDelegationsWaitingOn"];
  drainQueuedSends: Deps["fold"]["drains"]["drainQueuedSends"];
  drainConnectorResumes: Deps["fold"]["drains"]["drainConnectorResumes"];
  drainSecretResumes: Deps["fold"]["drains"]["drainSecretResumes"];
  drainTeamSetupResumes: Deps["fold"]["drains"]["drainTeamSetupResumes"];
  drainDelegationWakes: Deps["fold"]["drains"]["drainDelegationWakes"];
  releaseTurnResources: Deps["cleanup"]["releaseTurnResources"];
  settlingResourceOwners: Deps["cleanup"]["settlingResourceOwners"];
  startScreenPoller: Deps["cleanup"]["startScreenPoller"];
}) {
  runningTurnEngines.set(threadId, instance);
  // The prompt carries the soul as saved now. If it changed during setup,
  // decide again from what is actually sent.
  const dispatchedConfig = sessionConfig(liveBot?.soul ?? bot.soul);
  const plannedConfig = sessionConfig(bot.soul);
  const dispatchContext = strictResume && dispatchedConfig !== plannedConfig
    ? decideContext(dispatchedConfig) : plannedContext;
  // Before sendTurn: an adapter may emit the whole turn before it resolves.
  handoffs.dispatching(threadId, dispatchClaimId, dispatchContext.handoff);
  const dispatch = await guardTurnDispatch(instance.adapter.sendTurn({
    threadId,
    botId: bot.id,
    text: dispatchContext.turnText,
    refreshSystemPrompt: true,
    images: turnImages,
    approvalMode: approvalModeForTurn(bot, commsDepth > 0),
    model,
    effort,
    variant,
    // a rewound thread never resumes the abandoned branch's session
    // the active task's own session — another task's cursor would
    // resume the wrong conversation and defeat the context bubble
    resumeCursor: dispatchContext.resumeCursor,
    ...(dispatchContext.recoveryText !== undefined ? { recoveryText: dispatchContext.recoveryText } : {}),
    ...(dispatchContext.recoveryIsReplay ? { recoveryIsReplay: true } : {}),
    transcript,
    system: prompt.text,
    systemStable: prompt.stable,
    systemStanding: prompt.standing,
    systemVolatile: prompt.volatile,
    integrations,
    mcpFromUserConfig: claudeUserMcpEnabled(cfg),
    cwd,
  }), () => !directTurnClaimExists(bot.id, dispatchClaimId, threadId), async () => {
    await instance.adapter.interruptTurn(threadId).catch(() => {});
  });
  if (dispatch.cancelled) {
    retireProviderTurn(dispatch.value.turnId);
    throw new DirectTurnSetupCancelled("turn stopped during provider setup");
  }
  bindInternalCapabilityToProviderTurn(threadId, dispatchClaimId, dispatch.value.turnId);
  handoffs.bindTurn(threadId, dispatchClaimId, dispatch.value.turnId);
  if (directFollowupSettlers.has(dispatchClaimId) && dispatch.value.turnId &&
    !directFollowupTurns.bind(threadId, dispatchClaimId, dispatch.value.turnId)) {
    // This exact queued turn completed before its dispatch ACK arrived.
    const outcome = directFollowupTurns.takeEarlyCompletion(threadId, dispatch.value.turnId);
    if (outcome) settleDirectCoordination(dispatchClaimId, outcome);
    settleDirectFollowup(dispatchClaimId);
  }
  clearDirectTurnDispatch(threadId, dispatchClaimId);
  // dispatched: the rewind is spent, and the old cursors are dead
  if (rewound) store.patchTask(bot.id, threadId, { rewound: false, resumeCursors: {} });
  // and this engine now owns the thread's most recent turn
  // Consume exactly the external-update generation this turn replayed.
  // If a newer delegated result landed during setup, its unique marker
  // differs and must survive so the next turn also receives that update.
  if (!isExternalContextMarker(task.lastInstanceId) || task.lastInstanceId === externalContextMarker) {
    store.markTaskDispatched(bot.id, threadId, instanceId);
  }
  // a turn can settle before dispatch returns, and a poller started
  // after its own turn.completed would never be torn down — it would
  // keep polling the box forever, carrying dead per-turn state. busy
  // is flipped false in the fold, so it is the honest "still running".
  if ((previewCapture || browserCapture) && threadBusy(bot.id, threadId)) {
    startScreenPoller(
      bot.id,
      threadId,
      { ...(previewCapture ? { computer: previewCapture } : {}), ...(browserCapture ? { browser: browserCapture } : {}) },
      { screenIsTheWork: instance.driverKind === "boxAgent" },
    );
  }
  // An adapter may publish completion synchronously just before its
  // dispatch promise resolves. The event could not use the turn-id map
  // above yet, so close this exact generation from durable busy state.
  if (!threadBusy(bot.id, threadId) && directTurnGenerationByThread.get(threadId) === dispatchClaimId) {
    revokeInternalCapabilityGeneration(threadId, dispatchClaimId);
    if (settlingResourceOwners.get(threadId) !== dispatchClaimId) releaseTurnResources(resourceOwner);
    retryDelegationsWaitingOn(bot.id);
    drainQueuedSends();
    drainConnectorResumes();
    drainSecretResumes();
    drainTeamSetupResumes();
    drainDelegationWakes();
  }
}


/** Failure settlement: the catch path of the dispatch task — release, idle flip, error transcript line and drains. */
export function settleDispatchFailure({
  error: e,
  bot,
  opts,
  threadId,
  dispatchClaimId,
  resourceOwner,
  store,
  notify,
  watchdog,
  directTurnGenerationByThread,
  settleDirectFollowup,
  clearDirectTurnDispatch,
  clearCancelledProviderHandshake,
  DirectTurnSetupCancelled,
  turnUsage,
  turnContext,
  retryDelegationsWaitingOn,
  drainQueuedSends,
  drainConnectorResumes,
  drainSecretResumes,
  drainTeamSetupResumes,
  drainDelegationWakes,
  releaseTurnResources,
  releaseLocalVmThread,
  activeVpsThreads,
}: {
  error: unknown;
  bot: BotRecord;
  opts: StartTurnOptions | undefined;
  threadId: string;
  dispatchClaimId: string;
  resourceOwner: TurnOwner;
  store: Store;
  notify: Deps["events"]["notify"];
  watchdog: Deps["events"]["watchdog"];
  directTurnGenerationByThread: Deps["dispatch"]["directTurnGenerationByThread"];
  settleDirectFollowup: Deps["dispatch"]["settleDirectFollowup"];
  clearDirectTurnDispatch: Deps["dispatch"]["clearDirectTurnDispatch"];
  clearCancelledProviderHandshake: Deps["dispatch"]["clearCancelledProviderHandshake"];
  DirectTurnSetupCancelled: Deps["dispatch"]["DirectTurnSetupCancelled"];
  turnUsage: Deps["fold"]["turnUsage"];
  turnContext: Deps["fold"]["turnContext"];
  retryDelegationsWaitingOn: Deps["fold"]["retryDelegationsWaitingOn"];
  drainQueuedSends: Deps["fold"]["drains"]["drainQueuedSends"];
  drainConnectorResumes: Deps["fold"]["drains"]["drainConnectorResumes"];
  drainSecretResumes: Deps["fold"]["drains"]["drainSecretResumes"];
  drainTeamSetupResumes: Deps["fold"]["drains"]["drainTeamSetupResumes"];
  drainDelegationWakes: Deps["fold"]["drains"]["drainDelegationWakes"];
  releaseTurnResources: Deps["cleanup"]["releaseTurnResources"];
  releaseLocalVmThread: Deps["cleanup"]["releaseLocalVmThread"];
  activeVpsThreads: Deps["computers"]["activeVpsThreads"];
}) {
  handoffs.abandon(threadId, dispatchClaimId);
  if (computerSelectionTurns.get(threadId)?.generation === dispatchClaimId) computerSelectionTurns.delete(threadId);
  settleDirectFollowup(dispatchClaimId);
  clearCancelledProviderHandshake(threadId, `direct:${dispatchClaimId}`);
  clearDirectTurnDispatch(threadId, dispatchClaimId);
  revokeInternalCapabilityGeneration(threadId, dispatchClaimId);
  const ownsLatestGeneration = directTurnGenerationByThread.get(threadId) === dispatchClaimId;
  releaseTurnResources(resourceOwner);
  if (ownsLatestGeneration) {
    releaseLocalVmThread(threadId);
    if (activeVpsThreads.get(bot.id) === threadId) activeVpsThreads.delete(bot.id);
    watchdog.settle(threadId);
    turnUsage.delete(threadId);
    turnContext.delete(threadId);
  }
  if (e instanceof DirectTurnSetupCancelled) {
    opts?.onDispatchError?.(e.message);
    if (ownsLatestGeneration && threadBusy(bot.id, threadId)) {
      store.setTaskActivity(bot.id, threadId, "idle");
      directTurnBots.delete(threadId);
      retryDelegationsWaitingOn(bot.id);
    }
    if (ownsLatestGeneration) {
      drainQueuedSends();
      drainConnectorResumes();
      drainSecretResumes();
      drainTeamSetupResumes();
      drainDelegationWakes();
    }
    return;
  }
  if (!ownsLatestGeneration) return;
  const message = e instanceof Error ? e.message : String(e);
  store.appendMessage(threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `error: ${message.slice(0, 160)}`, ok: false },
  });
  // Worth a buzz for the same reason a routine failure is, and the rule
  // notify.ts encodes: the bot is not working, and the cause is usually
  // a setting only a person can change — an unattended user would
  // otherwise learn nothing until they next opened the thread.
  //
  // Only for a turn the person started themselves. A routine reaches
  // this same catch and then reports through onDispatchError, which
  // raises routine-failed; buzzing here too would ring twice for one
  // failure. A delegated sub-turn is reported to the bot that asked
  // for it, in its own thread, so it does not need a second channel.
  if (opts?.automationSource === undefined && !opts?.commsDepth && !opts?.cardContinuation) {
    notify(
      buildNotification("turn-failed", bot, threadId, redactSecretsInText(message), { avatarUrl: bot.avatarUrl }),
    );
    reportIncident({ kind: "could-not-start", bot, threadId, detail: message });
  }
  store.setTaskActivity(bot.id, threadId, "idle");
  directTurnBots.delete(threadId);
  retryDelegationsWaitingOn(bot.id);
  opts?.onDispatchError?.(message);
  // a dispatch failure never emits turn.completed, so the settle-driven
  // drain would strand anything queued behind this turn
  drainQueuedSends();
  drainConnectorResumes();
  drainSecretResumes();
  drainTeamSetupResumes();
  drainDelegationWakes();
}
