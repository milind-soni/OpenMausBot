// Named phase functions for the direct-turn engine (server/start-turn.ts).
// Each phase is a verbatim extraction of one region of the old startTurn
// body: it receives exactly the turn locals and dep handles it reads and
// returns exactly what the next phase consumes. The orchestrator in
// start-turn.ts owns the sequence; control flow that spans regions (the
// try/catch around dispatch, the final pre-dispatch gates) stays there.
import { createHash, randomUUID } from "node:crypto";

import * as box from "../box.ts";
import * as composio from "../composio.ts";
import * as vps from "../vps-computer.ts";
import {
  builtInBrowserEnabled,
  claudeUserMcpEnabled,
  customMcpServers,
  DATA_DIR,
  llmThreadTitlesEnabled,
  localVmMode,
  maxConcurrentBotThreads,
  skillAuthoringEnabled,
  vpsSshAlias,
  type AppConfig,
} from "../config.ts";
import { assertWithinBudget } from "../spend.ts";
import { assertModelVariantSupported } from "../member-turn.ts";
import { extractTurnImages } from "../turn-images.ts";
import { buildRecoveryText, buildTurnContext, engineIsFresh, peerMessageText } from "../turn-context.ts";
import { handedStateUsable, renderUnseen, sessionStart, unseenMessages, withUnseenMessages, type ContextMessage, type Handoffs } from "../delta-context.ts";
import { promptWithReply, transcriptText } from "../replies.ts";
import { peerName, peerRosterSystemPrompt, reachablePeers } from "../peer-roster.ts";
import { mentionedBots, type BotRecord, type Message, type Store } from "../store.ts";
import { chiefOfStaffSystemPrompt } from "../chief-of-staff.ts";
import { openMausStatusSystemPrompt } from "../openmaus-status-capsule.ts";
import { sectionContextSystemPrompt } from "../section-context.ts";
import { recentWork, recentWorkPrompt } from "../recent-work.ts";
import {
  ensureTaskWorkspace,
  ensureWorkspace,
  memorySystemPrompt,
  SESSION_SEARCH_SYSTEM_PROMPT,
  supportsWorkspaceFiles,
  workspaceLocationsPrompt,
} from "../workspace.ts";
import { skillsSystemPrompt } from "../skills.ts";
import { beginMemoryTurn } from "../memory-journal.ts";
import { expandLearnTurnText } from "../skill-learn.ts";
import { expandSetupTurnText, setupModeActive, setupSystemPrompt } from "../setup-mode.ts";
import { checkSoulDrift } from "../bot-folder.ts";
import {
  buildSystemPrompt,
  computerPrompt,
  COMPOSIO_PROMPT,
  CREDENTIAL_PROMPT,
  customMcpPrompt,
  LEARN_PROMPT,
  mentionPrompt,
  PROFILE_PROMPT,
  ROUTINE_EXECUTION_PROMPT,
  ROUTINE_PROMPT,
  THREADS_PROMPT,
  WEBHOOK_PROMPT,
  type ComputerPromptKind,
} from "../system-prompt.ts";
import { readCuaConnection, gatedLocalComputer } from "../local-computer.ts";
import { shouldMountLocalComputer } from "../local-routing.ts";
import {
  autoLocalVmAttachable,
  containerComputerFrame,
  containerComputerMcp,
  containerComputerStatus,
  type LocalVmTarget,
  type Runtime,
} from "../container-computer.ts";
import { workspaceResource, type TurnOwner } from "../turn-resources.ts";
import { renderSkillInstructions, selectBundledSkills } from "../skill-library.ts";
import { installedPlaybookInstructions } from "../installed-playbooks.ts";
import { computerBackendFor } from "../computer-backend.ts";
import { agentBrowserFrame, BUILT_IN_BROWSER_SYSTEM_PROMPT } from "../browser-engine.ts";
import { guardTurnDispatch } from "../turn-dispatch-guard.ts";
import { botAtThreadCapacity, claimTurnResource, directTurnBots, directTurnDispatchClaims, threadBusy, turnResourceOwners } from "../turn-admission.ts";
import {
  beginInternalCapabilityGeneration,
  bindInternalCapabilityToProviderTurn,
  computerSelectionTurns,
  revokeInternalCapabilitiesForThread,
  revokeInternalCapabilityGeneration,
} from "../internal-capabilities.ts";
import { redactSecretsInText } from "../redact.ts";
import { buildNotification } from "../notify.ts";
import { surfaceOfComputerKind, surfacePrompt, type SurfacePlan } from "../surface.ts";
import type { ProviderInstance } from "../contracts.ts";
import type { TeamComputerRecord } from "../team-computers.ts";
import type { StartTurnDeps, StartTurnOptions } from "../start-turn.ts";

type Deps = StartTurnDeps;
type Task = NonNullable<ReturnType<Store["taskByThread"]>>;
type SendTurnInput = Parameters<ProviderInstance["adapter"]["sendTurn"]>[0];
type TurnIntegrations = NonNullable<SendTurnInput["integrations"]>;
type CaptureFn = () => Promise<{ png: string; format: string }>;
type ComputerKind = "box" | "vps" | "vm" | "local" | null;

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


/** Active-branch messages a provider reads as conversation context. */
function isContextMessage(m: Message): boolean {
  return Boolean((m.kind === "text" && m.text) || m.roomRequest?.phase === "result");
}


