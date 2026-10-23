import { z } from "zod";
import type { ResolvedSender, WireGroup } from "../../shared/wire.ts";
import { admit } from "../admission.ts";
import {
  cancelChannelMessage,
  headChannelGroup,
  holdChannelQueue,
  queueChannelMessage,
  queuedChannelMessage,
  resolveHeldReplyTarget,
  restoreHeldChannelQueue,
  settleHeldChannelQueueHead,
} from "../channel-queue.ts";
import { DATA_DIR, type AppConfig } from "../config.ts";
import type { ProviderInstance, SteerOutcome } from "../contracts.ts";
import { cancelledChatFollowup } from "../message-db.ts";
import type { PhoneSecretSubmissionRegistry } from "../phone-secret.ts";
import { promptWithReply, type PersonName } from "../replies.ts";
import { clientGroupPatchViolation, requestSource, type RequestAuth } from "../request-auth.ts";
import type { RoomContextTracker } from "../room-context.ts";
import { parseConversationTurnTimeout } from "../room-turn-timeout.ts";
import type { RoutineManager } from "../routines.ts";
import { acceptedSendMatch, parseSendId, sendFingerprint, type SendSequencer } from "../send-idempotency.ts";
import type { SkillReview } from "../skill-review.ts";
import { assertWithinBudget } from "../spend.ts";
import type { BotRecord, GroupRecord, GroupTaskPatch, Message, Store } from "../store.ts";
import type { ThreadStarters } from "../thread-starters.ts";
import { extractSteerImages } from "../turn-images.ts";
import type { UsageTrigger } from "../usage-ledger.ts";
import { bulkDeleteThreadIds, type BulkDeleteRefusal } from "./bulk-delete.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { sawThread } from "../thread-presence.ts";
import { readThreadNotifications } from "./notifications.ts";

export type MessagePage = { messages: Array<Message | Record<string, unknown>>; hasMore?: boolean; activeLeafId: string | null };

export interface ChannelRouteDeps {
  store: Pick<Store,
    | "group" | "groupTaskByThread" | "bot" | "switchGroupTask" | "patchGroupTask" | "patchGroup" | "messagesFor" | "groupTasks" | "deleteGroupTasks" | "deleteGroup"
    | "createGroupTask" | "appendMessage">;
  cfg: Pick<AppConfig, "budgets">;
  /** What people's lines are called in this conversation (replies.ts PersonName). */
  userName(threadId: string): PersonName;
  /** The desktop app owns this server, so a loopback caller is its owner. */
  desktopManaged: boolean;
  routines(): Pick<RoutineManager, "disableForGroup"> | null;
  broadcast(payload: Record<string, unknown>): void;
  actorKey(auth: RequestAuth & { kind: "session" }): string;
  threadStarters: Pick<ThreadStarters, "set">;
  phoneSecretSubmissions: Pick<PhoneSecretSubmissionRegistry, "hasGroup" | "hasThread">;
  sendSequencer: Pick<SendSequencer, "run">;
  roomMemberContexts: Pick<RoomContextTracker, "request">;
  skillReview: Pick<SkillReview, "dropThread">;
  groupSpeakers: ReadonlyMap<string, { botId: string }>;
  groupTurnOperations: ReadonlyMap<string, ReadonlySet<{ threadId: string; cancelled: boolean }>>;
  lastReply: Pick<Map<string, string>, "delete">;
  cloudThreadRefusal(auth: RequestAuth, threadId: string): string | null;
  messageSender(auth: RequestAuth): ResolvedSender | undefined;
  usageTriggerFor(auth: RequestAuth): UsageTrigger;
  publicGroupState(record: GroupRecord): WireGroup;
  groupWithThread(group: GroupRecord): WireGroup;
  updateChannel(groupId: string, value: unknown): GroupRecord;
  groupIsWorking(group: GroupRecord): boolean;
  groupThreadIsWorking(groupId: string, threadId: string): boolean;
  readCursor(threadId: string): { lastReadMessageId?: string };
  pageSize(raw: string | null): number | null | undefined;
  messagePage(threadId: string, limit: number | undefined): MessagePage;
  resolveReplyTarget(threadId: string, value: unknown): Message | undefined;
  runningTurnInstance(bot: BotRecord | null | undefined, threadId: string): ProviderInstance | null;
  engineSteersImages(instance: ProviderInstance | null | undefined): boolean;
  startGroupTurn(
    groupId: string,
    text: string,
    replyTo: Message | undefined,
    sendId: string | undefined,
    channelMode: "chat" | "goal",
    queueId: undefined,
    options: { via?: "api"; sender?: ResolvedSender; trigger?: UsageTrigger; threadId?: string },
  ): Message;
  applyRoomHoldsFromMessage(groupId: string, text: string): void;
  cancelGroupTurnOperations(groupId: string, threadId: string): void;
  drainQueuedChannelSends(): void;
  clearTurnDigestState(threadId: string): void;
  closeOpenApprovals(threadId: string): void;
  revokeInternalCapabilitiesForThread(threadId: string): void;
  stagedSkillCleanupsForThread(threadId: string): Array<{ botId: string; stagedId: string }>;
  rejectDeletedThreadSkillStages(cleanups: Array<{ botId: string; stagedId: string }>): void;
}

