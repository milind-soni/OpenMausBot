// The bot task and folder HTTP routes (project reorder, project CRUD,
// task creation, task switch, the task-detail PATCH with
// model/approval/surface settings, and task deletion), extracted
// verbatim from index.ts's dispatch chain. Path matching, methods,
// and status codes are unchanged; the handler returns false for
// anything it does not own so the chain falls through in the same
// order. The module's call site sits exactly where the family sat —
// immediately before the computers module — so dispatch order is
// unchanged; the botWithThread wire helper moved with the family
// because only these handlers use it. The checked-input helpers,
// skill-stage bookkeeping, deferred-resume and followup settlers are
// index-local and cross via deps: routines is a late-bound thunk over
// index.ts's let; store/registry are live bindings from
// ../runtime.ts. index.ts's `return json(...)` statements became
// `json(...); return true;` (json returns void).
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import type { createEventsRoutes } from "./events.ts";
import { approvalModeFor, supportsApprovalMode } from "../../shared/approval-mode.ts";
import { registry, store } from "../runtime.ts";
import { isProjectEmoji } from "../store.ts";
import { parseSurface } from "../surface.ts";
import { threadBusy } from "../turn-admission.ts";
import type { RoutineManager } from "../routines.ts";
import type { RoomHandoffs } from "../room-handoffs.ts";
import type { PhoneSecretSubmissionRegistry } from "../phone-secret.ts";
import type { createBotViews } from "../bot-views.ts";
import type { createCheckedInputs } from "../checked-inputs.ts";
import type { createDeferredResumes } from "../deferred-resumes.ts";
import type { createDelegationWatch } from "../delegation-watch.ts";

type BotViews = ReturnType<typeof createBotViews>;
type CheckedInputs = ReturnType<typeof createCheckedInputs>;
type DeferredResumes = ReturnType<typeof createDeferredResumes>;
type DelegationWatch = ReturnType<typeof createDelegationWatch>;

