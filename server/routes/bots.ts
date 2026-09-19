// The room-action HTTP routes (room setup, channel tasks, room
// rename/read/delete, room messages with queued-send idempotency, queue
// cancel/steer, room interrupt, and message reactions) plus the
// sidebar-sections trio, extracted verbatim from index.ts's dispatch
// chain. Path matching, methods, and status codes are unchanged; the
// handler returns false for anything it does not own so the chain falls
// through in the same order. sidebar-sections is part of this family
// because it manages bot grouping: its sections are how bots are
// organized in the sidebar. The room engine, queue admission, and view
// helpers are index-local and cross via deps; routines is a late-bound
// thunk over index.ts's let; store/cfg are live bindings from
// ../runtime.ts; the coordination/queue/admission helpers are imported
// from their source modules.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import type { createEventsRoutes } from "./events.ts";
import { z } from "zod";
import { cfg, store } from "../runtime.ts";
import { validateBotCwd } from "../bot-cwd.ts";
import { assertWithinBudget } from "../spend.ts";
import { cancelledChatFollowup } from "../message-db.ts";
import { promptWithReply } from "../replies.ts";
import { acceptedSendMatch, parseSendId, sendFingerprint, type SendSequencer } from "../send-idempotency.ts";
import {
  cancelChannelMessage,
  holdChannelQueue,
  queuedChannelMessage,
  queueChannelMessage,
  restoreHeldChannelQueue,
  resolveHeldReplyTarget,
  settleHeldChannelQueueHead,
} from "../channel-queue.ts";
import { groupIsWorking, groupTurnOperations } from "../group-coordination.ts";
import { revokeInternalCapabilitiesForThread } from "../internal-capabilities.ts";
import { closeOpenApprovals } from "../turn-fold.ts";
import { clientGroupPatchViolation, requestSource } from "../request-auth.ts";
import type { RequestAuth } from "../request-auth.ts";
import { DATA_DIR } from "../config.ts";
import type { SteerOutcome } from "../contracts.ts";
import type { GroupDefaultResponder, GroupRecord, Message } from "../store.ts";
import type { WireGroup } from "../../shared/wire.ts";
import type { RoutineManager } from "../routines.ts";
import type { TeamComputers } from "../team-computers.ts";
import type { PhoneSecretSubmissionRegistry } from "../phone-secret.ts";
import type { createBotViews } from "../bot-views.ts";
import type { createComputerLifecycle } from "../computer-lifecycle.ts";
import type { createGroupTurn } from "../group-turn.ts";
import type { createGroupTurnOperations } from "../group-turn-operations.ts";

type BotViews = ReturnType<typeof createBotViews>;
type ComputerLifecycle = ReturnType<typeof createComputerLifecycle>;