const createGroupTaskRequestSchema = z.object({ title: z.string().optional() });

export function createChannelRoutes(deps: ChannelRouteDeps): RouteHandler {
  const {
    store, cfg, broadcast, actorKey, threadStarters, phoneSecretSubmissions, sendSequencer, roomMemberContexts, skillReview,
    groupSpeakers, groupTurnOperations, lastReply, cloudThreadRefusal, messageSender, usageTriggerFor, publicGroupState,
    groupWithThread, updateChannel, groupIsWorking, groupThreadIsWorking, readCursor, pageSize, messagePage,
    resolveReplyTarget, runningTurnInstance, startGroupTurn, engineSteersImages, applyRoomHoldsFromMessage, cancelGroupTurnOperations,
    drainQueuedChannelSends, clearTurnDigestState, closeOpenApprovals, revokeInternalCapabilitiesForThread,
    stagedSkillCleanupsForThread, rejectDeletedThreadSkillStages,
  } = deps;
  const DESKTOP_MANAGED = deps.desktopManaged;
  const deleteRefusal = (auth: RequestAuth, groupId: string, threadId: string): { status: 403 | 404 | 409; error: string } | null => {
    if (phoneSecretSubmissions.hasThread(threadId)) {
      return { status: 409, error: "this task is securely saving a credential — try again when it finishes" };
    }
    if (groupThreadIsWorking(groupId, threadId)) return { status: 409, error: "this task is running — stop it first" };
    if (!store.groupTaskByThread(groupId, threadId)) return { status: 404, error: "no such channel task" };
    const notYours = cloudThreadRefusal(auth, threadId);
    return notYours ? { status: 403, error: notYours } : null;
  };
  const deleteGroupTasks = (groupId: string, threadIds: string[]) => {
    const stagedSkillCleanups = new Map(threadIds.map((threadId) => [threadId, stagedSkillCleanupsForThread(threadId)]));
    const result = store.deleteGroupTasks(groupId, threadIds);
    for (const threadId of result?.deleted ?? []) {
      lastReply.delete(threadId);
      clearTurnDigestState(threadId);
      skillReview.dropThread(threadId);
      revokeInternalCapabilitiesForThread(threadId);
      rejectDeletedThreadSkillStages(stagedSkillCleanups.get(threadId) ?? []);
    }
    return result;
  };
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    let m: RegExpMatchArray | null = null;
    const routines = deps.routines();

    m = path.match(/^\/api\/groups\/([\w-]+)\/tasks$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such channel" });
      if (group.dm) return json(res, 400, { error: "bot-to-bot channels keep one canonical conversation" });
      if (phoneSecretSubmissions.hasGroup(group.id)) {
        return json(res, 409, { error: "this channel is securely saving a credential — try again when it finishes" });
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const request = createGroupTaskRequestSchema.safeParse(body);
      if (!request.success) return json(res, 400, { error: "title must be text" });
      const task = store.createGroupTask(group.id, request.data.title);
      if (!task) return json(res, 500, { error: "couldn't create that task" });
      // Who opened it decides who may answer its cards on a shared workspace.
      if (auth.kind === "session") threadStarters.set(task.threadId, actorKey(auth));
      return json(res, 201, { group: groupWithThread(store.group(group.id)!), task });
    }

    m = path.match(/^\/api\/groups\/([\w-]+)\/tasks\/delete$/);
    if (m && method === "POST") {
      const parsed = bulkDeleteThreadIds(await readBody(req));
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such channel" });
      if (group.dm) return json(res, 400, { error: "bot-to-bot channels keep one canonical conversation" });
      const allowed: string[] = [];
      const refused: BulkDeleteRefusal[] = [];
      for (const threadId of parsed.threadIds) {
        const refusal = deleteRefusal(auth, group.id, threadId);
        if (!refusal) allowed.push(threadId);
        else refused.push({ threadId, reason: refusal.status === 409 ? "busy" : "not-found" });
      }
      if (allowed.length >= (group.tasks?.length ?? 1)) return json(res, 400, { error: "a channel keeps at least one task" });
      const result = deleteGroupTasks(group.id, allowed);
      if (!result) return json(res, 400, { error: "a channel keeps at least one task" });
      return json(res, 200, { group: groupWithThread(result.group), deleted: result.deleted, refused });
    }

    m = path.match(/^\/api\/groups\/([\w-]+)\/tasks\/([\w-]+)$/);
    if (m && method === "POST") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such channel" });
      if (group.dm) return json(res, 400, { error: "bot-to-bot channels keep one canonical conversation" });
      if (phoneSecretSubmissions.hasGroup(group.id)) {
        return json(res, 409, { error: "this channel is securely saving a credential — try again when it finishes" });
      }
      // Parsed before the switch: a rejected parameter must not leave the channel on another thread.
      const requestedMessages = url.searchParams.get("messages");
      const switchLimit = pageSize(requestedMessages);
      if (switchLimit === null) return json(res, 400, { error: "messages must be a non-negative whole number" });
      const switched = store.switchGroupTask(group.id, m[2]);
      if (!switched) return json(res, 404, { error: "no such channel task" });
      readThreadNotifications(switched.threadId, broadcast);
      const switchedSettings = publicGroupState(switched);
      // "0": settings only (no `messages` key); a positive page: that tail; omitted: the whole transcript.
      const responseGroup = requestedMessages === "0"
        ? switchedSettings
        : { ...switchedSettings, ...messagePage(switched.threadId, switchLimit) };
      return json(res, 200, { group: responseGroup });
    }
    if (m && method === "PATCH") {
      const body = await readBody(req);
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such channel" });
      if (group.dm) return json(res, 400, { error: "bot-to-bot channels keep one canonical conversation" });
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const allowed = new Set(["title", "pinned", "turnTimeoutMinutes"]);
      if (Object.keys(body).some((key) => !allowed.has(key))) return json(res, 400, { error: "unsupported channel thread setting" });
      const existing = store.groupTaskByThread(group.id, m[2]);
      if (!existing) return json(res, 404, { error: "no such channel task" });
      const pinning = body.pinned !== undefined;
      const renaming = body.title !== undefined;
      const limiting = Object.prototype.hasOwnProperty.call(body, "turnTimeoutMinutes");
      if (!pinning && !renaming && !limiting) return json(res, 400, { error: "unsupported channel thread setting" });
      if (pinning && typeof body.pinned !== "boolean") return json(res, 400, { error: "pinned must be a boolean" });
      if (renaming && typeof body.title !== "string") return json(res, 400, { error: "title must be a string" });
      const parsedLimit = limiting ? parseConversationTurnTimeout(body.turnTimeoutMinutes) : null;
      if (parsedLimit && !parsedLimit.ok) return json(res, 400, { error: parsedLimit.error });
      // Echoing the current title is not a rename: newer clients send it so an older server keeps the title.
      const titleChange = renaming && body.title !== existing.title;
      const notYours = titleChange ? cloudThreadRefusal(auth, m[2]) : null;
      if (notYours) return json(res, 403, { error: notYours });
      if (titleChange && groupThreadIsWorking(group.id, m[2])) {
        return json(res, 409, { error: "this task is running — stop it first" });
      }
      const patch: GroupTaskPatch = {
        ...(parsedLimit?.ok ? { turnTimeoutMinutes: parsedLimit.minutes } : {}),
        ...(pinning ? { pinned: body.pinned === true } : {}),
        ...(titleChange ? { title: body.title } : {}),
      };
      const task = Object.keys(patch).length ? store.patchGroupTask(group.id, m[2], patch) : existing;
      if (!task) return json(res, 404, { error: "no such channel task" });
      return json(res, 200, { task });
    }
    if (m && method === "DELETE") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such channel" });
      if (group.dm) return json(res, 400, { error: "bot-to-bot channels keep one canonical conversation" });
      const refusal = deleteRefusal(auth, group.id, m[2]);
      if (refusal) return json(res, refusal.status, { error: refusal.error });
      const updated = deleteGroupTasks(group.id, [m[2]]);
      if (!updated?.deleted.length) return json(res, 400, { error: "a channel keeps at least one task" });
      return json(res, 200, { group: groupWithThread(updated.group) });
    }

    m = path.match(/^\/api\/groups\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (auth.kind === "session" && !auth.scopes.includes("admin")) {
        const field = clientGroupPatchViolation(body);
        if (field) return json(res, 403, { error: `forbidden: this session may rename or mark a room, not change "${field}" (needs the admin scope)` });
      }
      const renamed = store.group(m[1]);
      if (renamed && body && typeof body === "object" &&
        ((body.name !== undefined && body.name !== renamed.name) || (body.bulletin !== undefined && body.bulletin !== (renamed.bulletin ?? "")))) {
        const notYours = cloudThreadRefusal(auth, renamed.threadId);
        if (notYours) return json(res, 403, { error: notYours });
      }
      const group = updateChannel(m[1], body);
      return json(res, 200, { group: publicGroupState(group) });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/read$/);
    if (m && method === "POST") {
      const room = store.group(m[1]);
      if (!room) return json(res, 404, { error: "no such room" });
      sawThread(room.threadId);
      const group = store.patchGroup(room.id, { unread: false, ...readCursor(room.threadId) })!;
      readThreadNotifications(room.threadId, broadcast);
      broadcast({ kind: "group", group: publicGroupState(group) });
      return json(res, 200, { group: publicGroupState(group) });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      if (phoneSecretSubmissions.hasGroup(group.id)) {
        return json(res, 409, { error: "this channel is securely saving a credential — try again when it finishes" });
      }
      if (groupIsWorking(group)) {
        return json(res, 409, { error: "this channel is working — stop that turn first" });
      }
      const threadIds = new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]);
      const stagedSkillCleanups = [...threadIds].flatMap(stagedSkillCleanupsForThread);
      for (const threadId of threadIds) {
        lastReply.delete(threadId);
        clearTurnDigestState(threadId);
        skillReview.dropThread(threadId);
      }
      routines!.disableForGroup(group.id);
      store.deleteGroup(group.id);
      rejectDeletedThreadSkillStages(stagedSkillCleanups);
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/messages$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such group" });
      if (body.mode !== undefined && body.mode !== "chat" && body.mode !== "goal") {
        return json(res, 400, { error: "mode must be chat or goal" });
      }
      const channelMode: "chat" | "goal" = body.mode === "goal" ? "goal" : "chat";
      if (group.dm && channelMode === "goal") {
        return json(res, 400, { error: "goal mode is available in team channels, not bot-to-bot channels" });
      }
      if (body.threadId !== undefined && (typeof body.threadId !== "string" || !/^[\w-]+$/.test(body.threadId))) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      const threadId = body.threadId ?? group.threadId;
      const trigger = usageTriggerFor(auth);
      try {
        assertWithinBudget(cfg, DATA_DIR);
      } catch (error) {
        return json(res, 409, { error: error instanceof Error ? error.message : String(error), code: "spend_cap" });
      }
      const ownsThread = group.dm
        ? group.threadId === threadId
        : Boolean(store.groupTaskByThread(group.id, threadId));
      if (!ownsThread) {
        return json(res, 409, { error: "the channel switched tasks before it could receive the message" });
      }
      const sendId = parseSendId(body.sendId);
      const replyTo = resolveReplyTarget(threadId, body.replyToId);
      // A bot's shell is a loopback caller too: with no paired session and no browser origin the message
      // is stamped, not trusted as typed (readers, posting budget and transcript see the stamp), and logged.
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
          const ownsTarget = current.threadId === threadId || store.groupTasks(current.id).some((task) => task.threadId === threadId);
          if (!ownsTarget) {
            throw Object.assign(new Error("no such thread in channel"), {
              status: 404,
            });
          }
          if (channelMode === "chat") applyRoomHoldsFromMessage(current.id, text);
          const threadWorking = groupThreadIsWorking(current.id, threadId);
          const decision = admit("room", {}, { roomWorking: threadWorking, threadWorking });
          if (decision.action === "queue") {
            const queued = queueChannelMessage(current.id, threadId, text, {
              replyToId: replyTo?.id,
              sendId,
              mode: channelMode,
              via,
              sender: messageSender(auth),
              trigger,
            });
            return { ok: true as const, queued: true as const, queueId: queued.id, threadId };
          }
          const message = startGroupTurn(current.id, text, replyTo, sendId, channelMode, undefined, { via, sender: messageSender(auth), trigger, threadId });
          return { ok: true as const, threadId, message };
        },
      );
      return json(res, 202, receipt);
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/queue\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such group" });
      if (!cancelChannelMessage(group.id, m[2])) {
        return json(res, 404, { error: "no such queued message" });
      }
      return json(res, 200, { ok: true });
    }

    // Steers the queued head into the running room turn without interrupting it; a driver that cannot steer keeps the queue.
    m = path.match(/^\/api\/groups\/([\w-]+)\/queue\/([\w-]+)\/steer$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const threadId = typeof body?.threadId === "string" ? body.threadId : undefined;
      if (threadId !== undefined && !/^[\w-]+$/.test(threadId)) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      const targetThreadId = threadId ?? group.threadId;
      const ownsThread = group.dm
        ? group.threadId === targetThreadId
        : Boolean(store.groupTaskByThread(group.id, targetThreadId));
      if (!ownsThread) {
        return json(res, 409, { error: "the channel switched tasks before it could receive the message" });
      }
      const current = store.group(group.id);
      if (!current) return json(res, 404, { error: "no such room" });
      const speakerBotId =
        groupSpeakers.get(targetThreadId)?.botId ??
        (targetThreadId === current.threadId ? current.busyBotId : undefined);
      const speaker = speakerBotId ? store.bot(speakerBotId) : undefined;
      const instance = speaker ? runningTurnInstance(speaker, targetThreadId) : undefined;
      // Hold the queue atomically: the room's settle drains it or this request steers its head, never both.
      const held = holdChannelQueue(current.id, targetThreadId, m[2]);
      if (!held) return json(res, 404, { error: "no such queued message" });
      const headGroup = headChannelGroup(held.items);
      const [head] = headGroup;
      const steerInput = extractSteerImages(headGroup.map((item) => item.text));
      const decision = admit("room-steer", {
        speakerPresent: Boolean(speaker),
        engineCanSteer: Boolean(instance?.adapter.capabilities.queueing && instance.adapter.steer),
        carriesImages: !steerInput || steerInput.images.length > 0,
        engineCanSteerImages: Boolean(steerInput) && engineSteersImages(instance),
        isQueueHead: Boolean(head && head.id === m[2]),
      });
      if (decision.action === "refuse") {
        restoreHeldChannelQueue(held);
        return json(res, 409, { error: "only the first queued message can steer" });
      }
      if (decision.action === "queue" || !steerInput) {
        restoreHeldChannelQueue(held);
        return json(res, 200, {
          ok: true,
          queued: true,
          threadId: targetThreadId,
          ...(decision.action === "queue" && decision.blockedBy ? { blockedBy: decision.blockedBy } : {}),
        });
      }
      const replyTo = resolveHeldReplyTarget(held, resolveReplyTarget);
      const speakerName = deps.userName(targetThreadId);
      let foldedPrompt: string;
      try {
        foldedPrompt = headGroup
          .map((item, index) =>
            promptWithReply(
              steerInput.texts[index] ?? item.text,
              index === 0
                ? replyTo
                : item.replyToId
                  ? resolveReplyTarget(targetThreadId, item.replyToId)
                  : undefined,
              speakerName,
            ),
          )
          .join("\n\n");
      } catch (error) {
        restoreHeldChannelQueue(held);
        throw error;
      }
      const steered: SteerOutcome = instance?.adapter.steer
        ? await (steerInput.images.length > 0
            ? instance.adapter.steer(targetThreadId, foldedPrompt, steerInput.images)
            : instance.adapter.steer(targetThreadId, foldedPrompt))
            .catch((): SteerOutcome => "indeterminate")
        : "refused";
      // The steer awaited adapter work: re-read every ownership invariant before writing anything.
      const after = store.group(current.id);
      const afterSpeakerBotId = after
        ? groupSpeakers.get(targetThreadId)?.botId ??
          (targetThreadId === after.threadId ? after.busyBotId : undefined)
        : undefined;
      // "indeterminate" never restores: the words may already be in the live turn, and a replay would run them twice.
      const delivered = steered !== "refused";
      if (after && delivered && (steered === "indeterminate" || afterSpeakerBotId === speakerBotId)) {
        const messages = headGroup.map((item) => store.appendMessage(targetThreadId, {
          role: "user",
          kind: "text",
          text: item.text,
          replyToId: item.replyToId,
          sendId: item.sendId,
          channelMode: item.mode,
          queueId: item.id,
          via: item.via,
          steered: true,
          sender: item.sender,
        }));
        settleHeldChannelQueueHead(held);
        return json(res, 200, {
          ok: true,
          steered: true,
          threadId: targetThreadId,
          messages,
          queueIds: headGroup.map((item) => item.id),
        });
      }
      if (steered === "indeterminate" && !after) {
        // Settle the head so a restart cannot replay words the dead turn may have run.
        settleHeldChannelQueueHead(held);
        return json(res, 404, { error: "no such room" });
      }
      restoreHeldChannelQueue(held);
      if (after && !groupThreadIsWorking(after.id, targetThreadId)) drainQueuedChannelSends();
      return json(res, 200, { ok: true, queued: true, threadId: targetThreadId });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/members\/([\w-]+)\/compact$/);
    if (m && method === "POST") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      if (!group.memberIds.includes(m[2])) return json(res, 404, { error: "that bot is not in this room" });
      const notYours = cloudThreadRefusal(auth, group.threadId);
      if (notYours) return json(res, 403, { error: notYours });
      if (!roomMemberContexts.request(group.threadId, m[2])) {
        return json(res, 409, { error: "this bot has no measured context in this room yet" });
      }
      const visible = publicGroupState(store.group(group.id) ?? group);
      broadcast({ kind: "group", group: visible });
      return json(res, 202, { ok: true, threadId: group.threadId, group: visible });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      const rawBody = await readBody(req);
      if (rawBody !== null && (typeof rawBody !== "object" || Array.isArray(rawBody))) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const body = rawBody ?? {};
      if (body.threadId !== undefined && (typeof body.threadId !== "string" || !/^[\w-]+$/.test(body.threadId))) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      if (body.threadId !== undefined) {
        const ownsThread = group.dm
          ? body.threadId === group.threadId
          : Boolean(store.groupTaskByThread(group.id, body.threadId));
        if (!ownsThread) {
          return json(res, 409, { error: "the channel switched tasks before it could be interrupted" });
        }
      }
      const activeOperations = [...(groupTurnOperations.get(group.id) ?? [])]
        .filter((operation) => !operation.cancelled);
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
      // Abort every queued operation before the first provider round trip, so none begins while Stop awaits.
      for (const { threadId } of interruptTargets) cancelGroupTurnOperations(group.id, threadId);
      for (const { threadId, instance } of interruptTargets) {
        revokeInternalCapabilitiesForThread(threadId);
        await instance?.adapter.interruptTurn(threadId).catch(() => {});
        closeOpenApprovals(threadId);
      }
      return json(res, 200, { ok: true });
    }
    return PASS;
  };
}