/** Provider resolution: surface plan, provider instance, image/text split and model selection. */
export function resolveTurnProvider({
  botId,
  text,
  opts,
  bot,
  threadId,
  store,
  cfg,
  generateThreadTitle,
  turnSurfacePlan,
  turnProvider,
  turnInstance,
  providerInstancesChanging,
  markInternalTurn,
  clearInternalTurn,
}: {
  botId: string;
  text: string;
  opts: StartTurnOptions | undefined;
  bot: BotRecord;
  threadId: string;
  store: Store;
  cfg: AppConfig;
  generateThreadTitle: Deps["titles"]["generateThreadTitle"];
  turnSurfacePlan: Deps["admission"]["turnSurfacePlan"];
  turnProvider: Deps["admission"]["turnProvider"];
  turnInstance: Deps["admission"]["turnInstance"];
  providerInstancesChanging: Deps["admission"]["providerInstancesChanging"];
  markInternalTurn: Deps["turnMarks"]["markInternalTurn"];
  clearInternalTurn: Deps["turnMarks"]["clearInternalTurn"];
}) {
  const plan = turnSurfacePlan(bot, opts?.runOn, threadId);
  const instance = turnInstance(bot, opts?.runOn, threadId);
  if (!instance) {
    throw Object.assign(
      new Error(
        turnProvider(bot, opts?.runOn, threadId) === "box"
          ? "the Cloud VM runner is unavailable — configure Box in App Settings"
          : `provider instance "${bot.modelSelection.instanceId}" is unavailable — pick another model in settings`,
      ),
      { status: 409 },
    );
  }
  // Resolve only transport tags from this newly submitted text. The original
  // string remains the durable message. Native-image providers get a
  // path-free prompt and bounded inputs instead of needing a Read tool;
  // path-reading drivers retain the attachment tag as their compatibility route.
  const resolvedImages = extractTurnImages(text);
  const usesNativeImageInput = instance.adapter.capabilities.nativeImageInput === true;
  const providerText = usesNativeImageInput ? resolvedImages.text : text;
  const turnImages = usesNativeImageInput ? resolvedImages.images : [];
  const commsDepth = opts?.commsDepth ?? 0;
  // Classify the turn where the peer paths' depth actually arrives: by the
  // time it settles, the fold has only a thread id to go on.
  if (commsDepth > 0) markInternalTurn(threadId);
  else clearInternalTurn(threadId);
  // a task takes its name from the first thing you asked it to do
  if (resolvedImages.text.trim() && !opts?.cardContinuation) {
    const titled = store.titleTaskFromFirstMessage(bot.id, resolvedImages.text, threadId);
    // The snippet is only the fallback name. A cheap one-shot may trade it
    // for a title a person would have typed, but never on a peer-opened
    // row: adoption recognises those by the exact title their assignment
    // gave them (openingRequestTitle), and a generated one would break the
    // comparison it renames under. Everywhere else, the swap happens only
    // while the row still carries the snippet — a rename by the person or
    // by adoption has already broken that equality by then.
    const snippet = titled?.title;
    if (titled && snippet && !titled.openedBy?.botId && llmThreadTitlesEnabled(cfg) && instance.generateText) {
      void generateThreadTitle(instance, resolvedImages.text)
        .then((title) => {
          if (title) store.retitleTask(bot.id, threadId, snippet, title);
        })
        .catch(() => undefined);
    }
  }

  console.error(`[omb-turn] bot=${botId} text=${JSON.stringify(resolvedImages.text.slice(0, 70))} images=${turnImages.length} depth=${commsDepth} card=${Boolean(opts?.cardContinuation)}`);
  const instanceId = instance.instanceId;
  if (providerInstancesChanging().has(instanceId)) {
    throw Object.assign(new Error("this provider account is being updated — try again shortly"), { status: 409 });
  }
  const switchedEngine = instance.instanceId !== bot.modelSelection.instanceId;
  const model = opts?.runOn === "cloud" || switchedEngine ? instance.models.default : bot.modelSelection.model;
  // a cloud routine borrows the instance default model, so it borrows no
  // per-bot effort either
  const effort = opts?.runOn === "cloud" || switchedEngine ? undefined : bot.modelSelection.effort;
  const variant = opts?.runOn === "cloud" || switchedEngine ? undefined : bot.modelSelection.variant;
  assertModelVariantSupported({ variant, effort }, instance.adapter.capabilities);
  // A selection can be persisted while its engine is offline. Re-check when
  // the engine returns so an old or unsupported value never reaches a CLI.
  if (effort && !instance.adapter.capabilities.effortLevels?.includes(effort)) {
    throw Object.assign(
      new Error(`effort "${effort}" is not offered by this bot's engine — choose another level in settings`),
      { status: 409 },
    );
  }
  return { plan, instance, providerText, turnImages, commsDepth, instanceId, model, effort, variant };
}


/** User-message binding: edit branch, card continuation or plain append, plus the person-ask record. */
export function bindUserMessage({
  text,
  opts,
  bot,
  task,
  threadId,
  commsDepth,
  store,
  personAskAt,
}: {
  text: string;
  opts: StartTurnOptions | undefined;
  bot: BotRecord;
  task: Task;
  threadId: string;
  commsDepth: number;
  store: Store;
  personAskAt: Deps["fold"]["personAskAt"];
}) {
  // an edit hands us its already-branched user message; a plain send appends
  let userMessage = opts?.userMessage;
  if (opts?.editedMessageId) {
    const edited = store.branchMessage(threadId, opts.editedMessageId, text);
    if (!edited) throw Object.assign(new Error("only a user text message can be edited"), { status: 400 });
    store.patchTask(bot.id, threadId, { rewound: true });
    userMessage = edited;
  }
  if (!userMessage) {
    userMessage = opts?.cardContinuation
      ? { id: `card-${randomUUID()}`, at: Date.now(), role: "user", kind: "text", text }
      : store.appendMessage(threadId, {
          role: "user",
          kind: "text",
          text,
          replyToId: opts?.replyTo?.id,
          sendId: opts?.sendId,
          peerAsk: opts?.peerAsk,
          sender: opts?.sender,
        });
  }
  // A card continuation neither starts nor ends the person's ask: it
  // resumes the turn their last message began, so that record stands.
  if (!opts?.cardContinuation) {
    if (commsDepth === 0 && opts?.automationSource === undefined && !opts?.unattended && !userMessage.peerAsk) {
      personAskAt.set(threadId, userMessage.at);
      // Continuing an old run as a normal conversation makes that task
      // visible again; these new replies are not routine report updates.
      if (task.routineRunId) store.patchTask(bot.id, threadId, { routineRunId: undefined });
    } else {
      personAskAt.delete(threadId);
    }
  }
  return userMessage;
}


