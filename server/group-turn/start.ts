// The channel starter and queue drain — extracted verbatim from
// group-turn.ts. startGroupTurn turns an incoming room message (or goal,
// or queued send) into an operation on the room's group queue;
// drainQueuedChannelSends restarts that starter for messages parked while
// the channel was busy. One factory, one ctx: the drain exists to call the
// starter, so their dep sets are nested rather than divergent. The member
// turn and goal operation arrive through the ctx from the composition
// root.
import { randomUUID } from "node:crypto";

import { llmThreadTitlesEnabled } from "../config.ts";
import { cfg, registry, store } from "../runtime.ts";
import { extractTurnImages } from "../turn-images.ts";
import { mentionedBots, roomResponders, type Message } from "../store.ts";
import { GROUP_GOAL_MAX_TURNS, selectGroupGoalCoordinator } from "../group-goal-run.ts";
import { drainChannelMessages } from "../channel-queue.ts";
import type { GroupTurnDeps } from "../group-turn.ts";
import type { createGoalRun } from "./goal-run.ts";
import type { createMemberTurn } from "./member-turn.ts";

type StartGroupTurnOptions = {
  /** Run against an existing background room task instead of the active UI task. */
  threadId?: string;
  /** Internal routine goals choose their lead explicitly rather than by @mention/default. */
  goalCoordinatorBotId?: string;
  /** Correlates a room goal card with its durable RoutineRun receipt. */
  goalRunId?: string;
  /** The message came through the HTTP API with nothing to say a person
   * sent it (see Message.via). */
  via?: "api";
  /** The person who sent it, when not the desktop owner (see Message.sender). */
  sender?: { name: string };
};

/** Everything the starter and its queue drain read from their host. */
interface StartGroupTurnCtx {
  groupQueues: GroupTurnDeps["rooms"]["groupQueues"];
  groupIsWorking: GroupTurnDeps["rooms"]["groupIsWorking"];
  roomSetupPending: GroupTurnDeps["rooms"]["roomSetupPending"];
  resolveReplyTarget: GroupTurnDeps["rooms"]["resolveReplyTarget"];
  beginGroupTurnOperation: GroupTurnDeps["operations"]["beginGroupTurnOperation"];
  finishGroupTurnOperation: GroupTurnDeps["operations"]["finishGroupTurnOperation"];
  waitForChatRoomMember: GroupTurnDeps["operations"]["waitForChatRoomMember"];
  groupProviderHandshakeStarted: GroupTurnDeps["operations"]["groupProviderHandshakeStarted"];
  groupProviderHandshakeSettled: GroupTurnDeps["operations"]["groupProviderHandshakeSettled"];
  followupsReady: GroupTurnDeps["queue"]["followupsReady"];
  generateThreadTitle: GroupTurnDeps["prompts"]["generateThreadTitle"];
  runGroupMemberTurn: ReturnType<typeof createMemberTurn>["runGroupMemberTurn"];
  runGroupGoalOperation: ReturnType<typeof createGoalRun>["runGroupGoalOperation"];
}