export function createBotTasksRoutes(deps: {
  routines: () => RoutineManager | null;
  broadcast: ReturnType<typeof createEventsRoutes>["broadcast"];
  wireBot: BotViews["wireBot"];
  wireTask: BotViews["wireTask"];
  DESKTOP_MANAGED: boolean;
  phoneSecretSubmissions: PhoneSecretSubmissionRegistry;
  checkedModelSelection: CheckedInputs["checkedModelSelection"];
  checkedTaskModelSwitch: CheckedInputs["checkedTaskModelSwitch"];
  stagedSkillCleanupsForThread: (threadId: string) => Array<{ botId: string; stagedId: string }>;
  rejectDeletedThreadSkillStages: (cleanups: Array<{ botId: string; stagedId: string }>) => void;
  roomHandoffs: RoomHandoffs;
  cancelTeamSetupResumesForThread: DeferredResumes["cancelTeamSetupResumesForThread"];
  settleDirectFollowup: DelegationWatch["settleDirectFollowup"];
  handoffs: DelegationWatch["handoffs"];
  directTurnGenerationByThread: Map<string, string>;
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, url, auth } = rctx;
    /** scratch for route matches, shared by every `path.match` below */
    let m: RegExpMatchArray | null = null;
    const {
      routines,
      broadcast,
      wireBot,
      wireTask,
      DESKTOP_MANAGED,
      phoneSecretSubmissions,
      checkedModelSelection,
      checkedTaskModelSwitch,
      stagedSkillCleanupsForThread,
      rejectDeletedThreadSkillStages,
      roomHandoffs,
      cancelTeamSetupResumesForThread,
      settleDirectFollowup,
      handoffs,
      directTurnGenerationByThread,
    } = deps;
    // ── tasks: a bot's separate contexts ────────────────────────────────
    // The bot record answers with its messages because switching tasks
    // changes which transcript is live, and a partial patch would leave
    // the client showing the previous task's conversation.
    const botWithThread = (bot: NonNullable<ReturnType<typeof store.bot>>) => ({
      ...wireBot(bot),
      messages: store.messagesFor(bot.threadId),
      activeLeafId: store.activeLeaf(bot.threadId),
      tasks: store.tasks(bot.id).map(wireTask),
    });

    // Folders organize one bot's threads; they never own settings,
    // transcripts or working directories. The project wire names stay stable.
    m = path.match(/^\/api\/bots\/([\w-]+)\/projects\/order$/);
    if (m && method === "PATCH") {
      const bot = store.bot(m[1]);
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "projectIds") ||
        !Array.isArray(body.projectIds) || body.projectIds.some((id: unknown) => typeof id !== "string")) {
        json(res, 400, { error: "projectIds must be an array of folder IDs" });
        return true;
      }
      const projects = store.reorderProjects(bot.id, body.projectIds);
      if (!projects) { json(res, 400, { error: "projectIds must include each of this bot's folders exactly once" }); return true; }
      json(res, 200, { projects, bot: botWithThread(bot) });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/projects(?:\/([\w-]+))?$/);
    if (m && ((method === "POST" && !m[2]) || (method === "PATCH" && m[2]) || (method === "DELETE" && m[2]))) {
      const bot = store.bot(m[1]);
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      if (m[2] && !store.project(bot.id, m[2])) { json(res, 404, { error: "no such folder" }); return true; }
      if (method === "DELETE") {
        const updated = store.deleteProject(bot.id, m[2]!);
        json(res, 200, { bot: botWithThread(updated!) });
        return true;
      }
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) { json(res, 400, { error: "body must be a JSON object" }); return true; }
      if (Object.keys(body).some((key) => key !== "name" && key !== "emoji")) {
        json(res, 400, { error: "unsupported folder setting" });
        return true;
      }
      if ((method === "POST" || body.name !== undefined) &&
        (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80)) {
        json(res, 400, { error: "folder name must be between 1 and 80 characters" });
        return true;
      }
      if (body.emoji !== undefined && body.emoji !== null && !isProjectEmoji(body.emoji)) {
        json(res, 400, { error: "folder emoji must be one emoji, or null to reset it" });
        return true;
      }
      const patch: Parameters<typeof store.patchProject>[2] = {};
      if (body.name !== undefined) patch.name = body.name.trim();
      if (body.emoji !== undefined) patch.emoji = body.emoji;
      const project = method === "POST"
        ? store.createProject(bot.id, patch.name!, patch.emoji)
        : store.patchProject(bot.id, m[2]!, patch);
      json(res, method === "POST" ? 201 : 200, { project, bot: botWithThread(bot) });
      return true;
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const bot = store.bot(m[1]);
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      if (phoneSecretSubmissions.hasBot(bot.id)) {
        json(res, 409, { error: "this bot is securely saving a credential — try again when it finishes" });
        return true;
      }
      if (body.projectId !== undefined && (typeof body.projectId !== "string" || !store.project(bot.id, body.projectId))) {
        json(res, 400, { error: "projectId must belong to this bot" });
        return true;
      }
      const task = store.createTask(bot.id, typeof body.title === "string" ? body.title : undefined, true, body.projectId);
      if (!task) { json(res, 500, { error: "couldn't create that task" }); return true; }
      const fresh = botWithThread(store.bot(bot.id)!);
      broadcast({ kind: "bot", bot: fresh });
      json(res, 201, { bot: fresh, task: wireTask(task) });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks\/([\w-]+)$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      if (phoneSecretSubmissions.hasBot(bot.id)) {
        json(res, 409, { error: "this bot is securely saving a credential — try again when it finishes" });
        return true;
      }
      // Navigation only: execution owns its thread, never this selected id.
      const switched = store.switchTask(bot.id, m[2]);
      if (!switched) { json(res, 404, { error: "no such task" }); return true; }
      const fresh = botWithThread(switched);
      broadcast({ kind: "bot", bot: fresh });
      const responseBot = url.searchParams.get("messages") === "0"
        ? { ...wireBot(switched), tasks: store.tasks(switched.id).map(wireTask) }
        : fresh;
      json(res, 200, { bot: responseBot });
      return true;
    }
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) { json(res, 400, { error: "body must be a JSON object" }); return true; }
      const current = store.projectBotForTask(m[1], m[2]);
      if (!current) { json(res, 404, { error: "no such task" }); return true; }
      const allowed = new Set(["title", "projectId", "modelSelection", "updateBotDefault", "resetApprovalToAsk", "approvalMode", "autoApprove", "requireAvailableModel", "pinnedMessageId", "acknowledgeLocalAuto", "archivedAt", "surface"]);
      if (Object.keys(body).some((key) => !allowed.has(key))) { json(res, 400, { error: "unsupported thread setting" }); return true; }
      for (const key of ["requireAvailableModel", "acknowledgeLocalAuto", "updateBotDefault", "resetApprovalToAsk"] as const) {
        if (body[key] !== undefined && typeof body[key] !== "boolean") { json(res, 400, { error: `${key} must be a boolean` }); return true; }
      }
      if (body.requireAvailableModel === true && body.modelSelection === undefined) { json(res, 400, { error: "requireAvailableModel requires modelSelection" }); return true; }
      if (body.updateBotDefault === true && body.modelSelection === undefined) { json(res, 400, { error: "updateBotDefault requires modelSelection" }); return true; }
      if (body.resetApprovalToAsk === true && (body.modelSelection === undefined ||
        (body.approvalMode !== undefined && body.approvalMode !== "ask") || body.autoApprove === true)) {
        json(res, 400, { error: "resetApprovalToAsk requires a model selection and cannot be combined with another approval mode" });
        return true;
      }
      const patch: Parameters<typeof store.patchTask>[2] = {};
      if (body.projectId !== undefined) {
        if (body.projectId === null) patch.projectId = undefined;
        else if (typeof body.projectId === "string" && store.project(current.id, body.projectId)) patch.projectId = body.projectId;
        else { json(res, 400, { error: "projectId must belong to this bot, or null to ungroup the thread" }); return true; }
      }
      if (body.title !== undefined) {
        if (typeof body.title !== "string") { json(res, 400, { error: "title must be a string" }); return true; }
        patch.title = body.title;
      }
      if (body.archivedAt !== undefined) {
        if (body.archivedAt === null) patch.archivedAt = undefined;
        else if (typeof body.archivedAt === "number" && Number.isFinite(body.archivedAt) && body.archivedAt >= 0) patch.archivedAt = body.archivedAt;
        else { json(res, 400, { error: "archivedAt must be a timestamp, or null to unarchive" }); return true; }
      }
      if (body.surface !== undefined) {
        if (threadBusy(current.id, current.threadId)) { json(res, 409, { error: "Stop this thread before changing its computer destination." }); return true; }
        // Where this conversation works, chosen from the composer. Null follows
        // the bot's Works on again. Reachability is the turn's to judge.
        if (body.surface === null) patch.surface = undefined;
        else if (parseSurface(body.surface)) patch.surface = parseSurface(body.surface);
        else { json(res, 400, { error: "surface must be cloud, vm, local, browser, or null to follow the bot" }); return true; }
      }
      if (body.pinnedMessageId !== undefined) {
        if (body.pinnedMessageId === null || body.pinnedMessageId === "") patch.pinnedMessageId = undefined;
        else if (typeof body.pinnedMessageId === "string" && store.messagesFor(current.threadId).some((message) => message.id === body.pinnedMessageId)) patch.pinnedMessageId = body.pinnedMessageId;
        else { json(res, 400, { error: "pinnedMessageId must belong to this thread" }); return true; }
      }
      if (body.modelSelection !== undefined) {
        if (current.approvalGrant) { json(res, 409, { error: "the bot's approval mode is still being confirmed" }); return true; }
        const checked = checkedModelSelection(body.modelSelection, { selection: current.modelSelection, busy: threadBusy(current.id, current.threadId) }, body.requireAvailableModel === true);
        if (!checked.ok) { json(res, checked.status, { error: checked.error }); return true; }
        patch.modelSelection = checked.selection;
      }
      if (body.approvalMode !== undefined || body.autoApprove !== undefined) {
        if (body.autoApprove !== undefined && typeof body.autoApprove !== "boolean") { json(res, 400, { error: "autoApprove must be a boolean" }); return true; }
        const mode = body.approvalMode ?? (body.autoApprove ? "auto" : "ask");
        // Elevated modes still require the trusted desktop transition. A
        // thread settings PATCH cannot manufacture that grant.
        if (mode !== "ask" && mode !== "auto" && mode !== "edits") { json(res, 403, { error: "Full and Custom access require trusted desktop confirmation" }); return true; }
        if (approvalModeFor(current) === "custom") { json(res, 403, { error: "Leaving Custom approval requires confirmation in the packaged desktop app" }); return true; }
        if (!supportsApprovalMode(registry.cliTarget((patch.modelSelection ?? current.modelSelection).instanceId)?.driverKind, mode)) {
          json(res, 400, { error: "This provider does not support the selected approval level" });
          return true;
        }
        if (threadBusy(current.id, current.threadId)) { json(res, 409, { error: "stop this thread before changing its approval mode" }); return true; }
        if (current.approvalGrant) { json(res, 409, { error: "the bot's approval mode is still being confirmed" }); return true; }
        if (mode === "auto" && approvalModeFor(current) !== "auto" && auth.kind === "loopback" && !DESKTOP_MANAGED && !req.headers.origin && store.bots.some((bot) => bot.busy)) {
          json(res, 409, { error: "Change approval mode from the app or a paired device while bots are working." });
          return true;
        }
        if (mode === "auto" && current.computer === "local" && approvalModeFor(current) !== "auto" && body.acknowledgeLocalAuto !== true) {
          json(res, 400, { error: "Auto mode on this computer requires confirming the warning first (acknowledgeLocalAuto)" });
          return true;
        }
        patch.approvalMode = mode;
        patch.autoApprove = mode === "auto";
      }
      if (patch.modelSelection) {
        const checked = checkedTaskModelSwitch({ ...current,
          ...(patch.approvalMode ? { approvalMode: patch.approvalMode, autoApprove: patch.autoApprove } : {}),
        }, patch.modelSelection, body.updateBotDefault === true, body.resetApprovalToAsk === true, body.requireAvailableModel === true);
        if (!checked.ok) { json(res, checked.status, { error: checked.error }); return true; }
      }
      const task = patch.modelSelection
        ? store.switchTaskModel(m[1], m[2], patch.modelSelection, body.updateBotDefault === true, body.resetApprovalToAsk === true, patch)!
        : store.patchTask(m[1], m[2], patch)!;
      const fresh = botWithThread(store.bot(m[1])!);
      broadcast({ kind: "bot", bot: fresh });
      json(res, 200, { task: wireTask(task), bot: fresh });
      return true;
    }
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot || !store.taskByThread(bot.id, m[2])) {
        json(res, 404, { error: "no such task" });
        return true;
      }
      if (phoneSecretSubmissions.hasThread(m[2])) {
        json(res, 409, { error: "this task is securely saving a credential — try again when it finishes" });
        return true;
      }
      if (threadBusy(bot.id, m[2]) || routines()!.isActiveThread(m[2])) {
        json(res, 409, { error: "this task is running — stop it first" });
        return true;
      }
      const stagedSkillCleanups = stagedSkillCleanupsForThread(m[2]);
      roomHandoffs.cancelDirect(m[2], "The source conversation was deleted");
      cancelTeamSetupResumesForThread(m[2]);
      const updated = store.deleteTask(m[1], m[2]);
      if (!updated) { json(res, 404, { error: "no such task" }); return true; }
      handoffs.forget(m[2]);
      settleDirectFollowup(directTurnGenerationByThread.get(m[2]));
      rejectDeletedThreadSkillStages(stagedSkillCleanups);
      const fresh = botWithThread(updated);
      broadcast({ kind: "bot", bot: fresh });
      json(res, 200, { bot: fresh });
      return true;
    }
    return false;
  };
}
