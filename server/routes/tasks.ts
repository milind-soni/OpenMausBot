import { approvalModeFor, approvalModeWidens, isApprovalMode, type ApprovalMode } from "../../shared/approval-mode.ts";
import { threadLinkUrl } from "../../shared/thread-link.ts";
import type { WireBot, WireTask } from "../../shared/wire.ts";
import { validateBotCwd } from "../bot-cwd.ts";
import type { ModelSelection, ProviderInstance } from "../contracts.ts";
import type { Coordinator } from "../coordinator.ts";
import type { Handoffs } from "../delta-context.ts";
import type { hostedModelPolicy } from "../hosted-models.ts";
import type { PhoneSecretSubmissionRegistry } from "../phone-secret.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { RoutineManager } from "../routines.ts";
import type { SkillReview } from "../skill-review.ts";
import { isProjectEmoji, type BotRecord, type Store, type TaskRecord } from "../store.ts";
import { parseSurface } from "../surface.ts";
import type { ThreadStarters } from "../thread-starters.ts";
import { titleConversationExcerpt, type ThreadTitleSource } from "../thread-title.ts";
import type { MessagePage } from "./channels.ts";
import { bulkDeleteThreadIds, type BulkDeleteRefusal } from "./bulk-delete.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { sawThread } from "../thread-presence.ts";
import { readThreadNotifications } from "./notifications.ts";

type HostedModels = NonNullable<ReturnType<typeof hostedModelPolicy>>;

export interface TaskRouteDeps {
  store: Pick<Store,
    | "bot" | "bots" | "taskByThread" | "project" | "projectBotForTask" | "patchTask" | "patchProject" | "tasks"
    | "switchTaskModel" | "switchTask" | "retitleTask" | "reorderProjects" | "refreshTaskPermissions" | "messagesTail"
    | "messagesFor" | "deleteTasks" | "deleteProject" | "createTask" | "createProject">;
  /** On a Cloud home only the owner changes how a bot asks for approval. */
  cloudHome: boolean;
  /** The desktop app owns this server, so a loopback caller is its owner. */
  desktopManaged: boolean;
  /** A shared company workspace: Full access comes only from its operator. */
  hostedWorkspace: boolean;
  hostedFullAccessRefusal: string;
  hostedModels: Pick<HostedModels, "resetTask"> | null;
  routines(): Pick<RoutineManager, "isActiveThread"> | null;
  coordinator: Pick<Coordinator, "cancelDirect">;
  handoffs: Pick<Handoffs, "forget">;
  skillReview: Pick<SkillReview, "dropThread">;
  threadStarters: Pick<ThreadStarters, "set">;
  phoneSecretSubmissions: Pick<PhoneSecretSubmissionRegistry, "hasBot" | "hasThread">;
  titleRegenerations: Pick<Set<string>, "has" | "add" | "delete">;
  directTurnGenerationByThread: ReadonlyMap<string, string>;
  actorKey(auth: RequestAuth & { kind: "session" }): string;
  cloudOwnerSession(auth: RequestAuth): boolean;
  cloudThreadRefusal(auth: RequestAuth, threadId: string): string | null;
  sharedWorkspaceFullAccessEnabled(): boolean;
  supportsApprovalMode(selection: ModelSelection, mode: ApprovalMode): boolean;
  threadBusy(botId: string, threadId: string): boolean;
  broadcast(payload: Record<string, unknown>): void;
  publicBot(bot: BotRecord): WireBot;
  wireBot(bot: BotRecord): WireBot;
  wireTask(task: TaskRecord, botModel: ModelSelection): WireTask;
  pageSize(raw: string | null): number | null | undefined;
  messagePage(threadId: string, limit: number | undefined): MessagePage;
  checkedModelSelection(raw: unknown, current?: { selection: ModelSelection; busy: boolean }, requireAvailableModel?: boolean):
    | { ok: true; selection: ModelSelection }
    | { ok: false; status: number; error: string };
  checkedTaskModelSwitch(current: BotRecord, raw: unknown, updateBotDefault: boolean, resetApprovalToAsk: boolean, requireAvailableModel?: boolean):
    | { ok: true }
    | { ok: false; status: number; error: string };
  threadTitleGate(bot: Pick<BotRecord, "modelSelection">): { ok: true; instance: ProviderInstance } | { ok: false; refusal: string };
  generateThreadTitle(provider: ProviderInstance, text: string, source: ThreadTitleSource): Promise<string | null>;
  settleDirectFollowup(generation: string | undefined): void;
  clearTurnDigestState(threadId: string): void;
  revokeInternalCapabilitiesForThread(threadId: string): void;
  stagedSkillCleanupsForThread(threadId: string): Array<{ botId: string; stagedId: string }>;
  rejectDeletedThreadSkillStages(cleanups: Array<{ botId: string; stagedId: string }>): void;
}

