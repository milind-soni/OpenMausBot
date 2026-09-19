// User-message binding and context/session assembly phases for the
// direct-turn engine (server/start-turn.ts).
import { createHash, randomUUID } from "node:crypto";

import { skillAuthoringEnabled, type AppConfig } from "../../config.ts";
import { sectionContextSystemPrompt } from "../../section-context.ts";
import { handedStateUsable, isContextMessage, renderUnseen, sessionStart, unseenMessages, withUnseenMessages, type ContextMessage } from "../../delta-context.ts";
import { buildRecoveryText, buildTurnContext, engineIsFresh, peerMessageText } from "../../turn-context.ts";
import { promptWithReply, transcriptText } from "../../replies.ts";
import { expandLearnTurnText } from "../../skill-learn.ts";
import { expandSetupTurnText } from "../../setup-mode.ts";
import { checkSoulDrift } from "../../bot-folder.ts";
import { type BotRecord, type Message, type Store } from "../../store.ts";
import type { ProviderInstance } from "../../contracts.ts";
import type { StartTurnOptions } from "../../start-turn.ts";
import type { Deps, Task } from "./shared.ts";

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
  model,
  effort,
  commsDepth,
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
  model: string | undefined;
  effort: string | undefined;
  commsDepth: number;
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
  // A teammate’s result or reply: without records this turn would replay.
  const externalUpdate = Boolean(opts?.coordination?.resumed || unseen?.some((m) => m.keep));
  // What a resumed session keeps from its launch: the standing instructions
  // (tools, servers and — for Claude — the model are passed on every launch),
  // plus whatever this engine can only set when a session starts. Codex’s
  // thread/resume sends no model selection, and an effort it is not sent stays
  // at the thread’s last value, so both belong to the session there. An
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
  const dispatchContext = decideContext(plannedConfig);

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
  return { transcript, rewound, externalContextMarker, agentsMounted, skillAuthoring, dispatchContext, decideContext, plannedConfig, sessionConfig, strictResume, persona };
}
