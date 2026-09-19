// Workspace edits: start_thread, create_bot, and create-room/manage-room.
// Bodies moved verbatim from ../internal.ts; the dispatch chain there owns
// order.
import type { ServerResponse } from "node:http";

import { z } from "zod";
import { fitsOnOneLine } from "../../bot-profile.ts";
import { maxConcurrentBotThreads } from "../../config.ts";
import { queueDelegation, pendingDelegationSnapshot, type QueueResult } from "../../delegations.ts";
import { canAccessTeam, peerAllowed, reachablePeers, PEER_ACCESS_HELP} from "../../peer-roster.ts";
import { redactSecretsInText } from "../../redact.ts";
import { sectionKey, type Message } from "../../store.ts";
import type { InternalRoutesOptions } from "../internal.ts";
import type { InternalRequestCtx } from "./types.ts";

export type ThreadsCtx = InternalRequestCtx & {
  store: InternalRoutesOptions["store"];
  cfg: InternalRoutesOptions["cfg"];
  commsBus: InternalRoutesOptions["commsBus"];
  createChannel: InternalRoutesOptions["createChannel"];
  updateChannel: InternalRoutesOptions["updateChannel"];
  startOrQueueOpenedThread: InternalRoutesOptions["startOrQueueOpenedThread"];
  connectorThread: InternalRoutesOptions["connectorThread"];
  delegatedFullAccess: InternalRoutesOptions["delegatedFullAccess"];
  grantDelegatedFullAccess: InternalRoutesOptions["grantDelegatedFullAccess"];
  peerReviewRequired: InternalRoutesOptions["peerReviewRequired"];
  isUnattended: InternalRoutesOptions["isUnattended"];
  threadBusy: InternalRoutesOptions["threadBusy"];
  MAX_THREADS_OPENED_PER_TURN: InternalRoutesOptions["MAX_THREADS_OPENED_PER_TURN"];
  MAX_WORKSPACE_BOTS: InternalRoutesOptions["MAX_WORKSPACE_BOTS"];
  MAX_COMMS_DEPTH: InternalRoutesOptions["MAX_COMMS_DEPTH"];
}