export function createBotRoutes(deps: {
  routines: () => RoutineManager | null;
  broadcast: ReturnType<typeof createEventsRoutes>["broadcast"];
  publicGroupState: (group: GroupRecord) => WireGroup;
  wireBot: BotViews["wireBot"];
  updateChannel: (groupId: string, value: unknown) => GroupRecord;
  channelTaskBlocked: (group: GroupRecord) => boolean;
  phoneSecretSubmissions: PhoneSecretSubmissionRegistry;
  createGroupTaskRequestSchema: z.ZodType<{ title?: string }>;
  createSidebarSectionSchema: z.ZodType<{ name: string; botIds: string[] }>;
  groupWithThread: (group: GroupRecord) => WireGroup & { messages: Message[]; activeLeafId: string | null };
  groupSpeakers: Map<string, { botId: string; name: string; color: string }>;
  lastReply: Map<string, string>;
  sendSequencer: SendSequencer;
  noteTurnTrigger: (threadId: string, auth: RequestAuth) => void;
  messageSender: (auth: RequestAuth) => { name: string } | undefined;
  resolveReplyTarget: (threadId: string, value: unknown) => Message | undefined;
  stagedSkillCleanupsForThread: (threadId: string) => Array<{ botId: string; stagedId: string }>;
  rejectDeletedThreadSkillStages: (cleanups: Array<{ botId: string; stagedId: string }>) => void;
  cancelTeamSetupResumesForThread: (threadId: string) => void;
  DESKTOP_MANAGED: boolean;
  startGroupTurn: ReturnType<typeof createGroupTurn>["startGroupTurn"];
  drainQueuedChannelSends: ReturnType<typeof createGroupTurn>["drainQueuedChannelSends"];
  runningTurnInstance: ComputerLifecycle["runningTurnInstance"];
  cancelGroupTurnOperations: ReturnType<typeof createGroupTurnOperations>["cancelGroupTurnOperations"];
  assertTeamComputerChangeIdle: ComputerLifecycle["assertTeamComputerChangeIdle"];
  teamComputers: TeamComputers;
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, url, auth } = rctx;
    let m: RegExpMatchArray | null = null;
    const {
      routines,
      broadcast,
      publicGroupState,
      wireBot,
      updateChannel,
      channelTaskBlocked,
      phoneSecretSubmissions,
      createGroupTaskRequestSchema,
      createSidebarSectionSchema,
      groupWithThread,
      groupSpeakers,
      lastReply,
      sendSequencer,
      noteTurnTrigger,
      messageSender,
      resolveReplyTarget,
      stagedSkillCleanupsForThread,
      rejectDeletedThreadSkillStages,
      cancelTeamSetupResumesForThread,
      DESKTOP_MANAGED,
      startGroupTurn,
      drainQueuedChannelSends,
      runningTurnInstance,
      cancelGroupTurnOperations,
      assertTeamComputerChangeIdle,
      teamComputers,
    } = deps;
    m = path.match(/^\/api\/groups\/([\w-]+)\/setup$/);
    if (m && method === "PATCH") {
      const group = store.group(m[1]);
      if (!group) {
        json(res, 404, { error: "no such room" });
        return true;
      }
      if (group.dm) {
        json(res, 400, { error: "direct-message channels do not have room setup" });
        return true;
      }
      const body = await readBody(req);
      if (body.action !== "complete" && body.action !== "skip") {
        json(res, 400, { error: "action must be complete or skip" });
        return true;
      }
      if (group.setupCompletedAt != null || group.setupSkippedAt != null) {
        json(res, 200, { group: publicGroupState(group) });
        return true;
      }
      if (store.messagesFor(group.threadId).length > 0) {
        json(res, 409, { error: "room setup must be finished before the first message" });
        return true;
      }

      const patch: Partial<Pick<GroupRecord, "cwd" | "defaultResponder" | "bulletin" | "setupCompletedAt" | "setupSkippedAt">> = {};
      if (body.action === "complete") {
        const checked = validateBotCwd(body.cwd ?? null);
        if (!checked.ok) {
          json(res, 400, { error: checked.error });
          return true;
        }
        if (typeof body.bulletin !== "string") {
          json(res, 400, { error: "bulletin must be a string" });
          return true;
        }
        if (body.bulletin.length > 12_000) {
          json(res, 400, { error: "bulletin must be at most 12000 characters" });
          return true;
        }
        const value = body.defaultResponder as { kind?: unknown; botId?: unknown } | null;
        let responder: GroupDefaultResponder | null = null;
        if (value?.kind === "everyone") responder = { kind: "everyone" };
        else if (value?.kind === "mentions") responder = { kind: "mentions" };
        else if (value?.kind === "member" && typeof value.botId === "string" && group.memberIds.includes(value.botId)) {
          responder = { kind: "member", botId: value.botId };
        }
        if (!responder) {
          json(res, 400, { error: "invalid default responder" });
          return true;
        }
        patch.cwd = checked.cwd ?? undefined;
        patch.defaultResponder = responder;
        patch.bulletin = body.bulletin;
        patch.setupCompletedAt = Date.now();
      } else {
        patch.setupSkippedAt = Date.now();
      }
      const updated = store.patchGroup(m[1], patch);
      if (!updated) {
        json(res, 404, { error: "no such room" });
        return true;
      }
      json(res, 200, { group: publicGroupState(updated) });
      return true;
    }

    // ── channel tasks: separate conversations for the same team ────────


    // A scheduled goal starts in a detached task. Let the user open the
    // exact task that owns the live operation (or a durable approval card)
    // so they can observe or unblock it; switching to an unrelated task is
    // still forbidden until the room settles.
    const channelTaskSwitchBlocked = (group: GroupRecord, targetThreadId: string) => {
      const operationOwnsTarget = [...(groupTurnOperations.get(group.id) ?? [])]
        .some((operation) => !operation.cancelled && operation.threadId === targetThreadId);
      if (groupIsWorking(group) && !operationOwnsTarget) return true;
      const openApprovalThreads = store.groupTasks(group.id).flatMap((task) =>
        store.messagesFor(task.threadId).some(
          (message) =>
            message.kind === "options" &&
            message.card?.requestId &&
            !message.card.answered &&
            !message.card.dismissed,
        ) ? [task.threadId] : [],
      );
      return openApprovalThreads.length > 0 && !openApprovalThreads.includes(targetThreadId);
    };

    m = path.match(/^\/api\/groups\/([\w-]+)\/tasks$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const group = store.group(m[1]);
      if (!group) {
        json(res, 404, { error: "no such channel" });
        return true;
      }
      if (group.dm) {
        json(res, 400, { error: "bot-to-bot channels keep one canonical conversation" });
        return true;
      }
      if (channelTaskBlocked(group)) {
        json(res, 409, { error: "this channel is working or waiting on you — finish that turn first" });
        return true;
      }
      if (phoneSecretSubmissions.hasGroup(group.id)) {
        json(res, 409, { error: "this channel is securely saving a credential — try again when it finishes" });
        return true;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        json(res, 400, { error: "body must be a JSON object" });
        return true;
      }
      const request = createGroupTaskRequestSchema.safeParse(body);
      if (!request.success) {
        json(res, 400, { error: "title must be text" });
        return true;
      }
      const task = store.createGroupTask(group.id, request.data.title);
      if (!task) {
        json(res, 500, { error: "couldn't create that task" });
        return true;
      }
      const fresh = groupWithThread(store.group(group.id)!);
      broadcast({ kind: "group", group: fresh });
      json(res, 201, { group: fresh, task });
      return true;
    }

    m = path.match(/^\/api\/groups\/([\w-]+)\/tasks\/([\w-]+)$/);
    if (m && method === "POST") {
      const group = store.group(m[1]);
      if (!group) {
        json(res, 404, { error: "no such channel" });
        return true;
      }
      if (group.dm) {
        json(res, 400, { error: "bot-to-bot channels keep one canonical conversation" });
        return true;
      }
      if (phoneSecretSubmissions.hasGroup(group.id)) {
        json(res, 409, { error: "this channel is securely saving a credential — try again when it finishes" });
        return true;
      }
      if (channelTaskSwitchBlocked(group, m[2])) {
        json(res, 409, { error: "this channel is working or waiting on you in another task" });
        return true;
      }
      const switched = store.switchGroupTask(group.id, m[2]);
      if (!switched) {
        json(res, 404, { error: "no such channel task" });
        return true;
      }
      const fresh = groupWithThread(switched);
      broadcast({ kind: "group", group: fresh });
      const responseGroup = url.searchParams.get("messages") === "0"
        ? { ...publicGroupState(switched), tasks: store.groupTasks(switched.id) }
        : fresh;
      json(res, 200, { group: responseGroup });
      return true;
    }
    if (m && method === "PATCH") {
      const body = await readBody(req);
      const group = store.group(m[1]);
      if (!group) {
        json(res, 404, { error: "no such channel" });
        return true;
      }
      if (group.dm) {
        json(res, 400, { error: "bot-to-bot channels keep one canonical conversation" });
        return true;
      }
      if (channelTaskBlocked(group)) {
        json(res, 409, { error: "this channel is working or waiting on you — finish that turn first" });
        return true;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        json(res, 400, { error: "body must be a JSON object" });
        return true;
      }
      const task = store.renameGroupTask(m[1], m[2], String(body.title ?? ""));
      if (!task) {
        json(res, 404, { error: "no such channel task" });
        return true;
      }
      json(res, 200, { task });
      return true;
    }
    if (m && method === "DELETE") {
      const group = store.group(m[1]);
      if (!group) {
        json(res, 404, { error: "no such channel" });
        return true;
      }
      if (group.dm) {
        json(res, 400, { error: "bot-to-bot channels keep one canonical conversation" });
        return true;
      }
      if (phoneSecretSubmissions.hasThread(m[2])) {
        json(res, 409, { error: "this task is securely saving a credential — try again when it finishes" });
        return true;
      }
      if (channelTaskBlocked(group)) {
        json(res, 409, { error: "this channel is working or waiting on you — finish that turn first" });
        return true;
      }
      if (!store.groupTaskByThread(group.id, m[2])) {
        json(res, 404, { error: "no such channel task" });
        return true;
      }
      const stagedSkillCleanups = stagedSkillCleanupsForThread(m[2]);
      lastReply.delete(m[2]);
      cancelTeamSetupResumesForThread(m[2]);
      const updated = store.deleteGroupTask(group.id, m[2]);
      if (!updated) {
        json(res, 400, { error: "a channel keeps at least one task" });
        return true;
      }
      rejectDeletedThreadSkillStages(stagedSkillCleanups);
      const fresh = groupWithThread(updated);
      broadcast({ kind: "group", group: fresh });
      json(res, 200, { group: fresh });
      return true;
    }

    m = path.match(/^\/api\/groups\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (auth.kind === "session" && !auth.scopes.includes("admin")) {
        const field = clientGroupPatchViolation(body);
        if (field) {
          json(res, 403, { error: `forbidden: this session may rename or mark a room, not change "${field}" (needs the admin scope)` });
          return true;
        }
      }
      const group = updateChannel(m[1], body);
      json(res, 200, { group: publicGroupState(group) });
      return true;
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/read$/);
    if (m && method === "POST") {
      const group = store.patchGroup(m[1], { unread: false });
      if (!group) {
        json(res, 404, { error: "no such room" });
        return true;
      }
      broadcast({ kind: "group", group: publicGroupState(group) });
      json(res, 200, { group: publicGroupState(group) });
      return true;
    }
    m = path.match(/^\/api\/groups\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const group = store.group(m[1]);
      if (!group) {
        json(res, 404, { error: "no such room" });
        return true;
      }
      if (phoneSecretSubmissions.hasGroup(group.id)) {
        json(res, 409, { error: "this channel is securely saving a credential — try again when it finishes" });
        return true;
      }
      if (groupIsWorking(group)) {
        json(res, 409, { error: "this channel is working — stop that turn first" });
        return true;
      }
      const threadIds = new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]);
      const stagedSkillCleanups = [...threadIds].flatMap(stagedSkillCleanupsForThread);
      for (const threadId of threadIds) {
        cancelTeamSetupResumesForThread(threadId);
        lastReply.delete(threadId);
      }
      routines()!.disableForGroup(group.id);
      store.deleteGroup(group.id);
      rejectDeletedThreadSkillStages(stagedSkillCleanups);
      json(res, 200, { ok: true });
      return true;
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/messages$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        json(res, 400, { error: "body must be a JSON object" });
        return true;
      }
      const text = String(body.text ?? "").trim();
      if (!text) {
        json(res, 400, { error: "text required" });
        return true;
      }
      const group = store.group(m[1]);
      if (!group) {
        json(res, 404, { error: "no such group" });
        return true;
      }
      if (body.mode !== undefined && body.mode !== "chat" && body.mode !== "goal") {
        json(res, 400, { error: "mode must be chat or goal" });
        return true;
      }
      const channelMode: "chat" | "goal" = body.mode === "goal" ? "goal" : "chat";
      if (group.dm && channelMode === "goal") {
        json(res, 400, { error: "goal mode is available in team channels, not bot-to-bot channels" });
        return true;
      }
      if (body.threadId !== undefined && (typeof body.threadId !== "string" || !/^[\w-]+$/.test(body.threadId))) {
        json(res, 400, { error: "threadId must be a task id" });
        return true;
      }
      const threadId = body.threadId ?? group.threadId;
      noteTurnTrigger(threadId, auth);
      try {
        assertWithinBudget(cfg, DATA_DIR);
      } catch (error) {
        json(res, 409, { error: error instanceof Error ? error.message : String(error), code: "spend_cap" });
        return true;
      }
      const ownsThread = group.dm
        ? group.threadId === threadId
        : Boolean(store.groupTaskByThread(group.id, threadId));
      if (!ownsThread) {
        json(res, 409, { error: "the channel switched tasks before it could receive the message" });
        return true;
      }
      const sendId = parseSendId(body.sendId);
      const replyTo = resolveReplyTarget(threadId, body.replyToId);
      // Who is this "user"? On a headless server loopback is the owner by
      // design, and a bot's shell is a loopback caller too. A request with
      // no paired session and no browser origin cannot be told from a
      // script, so its message is stamped rather than trusted as typed —
      // the room's readers, its posting budget and its transcript all look
      // at that stamp — and the send is logged where the operator can see
      // it. The desktop app never gets here: its owner capability is
      // checked before this handler runs.
      const browserOrigin = typeof req.headers.origin === "string" && req.headers.origin.trim() !== "";
      const via: "api" | undefined =
        auth.kind === "loopback" && !DESKTOP_MANAGED && !browserOrigin ? "api" : undefined;
      if (via) {
        console.warn(`room message from ${requestSource(req)} through the local API (no session, no browser origin) into "${group.name}"`);
      }
      const receipt = await sendSequencer.run(
        sendId ? `group:${group.id}:${threadId}:${sendId}` : undefined,
        sendFingerprint(text, replyTo?.id, channelMode),
        async () => {
          if (sendId) {
            if (cancelledChatFollowup("channel", group.id, threadId, sendId)) {
              throw Object.assign(new Error("this queued sendId was cancelled; send a new message to try again"), { status: 409 });
            }
            const accepted = acceptedSendMatch(store.messagesFor(threadId), sendId, text, replyTo?.id, channelMode);
            if (accepted.kind === "conflict") {
              throw Object.assign(new Error("sendId already belongs to another message"), { status: 409 });
            }
            if (accepted.kind === "match") {
              return { ok: true as const, threadId, message: accepted.message };
            }
            const queued = queuedChannelMessage(group.id, threadId, sendId);
            if (queued) {
              if (
                queued.text !== text ||
                queued.replyToId !== replyTo?.id ||
                queued.mode !== channelMode
              ) {
                throw Object.assign(new Error("sendId already belongs to another message"), { status: 409 });
              }
              return { ok: true as const, queued: true as const, queueId: queued.id, threadId };
            }
          }
          const current = store.group(group.id);
          if (!current) throw Object.assign(new Error("no such group"), { status: 404 });
          if (current.threadId !== threadId) {
            throw Object.assign(new Error("the channel switched tasks before it could receive the message"), {
              status: 409,
            });
          }
          if (groupIsWorking(current)) {
            const queued = queueChannelMessage(current.id, threadId, text, {
              replyToId: replyTo?.id,
              sendId,
              mode: channelMode,
              via,
            });
            return { ok: true as const, queued: true as const, queueId: queued.id, threadId };
          }
          const message = startGroupTurn(current.id, text, replyTo, sendId, channelMode, undefined, { via, sender: messageSender(auth) });
          return { ok: true as const, threadId, message };
        },
      );
      json(res, 202, receipt);
      return true;
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/queue\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const group = store.group(m[1]);
      if (!group) {
        json(res, 404, { error: "no such group" });
        return true;
      }
      if (!cancelChannelMessage(group.id, m[2])) {
        json(res, 404, { error: "no such queued message" });
        return true;
      }
      json(res, 200, { ok: true });
      return true;
    }

    // Steer a queued room message into the RUNNING room turn (no interrupt).
    // Only the head steers — room queues drain one item at a time — and the
    // engine that receives it is the thread's live speaker. A room whose
    // running driver cannot steer keeps its queue, exactly like an incapable
    // 1:1 engine; this never ends the running turn.
    m = path.match(/^\/api\/groups\/([\w-]+)\/queue\/([\w-]+)\/steer$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
        json(res, 400, { error: "body must be a JSON object" });
        return true;
      }
      const threadId = typeof body?.threadId === "string" ? body.threadId : undefined;
      if (threadId !== undefined && !/^[\w-]+$/.test(threadId)) {
        json(res, 400, { error: "threadId must be a task id" });
        return true;
      }
      const group = store.group(m[1]);
      if (!group) {
        json(res, 404, { error: "no such room" });
        return true;
      }
      const targetThreadId = threadId ?? group.threadId;
      const ownsThread = group.dm
        ? group.threadId === targetThreadId
        : Boolean(store.groupTaskByThread(group.id, targetThreadId));
      if (!ownsThread) {
        json(res, 409, { error: "the channel switched tasks before it could receive the message" });
        return true;
      }
      noteTurnTrigger(targetThreadId, auth);
      const current = store.group(group.id);
      if (!current) {
        json(res, 404, { error: "no such room" });
        return true;
      }
      // Which engine owns the running room turn on this thread? The same
      // resolution the room's own Stop uses: the live speaker, else the busy
      // bot on the channel's main thread.
      const speakerBotId =
        groupSpeakers.get(targetThreadId)?.botId ??
        (targetThreadId === current.threadId ? current.busyBotId : undefined);
      const speaker = speakerBotId ? store.bot(speakerBotId) : undefined;
      const instance = speaker ? runningTurnInstance(speaker, targetThreadId) : undefined;
      // Lift the queue atomically: the room settling can drain it as the
      // next follow-up, or this request can steer its head into the live
      // turn — never both for the same words.
      const held = holdChannelQueue(current.id, targetThreadId, m[2]);
      if (!held) {
        json(res, 404, { error: "no such queued message" });
        return true;
      }
      if (!speaker || !instance?.adapter.capabilities.queueing || !instance.adapter.steer) {
        restoreHeldChannelQueue(held);
        json(res, 200, { ok: true, queued: true, threadId: targetThreadId });
        return true;
      }
      const [head] = held.items;
      if (!head || head.id !== m[2]) {
        restoreHeldChannelQueue(held);
        json(res, 409, { error: "only the first queued message can steer" });
        return true;
      }
      // A reply target that cannot be resolved restores the held queue
      // before the request fails — the room's normal drain keeps the head.
      const replyTo = resolveHeldReplyTarget(held, resolveReplyTarget);
      const steered = await instance.adapter
        .steer(targetThreadId, promptWithReply(head.text, replyTo, cfg.profile?.name?.trim() || "User"))
        .catch((): SteerOutcome => "indeterminate");
      // The steer was awaited adapter work: re-read every ownership
      // invariant before writing anything, exactly like the 1:1 path. A
      // speaker change, a channel switch, or a settled room restores the
      // queue instead of recording words the new turn never saw.
      const after = store.group(current.id);
      const afterSpeakerBotId = after
        ? groupSpeakers.get(targetThreadId)?.botId ??
          (targetThreadId === after.threadId ? after.busyBotId : undefined)
        : undefined;
      // "indeterminate" (timeout after delivery, lost transport, a settle
      // race) never restores: the words may already be folded into the turn
      // that was live when they were sent, and replaying them into a new
      // turn would run them twice. Record them once — even under a new
      // speaker — and settle the head.
      const delivered = steered !== "refused";
      if (after && delivered && (steered === "indeterminate" || afterSpeakerBotId === speakerBotId)) {
        const message = store.appendMessage(targetThreadId, {
          role: "user",
          kind: "text",
          text: head.text,
          replyToId: head.replyToId,
          sendId: head.sendId,
          channelMode: head.mode,
          queueId: head.id,
          via: head.via,
          steered: true,
        });
        settleHeldChannelQueueHead(held);
        json(res, 200, {
          ok: true,
          steered: true,
          threadId: targetThreadId,
          messages: [message],
          queueIds: [head.id],
        });
        return true;
      }
      if (steered === "indeterminate" && !after) {
        // The room vanished while the answer was lost: settle the head so a
        // restart cannot replay words the dead turn may already have run.
        settleHeldChannelQueueHead(held);
        json(res, 404, { error: "no such room" });
        return true;
      }
      restoreHeldChannelQueue(held);
      // The room may have settled while the steer was refused; a queue that
      // is now drainable must not strand behind a missed settle.
      if (after && !groupIsWorking(after)) drainQueuedChannelSends();
      json(res, 200, { ok: true, queued: true, threadId: targetThreadId });
      return true;
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const group = store.group(m[1]);
      if (!group) {
        json(res, 404, { error: "no such room" });
        return true;
      }
      const rawBody = await readBody(req);
      if (rawBody !== null && (typeof rawBody !== "object" || Array.isArray(rawBody))) {
        json(res, 400, { error: "body must be a JSON object" });
        return true;
      }
      const body = rawBody ?? {};
      if (body.threadId !== undefined && (typeof body.threadId !== "string" || !/^[\w-]+$/.test(body.threadId))) {
        json(res, 400, { error: "threadId must be a task id" });
        return true;
      }
      if (body.threadId !== undefined) {
        const ownsThread = group.dm
          ? body.threadId === group.threadId
          : Boolean(store.groupTaskByThread(group.id, body.threadId));
        if (!ownsThread) {
          json(res, 409, { error: "the channel switched tasks before it could be interrupted" });
          return true;
        }
      }
      const activeOperations = [...(groupTurnOperations.get(group.id) ?? [])]
        .filter((operation) => !operation.cancelled);
      if (
        body.threadId !== undefined &&
        activeOperations.length > 0 &&
        !activeOperations.some((operation) => operation.threadId === body.threadId)
      ) {
        json(res, 409, { error: "this channel is working in another task" });
        return true;
      }
      // Without an explicit task, Stop means the room's live operation—not
      // merely whichever task the UI was showing when a detached routine
      // began. There is normally one operation; cancel every active thread
      // defensively so no queued handoff survives a room-level stop.
      const targetThreadIds = body.threadId !== undefined
        ? [body.threadId]
        : activeOperations.length > 0
          ? [...new Set(activeOperations.map((operation) => operation.threadId))]
          : [group.threadId];
      const interruptTargets = targetThreadIds.map((threadId) => {
        const speaker = groupSpeakers.get(threadId);
        const busy = speaker
          ? store.bot(speaker.botId)
          : threadId === group.threadId && group.busyBotId
            ? store.bot(group.busyBotId)
            : undefined;
        return {
          threadId,
          instance: busy ? runningTurnInstance(busy, threadId) : undefined,
        };
      });
      // Abort every queued operation before the first provider round trip;
      // otherwise one queued task could begin while Stop awaits interruption
      // of the task ahead of it.
      for (const { threadId } of interruptTargets) cancelGroupTurnOperations(group.id, threadId);
      for (const { threadId, instance } of interruptTargets) {
        revokeInternalCapabilitiesForThread(threadId);
        await instance?.adapter.interruptTurn(threadId).catch(() => {});
        closeOpenApprovals(threadId);
      }
      json(res, 200, { ok: true });
      return true;
    }

    // emoji reactions — works on any thread (1:1 or room)
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/reactions$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const emoji = String(body.emoji ?? "").slice(0, 8);
      if (!emoji) {
        json(res, 400, { error: "emoji required" });
        return true;
      }
      const patched = store.toggleReaction(m[1], m[2], emoji, typeof body.by === "string" ? body.by : "user");
      if (!patched) {
        json(res, 404, { error: "no such message" });
        return true;
      }
      json(res, 200, { message: patched });
      return true;
    }
    if (path === "/api/sidebar-sections" && method === "GET") {
      json(res, 200, { sections: store.sections });
      return true;
    }
    if (path === "/api/sidebar-sections" && (method === "PATCH" || method === "DELETE")) {
      const section = url.searchParams.get("section")?.trim();
      if (!section) {
        json(res, 400, { error: "Choose a named team" });
        return true;
      }
      if (teamComputers.forSection(section)) {
        json(res, 409, { error: "Unassign this team's computer before renaming or deleting the team" });
        return true;
      }
      let nextName: string | null = null;
      if (method === "PATCH") {
        const parsed = z.object({ name: z.string().trim().min(1).max(60) }).strict().safeParse(await readBody(req));
        if (!parsed.success) {
          json(res, 400, { error: "Team name must be 1 to 60 characters" });
          return true;
        }
        nextName = parsed.data.name;
      }
      const error = store.changeEmptySection(section, nextName);
      if (error) {
        json(res, error === "No such team" ? 404 : 409, { error });
        return true;
      }
      json(res, 200, { sections: store.sections });
      return true;
    }
    if (method === "POST" && path === "/api/sidebar-sections") {
      const parsed = createSidebarSectionSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        json(res, 400, { error: "Provide a team name and up to 100 valid botIds" });
        return true;
      }
      const name = parsed.data.name.trim();
      if (name.length > 60) {
        json(res, 400, { error: "name must be at most 60 characters" });
        return true;
      }
      const botIds = [...new Set(parsed.data.botIds)];
      if (!name && !botIds.length) {
        json(res, 400, { error: "Team name is required" });
        return true;
      }
      for (const botId of botIds) {
        const bot = store.bot(botId);
        if (bot) assertTeamComputerChangeIdle(bot, { ...bot, section: name || undefined });
      }
      const result = store.setBotsSection(botIds, name);
      if (!result.ok) {
        if (result.reason === "chief-conflict") {
          json(res, 409, {
            error: "A team can have only one Chief of Staff. Choose one Chief or use a team without one.",
          });
          return true;
        }
        json(res, 404, { error: "one or more bots are unavailable" });
        return true;
      }
      json(res, 200, { section: name, sections: store.sections, bots: result.bots.map(wireBot) });
      return true;
    }
    return false;
  };
}