export function createStartGroupTurn({
  groupQueues, groupIsWorking, roomSetupPending, resolveReplyTarget,
  beginGroupTurnOperation, finishGroupTurnOperation, waitForChatRoomMember,
  groupProviderHandshakeStarted, groupProviderHandshakeSettled, followupsReady,
  generateThreadTitle,
  runGroupMemberTurn, runGroupGoalOperation,
}: StartGroupTurnCtx) {
function startGroupTurn(
  groupId: string,
  text: string,
  replyTo?: Message,
  sendId?: string,
  channelMode: "chat" | "goal" = "chat",
  queueId?: string,
  options: StartGroupTurnOptions = {},
) {
  const group = store.group(groupId);
  if (!group) throw Object.assign(new Error("no such group"), { status: 404 });
  if (roomSetupPending(group)) {
    throw Object.assign(new Error("finish room setup before sending the first message"), { status: 409 });
  }
  // Capture the chosen thread once. Manual sends use the active task; a
  // scheduled team goal supplies its detached background task explicitly.
  const threadId = options.threadId ?? group.threadId;
  const ownsThread = group.dm
    ? group.threadId === threadId
    : Boolean(store.groupTaskByThread(group.id, threadId));
  if (!ownsThread) {
    throw Object.assign(new Error("no such room task"), { status: 404 });
  }
  const members = group.memberIds
    .map((id) => store.bot(id))
    .filter((bot): bot is NonNullable<typeof bot> => Boolean(bot));
  const availableMembers = members.filter((member) => !member.hidden);
  const requestedGoalCoordinator = options.goalCoordinatorBotId
    ? availableMembers.find((member) => member.id === options.goalCoordinatorBotId)
    : undefined;
  if (options.goalCoordinatorBotId && (channelMode !== "goal" || !requestedGoalCoordinator)) {
    throw Object.assign(new Error("the selected goal coordinator is not an active room member"), { status: 409 });
  }
  const message = store.appendMessage(threadId, {
    role: "user",
    kind: "text",
    text,
    replyToId: replyTo?.id,
    sendId,
    channelMode,
    queueId,
    via: options.via,
    sender: options.sender,
  });
  const titled = group.dm ? null : store.titleGroupTaskFromFirstMessage(group.id, text, threadId);
  const snippet = titled?.title;

  const archived = members.filter((member) => member.hidden);
  const mentionedArchived = mentionedBots(text, archived.map(({ name }) => ({ name })))[0];
  if (mentionedArchived) {
    store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      tool: {
        name: `${mentionedArchived.name} is archived and can't respond — restore it or mention an active room member.`,
        ok: false,
      },
    });
  }
  let responders = roomResponders(text, members, group.defaultResponder);
  const explicitlyMentionedLead = roomResponders(text, availableMembers, { kind: "mentions" })[0];
  const goalCoordinator = channelMode === "goal"
    ? requestedGoalCoordinator ?? explicitlyMentionedLead ?? selectGroupGoalCoordinator(availableMembers, group.defaultResponder)
    : null;
  // bot⇄bot channels: chipping in without a tag addresses the last speaker
  if (!responders.length && group.dm) {
    const lastSpeakerId = [...store.messagesFor(threadId)]
      .reverse()
      .find((msg) => msg.kind === "text" && msg.from)?.from?.botId;
    const last = availableMembers.find((b) => b.id === lastSpeakerId) ?? availableMembers[0];
    responders = last ? [last] : [];
  }
  if (!responders.length && !goalCoordinator) {
    const defaultArchivedId = group.defaultResponder.kind === "member" ? group.defaultResponder.botId : undefined;
    const defaultArchived = archived.find((member) => member.id === defaultArchivedId);
    let unavailableMessage: string | undefined;
    if (!mentionedArchived && !availableMembers.length) {
      unavailableMessage = "No active room members can respond — restore an archived bot or add an active member.";
    } else if (!mentionedArchived && defaultArchived) {
      unavailableMessage = `${defaultArchived.name} is archived and can't respond — restore it or mention an active room member.`;
    }
    if (unavailableMessage) {
      store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: unavailableMessage, ok: false },
      });
    }
    return message;
  }

  // The snippet is only the fallback name here too. The member about to
  // answer supplies the same cheap one-shot the bot path uses, and the
  // swap lands only while the row still carries the snippet — a rename by
  // the person always wins. Channel tasks carry no peer provenance (no
  // assignment opens them), and a member whose engine offers no text
  // one-shot simply keeps the snippet.
  const titleBot = goalCoordinator ?? responders[0]!;
  const titleInstance = registry.get(titleBot.modelSelection.instanceId);
  const titleText = extractTurnImages(text).text;
  if (titled && snippet && titleText.trim() && llmThreadTitlesEnabled(cfg) && titleInstance?.generateText) {
    void generateThreadTitle(titleInstance, titleText)
      .then((title) => {
        if (title) store.retitleGroupTask(group.id, threadId, snippet, title);
      })
      .catch(() => undefined);
  }

  const operation = beginGroupTurnOperation(
    groupId,
    threadId,
    goalCoordinator ? [] : responders.map((responder) => responder.id),
  );
  if (goalCoordinator) {
    const runId = options.goalRunId?.trim() || `goal-${Date.now().toString(36)}-${randomUUID()}`;
    const startedAt = Date.now();
    const detail = `${goalCoordinator.name} is coordinating this goal.`;
    const card = store.appendMessage(threadId, {
      role: "bot",
      kind: "goal.run",
      text: `Goal in progress: ${detail}`,
      from: { botId: goalCoordinator.id, name: goalCoordinator.name, color: goalCoordinator.color },
      goalRun: {
        runId,
        goal: text,
        status: "working",
        coordinatorBotId: goalCoordinator.id,
        coordinatorName: goalCoordinator.name,
        turnCount: 0,
        maxTurns: GROUP_GOAL_MAX_TURNS,
        detail,
        startedAt,
      },
    });
    operation.goalRun = {
      runId,
      cardMessageId: card.id,
      goal: text,
      coordinatorBotId: goalCoordinator.id,
      coordinatorName: goalCoordinator.name,
      turnCount: 0,
      maxTurns: GROUP_GOAL_MAX_TURNS,
      startedAt,
      finished: false,
    };
  }
  const prev = groupQueues.get(groupId) ?? Promise.resolve();
  const next = prev.then(async () => {
    if (operation.cancelled) return;
    const current = store.group(groupId);
    if (current?.busyBotId) {
      const owner = store.bot(current.busyBotId);
      store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `${owner?.name ?? "A room member"} is still stopping — this message was not dispatched`, ok: false },
      });
      return;
    }
    if (goalCoordinator) {
      await runGroupGoalOperation({ groupId, threadId, coordinator: goalCoordinator, members, operation });
    } else {
      const spoken = new Set<string>();
      const skillAuthoringClaim = { claimed: false };
      for (const responder of responders) {
        if (operation.cancelled) break;
        if (spoken.has(responder.id)) continue;
        // A responder busy in another conversation takes its turn when it
        // frees (the host wakes each member in turn) — never skipped, only
        // bounded. Stop ends the round; a member the cap gave up on, or one
        // that vanished meanwhile, is passed over for this round only.
        const verdict = await waitForChatRoomMember(operation, threadId, responder);
        if (verdict === "stop") break;
        if (verdict === "skip") {
          spoken.add(responder.id);
          continue;
        }
        if (!(await runGroupMemberTurn(
          groupId,
          threadId,
          responder.id,
          0,
          spoken,
          undefined,
          undefined,
          () => operation.cancelled,
          () => groupProviderHandshakeStarted(operation),
          () => groupProviderHandshakeSettled(operation),
          skillAuthoringClaim,
          undefined,
          operation,
        ))) break;
      }
    }
  });
  const tracked = next.finally(() => finishGroupTurnOperation(groupId, operation));
  groupQueues.set(groupId, tracked.catch(() => {}));
  return message;
}