// start_thread: a bot opens a real thread — on itself for separate
// work, or on a teammate as a handoff that should run on its own.
// Never activates: a bot must not move what the person is looking at.
export async function startThread(ctx: ThreadsCtx, res: ServerResponse): Promise<boolean> {
  const {
    store, cfg, commsBus, startOrQueueOpenedThread, connectorThread, delegatedFullAccess, grantDelegatedFullAccess,
    peerReviewRequired, isUnattended, threadBusy, MAX_THREADS_OPENED_PER_TURN, MAX_COMMS_DEPTH,
    internalCapability, internalSender, json, readInternalBody,
  } = ctx;
    const body = await readInternalBody();
    const from = internalSender;
    const fromThreadId = internalCapability.threadId;
    const owner = connectorThread(from.id, fromThreadId);
    if (!owner) return json(res, 403, { error: "source conversation does not belong to sender" });
    if (
      body.depth !== undefined &&
      (!Number.isInteger(body.depth) || body.depth < 0 || body.depth !== internalCapability.depth)
    ) {
      return json(res, 403, { error: "the recursion depth does not match this turn" });
    }
    const title = String(body.title ?? "").trim();
    const message = String(body.message ?? "").trim();
    if (!title || !message) return json(res, 400, { error: "title and message are required" });
    if (title.length > 80) return json(res, 400, { error: "title must be at most 80 characters" });
    // the title is quoted into chips and the sidebar, one line each
    if (!fitsOnOneLine(title)) return json(res, 400, { error: "title must fit on one line" });
    if (internalCapability.openedThreads >= MAX_THREADS_OPENED_PER_TURN) {
      return json(res, 429, { error: `you can open at most ${MAX_THREADS_OPENED_PER_TURN} threads in one turn` });
    }
    const toBotId = typeof body.toBotId === "string" && body.toBotId.trim() ? body.toBotId.trim() : from.id;
    const target = store.bot(toBotId);
    if (!target) return json(res, 404, { error: "no such bot" });
    if (internalCapability.roomCoordination) {
      if (target.id !== from.id) {
        return json(res, 409, { error: "Use coordinate_bots for teamwork; it queues actual teammates and resumes you automatically." });
      }
      if (!internalCapability.ownThreadCreation) {
        return json(res, 409, { error: "Only a direct user request can open separate self-owned threads. Finish this assigned work here; use coordinate_bots for teammates." });
      }
    }
    // A folder is the target's own organisation; a name is what the
    // model has, an id is what the sidebar has, so accept either.
    const folder = typeof body.folder === "string" ? body.folder.trim() : "";
    let projectId: string | undefined;
    if (folder) {
      const project = (target.projects ?? []).find(
        (candidate) => candidate.id === folder || candidate.name.trim().toLowerCase() === folder.toLowerCase(),
      );
      if (!project) {
        const names = (target.projects ?? []).map((candidate) => candidate.name).join(", ");
        return json(res, 400, { error: `@${target.name} has no folder named "${folder}"${names ? ` — the folders are: ${names}` : " — it has no folders; leave folder out"}` });
      }
      projectId = project.id;
    }
    const sourceTitle = owner.group ? owner.group.name : (store.taskByThread(from.id, fromThreadId)?.title ?? "");
    if (target.id === from.id) {
      const task = store.createTask(from.id, title, false, projectId, { botId: from.id, name: from.name, at: Date.now() });
      if (!task) return json(res, 500, { error: "couldn't create that thread" });
      internalCapability.openedThreads += 1;
      const chip: Omit<Message, "id" | "at"> = {
        role: "bot",
        kind: "activity",
        tool: { name: `Opened thread #${task.title}`, ok: true },
        threadRef: { botId: from.id, threadId: task.threadId, title: task.title },
      };
      if (owner.group) chip.from = { botId: from.id, name: from.name, color: from.color };
      store.appendMessage(fromThreadId, chip);
      // The first line is the bot's own words. Say so where the model
      // reads it, so a later turn in that thread never mistakes the
      // request for the person's.
      const opening = `[Thread you opened yourself${sourceTitle ? ` from #${sourceTitle}` : ""}. The request below is your own words, not the person's: do the work here and end with a clear result they can read.]\n\n${message}`;
      const outcome = await startOrQueueOpenedThread(from.id, task.threadId, opening, isUnattended(from.id, fromThreadId));
      return json(res, 201, {
        threadId: task.threadId,
        title: task.title,
        botId: from.id,
        botName: from.name,
        self: true,
        limit: maxConcurrentBotThreads(cfg),
        ...outcome,
      });
    }
    // A peer thread is a handoff into a fresh thread: every gate the
    // classic handoff has applies unchanged, here at queue time and
    // again in the drain at dispatch time.
    const depth = internalCapability.depth;
    if (depth >= MAX_COMMS_DEPTH) {
      return json(res, 200, { error: "thread chains are limited to one hop — open the thread on yourself, or do this one here" });
    }
    if (!canAccessTeam(from, target.section) || target.hidden) {
      return json(res, 403, { error: `that bot belongs to a different section or is unavailable. ${PEER_ACCESS_HELP}` });
    }
    if (!peerAllowed(from, target.id)) {
      return json(res, 403, { error: `that bot is not on this bot's allowed peers. ${PEER_ACCESS_HELP}` });
    }
    const task = store.createTask(target.id, title, false, projectId, { botId: from.id, name: from.name, at: Date.now() });
    if (!task) return json(res, 500, { error: "couldn't create that thread" });
    if (delegatedFullAccess(from, fromThreadId, target)) grantDelegatedFullAccess(from, target, task.threadId);
    const queued = queueDelegation(
      commsBus,
      from,
      { toBotId: target.id, message, depth, targetThreadId: task.threadId },
      MAX_COMMS_DEPTH,
      fromThreadId,
    );
    if (queued.result !== "ok" || !queued.id) {
      // nothing will ever run there: take the row back before the person
      // sees a thread that goes nowhere
      store.deleteTask(target.id, task.threadId);
      const said: Record<Exclude<QueueResult, "ok">, string> = {
        self: "a bot cannot hand a thread to itself this way — leave bot_id out",
        too_deep: "thread chains are limited to one hop — open the thread on yourself, or do this one here",
        no_target: "no such bot",
        too_many: "too many handoffs queued on this turn — finish your turn and open the rest next time",
      };
      return json(res, 200, { error: said[queued.result === "ok" ? "no_target" : queued.result] });
    }
    store.setTaskOpenedBy(target.id, task.threadId, { botId: from.id, name: from.name, delegationId: queued.id, at: task.openedBy?.at ?? Date.now() });
    internalCapability.openedThreads += 1;
    // An honest forecast, not a promise: the handoff starts when this
    // turn ends, and by then the target's slots are taken by whatever is
    // running there plus the threads this turn already opened ahead.
    const limit = maxConcurrentBotThreads(cfg);
    const running = store.tasks(target.id).filter((candidate) => threadBusy(target.id, candidate.threadId)).length;
    const ahead = pendingDelegationSnapshot().filter(
      (pending) => pending.toBotId === target.id && pending.targetThreadId !== undefined && pending.targetThreadId !== task.threadId,
    ).length;
    const position = running + ahead + 1;
    return json(res, 201, {
      threadId: task.threadId,
      title: task.title,
      botId: target.id,
      botName: target.name,
      self: false,
      delegationId: queued.id,
      approvalRequired: peerReviewRequired(from, fromThreadId),
      limit,
      ...(position > limit ? { state: "queued", position: position - limit } : { state: "pending" }),
    });
}

