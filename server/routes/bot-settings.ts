import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode.ts";
import { botAvatarUrlFromStoredPath } from "../../shared/bot-avatar.ts";
import type { CommandAllowlistResponse } from "../../shared/command-allowlist.ts";
import type { WireBot } from "../../shared/wire.ts";
import { deleteAttachment, saveImage } from "../attachments.ts";
import { avatarGenerationRequestSchema, avatarGenerationStateMatches, generateAvatarImage, snapshotAvatarGenerationState } from "../avatar-image.ts";
import { parseBotProfilePatch } from "../bot-profile.ts";
import { commandAllowlistCandidate, type CommandAllowlistStore } from "../command-allowlist.ts";
import type { AppConfig } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import type { createApprovalModeSupport } from "../harness-capabilities.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import type { hostedModelPolicy } from "../hosted-models.ts";
import { profileSnapshot } from "../profile-revision.ts";
import { recordProfileChange } from "../profile-versions.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";
import type { ModelSelectionCheck } from "./bots-create.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { pinnedClientThreadGuard } from "./pinned-client-thread.ts";
import { sawThread } from "../thread-presence.ts";
import { readThreadNotifications } from "./notifications.ts";

export interface BotSettingsRouteDeps {
  store: Store;
  cfg: AppConfig;
  registry: Pick<ProviderRegistry, "get">;
  commandAllowlist: Pick<CommandAllowlistStore, "add" | "remove">;
  commandAllowlistDrivers: ReadonlySet<string>;
  cloudHome: boolean;
  cloudOwnerProfileFields: readonly ("name" | "title" | "description" | "soul" | "notifications")[];
  hostedModels: ReturnType<typeof hostedModelPolicy>;
  supportsApprovalMode: ReturnType<typeof createApprovalModeSupport>;
  directTurnBots: { get(threadId: string): BotRecord | undefined };
  broadcast(payload: Record<string, unknown>): void;
  wireBot(bot: BotRecord): WireBot;
  cloudOwnerSession(auth: RequestAuth): boolean;
  storedAvatarExists(avatarUrl: string): boolean;
  requestedTaskBot(botId: string, rawThreadId: unknown): BotRecord;
  threadBusy(botId: string, threadId: string): boolean;
  activeGroupTurnForBot(botId: string): { group: GroupRecord; threadId: string } | null;
  checkedModelSelection(raw: unknown, current?: { selection: ModelSelection; busy: boolean }, requireAvailableModel?: boolean): ModelSelectionCheck;
  engineSwitchNeedsAsk(mode: ApprovalMode, from: ModelSelection, to: ModelSelection): boolean;
  readCursor(threadId: string): { lastReadMessageId?: string };
  canManageCommandAllowlist(auth: RequestAuth): boolean;
  commandAllowlistResponse(bot: BotRecord): CommandAllowlistResponse;
  cardAnswerRefusal(auth: RequestAuth, threadId: string, requestId: string, behavior: string): string | null;
  /** A person opened this conversation (a Team Cloud's Needs you lines for them there are done). */
  threadRead?(auth: RequestAuth, threadId: string): void;
}