/** `deleteTasks`: the same deletion for the server's own use (a person leaving a Team Cloud, host/team-member-left.ts). */
export function createTaskRoutes(deps: TaskRouteDeps): RouteHandler & { deleteTasks(botId: string, threadIds: string[]): ReturnType<TaskRouteDeps["store"]["deleteTasks"]> } {
  const {
    store, hostedModels, coordinator, handoffs, skillReview, threadStarters, phoneSecretSubmissions, titleRegenerations,
    directTurnGenerationByThread, actorKey, cloudOwnerSession, cloudThreadRefusal, sharedWorkspaceFullAccessEnabled,
    supportsApprovalMode, threadBusy, broadcast, publicBot, wireBot, wireTask, pageSize, messagePage, checkedModelSelection,
    checkedTaskModelSwitch, threadTitleGate, generateThreadTitle, settleDirectFollowup, clearTurnDigestState,
    revokeInternalCapabilitiesForThread, stagedSkillCleanupsForThread, rejectDeletedThreadSkillStages,
  } = deps;
  const CLOUD_HOME = deps.cloudHome;
  const DESKTOP_MANAGED = deps.desktopManaged;
  const HOSTED_WORKSPACE = deps.hostedWorkspace;
  const HOSTED_FULL_ACCESS_REFUSAL = deps.hostedFullAccessRefusal;
  const deleteRefusal = (auth: RequestAuth, botId: string, threadId: string): { status: 403 | 404 | 409; error: string } | null => {
    if (!store.taskByThread(botId, threadId)) return { status: 404, error: "no such task" };
    const notYours = cloudThreadRefusal(auth, threadId);
    if (notYours) return { status: 403, error: notYours };
    if (phoneSecretSubmissions.hasThread(threadId)) {
      return { status: 409, error: "this task is securely saving a credential — try again when it finishes" };
    }
    if (threadBusy(botId, threadId) || deps.routines()!.isActiveThread(threadId)) {
      return { status: 409, error: "this task is running — stop it first" };
    }
    return null;
  };
  const deleteTasks = (botId: string, threadIds: string[]) => {
    const stagedSkillCleanups = new Map(threadIds.map((threadId) => [threadId, stagedSkillCleanupsForThread(threadId)]));
    for (const threadId of threadIds) coordinator.cancelDirect(threadId, "The source conversation was deleted");
    const result = store.deleteTasks(botId, threadIds);
    for (const threadId of result?.deleted ?? []) {
      clearTurnDigestState(threadId);
      skillReview.dropThread(threadId);
      revokeInternalCapabilitiesForThread(threadId);
      handoffs.forget(threadId);
      settleDirectFollowup(directTurnGenerationByThread.get(threadId));
      rejectDeletedThreadSkillStages(stagedSkillCleanups.get(threadId) ?? []);
    }
    return result;
  };
  return Object.assign(async ({ req, res, url, path, method, auth, json, readBody }: Parameters<RouteHandler>[0]) => {
    let m: RegExpMatchArray | null = null;

    m = path.match(/^\/api\/bots\/([\w-]+)\/projects\/order$/);
    if (m && method === "PATCH") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "projectIds") ||
        !Array.isArray(body.projectIds) || body.projectIds.some((id: unknown) => typeof id !== "string")) {
        return json(res, 400, { error: "projectIds must be an array of folder IDs" });
      }
      const projects = store.reorderProjects(bot.id, body.projectIds);
      if (!projects) return json(res, 400, { error: "projectIds must include each of this bot's folders exactly once" });
      return json(res, 200, { projects, bot: publicBot(bot) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/projects(?:\/([\w-]+))?$/);
    if (m && ((method === "POST" && !m[2]) || (method === "PATCH" && m[2]) || (method === "DELETE" && m[2]))) {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (m[2] && !store.project(bot.id, m[2])) return json(res, 404, { error: "no such folder" });
      if (method === "DELETE") {
        const updated = store.deleteProject(bot.id, m[2]!);
        return json(res, 200, { bot: publicBot(updated!) });
      }
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "body must be a JSON object" });
      if (Object.keys(body).some((key) => key !== "name" && key !== "emoji")) {
        return json(res, 400, { error: "unsupported folder setting" });
      }
      if ((method === "POST" || body.name !== undefined) &&
        (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80)) {
        return json(res, 400, { error: "folder name must be between 1 and 80 characters" });
      }
      if (body.emoji !== undefined && body.emoji !== null && !isProjectEmoji(body.emoji)) {
        return json(res, 400, { error: "folder emoji must be one emoji, or null to reset it" });
      }
      const patch: Parameters<typeof store.patchProject>[2] = {};
      if (body.name !== undefined) patch.name = body.name.trim();
      if (body.emoji !== undefined) patch.emoji = body.emoji;
      const project = method === "POST"
        ? store.createProject(bot.id, patch.name!, patch.emoji)
        : store.patchProject(bot.id, m[2]!, patch);
      return json(res, method === "POST" ? 201 : 200, { project, bot: publicBot(bot) });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "body must be a JSON object" });
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      let cwd: string | undefined;
      if (body.cwd !== undefined) {
        if (!auth.scopes.includes("admin")) {
          return json(res, 403, { error: "Choosing a working folder requires the admin scope" });
        }
        const checked = validateBotCwd(body.cwd);
        if (!checked.ok) return json(res, 400, { error: checked.error });
        if (!checked.cwd) return json(res, 400, { error: "Choose an existing working folder, or omit cwd to use the bot's default" });
        cwd = checked.cwd;
      }
      if (body.approvalMode !== undefined && body.approvalMode !== "ask" && body.approvalMode !== "full") {
        return json(res, 400, { error: "new task approvalMode must be ask or full" });
      }
      if (body.approvalMode === "full") {
        if (auth.kind !== "loopback" || !sharedWorkspaceFullAccessEnabled()) {
          return json(res, 403, { error: "New Full tasks require the operator's dedicated shared-workspace policy" });
        }
        if (bot.approvalGrant) return json(res, 409, { error: "the bot's approval mode is still being confirmed" });
      }
      if (phoneSecretSubmissions.hasBot(bot.id)) {
        return json(res, 409, { error: "this bot is securely saving a credential — try again when it finishes" });
      }
      if (body.projectId !== undefined && (typeof body.projectId !== "string" || !store.project(bot.id, body.projectId))) {
        return json(res, 400, { error: "projectId must belong to this bot" });
      }
      const task = store.createTask(bot.id, typeof body.title === "string" ? body.title : undefined, true, body.projectId, undefined, body.approvalMode, undefined, cwd);
      if (!task) return json(res, 500, { error: "couldn't create that task" });
      // Who opened it decides who may answer its cards on a shared workspace.
      if (auth.kind === "session") threadStarters.set(task.threadId, actorKey(auth));
      return json(res, 201, { bot: publicBot(store.bot(bot.id)!), task: wireTask(task, store.bot(bot.id)!.modelSelection) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks\/delete$/);
    if (m && method === "POST") {
      const parsed = bulkDeleteThreadIds(await readBody(req));
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const allowed: string[] = [];
      const refused: BulkDeleteRefusal[] = [];
      for (const threadId of parsed.threadIds) {
        const refusal = deleteRefusal(auth, bot.id, threadId);
        if (!refusal) allowed.push(threadId);
        else refused.push({ threadId, reason: refusal.status === 409 ? "busy" : "not-found" });
      }
      const result = deleteTasks(bot.id, allowed);
      if (!result) return json(res, 404, { error: "no such bot" });
      for (const threadId of result.missing) refused.push({ threadId, reason: "not-found" });
      return json(res, 200, { bot: publicBot(result.bot), deleted: result.deleted, refused });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks\/([\w-]+)$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (phoneSecretSubmissions.hasBot(bot.id)) {
        return json(res, 409, { error: "this bot is securely saving a credential — try again when it finishes" });
      }
      // Navigation only: execution owns its thread, never this selected id.
      const requestedMessages = url.searchParams.get("messages");
      const switchLimit = pageSize(requestedMessages);
      if (switchLimit === null) return json(res, 400, { error: "messages must be a non-negative whole number" });
      const switched = store.switchTask(bot.id, m[2]);
      if (!switched) return json(res, 404, { error: "no such task" });
      sawThread(m[2]);
      readThreadNotifications(m[2], broadcast);
      const wiredSwitch = wireBot(switched);
      const switchedSettings = { ...wiredSwitch, tasks: wiredSwitch.tasks ?? [] };
      // "0": settings only; a positive page: that tail; omitted: the whole thread (search hits can be older than a page).
      const responseBot = requestedMessages === "0"
        ? switchedSettings
        : { ...switchedSettings, ...messagePage(switched.threadId, switchLimit) };
      return json(res, 200, { bot: responseBot });
    }
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "body must be a JSON object" });
      const current = store.projectBotForTask(m[1], m[2]);
      if (!current) return json(res, 404, { error: "no such task" });
      const allowed = new Set(["title", "projectId", "modelSelection", "updateBotDefault", "resetApprovalToAsk", "approvalMode", "autoApprove", "requireAvailableModel", "pinnedMessageId", "acknowledgeLocalAuto", "archivedAt", "pinned", "snoozedUntil", "surface", "refreshPermissions", "link"]);
      if (Object.keys(body).some((key) => !allowed.has(key))) return json(res, 400, { error: "unsupported thread setting" });
      const notYours = cloudThreadRefusal(auth, m[2]);
      if (notYours) return json(res, 403, { error: notYours });
      if (CLOUD_HOME && !cloudOwnerSession(auth) &&
        (body.approvalMode !== undefined || body.autoApprove !== undefined || body.acknowledgeLocalAuto !== undefined || body.updateBotDefault === true || body.refreshPermissions === true)) {
        return json(res, 403, { error: "On this Cloud only its owner can change how a bot asks for approval, or its default model." });
      }
      for (const key of ["requireAvailableModel", "acknowledgeLocalAuto", "updateBotDefault", "resetApprovalToAsk"] as const) {
        if (body[key] !== undefined && typeof body[key] !== "boolean") return json(res, 400, { error: `${key} must be a boolean` });
      }
      if (body.requireAvailableModel === true && body.modelSelection === undefined) return json(res, 400, { error: "requireAvailableModel requires modelSelection" });
      if (body.updateBotDefault === true && body.modelSelection === undefined) return json(res, 400, { error: "updateBotDefault requires modelSelection" });
      if (body.resetApprovalToAsk === true && (body.modelSelection === undefined ||
        (body.approvalMode !== undefined && body.approvalMode !== "ask") || body.autoApprove === true)) {
        return json(res, 400, { error: "resetApprovalToAsk requires a model selection and cannot be combined with another approval mode" });
      }
      if (body.refreshPermissions !== undefined && body.refreshPermissions !== true) {
        return json(res, 400, { error: "refreshPermissions must be true" });
      }
      if (body.refreshPermissions === true) {
        const extra = Object.keys(body).filter((key) => key !== "refreshPermissions" && key !== "acknowledgeLocalAuto");
        if (extra.length) return json(res, 400, { error: "refreshPermissions cannot be combined with other thread settings" });
        const profile = store.bot(m[1]);
        if (!profile) return json(res, 404, { error: "no such bot" });
        if (profile.approvalGrant) return json(res, 409, { error: "the bot's approval mode is still being confirmed" });
        const nextMode = approvalModeFor({ ...profile, approvalGrant: undefined });
        if (nextMode === "custom") {
          return json(res, 403, { error: "Refresh Custom access from the packaged desktop app" });
        }
        if (nextMode === "full" && HOSTED_WORKSPACE && approvalModeFor(current) !== "full") {
          return json(res, 403, { error: HOSTED_FULL_ACCESS_REFUSAL });
        }
        if (approvalModeFor(current) === "custom") {
          return json(res, 403, { error: "Leaving Custom approval requires the packaged desktop app" });
        }
        if (!supportsApprovalMode(current.modelSelection, nextMode)) {
          return json(res, 400, { error: "This provider does not support the selected approval level" });
        }
        if (nextMode === "auto" && current.computer === "local" && approvalModeFor(current) !== "auto" && body.acknowledgeLocalAuto !== true) {
          return json(res, 400, { error: "Auto mode on this computer requires confirming the warning first (acknowledgeLocalAuto)" });
        }
        const widensMode = approvalModeWidens(approvalModeFor(current), nextMode);
        const nextAllow = profile.alwaysAllow ?? [];
        const widensAllow = nextAllow.some((key) => !(current.alwaysAllow ?? []).includes(key));
        if (nextMode !== "full" && (widensMode || widensAllow) && auth.kind === "loopback" && !DESKTOP_MANAGED && !req.headers.origin && store.bots.some((bot) => bot.busy)) {
          return json(res, 409, { error: "Change approval mode from the app or a paired device while bots are working." });
        }
        const task = store.refreshTaskPermissions(profile.id, m[2]);
        if (!task) return json(res, 404, { error: "no such task" });
        return json(res, 200, { task: wireTask(task, store.bot(profile.id)!.modelSelection), bot: publicBot(store.bot(profile.id)!) });
      }
      const patch: Parameters<typeof store.patchTask>[2] = {};
      if (body.projectId !== undefined) {
        if (body.projectId === null) patch.projectId = undefined;
        else if (typeof body.projectId === "string" && store.project(current.id, body.projectId)) patch.projectId = body.projectId;
        else return json(res, 400, { error: "projectId must belong to this bot, or null to ungroup the thread" });
      }
      if (body.title !== undefined) {
        if (typeof body.title !== "string") return json(res, 400, { error: "title must be a string" });
        patch.title = body.title;
      }
      if (body.archivedAt !== undefined) {
        if (body.archivedAt === null) patch.archivedAt = undefined;
        else if (typeof body.archivedAt === "number" && Number.isFinite(body.archivedAt) && body.archivedAt >= 0) patch.archivedAt = body.archivedAt;
        else return json(res, 400, { error: "archivedAt must be a timestamp, or null to unarchive" });
      }
      if (body.pinned !== undefined) {
        if (typeof body.pinned !== "boolean") return json(res, 400, { error: "pinned must be a boolean" });
        patch.pinned = body.pinned ? true : undefined;
      }
      if (body.snoozedUntil !== undefined) {
        if (body.snoozedUntil === null) patch.snoozedUntil = undefined;
        else if (typeof body.snoozedUntil === "number" && Number.isFinite(body.snoozedUntil) && body.snoozedUntil >= 0) patch.snoozedUntil = body.snoozedUntil;
        else return json(res, 400, { error: "snoozedUntil must be a timestamp, 0 to snooze until activity, or null to wake now" });
      }
      if (body.link !== undefined) {
        const link = body.link === null ? undefined : threadLinkUrl(body.link);
        if (link === null) return json(res, 400, { error: "link must be an http(s) address of at most 2048 characters, or null to remove it" });
        patch.link = link;
        patch.linkAuto = link ? undefined : false;
      }
      if (body.surface !== undefined) {
        if (threadBusy(current.id, current.threadId)) return json(res, 409, { error: "Stop this thread before changing its computer destination." });
        if (body.surface === null) {
          patch.surface = undefined;
          patch.surfaceSource = undefined;
        } else if (parseSurface(body.surface)) {
          patch.surface = parseSurface(body.surface);
          patch.surfaceSource = "user";
        } else return json(res, 400, { error: "surface must be cloud, vm, local, browser, or null to follow the bot" });
      }
      if (body.pinnedMessageId !== undefined) {
        if (body.pinnedMessageId === null || body.pinnedMessageId === "") patch.pinnedMessageId = undefined;
        else if (typeof body.pinnedMessageId === "string" && store.messagesFor(current.threadId).some((message) => message.id === body.pinnedMessageId)) patch.pinnedMessageId = body.pinnedMessageId;
        else return json(res, 400, { error: "pinnedMessageId must belong to this thread" });
      }
      if (body.modelSelection !== undefined) {
        if (current.approvalGrant) return json(res, 409, { error: "the bot's approval mode is still being confirmed" });
        const checked = checkedModelSelection(body.modelSelection, { selection: current.modelSelection, busy: threadBusy(current.id, current.threadId) }, body.requireAvailableModel === true);
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
        patch.modelSelection = checked.selection;
      }
      if (body.approvalMode !== undefined || body.autoApprove !== undefined) {
        if (body.autoApprove !== undefined && typeof body.autoApprove !== "boolean") return json(res, 400, { error: "autoApprove must be a boolean" });
        const mode: unknown = body.approvalMode ?? (body.autoApprove ? "auto" : "ask");
        if (!isApprovalMode(mode)) return json(res, 400, { error: "approvalMode must be ask, edits, auto, full, or custom" });
        if (mode === "custom") return json(res, 403, { error: "Custom access requires trusted desktop confirmation" });
        if (mode === "full" && HOSTED_WORKSPACE && approvalModeFor(current) !== "full") return json(res, 403, { error: HOSTED_FULL_ACCESS_REFUSAL });
        if (approvalModeFor(current) === "custom") return json(res, 403, { error: "Leaving Custom approval requires confirmation in the packaged desktop app" });
        if (!supportsApprovalMode(patch.modelSelection ?? current.modelSelection, mode)) {
          return json(res, 400, { error: "This provider does not support the selected approval level" });
        }
        if (current.approvalGrant) return json(res, 409, { error: "the bot's approval mode is still being confirmed" });
        if (mode === "auto" && approvalModeFor(current) !== "auto" && auth.kind === "loopback" && !DESKTOP_MANAGED && !req.headers.origin && store.bots.some((bot) => bot.busy)) {
          return json(res, 409, { error: "Change approval mode from the app or a paired device while bots are working." });
        }
        if (mode === "auto" && current.computer === "local" && approvalModeFor(current) !== "auto" && body.acknowledgeLocalAuto !== true) {
          return json(res, 400, { error: "Auto mode on this computer requires confirming the warning first (acknowledgeLocalAuto)" });
        }
        patch.approvalMode = mode;
        patch.autoApprove = mode === "auto";
      }
      if (patch.modelSelection) {
        const checked = checkedTaskModelSwitch({ ...current,
          ...(patch.approvalMode ? { approvalMode: patch.approvalMode, autoApprove: patch.autoApprove } : {}),
        }, patch.modelSelection, body.updateBotDefault === true, body.resetApprovalToAsk === true, body.requireAvailableModel === true);
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
      }
      const task = patch.modelSelection
        ? store.switchTaskModel(m[1], m[2], patch.modelSelection, body.updateBotDefault === true, body.resetApprovalToAsk === true,
          { ...patch, ...hostedModels?.resetTask(current.modelSelection, patch.modelSelection) })!
        : store.patchTask(m[1], m[2], patch)!;
      return json(res, 200, { task: wireTask(task, store.bot(m[1])!.modelSelection), bot: publicBot(store.bot(m[1])!) });
    }
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such task" });
      const refusal = deleteRefusal(auth, bot.id, m[2]);
      if (refusal) return json(res, refusal.status, { error: refusal.error });
      const updated = deleteTasks(bot.id, [m[2]]);
      if (!updated?.deleted.length) return json(res, 404, { error: "no such task" });
      return json(res, 200, { bot: publicBot(updated.bot) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks\/([\w-]+)\/title$/);
    if (m && method === "POST") {
      const current = store.projectBotForTask(m[1], m[2]);
      if (!current) return json(res, 404, { error: "no such task" });
      const notYours = cloudThreadRefusal(auth, m[2]);
      if (notYours) return json(res, 403, { error: notYours });
      const gate = threadTitleGate(current);
      if (!gate.ok) return json(res, 409, { error: gate.refusal });
      if (titleRegenerations.has(m[2])) return json(res, 409, { error: "a new title is already being generated for this thread" });
      const excerpt = titleConversationExcerpt(store.messagesTail(m[2], 200).messages);
      if (!excerpt) return json(res, 409, { error: "this thread has no messages to take a title from yet" });
      const startedFrom = store.taskByThread(m[1], m[2])!.title;
      titleRegenerations.add(m[2]);
      try {
        const title = await generateThreadTitle(gate.instance, excerpt, "conversation");
        if (!title) return json(res, 502, { error: "couldn't generate a title — try again, or rename the thread" });
        const task = store.retitleTask(m[1], m[2], startedFrom, title) ?? store.taskByThread(m[1], m[2]);
        if (!task) return json(res, 404, { error: "no such task" });
        return json(res, 200, { task: wireTask(task, store.bot(m[1])!.modelSelection) });
      } finally {
        titleRegenerations.delete(m[2]);
      }
    }
    return PASS;
  }, { deleteTasks });
}