export async function createBot(ctx: ThreadsCtx, res: ServerResponse): Promise<boolean> {
  const {
    store, MAX_WORKSPACE_BOTS, connectorThread, internalCapability, internalSender, json, readInternalBody,
  } = ctx;
    const body = await readInternalBody();
    const chief = internalSender;
    const fromThreadId = internalCapability.threadId;
    if (!connectorThread(chief.id, fromThreadId)) {
      return json(res, 403, { error: "source conversation does not belong to sender" });
    }
    if (!chief.chiefOfStaff) {
      return json(res, 403, { error: "only a section's Chief of Staff can create operator bots" });
    }
    if (internalCapability.createdBots >= 4) {
      return json(res, 429, { error: "you can create at most 4 bots in one turn" });
    }
    if (store.bots.length >= MAX_WORKSPACE_BOTS) {
      return json(res, 409, { error: `this workspace is limited to ${MAX_WORKSPACE_BOTS} bots` });
    }
    const name = String(body.name ?? "").trim();
    const role = String(body.role ?? "").trim();
    const instructions = String(body.instructions ?? "").trim();
    if (!name || !role || !instructions) {
      return json(res, 400, { error: "name, role, and instructions are required" });
    }
    if (name.length > 80) return json(res, 400, { error: "name must be at most 80 characters" });
    if (role.length > 120) return json(res, 400, { error: "role must be at most 120 characters" });
    // the same door the profile endpoints keep: both fields are quoted
    // into every other room member's system prompt, one line each
    if (!fitsOnOneLine(name)) return json(res, 400, { error: "name must fit on one line" });
    if (!fitsOnOneLine(role)) return json(res, 400, { error: "role must fit on one line" });
    if (instructions.length > 1_000) {
      return json(res, 400, { error: "instructions must be at most 1000 characters" });
    }
    const duplicate = store.bots.find(
      (candidate) =>
        !candidate.hidden &&
        sectionKey(candidate.section) === sectionKey(chief.section) &&
        candidate.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (duplicate) {
      return json(res, 409, { error: `@${duplicate.name} already exists in this section; use list_bots` });
    }
    const created = store.createBot(
      {
        name,
        title: role,
        description: instructions,
        modelSelection: { ...chief.modelSelection },
        section: chief.section,
      },
      { seedMessages: false },
    );
    const safeBot = store.patchBot(created.id, {
      composio: false,
      autoApprove: false,
      approvePeerComms: false,
    })!;
    internalCapability.createdBots += 1;
    return json(res, 201, {
      id: safeBot.id,
      name: safeBot.name,
      title: safeBot.title,
      section: safeBot.section || "General",
      model: safeBot.modelSelection.model,
    });
}

export async function createRoomOrManageRoom(ctx: ThreadsCtx, res: ServerResponse, path: string): Promise<boolean> {
  const {
    store, createChannel, updateChannel, connectorThread, peerReviewRequired, internalCapability, json, readInternalBody,
  } = ctx;
    const body = await readInternalBody();
    const chief = store.bot(internalCapability.botId)!;
    if (chief.hidden || !chief.chiefOfStaff || !connectorThread(chief.id, internalCapability.threadId)) {
      return json(res, 403, { error: "only an active section Chief of Staff can manage rooms" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json(res, 400, { error: "room request must be a JSON object" });
    }
    // ponytail: no new room-administration approval flow. Fail closed for
    // chiefs whose peer changes need review; add a proposal card if needed.
    if (peerReviewRequired(chief, internalCapability.threadId)) {
      return json(res, 403, { error: "peer approval is required; ask the user to make this room change" });
    }
    // Section labels are a permission boundary, not bot-owned organization.
    // A Chief may not recruit excluded peers or acquire a foreign transcript.
    const allowedIds = new Set([chief.id, ...reachablePeers(store.bots, chief).map((bot) => bot.id)]);
    const allowedRoster = (ids: string[]) => ids.includes(chief.id) && ids.every((id) => allowedIds.has(id));
    if (body.section !== undefined && (typeof body.section !== "string" || sectionKey(body.section) !== sectionKey(chief.section))) {
      return json(res, 403, { error: "rooms must stay in your own section; ask the user to move them" });
    }
    if (path === "/api/internal/create-room") {
      if ((internalCapability.createdRooms ?? 0) >= 4) {
        return json(res, 429, { error: "you can create at most 4 rooms in one turn" });
      }
      const parsed = z.object({
        fromBotId: z.string().optional(), fromThreadId: z.string().optional(),
        name: z.string().trim().min(1).max(100), memberIds: z.array(z.string()).min(1).max(100),
        section: z.string().optional(), bulletin: z.string().max(12_000).optional(),
      }).strict().safeParse(body);
      if (!parsed.success) return json(res, 400, { error: "provide a room name, memberIds, and optional bulletin (at most 12000 characters)" });
      const memberIds = [...new Set([chief.id, ...parsed.data.memberIds])];
      if (!allowedRoster(memberIds)) {
        return json(res, 403, { error: "include yourself and only active, allowed peers from your section" });
      }
      const group = createChannel({
        name: redactSecretsInText(parsed.data.name), memberIds, section: chief.section,
        setup: { bulletin: redactSecretsInText(parsed.data.bulletin ?? ""), defaultResponder: { kind: "member", botId: chief.id } },
      });
      internalCapability.createdRooms = (internalCapability.createdRooms ?? 0) + 1;
      return json(res, 201, { id: group.id, name: group.name, section: group.section || "General", memberIds: group.memberIds, memberCount: group.memberIds.length });
    }
    const parsed = z.object({
      fromBotId: z.string().optional(), fromThreadId: z.string().optional(),
      roomId: z.string(), action: z.enum(["add_members", "remove_members", "set_members", "rename", "set_bulletin"]),
      memberIds: z.array(z.string()).min(1).max(100).optional(),
      name: z.string().trim().min(1).max(100).optional(), bulletin: z.string().max(12_000).optional(),
    }).strict().safeParse(body);
    if (!parsed.success) return json(res, 400, { error: "provide roomId and a supported room action; section moves are user-only" });
    const room = store.group(parsed.data.roomId);
    if (!room || room.dm || sectionKey(room.section) !== sectionKey(chief.section) || !allowedRoster(room.memberIds)) {
      return json(res, 403, { error: "you can only manage rooms you belong to with allowed peers in your own section" });
    }
    const { action, memberIds, name, bulletin } = parsed.data;
    const patch: Record<string, unknown> = {};
    if (action === "rename") {
      if (name === undefined) return json(res, 400, { error: "rename requires a name" });
      patch.name = redactSecretsInText(name);
    } else if (action === "set_bulletin") {
      if (bulletin === undefined) return json(res, 400, { error: "set_bulletin requires bulletin text; use an empty string to clear it" });
      patch.bulletin = redactSecretsInText(bulletin);
    } else {
      if (!memberIds || memberIds.some((id) => !allowedIds.has(id))) {
        return json(res, 403, { error: "memberIds must name only yourself or active, allowed peers in your section" });
      }
      const next = action === "add_members" ? [...new Set([...room.memberIds, ...memberIds])]
        : action === "remove_members" ? room.memberIds.filter((id) => !memberIds.includes(id)) : memberIds;
      if (!allowedRoster(next)) return json(res, 403, { error: "keep yourself in the room; only the user can remove its managing Chief" });
      patch.memberIds = next;
    }
    const updated = updateChannel(room.id, patch);
    return json(res, 200, { ok: true, memberIds: updated.memberIds, memberCount: updated.memberIds.length, message: `Updated room “${updated.name}”.` });
}