/** Context/session assembly: transcript, resume-cursor decision, persona and the soul-drift check. */
export function assembleTurnContext({
  opts,
  bot,
  task,
  threadId,
  instance,
  instanceId,
  commsDepth,
  model,
  effort,
  providerText,
  userMessage,
  store,
  cfg,
  roomHandoffs,
  teammateReportContext,
  isExternalContextMarker,
  maxCommsDepth: MAX_COMMS_DEPTH,
}: {
  opts: StartTurnOptions | undefined;
  bot: BotRecord;
  task: Task;
  threadId: string;
  instance: ProviderInstance;
  instanceId: string;
  commsDepth: number;
  model: string | undefined;
  effort: string | undefined;
  providerText: string;
  userMessage: Message;
  store: Store;
  cfg: AppConfig;
  roomHandoffs: Deps["handoffs"]["roomHandoffs"];
  teammateReportContext: Deps["prompts"]["teammateReportContext"];
  isExternalContextMarker: Deps["admission"]["isExternalContextMarker"];
  maxCommsDepth: number;
}) {
  // transcript for API-backed drivers: settled text turns on the ACTIVE
  // branch only — abandoned forks never reach the model
  const skipTranscript = new Set<string>([userMessage.id, ...(opts?.excludeMessageIds ?? [])]);
  const activeMessages = store.activePath(threadId);
  // This turn's own text carries the addressed request and, when resuming,
  // every child result as JSON: neither is repeated from the transcript.
  const coordinationChildren = opts?.coordination?.resumed
    ? new Set(roomHandoffs.children(opts.coordination.id).map((child) => child.id)) : undefined;
  for (const m of activeMessages) {
    if (!opts?.coordination || !m.roomRequest) continue;
    if ((m.roomRequest.phase === "request" && m.roomRequest.id === opts.coordination.id) ||
      (m.roomRequest.phase === "result" && coordinationChildren?.has(m.roomRequest.id))) skipTranscript.add(m.id);
  }
  // A flat reply may deliberately point across a fork in the same thread.
  // Resolve its quote from full storage, while the replay itself remains
  // strictly limited to the selected branch below.
  const messagesById = new Map(store.messagesFor(threadId).map((message) => [message.id, message]));
  const context: ContextMessage[] = activeMessages.filter(isContextMessage).map((m) => ({
    id: m.id,
    role: m.role === "user" ? ("user" as const) : ("assistant" as const),
    text: m.roomRequest?.phase === "result" ? teammateReportContext(m.roomRequest.id, bot.id)
      : m.role !== "user" && m.from ? peerMessageText(m.from.name, transcriptText(m, messagesById, cfg.profile?.name?.trim() || "User"))
      : transcriptText(m, messagesById, cfg.profile?.name?.trim() || "User"),
    keep: m.roomRequest?.phase === "result" || (m.role !== "user" && Boolean(m.from)),
    ...(m.steered ? { steered: true } : {}),
  }));
  const contextOrder = context.map((m) => m.id);
  const replayable = context.filter((m) => !skipTranscript.has(m.id));
  const transcript = replayable.slice(-40).map((m) => ({ role: m.role, text: m.text }));

  // After a rewind (edit / branch switch) the provider's native session
  // still contains the abandoned branch: start a fresh session instead of
  // resuming, and for cursor-resuming drivers replay the surviving path
  // inline (transcript-replay drivers get it via transcript). The flag is
  // cleared only once the turn is actually dispatched — clearing it here
  // would cost the next attempt its history if this dispatch fails.
  const rewound = Boolean(task.rewound);
  // A fresh engine — the user switched this bot's model mid-thread — has no
  // current session here either, so it gets the same replay. Distinct from
  // rewound: the OTHER instances' cursors are left alone (a rewind wipes
  // them all), and "fresh" is decided by who ran the last turn, not by
  // whether we hold a cursor — see engineIsFresh.
  const externalContextMarker = isExternalContextMarker(task.lastInstanceId)
    ? task.lastInstanceId
    : undefined;
  const fresh =
    !rewound &&
    !externalContextMarker &&
    engineIsFresh({ instanceId, lastInstanceId: task.lastInstanceId, resumeCursors: task.resumeCursors, transcript });
  // An engine that records what its session was handed resumes it with only
  // the context messages outside that record. A record of another session
  // (the one it replaced) or one that no longer lines up with the branch is
  // not trusted: the session is rebuilt by the same replay as any other.
  const strictResume = instance.adapter.capabilities.strictResume === true;
  const cursor = task.resumeCursors[instanceId];
  const handed = strictResume && !rewound && !fresh && !externalContextMarker && cursor !== undefined
    ? task.handedMessages?.[instanceId] : undefined;
  const unseen = handed && handedStateUsable(handed, cursor, contextOrder) ? unseenMessages(replayable, contextOrder, handed) : undefined;
  // A teammate's result or reply: without records this turn would replay.
  const externalUpdate = Boolean(opts?.coordination?.resumed || unseen?.some((m) => m.keep));
  // What a resumed session keeps from its launch: the standing instructions
  // (tools, servers and — for Claude — the model are passed on every launch),
  // plus whatever this engine can only set when a session starts. Codex's
  // thread/resume sends no model selection, and an effort it is not sent stays
  // at the thread's last value, so both belong to the session there. An
  // external update that finds any of it changed since the session started
  // gets the fresh session and replay it always got, rather than a resume.
  const persistentConfig = [bot.name, bot.title, bot.description, sectionContextSystemPrompt(bot.section),
    ...(instance.driverKind === "codex" ? [model, effort ?? null] : [])];
  const sessionConfig = (soul: string | undefined) =>
    createHash("sha256").update(JSON.stringify([...persistentConfig, soul])).digest("hex").slice(0, 16);
  const plannedConfig = sessionConfig(bot.soul);
  // Agent-tool gate shared by skill authoring, the /setup turn-text rewrite,
  // the setup prompt block, and the peer-comms integration below: a driver
  // that never mounts agent tools (or a turn already at the comms-depth cap)
  // must not be steered into — or told about — tools it cannot call.
  const agentsMounted = (commsDepth < MAX_COMMS_DEPTH || Boolean(opts?.coordination)) && instance.adapter.capabilities.agentsMcp === true;
  const skillAuthoring = skillAuthoringEnabled(cfg) && agentsMounted;
  // Setup mode's turn-text rewrite (parseSetupCommand/expandSetupTurnText)
  // must not run ahead of a system prompt that can't explain it: a driver
  // without agent tools sees the user's literal "/setup ..." message. The
  // gate on whether the coaching block itself is active — setupModeActive,
  // which also depends on the bot's soul/description — is decided below,
  // from the same bot snapshot the prompt's soul is built from.
  const setupText = agentsMounted ? expandSetupTurnText(providerText) : providerText;
  const userTurnText = promptWithReply(
    skillAuthoring ? expandLearnTurnText(setupText) : setupText,
    opts?.replyTo,
    cfg.profile?.name?.trim() || "User",
  );
  // Decided again at dispatch when setup outlasted a soul edit (config).
  const decideContext = (config: string) => {
    const handedStale = Boolean(handed && (!unseen || (externalUpdate && handed.config !== config)));
    const { block: unseenBlock, placed } = unseen && !handedStale ? renderUnseen(unseen) : { block: "", placed: [] };
    const { turnText: contextTurnText, resume } = buildTurnContext({
      text: userTurnText,
      transcript,
      rewound,
      fresh,
      externallyUpdated: Boolean(externalContextMarker) || handedStale,
      replaysNatively: instance.driverKind === "grok",
    });
    // Snapshot the cursor alongside the context decision. An external result
    // can arrive during async computer/setup work and clear the task cursor;
    // this already-built turn must either keep its old session or replay on the
    // following turn, never start a blank session with no transcript.
    const resumeCursor = resume ? task.resumeCursors[instanceId] : undefined;
    // A cursor the provider no longer honours must not brick the thread: the
    // driver may fall back to ONE fresh session, and this is what it sends
    // there, so the new session is not blank (server/resume-recovery.ts). A
    // turn carrying an external update gets the replay it would have had.
    const recoveryIsReplay = resumeCursor !== undefined && externalUpdate && transcript.length > 0;
    const recoveryText = resumeCursor === undefined ? undefined : recoveryIsReplay
      ? buildTurnContext({ text: userTurnText, transcript, rewound: false, fresh: false, externallyUpdated: true, replaysNatively: false }).turnText
      : buildRecoveryText({ text: userTurnText, transcript });
    // What this turn puts in front of the provider, for each session it can end
    // up in (server/delta-context.ts). buildTurnContext prepends a replay only
    // when it replays, so a changed text means the transcript was sent.
    const carried = [...skipTranscript];
    const windowIds = replayable.slice(-40).map((m) => m.id);
    return {
      turnText: withUnseenMessages(unseenBlock, contextTurnText),
      resumeCursor, recoveryText, recoveryIsReplay,
      handoff: strictResume ? {
        botId: bot.id, instanceId, config, resumeCursor: typeof resumeCursor === "string" ? resumeCursor : undefined,
        started: sessionStart(contextOrder, contextTurnText !== userTurnText ? windowIds : [], carried),
        recovery: sessionStart(contextOrder, recoveryText !== undefined ? windowIds : [], carried),
        resumed: sessionStart(contextOrder, [], [...placed, ...carried]),
        placed, carried, own: [userMessage.id, ...(opts?.excludeMessageIds ?? [])],
      } : undefined,
    };
  };
  let dispatchContext = decideContext(plannedConfig);

  const persona = [
    `You are ${bot.name}, a personal bot in OpenMausBot.`,
    bot.title && `Role: ${bot.title}.`,
    bot.description && `About: ${bot.description}`,
  ]
    .filter(Boolean)
    .join(" ");

  // The SOUL.md mirror is checked here, at dispatch, and only reported:
  // the prompt below reads bot.soul, never the file.
  {
    const drift = checkSoulDrift(bot.id, bot.soul ?? "", bot.soulHash ?? "");
    if (drift.drift !== Boolean(bot.soulDrift)) store.patchBot(bot.id, { soulDrift: drift.drift });
  }
  return { transcript, rewound, externalContextMarker, agentsMounted, skillAuthoring, dispatchContext, decideContext, strictResume, plannedConfig, sessionConfig, persona };
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


/** Capability assembly: workspace, skills, phone/composio/MCP integrations and the computer destination (VM/VPS/Box/host). */
export async function assembleTurnIntegrations({
  bot,
  opts,
  threadId,
  plan,
  instance,
  providerText,
  skillAuthoring,
  dispatchClaimId,
  resourceOwner,
  store,
  cfg,
  broadcast,
  availableSkills,
  phoneIntegration,
  connectedAppsIntegration,
  bindTurnComputer,
  attachTeamBox,
  controlIntegration,
  vpsThreadStarted,
  vpsThreadEnded,
  turnResources,
  turnComputerResources,
  stopScreenPoller,
  screenPollers,
  startScreenPoller,
  browserCaptureRef,
  inheritedTeamComputer,
  autoVmClaims,
  releaseLocalVmThread,
  localVmTargetForBot,
  localVmLeaseFor,
  localVmIdleFor,
  localVmThreadTargets,
  localVmActiveThreads,
  localVmLifecycleBusy,
  localVmSeen,
  localVmOwnerBusy,
  localVmImageBusy,
  localVmModeChangeBusy,
  readyLocalVmForTurn,
}: {
  bot: BotRecord;
  opts: StartTurnOptions | undefined;
  threadId: string;
  plan: SurfacePlan;
  instance: ProviderInstance;
  providerText: string;
  skillAuthoring: boolean;
  dispatchClaimId: string;
  resourceOwner: TurnOwner;
  store: Store;
  cfg: AppConfig;
  broadcast: Deps["events"]["broadcast"];
  availableSkills: Deps["prompts"]["availableSkills"];
  phoneIntegration: Deps["computers"]["phoneIntegration"];
  connectedAppsIntegration: Deps["computers"]["connectedAppsIntegration"];
  bindTurnComputer: Deps["computers"]["bindTurnComputer"];
  attachTeamBox: Deps["computers"]["attachTeamBox"];
  controlIntegration: Deps["computers"]["controlIntegration"];
  vpsThreadStarted: Deps["computers"]["vpsThreadStarted"];
  vpsThreadEnded: Deps["computers"]["vpsThreadEnded"];
  turnResources: Deps["cleanup"]["turnResources"];
  turnComputerResources: Deps["cleanup"]["turnComputerResources"];
  stopScreenPoller: Deps["cleanup"]["stopScreenPoller"];
  screenPollers: Deps["cleanup"]["screenPollers"];
  startScreenPoller: Deps["cleanup"]["startScreenPoller"];
  browserCaptureRef: { current: (() => Promise<{ png: string; format: string }>) | null };
  inheritedTeamComputer: Deps["prompts"]["inheritedTeamComputer"];
  autoVmClaims: Deps["cleanup"]["autoVmClaims"];
  releaseLocalVmThread: Deps["cleanup"]["releaseLocalVmThread"];
  localVmTargetForBot: Deps["localVm"]["localVmTargetForBot"];
  localVmLeaseFor: Deps["localVm"]["localVmLeaseFor"];
  localVmIdleFor: Deps["localVm"]["localVmIdleFor"];
  localVmThreadTargets: Deps["localVm"]["localVmThreadTargets"];
  localVmActiveThreads: Deps["localVm"]["localVmActiveThreads"];
  localVmLifecycleBusy: Deps["localVm"]["localVmLifecycleBusy"];
  localVmSeen: Deps["localVm"]["localVmSeen"];
  localVmOwnerBusy: Deps["localVm"]["localVmOwnerBusy"];
  localVmImageBusy: Deps["localVm"]["localVmImageBusy"];
  localVmModeChangeBusy: Deps["localVm"]["localVmModeChangeBusy"];
  readyLocalVmForTurn: Deps["localVm"]["readyLocalVmForTurn"];
}) {
  const integrations: NonNullable<Parameters<typeof instance.adapter.sendTurn>[0]["integrations"]> = {};
  const selectedSkills = selectBundledSkills(
    providerText,
    [
      ...(instance.adapter.capabilities.phoneMcp === true ? ["phoneMcp"] : []),
      ...(skillAuthoring ? ["skillAuthoring"] : []),
    ],
    availableSkills(),
  );
  if (selectedSkills.some((skill) => skill.manifest.requiredCapabilities.includes("phoneMcp"))) {
    if (!claimTurnResource(resourceOwner, "computer:phone")) throw new Error("another thread is using the phone — wait for it to finish");
    integrations.phone = phoneIntegration();
  }
  // the user's connected apps, but only to a driver that can mount
  // them — a key in the config says the connections exist, not that
  // this engine can reach them — and only to a bot the user has not
  // switched off: the key is workspace-wide, the grant is per bot.
  if (bot.composio !== false && composio.configured(cfg) && instance.adapter.capabilities.composioMcp === true) {
    const connection = await connectedAppsIntegration(bot.id, threadId, dispatchClaimId);
    if (connection) integrations.composio = connection;
  }
  // user-configured MCP servers (config.json mcpServers): same rule as
  // composio — only to a driver that can mount them. Their tools are
  // never pre-allowed, so every call rides the normal permission flow.
  if (instance.adapter.capabilities.customMcp === true) {
    const custom = customMcpServers(cfg, bot.mcpServers);
    if (Object.keys(custom).length) integrations.custom = custom;
  }
  // CLI engines work inside the bot's own workspace directory rather
  // than the user's home: a bot with file tools and acceptEdits gets a
  // desk, not the whole house — and the workspace is where its
  // MEMORY.md lives. API/box engines have no local filesystem story.
  const worksInWorkspace = supportsWorkspaceFiles(instance.driverKind);
  if (worksInWorkspace) {
    ensureWorkspace(bot.id);
    // baseline for the journal's turn-boundary diff (see the bus hook)
    beginMemoryTurn(bot.id, threadId);
  }
  const privateWorkspace = worksInWorkspace ? ensureTaskWorkspace(bot.id, threadId) : undefined;
  const skillInstructions = renderSkillInstructions(selectedSkills, {
    includeRoot: worksInWorkspace && opts?.runOn !== "cloud",
  });
  const packagePlaybooks = installedPlaybookInstructions(providerText, bot.playbooks);
  // An explicit working folder wins for new tasks; otherwise they use
  // the private bot workspace. A legacy task with an existing provider
  // session deliberately pins to null (the old home-folder behavior),
  // because moving a live session would break resume.
  // A cloud run happens on the box, where a host folder means nothing:
  // pin the task to the default so the header chip never shows the
  // bot's folder for a task that runs elsewhere.
  if (opts?.runOn === "cloud") store.pinTaskCwd(bot.id, threadId, undefined, { none: true });
  const pinnedCwd =
    privateWorkspace && opts?.runOn !== "cloud"
      ? store.pinTaskCwd(bot.id, threadId, privateWorkspace)
      : null;
  const cwd = pinnedCwd ?? undefined;
  if (cwd && !claimTurnResource(resourceOwner, workspaceResource(cwd))) {
    throw Object.assign(new Error("another thread is working in this project folder — wait for it to finish or choose a separate folder"), { status: 409, code: "workspace_busy" });
  }
  // Checkpoint explicit project folders, where a bot can overwrite the
  // user's work. Its private OpenMaus workspace is app-owned and changes
  // on nearly every ordinary chat; snapshotting it would add hidden disk
  // and process overhead without a user project to restore.
  const checkpointCwd = cwd && cwd !== privateWorkspace ? cwd : undefined;
  // dweb is opt-in: without an explicit daemon URL, do not advertise
  // tools that would fail on every call or spawn an unnecessary proxy.
  const dwebUrl = process.env.DWEB_URL?.trim();
  if (dwebUrl) integrations.dweb = { url: dwebUrl };
  // Cloud routines always use Box/BoxAgent. The per-bot backend applies
  // only to ordinary turns that mount a computer into the local agent.
  const teamComputer = inheritedTeamComputer(bot);
  const computerBackend = computerBackendFor(bot);
  const cloudBackend = teamComputer || opts?.runOn === "cloud" || computerBackend.kind !== "vps" ? "box" : "vps";
  const mountsComputerMcp = instance.adapter.capabilities.computerMcp === true;
  // Box's native runner owns its computer tools. Local drivers mount
  // Local VM/VPS tools, but have no Box relay to execute this descriptor.
  const mountsCloudComputer = instance.driverKind === "boxAgent";
  const mountsLocalComputer = instance.adapter.capabilities.localComputerMcp === true;
  // Where this turn's hands may land. The bot's "Works on" choice is
  // strict; a browser-only bot gets no computer at all, and a bot whose
  // browser is withheld (workspace flag, its own switch, or an engine
  // without browser tools) gets told so instead of silently falling back
  // to a desktop it was never meant to touch.
  // The conversation's own place wins over the bot default: the person
  // pinned it from the composer, or its first Auto turn recorded where it
  // landed. A team computer or a cloud routine is not this conversation's
  // choice, so those ignore the pin.
  const dispatchTask = store.taskByThread(bot.id, threadId);
  if (plan.clearPin && dispatchTask) store.patchTask(bot.id, threadId, { surface: undefined });
  if (plan.computer !== undefined && plan.computer !== "cloud" && instance.driverKind === "boxAgent") {
    throw new Error("the Computer engine works on the cloud computer — set Works on to Cloud, or choose another engine");
  }
  const wants = plan.computer;
  let previewCapture: (() => Promise<{ png: string; format: string }>) | null = null;
  let computerKind: "box" | "vps" | "vm" | "local" | null = null;
  let autoVpsProblem: string | null = null;
  /** The Local VM frame capture for the poller and the settled transcript
   * screenshot. The shared desktop outlives the turn: once another thread
   * owns it, a capture still in flight would picture ITS work under this
   * bot's name — live and in the settled frame, which is taken after the
   * lease is already released. No owner means the desktop is simply
   * idle: that final frame is ours to keep. */
  const localVmPreviewFor = (localVmTarget: LocalVmTarget, claimThreadId: string) => () => {
    const owner = localVmLeaseFor(localVmTarget).current(localVmOwnerBusy);
    if (owner && owner.threadId !== claimThreadId) {
      throw new Error("the Local VM moved on to another turn");
    }
    return containerComputerFrame(undefined, undefined, localVmTarget);
  };
  /** The exclusive Local VM claim sequence, verbatim from the old inline
   * attach path, shared by dispatch (eager) and the first-screen-call
   * gate (issue #1361). Idempotent per turn: the resource claim and
   * the lease both re-assert the same owner, so a re-entrant call from
   * the gate no-ops once dispatch has already claimed. A lazy attach pins
   * the target it mounted the tools against: the claim must lease that
   * desktop, not whatever localVmTargetForBot resolves to by the time
   * the first screen call arrives. */
  const claimAutoLocalVm = async (claimThreadId: string, pinnedTarget?: LocalVmTarget): Promise<{ target: LocalVmTarget; runtime: Runtime }> => {
    const localVmTarget = pinnedTarget ?? localVmTargetForBot(bot.id);
    await bindTurnComputer(resourceOwner, `computer:vm:${localVmTarget.key}`, true);
    if (localVmImageBusy() || localVmModeChangeBusy() || localVmLifecycleBusy.has(localVmTarget.key)) {
      throw new Error("this Local VM is being started, stopped, or replaced — wait for setup to finish");
    }
    // Claim before the first await. The lifecycle route performs its
    // matching check synchronously, so neither side can enter while the
    // other is between inspection and mutation.
    if (!localVmLeaseFor(localVmTarget).claim(claimThreadId, bot.id, localVmOwnerBusy)) {
      throw new Error("this Local VM is already being used by another turn — wait for that turn to finish");
    }
    localVmThreadTargets.set(claimThreadId, localVmTarget);
    localVmActiveThreads.set(localVmTarget.key, claimThreadId);
    localVmIdleFor(localVmTarget).touch();
    // The lease is held from here. An eager attach that fails below
    // fails the turn and settle releases it; a lazy claim's rejection is
    // swallowed into the slot's failed flag and the turn carries on, so
    // without this the exclusive lease would sit held for the rest of a
    // turn that never got the VM — the very serialisation #1361 removes.
    const dropLease = () => {
      localVmLeaseFor(localVmTarget).release(claimThreadId);
      if (localVmActiveThreads.get(localVmTarget.key) === claimThreadId) localVmActiveThreads.delete(localVmTarget.key);
      localVmThreadTargets.delete(claimThreadId);
      // bindTurnComputer above also took the turn-level resource; a
      // later turn's exclusive bind queues behind it just the same.
      const resource = `computer:vm:${localVmTarget.key}`;
      turnResources.releaseOne(resource, resourceOwner);
      if (turnComputerResources.get(resourceOwner.threadId)?.resource === resource) turnComputerResources.delete(resourceOwner.threadId);
    };
    let localVm: Awaited<ReturnType<typeof readyLocalVmForTurn>>;
    try {
      localVm = await readyLocalVmForTurn(bot.id, localVmTarget);
    } catch (error) {
      dropLease();
      throw error;
    }
    if (!localVm.ready || !localVm.runtime) {
      dropLease();
      throw new Error(`${localVm.problem ?? "the Local VM is not ready"} (App Settings → Computers)`);
    }
    // Same contract as the Box and VPS branches below: without this the
    // poller never starts, so the Local VM publishes no `screen` events
    // and every client that only has the stream (the phone) waits
    // forever. The web panel hid the gap by polling the screenshot
    // route itself.
    previewCapture = localVmPreviewFor(localVmTarget, claimThreadId);
    return { target: localVmTarget, runtime: localVm.runtime };
  };

  // Explicit destinations are strict. In particular, Local VM must never
  // fall through to host CUA and accidentally click on the user's Mac.
  // The Local VM attach, shared by explicit "Local VM" and by Auto. Explicit
  // is strict and throws with the reason. Auto only reaches a VM this bot
  // already has — ready now, or one whose desktop image is prepared and can
  // be recreated on demand after idling away — and never creates a first
  // VM on its own; every failure there is a quiet "not this place".
  const attachLocalVm = async (strict: boolean): Promise<boolean> => {
    if (!mountsComputerMcp || instance.driverKind === "boxAgent") {
      if (!strict) return false;
      throw new Error("this model engine cannot use the Local VM — choose Claude or an ACP engine, or select another computer destination");
    }
    const localVmTarget = localVmTargetForBot(bot.id);
    let lazyReadyVm: { runtime: Runtime } | null = null;
    if (!strict) {
      // Nothing this process has ever seen for this target, and nobody is
      // relying on an unattended run: do not pay for a runtime probe.
      if (!localVmSeen.has(localVmTarget.key) && !opts?.automationSource) return false;
      const seen = await containerComputerStatus(undefined, undefined, localVmTarget).catch(() => null);
      if (!seen || !autoLocalVmAttachable(seen)) return false;
      if (localVmImageBusy() || localVmModeChangeBusy() || localVmLifecycleBusy.has(localVmTarget.key)) return false;
      if (seen.ready && seen.runtime) lazyReadyVm = { runtime: seen.runtime };
    }
    try {
      if (lazyReadyVm) {
        // Lazy exclusivity (issue #1361): a VM that is ready right now
        // mounts without claiming — screen-less Auto turns never touch
        // the lease, and the first screen tools/call fires the claim
        // through the computer-control gate. A VM that must be created
        // or recreated first keeps the eager claim below: the bridge
        // child needs the container to exist, and readyLocalVmForTurn
        // is what boots it.
        integrations.localComputer = containerComputerMcp(
          lazyReadyVm.runtime,
          controlIntegration(bot.id, threadId, dispatchClaimId),
          localVmTarget,
        );
        autoVmClaims.set(threadId, {
          owner: resourceOwner,
          lazy: true,
          label: "the Local VM",
          claim: async () => {
            await claimAutoLocalVm(threadId, localVmTarget);
            // The dispatch-site poller start saw a null previewCapture
            // (this lazy mount runs before any claim exists), so this
            // turn would publish no live `screen` events and settle no
            // final computer frame. Restart the poller with the now-live
            // computer capture, keeping any browser capture and whether
            // this turn already touched its screen. Same still-running
            // guard as dispatch: a poller started after its own
            // turn.completed would never be torn down.
            if (previewCapture && threadBusy(bot.id, threadId)) {
              const touched = screenPollers.get(threadId)?.touched ?? instance.driverKind === "boxAgent";
              stopScreenPoller(bot.id, threadId);
              startScreenPoller(
                bot.id,
                threadId,
                { computer: previewCapture, ...(browserCaptureRef.current ? { browser: browserCaptureRef.current } : {}) },
                { screenIsTheWork: touched },
              );
            }
          },
        });
        return true;
      }
      const claimed = await claimAutoLocalVm(threadId);
      integrations.localComputer = containerComputerMcp(
        claimed.runtime,
        controlIntegration(bot.id, threadId, dispatchClaimId),
        claimed.target,
      );
      // Hand the same claim to the first-screen-call gate. This eager
      // path has already claimed, so the gate's fire-once call can only
      // re-assert the same owner — a no-op (issue #1361).
      autoVmClaims.set(threadId, {
        owner: resourceOwner,
        label: "the Local VM",
        claim: async () => { await claimAutoLocalVm(threadId); },
      });
      return true;
    } catch (error) {
      if (strict) throw error;
      releaseLocalVmThread(threadId);
      return false;
    }
  };
  if (wants === "vm") {
    if (await attachLocalVm(true)) computerKind = "vm";
  } else if (wants === "local") {
    if (!shouldMountLocalComputer({
      requested: "local",
      hostPlatform: process.platform,
      providerSupportsLocal: mountsLocalComputer,
    })) {
      // Name the condition that actually failed: a person told "choose an
      // ACP engine" while already on one has nowhere to go.
      throw new Error(mountsLocalComputer
        ? `local computer control is not available on ${process.platform} — select another destination`
        : "this model engine cannot control this computer — choose Claude or an ACP engine, or select another destination");
    }
    const cua = readCuaConnection();
    if (!cua) throw new Error("CUA Driver is not ready for this computer — check permissions and restart OpenMausBot");
    await bindTurnComputer(resourceOwner, "computer:host");
    integrations.localComputer = gatedLocalComputer(cua, controlIntegration(bot.id, threadId, dispatchClaimId));
    computerKind = "local";
  }

  // A VPS is a local-agent computer mount, never a remote agent runner.
  // Explicit Cloud may prepare/start it. Auto remains read-only unless
  // the person explicitly opted this bot into remote lifecycle actions.
  if (computerBackend.kind === "vps" && !teamComputer && opts?.runOn !== "cloud" && (wants === "cloud" || wants === undefined)) {
    const unsupported = vps.vpsDriverError(instance.driverKind, mountsComputerMcp);
    if (unsupported && wants === "cloud") throw new Error(unsupported);
    if (unsupported && wants === undefined) autoVpsProblem = unsupported;
    if (!unsupported) {
      // The VPS "computer" is the desktop inside this bot's managed
      // container, and only screen work needs that desktop to itself.
      // So the lease is claimed on the first computer call, through the
      // computer-control gate (the Local VM's seam, #1361), never at
      // mount: a bot's turns that never touch the computer tools run
      // side by side, and its 3-hourly routine no longer queues behind
      // — or fails after 30 minutes behind — its own long-running task.
      // Container lifecycle (provision, start) is serialized by the
      // runner's per-container lock, not by this turn.
      const vpsResource = `computer:vps:${vpsSshAlias(cfg)}:${bot.id}`;
      vpsThreadStarted(bot.id, threadId);
      let remote;
      remote = vps.vpsStartsForTurn({ wants, autoStartVps: bot.autoStartVps, automationSource: opts?.automationSource })
        ? await computerBackend.action(cfg, bot.id, "provision")
        : await computerBackend.inspectForAuto(cfg, bot.id);
      if (remote?.ready && remote.sshAlias) {
        const targetCfg = { ...cfg, vps: { sshAlias: remote.sshAlias } };
        const vpsMcp = computerBackend.mcp(targetCfg, bot.id, remote.container_id ?? undefined);
        const vpsControl = controlIntegration(bot.id, threadId, dispatchClaimId);
        integrations.localComputer = {
          ...vpsMcp,
          env: { ...vpsMcp.env, OMB_CONTROL_URL: vpsControl.url, OMB_CONTROL_TOKEN: vpsControl.token },
        };
        computerKind = "vps";
        // Live frames only once this turn holds the desktop: a poller on
        // a desktop another turn is driving would publish that turn's
        // screen as this one's. The claim restarts the poller with the
        // capture, the way the Local VM's lazy claim does.
        const vpsCapture = () => computerBackend.screenshot(targetCfg, bot.id);
        autoVmClaims.set(threadId, {
          owner: resourceOwner,
          lazy: true,
          label: "the VPS computer",
          claim: async () => {
            await bindTurnComputer(resourceOwner, vpsResource, true);
            previewCapture = vpsCapture;
            if (threadBusy(bot.id, threadId)) {
              const touched = screenPollers.get(threadId)?.touched ?? false;
              stopScreenPoller(bot.id, threadId);
              startScreenPoller(
                bot.id,
                threadId,
                { computer: vpsCapture, ...(browserCaptureRef.current ? { browser: browserCaptureRef.current } : {}) },
                { screenIsTheWork: touched },
              );
            }
          },
        });
      } else {
        vpsThreadEnded(bot.id, threadId);
        if (wants === "cloud") {
          throw new Error(remote?.problem ?? "the VPS computer could not be created or reached");
        }
        autoVpsProblem = remote?.problem ?? "the VPS computer could not be reached";
      }
    }
  }

  // Cloud is strict when selected. Only the native Box engine can reuse
  // a Box on Auto; local engines have no relay for its desktop tools.
  if (teamComputer) {
    const attached = await attachTeamBox(teamComputer, bot.id, resourceOwner, mountsCloudComputer, instance.driverKind === "boxAgent");
    integrations.computer = attached.integration;
    previewCapture = attached.capture;
    computerKind = "box";
  }
  if (!teamComputer && mountsCloudComputer && (wants === "cloud" || wants === undefined) && cloudBackend === "box" && box.boxConfigured(cfg)) {
    // Explicit cloud turns can provision/wake the same bot's Box. Claim
    // before any network await so setup itself cannot race another turn.
    if (wants === "cloud") await bindTurnComputer(resourceOwner, `computer:box-bot:${bot.id}`, true);
    if (!mountsCloudComputer && wants === "cloud") {
      throw new Error("this model engine cannot use computer tools — choose Claude, an ACP engine, or the Computer engine");
    }
    let b;
    try {
      b = await box.findBox(cfg, bot.id);
    } catch (error) {
      // Auto may fall through when an optional provider is offline, but a
      // durable deletion fence must never be mistaken for "no computer".
      if (wants === "cloud" || (error as { status?: number })?.status === 409) throw error;
      b = null;
    }
    let lifecycle = box.boxTurnLifecycleAction({
      explicitCloud: wants === "cloud",
      canMount: mountsCloudComputer,
      state: typeof b?.state === "string" ? b.state : null,
    });
    if (lifecycle === "provision") {
      broadcast({ kind: "computer", botId: bot.id, state: "provisioning" });
      await box.provisionBox(cfg, bot.id, bot.name);
      b = await box.findBox(cfg, bot.id);
      lifecycle = box.boxTurnLifecycleAction({
        explicitCloud: true,
        canMount: mountsCloudComputer,
        state: typeof b?.state === "string" ? b.state : null,
      });
    }
    // an archived box answers every action with an error until it
    // resumes — wake it here, once, instead of letting the agent
    // discover it one failed tool call at a time. Explicit Cloud is the
    // consent boundary for the resume (~8s, and it un-pauses billing).
    if (lifecycle === "wake") {
      broadcast({ kind: "computer", botId: bot.id, state: "waking" });
      b = (await box.readyBox(cfg, bot.id)) ?? b;
      lifecycle = box.boxTurnLifecycleAction({
        explicitCloud: true,
        canMount: mountsCloudComputer,
        state: typeof b?.state === "string" ? b.state : null,
      });
    }
    if (b && lifecycle === "attach") {
      await bindTurnComputer(resourceOwner, `computer:box:${b.id}`, instance.driverKind === "boxAgent");
      previewCapture = () => box.screenshotBox(cfg, bot.id, b!.id);
      if (mountsCloudComputer) {
        integrations.computer = {
          kind: "box",
          boxId: b.id,
          token: cfg.box!.token!,
          control: controlIntegration(bot.id, threadId, dispatchClaimId),
        };
        computerKind = "box";
      }
    }
  }
  if (wants === "cloud" && cloudBackend === "box" && !box.boxConfigured(cfg)) {
    throw new Error("Cloud box is not configured — add a Box API key or choose Local VM");
  }
  if (wants === "cloud" && cloudBackend === "box" && !integrations.computer) {
    throw new Error("the cloud computer could not be created or reached");
  }

  // Auto-only host fallback. Electron owns cua-driver/TCC attribution;
  // the harness only reads its already-running connection descriptor.
  // Auto reaches a Local VM this bot already has before it ever touches the
  // host's own desktop: on a headless server that VM is the only desktop
  // there is, and a person who prepared one meant it to be used.
  if (wants === undefined && !integrations.computer && !integrations.localComputer && await attachLocalVm(false)) computerKind = "vm";
  // An unattended run on a bot with a VPS configured never lands on the
  // host's own desktop instead: a scheduled job clicking on someone's
  // laptop is worse than a scheduled job that fails and says why.
  const unattendedVps = cloudBackend === "vps" && Boolean(opts?.automationSource);
  if (
    !integrations.computer &&
    !integrations.localComputer &&
    wants === undefined &&
    !unattendedVps &&
    shouldMountLocalComputer({
      requested: undefined,
      hostPlatform: process.platform,
      providerSupportsLocal: mountsLocalComputer,
    })
  ) {
    const cua = readCuaConnection();
    if (cua) {
      await bindTurnComputer(resourceOwner, "computer:host");
      integrations.localComputer = gatedLocalComputer(cua, controlIntegration(bot.id, threadId, dispatchClaimId));
      computerKind = "local";
    }
  }
  if (
    wants === undefined &&
    cloudBackend === "vps" &&
    !integrations.computer &&
    !integrations.localComputer &&
    autoVpsProblem &&
    !computerSelectionTurns.has(threadId)
  ) {
    const hint = opts?.automationSource
      ? "This scheduled run tried to start the VPS computer and could not reach it. Check the VPS connection in App Settings → Connections."
      : bot.autoStartVps
        ? "Check the VPS connection in App Settings → Connections."
        : "Open Computer and enable Start VPS automatically, or choose Cloud to start it manually.";
    throw new Error(`${autoVpsProblem}. ${hint}`);
  }
  return { integrations, previewCapture, computerKind, worksInWorkspace, privateWorkspace, skillInstructions, packagePlaybooks, cwd, checkpointCwd, teamComputer };
}


/** Prompt fragments: agents integration, roster/mention resolution and the gated prompt blocks. */
export function buildCoordinationPrompts({
  bot,
  opts,
  threadId,
  userMessage,
  providerText,
  commsDepth,
  skillAuthoring,
  agentsMounted,
  boundedCoordination,
  dispatchClaimId,
  integrations,
  store,
  agentsIntegration,
}: {
  bot: BotRecord;
  opts: StartTurnOptions | undefined;
  threadId: string;
  userMessage: Message;
  providerText: string;
  commsDepth: number;
  skillAuthoring: boolean;
  agentsMounted: boolean;
  boundedCoordination: boolean;
  dispatchClaimId: string;
  integrations: TurnIntegrations;
  store: Store;
  agentsIntegration: Deps["computers"]["agentsIntegration"];
}) {
  // Agent control tools include peer comms and the secure credential
  // request card. A comms-invoked turn (depth ≥ cap) gets none — hard recursion
  // stop, so the user's tokens can't be burned by a bot-to-bot loop.
  // Only drivers that mount the tools get the integration (and, via the
  // integrations.agents gate below, the prompt hint) — a bot on a driver
  // without it must not be told about tools it cannot call. Any bot can
  // still be the TARGET of ask_bot regardless of its driver.
  // One reachability rule for the roster, list_bots and @mention
  // resolution: a bot is never told about — or nudged toward — a peer
  // that ask_bot and delegate_bot would then refuse.
  const sectionPeers = reachablePeers(store.bots, bot);
  if (agentsMounted) {
    // Only a direct human request can create separate self-owned jobs.
    // Coordinated children and self-opened jobs stay inside their scope;
    // a later real user message on the same task is a fresh request.
    const origin = opts?.cardContinuation
      ? store.activePath(threadId).findLast(message => message.role === "user" && message.kind === "text")
      : userMessage;
    const ownThreadCreation = boundedCoordination && !opts?.coordination && Boolean(origin && !origin.peerAsk);
    integrations.agents = agentsIntegration(bot.id, threadId, commsDepth, skillAuthoring, dispatchClaimId, opts?.coordination?.id, boundedCoordination, ownThreadCreation);
  }
  // @mentions in the user's message (the composer's tagging UI) become
  // an explicit coordination nudge. The agent still chooses the matching
  // peer tool, so the harness stays the single owner of turns/permissions.
  const tagged = integrations.agents
    ? mentionedBots(
        providerText,
        sectionPeers,
      )
    : [];
  const coordinationPrompt = bot.chiefOfStaff
    ? chiefOfStaffSystemPrompt(
        bot.id,
        store.bots,
        Boolean(integrations.agents),
        openMausStatusSystemPrompt(),
        boundedCoordination,
      )
    : integrations.agents && sectionPeers.length > 0
      // Ordinary bots could always CALL the peer tools; until now the
      // one generic sentence they got never named a teammate, so the
      // first move of any collaboration was a list_bots round trip the
      // model mostly did not think to make.
      ? peerRosterSystemPrompt(sectionPeers, boundedCoordination)
      : "";
  const credentialPrompt = integrations.agents ? CREDENTIAL_PROMPT + (boundedCoordination ? "" : THREADS_PROMPT) : "";
  const routinePrompt = integrations.agents ? ROUTINE_PROMPT : "";
  const profilePrompt = integrations.agents ? PROFILE_PROMPT : "";
  const recallPrompt = integrations.agents ? SESSION_SEARCH_SYSTEM_PROMPT : "";
  const learnPrompt = skillAuthoring ? LEARN_PROMPT : "";
  return { tagged, coordinationPrompt, credentialPrompt, routinePrompt, profilePrompt, recallPrompt, learnPrompt };
}


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


/** System prompt assembly: the full section list built from the phase outputs. */
export function buildTurnSystemPrompt({
  bot,
  opts,
  threadId,
  plan,
  instance,
  persona,
  liveBot,
  setupMode,
  mountedComputer,
  computerKind,
  integrations,
  cwd,
  worksInWorkspace,
  privateWorkspace,
  skillInstructions,
  packagePlaybooks,
  teamComputer,
  skillAuthoring,
  boundedCoordination,
  tagged,
  coordinationPrompt,
  credentialPrompt,
  routinePrompt,
  profilePrompt,
  recallPrompt,
  learnPrompt,
  store,
  cfg,
  roomHandoffs,
  roomHandoffProblem,
  coordinationSystemInstructions,
  outstandingAssignmentsPrompt,
  teamComputerPrompt,
  DirectTurnSetupCancelled,
}: {
  bot: BotRecord;
  opts: StartTurnOptions | undefined;
  threadId: string;
  plan: SurfacePlan;
  instance: ProviderInstance;
  persona: string;
  liveBot: ReturnType<Store["bot"]>;
  setupMode: boolean;
  mountedComputer: ReturnType<typeof surfaceOfComputerKind>;
  computerKind: ComputerKind;
  integrations: TurnIntegrations;
  cwd: string | undefined;
  worksInWorkspace: boolean;
  privateWorkspace: string | undefined;
  skillInstructions: string;
  packagePlaybooks: string;
  teamComputer: TeamComputerRecord | undefined;
  skillAuthoring: boolean;
  boundedCoordination: boolean;
  tagged: BotRecord[];
  DirectTurnSetupCancelled: Deps["dispatch"]["DirectTurnSetupCancelled"];
  coordinationPrompt: string;
  credentialPrompt: string;
  routinePrompt: string;
  profilePrompt: string;
  recallPrompt: string;
  learnPrompt: string;
  store: Store;
  cfg: AppConfig;
  roomHandoffs: Deps["handoffs"]["roomHandoffs"];
  roomHandoffProblem: Deps["prompts"]["roomHandoffProblem"];
  coordinationSystemInstructions: Deps["prompts"]["coordinationSystemInstructions"];
  outstandingAssignmentsPrompt: Deps["prompts"]["outstandingAssignmentsPrompt"];
  teamComputerPrompt: Deps["prompts"]["teamComputerPrompt"];
}) {
  const computerPromptKind: ComputerPromptKind | null =
    computerKind === "vm"
      ? localVmMode(cfg) === "per-bot" ? "vm-private" : "vm-shared"
      : computerKind === "box"
        ? instance.driverKind === "boxAgent" ? "box-agent" : "box"
        : computerKind === "vps"
          ? "vps"
          : computerKind === "local"
            ? "local"
            : null;
  const coordinationNode = opts?.coordination ? roomHandoffs.nodes.get(opts.coordination.id) : undefined;
  if (opts?.coordination && (!coordinationNode || coordinationNode.status !== "running" || roomHandoffProblem(coordinationNode,
    coordinationNode.parentId ? roomHandoffs.nodes.get(coordinationNode.parentId) : undefined))) {
    throw new DirectTurnSetupCancelled("Coordination access changed before dispatch");
  }
  const prompt = buildSystemPrompt(persona, liveBot?.soul ?? bot.soul ?? "", [
    // first after the soul: the block names agent tools, so it only goes
    // to a turn whose engine actually mounted them (setupMode is already
    // false when they are not — see agentsMounted above)
    { id: "setup", label: "Setup", text: setupSystemPrompt(setupMode, { skills: skillAuthoring, cwd: liveBot?.cwd ?? bot.cwd }) },
    { id: "files", label: "File locations", text: worksInWorkspace && opts?.runOn !== "cloud" ? workspaceLocationsPrompt(bot.id, cwd, liveBot?.cwd ?? bot.cwd) : "" },
    { id: "computer", label: "Computer", text: computerPrompt(computerPromptKind) },
    { id: "team-computer", label: "Team computer", text: teamComputerPrompt(teamComputer) },
    { id: "plan", label: "Surface", text: surfacePrompt({ computer: mountedComputer, browser: Boolean(integrations.browser) }, { pinned: plan.pinned, note: plan.note, canSelect: computerSelectionTurns.has(threadId) }) },
    // gated on the integration, not the key: the hint only goes to a
    // bot whose driver actually mounted the tools
    { id: "composio", label: "Connected apps", text: integrations.composio ? COMPOSIO_PROMPT : "" },
    { id: "mcp", label: "MCP servers", text: customMcpPrompt(Object.keys(integrations.custom ?? {})) },
    { id: "browser", label: "Browser", text: integrations.browser ? BUILT_IN_BROWSER_SYSTEM_PROMPT : "" },
    { id: "coordination", label: "Team", text: coordinationPrompt ? ` ${coordinationPrompt}` : "" },
    { id: "assignment", label: "Teammate task", text: coordinationNode ? `\n${coordinationSystemInstructions()}` : "" },
    { id: "outstanding", label: "Outstanding teammate work", text: outstandingAssignmentsPrompt(threadId) },
    { id: "credential", label: "Credentials", text: credentialPrompt },
    { id: "recall", label: "Recall", text: recallPrompt },
    { id: "routine", label: "Routines", text: routinePrompt },
    { id: "routine-execution", label: "Routine execution", text: opts?.automationSource === "schedule" || opts?.automationSource === "manual" ? ROUTINE_EXECUTION_PROMPT : "" },
    { id: "profile", label: "Profile changes", text: profilePrompt },
    { id: "learn", label: "Skill authoring", text: learnPrompt },
    { id: "section-context", label: "Section context", text: sectionContextSystemPrompt(bot.section) },
    // what the bot said lately in its other conversations, so a task
    // never redoes — or forgets — what another one already did
    { id: "recent", label: "Recent work", text: recentWorkPrompt(recentWork(store, bot, { userName: cfg.profile?.name?.trim() || "User", currentThreadId: threadId })) },
    { id: "memory", label: "Memory", text: memorySystemPrompt(bot.id, { managedWrites: Boolean(integrations.agents), fileTools: worksInWorkspace }) },
    { id: "skills", label: "Skills index", text: privateWorkspace ? skillsSystemPrompt(bot.id) : "" },
    { id: "skill-instructions", label: "Skill instructions", text: skillInstructions },
    { id: "playbooks", label: "Playbooks", text: packagePlaybooks },
    { id: "webhook", label: "Webhook provenance", text: opts?.automationSource === "webhook" ? WEBHOOK_PROMPT : "" },
    { id: "mentions", label: "Mentions", text: boundedCoordination && tagged.length ? `The user named these existing teammates: ${tagged.map(b => `${peerName(b.name)} (${b.id})`).join(", ")}. Use coordinate_bots when their contribution is needed; do not substitute native helper agents for these bots.` : mentionPrompt(tagged) },
  ]);
  return prompt;
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
  dispatchContext,
  decideContext,
  strictResume,
  plannedConfig,
  sessionConfig,
  liveBot,
  handoffs,
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
  dispatchContext: ReturnType<typeof assembleTurnContext>["dispatchContext"];
  decideContext: ReturnType<typeof assembleTurnContext>["decideContext"];
  strictResume: boolean;
  plannedConfig: string;
  sessionConfig: ReturnType<typeof assembleTurnContext>["sessionConfig"];
  liveBot: ReturnType<Store["bot"]>;
  handoffs: Handoffs;
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
  if (strictResume && dispatchedConfig !== plannedConfig) dispatchContext = decideContext(dispatchedConfig);
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
  vpsThreadEnded,
  handoffs,
  reportIncident,
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
  vpsThreadEnded: Deps["computers"]["vpsThreadEnded"];
  handoffs: Handoffs;
  reportIncident: Deps["incidents"]["reportIncident"];
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
    vpsThreadEnded(bot.id, threadId);
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