export function createBotSettingsRoutes(deps: BotSettingsRouteDeps): RouteHandler {
  const {
    store, cfg, registry, commandAllowlist,
    commandAllowlistDrivers: COMMAND_ALLOWLIST_DRIVERS, cloudHome: CLOUD_HOME, cloudOwnerProfileFields: CLOUD_OWNER_PROFILE_FIELDS,
    hostedModels, supportsApprovalMode, directTurnBots, broadcast, wireBot, cloudOwnerSession, storedAvatarExists,
    requestedTaskBot, threadBusy, activeGroupTurnForBot, checkedModelSelection, engineSwitchNeedsAsk, readCursor,
    canManageCommandAllowlist, commandAllowlistResponse, cardAnswerRefusal,
  } = deps;
  const pinnedClientThread = pinnedClientThreadGuard(store);
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    let m: RegExpMatchArray | null = null;
    const requirePinnedClientThread = pinnedClientThread(auth, req);
    m = path.match(/^\/api\/bots\/([\w-]+)\/avatar\/generate$/);
    if (m && method === "POST") {
      const existing = store.bot(m[1]);
      if (!existing) return json(res, 404, { error: "no such bot" });
      // Snapshot the fields this request owns before the first await, so a late result cannot win.
      const initialAvatar = snapshotAvatarGenerationState(existing);
      const parsed = avatarGenerationRequestSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: `prompt must be at most 400 characters` });
      }
      const generated = await generateAvatarImage(cfg, existing, parsed.data.prompt);
      const current = store.bot(existing.id);
      if (!current) return json(res, 404, { error: "no such bot" });
      if (!avatarGenerationStateMatches(initialAvatar, current)) {
        return json(res, 409, { error: "avatar changed while generation was in progress" });
      }
      const saved = saveImage(generated.bytes, generated.mime);
      const avatarUrl = botAvatarUrlFromStoredPath(saved.path);
      if (!avatarUrl) throw Object.assign(new Error("Could not store the generated avatar"), { status: 500 });
      const avatarCrop = initialAvatar.avatarCrop && initialAvatar.avatarCrop !== "mascot"
        ? initialAvatar.avatarCrop
        : "circle";
      const bot = store.patchBot(current.id, { avatarUrl, avatarCrop });
      if (!bot) {
        deleteAttachment(saved.path);
        return json(res, 404, { error: "no such bot" });
      }
      const visible = wireBot(bot);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 201, { avatarUrl, bot: visible });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/profile$/);
    if (m && method === "PATCH") {
      const parsed = parseBotProfilePatch(await readBody(req), true);
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      if (parsed.patch.avatarUrl && !storedAvatarExists(parsed.patch.avatarUrl)) {
        return json(res, 400, { error: "avatarUrl must reference an existing stored image" });
      }
      const existingBot = store.bot(m[1]);
      // On a Cloud home these fields ride every owner turn: only the owner's own devices change them.
      if (CLOUD_HOME && existingBot && !cloudOwnerSession(auth)) {
        const changed = CLOUD_OWNER_PROFILE_FIELDS.find((field) => parsed.patch[field] !== undefined && (field === "notifications"
          ? (parsed.patch.notifications !== false) !== (existingBot.notifications !== false)
          : parsed.patch[field] !== (existingBot[field] ?? "")));
        if (changed) return json(res, 403, { error: "On this Cloud only its owner can change a bot's name, title, description, instructions or notifications." });
      }
      const beforeProfile = existingBot ? profileSnapshot(existingBot) : undefined;
      const bot = store.patchBotProfile(m[1], parsed.patch);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (beforeProfile) recordProfileChange(bot.id, "user", "api", beforeProfile, profileSnapshot(bot));
      const visible = wireBot(bot);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/model$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const unsupported = Object.keys(body).find(
          (key) => key !== "instanceId" && key !== "model" && key !== "effort" && key !== "variant",
        );
        if (unsupported) return json(res, 400, { error: `unsupported model field: ${unsupported}` });
      }
      const existing = store.bot(m[1]);
      if (!existing) return json(res, 404, { error: "no such bot" });
      requirePinnedClientThread(existing.id, undefined);
      const selected = requestedTaskBot(existing.id, undefined);
      if (existing.approvalGrant) {
        return json(res, 409, { error: "wait for the approval-level change to finish before changing models" });
      }
      const checked = checkedModelSelection(
        body,
        { selection: selected.modelSelection, busy: threadBusy(selected.id, selected.threadId) },
        true,
      );
      if (!checked.ok) return json(res, checked.status, { error: checked.error });
      if (activeGroupTurnForBot(existing.id)) {
        const groupChecked = checkedModelSelection(checked.selection, { selection: existing.modelSelection, busy: true });
        if (!groupChecked.ok) return json(res, groupChecked.status, { error: groupChecked.error });
      }
      if ([existing, selected].some((owner) => {
        const mode = approvalModeFor(owner);
        return mode === "custom" &&
          (!supportsApprovalMode(checked.selection, mode) || engineSwitchNeedsAsk(mode, owner.modelSelection, checked.selection));
      })) {
        return json(res, 400, {
          error: "Changing providers with elevated permissions requires choosing Ask first",
        });
      }
      const bot = store.patchBot(existing.id, { modelSelection: checked.selection });
      if (!bot) return json(res, 404, { error: "no such bot" });
      store.patchTask(bot.id, selected.threadId, { modelSelection: undefined,
        ...hostedModels?.resetTask(selected.modelSelection, checked.selection) });
      return json(res, 200, { bot: wireBot(bot) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/read$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const current = requestedTaskBot(m[1], body?.threadId);
      sawThread(current.threadId);
      deps.threadRead?.(auth, current.threadId);
      store.patchTask(current.id, current.threadId, { unread: false, ...readCursor(current.threadId) });
      readThreadNotifications(current.threadId, broadcast, auth);
      const bot = store.bot(current.id)!;
      const visible = wireBot(bot);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/command-allowlist(?:\/([\w-]+))?$/);
    if (m && ["GET", "POST", "DELETE"].includes(method)) {
      if (!canManageCommandAllowlist(auth)) return json(res, 403, { error: "Only the owner or an admin can manage command permissions." });
      const bot = requestedTaskBot(m[1], url.searchParams.get("threadId") ?? undefined);
      if (method === "GET" && !m[2]) return json(res, 200, commandAllowlistResponse(bot));
      if (method === "POST" && !m[2]) {
        const candidate = commandAllowlistCandidate(await readBody(req));
        if (!candidate) return json(res, 400, { error: "Enter an exact command without secret values, an absolute working folder, and a provider." });
        const instance = registry.get(candidate.providerInstanceId);
        if (!instance || !COMMAND_ALLOWLIST_DRIVERS.has(instance.driverKind)) {
          return json(res, 400, { error: "This provider does not supply structured command approvals." });
        }
        commandAllowlist.add(bot.id, candidate);
        return json(res, 200, commandAllowlistResponse(bot));
      }
      if (method === "DELETE" && m[2]) {
        commandAllowlist.remove(bot.id, m[2]);
        return json(res, 200, commandAllowlistResponse(bot));
      }
      return json(res, 405, { error: "Unsupported command allowlist operation" });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/always-allow$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const allowKey = typeof body.allowKey === "string" ? body.allowKey : "";
      const bot = requestedTaskBot(m[1], body.threadId);
      if (!allowKey) return json(res, 400, { error: "allowKey required" });
      const pending = store.messagesFor(bot.threadId).find((message) =>
        message.card?.requestId &&
        !message.card.answered &&
        message.card.dismissed !== true &&
        message.card.allowKey === allowKey
      );
      if (!pending) {
        return json(res, 409, { error: "that grant is not on a pending approval for this bot" });
      }
      // A standing grant is an approval: only those who may approve the card may remember it.
      const refusal = cardAnswerRefusal(auth, bot.threadId, pending.card!.requestId!, "allow");
      if (refusal) return json(res, 403, { error: refusal });
      const savedBot = store.bot(bot.id)!;
      store.patchBot(bot.id, {
        alwaysAllow: [...new Set([...(savedBot.alwaysAllow ?? []), allowKey])].slice(0, 200),
      });
      store.patchTask(bot.id, bot.threadId, {
        alwaysAllow: [...new Set([...(bot.alwaysAllow ?? []), allowKey])].slice(0, 200),
      });
      const live = directTurnBots.get(bot.threadId);
      if (live) live.alwaysAllow = [...new Set([...(live.alwaysAllow ?? []), allowKey])].slice(0, 200);
      const updated = store.bot(bot.id)!;
      const visible = wireBot(updated);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    }
    return PASS;
  };
}