function drainQueuedChannelSends(): void {
  if (!followupsReady()) return;
  drainChannelMessages(
    (groupId) => {
      const group = store.group(groupId);
      return group ? groupIsWorking(group) : false;
    },
    ({ groupId, threadId, text, replyToId, sendId, mode, id, via }) => {
      const group = store.group(groupId);
      const ownsThread = group?.dm
        ? group.threadId === threadId
        : Boolean(group && store.groupTaskByThread(group.id, threadId));
      if (!group || !ownsThread) return;
      try {
        startGroupTurn(groupId, text, resolveReplyTarget(threadId, replyToId), sendId, mode, id, { via, threadId });
      } catch (error) {
        if (!store.messagesFor(threadId).some((message) => message.queueId === id && message.role === "user")) {
          store.appendMessage(threadId, { role: "user", kind: "text", text, replyToId, sendId, channelMode: mode, queueId: id, via });
        }
        store.appendMessage(threadId, {
          role: "bot",
          kind: "activity",
          tool: {
            name: `error: queued channel message could not start — ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`,
            ok: false,
          },
        });
      }
      // A message with no eligible responder creates no operation. Continue
      // draining instead of leaving later user messages behind it forever.
      queueMicrotask(drainQueuedChannelSends);
      return groupQueues.get(groupId);
    },
  );
}
  return { startGroupTurn, drainQueuedChannelSends };
}
