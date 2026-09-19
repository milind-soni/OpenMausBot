// The bot-management HTTP routes (bot creation, avatar generation,
// profile patch, per-thread model patch, read marker, always-allow
// grant, and the general bot-settings PATCH), extracted verbatim from
// index.ts's dispatch chain. Path matching, methods, and status codes
// are unchanged; the handler returns false for anything it does not
// own so the chain falls through in the same order. The bot views,
// checked model selection, group-turn admission, browser runtime
// handles, session registry, and broadcast are index-local and cross
// via deps; routines is a late-bound thunk over index.ts's let;
// store/cfg/registry are live bindings from ../runtime.ts;
// requirePinnedClientThread is rebuilt per request from ./messages.ts
// with the same (auth, req) pair index.ts passed it. Bot deletion
// (DELETE /api/bots/:id) stays in index.ts: that handler sits after
// the local-computer interrupt family and re-matches the path itself.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import { createRequirePinnedClientThread } from "./messages.ts";
import type { createEventsRoutes } from "./events.ts";
import { z } from "zod";
import { cfg, defaultSelection, registry, store } from "../runtime.ts";
import { validateBotCwd } from "../bot-cwd.ts";
import { parseBotProfilePatch } from "../bot-profile.ts";
import { deleteAttachment, saveImage } from "../attachments.ts";
import {
  avatarGenerationRequestSchema,
  avatarGenerationStateMatches,
  generateAvatarImage,
  snapshotAvatarGenerationState,
} from "../avatar-image.ts";
import { botAvatarUrlFromStoredPath } from "../../shared/bot-avatar.ts";
import {
  approvalModeFor,
  supportsApprovalMode,
  isApprovalMode,
  type ApprovalMode,
} from "../../shared/approval-mode.ts";
import { MAX_MCP_SERVERS, mcpServerNameError } from "../mcp-registry.ts";
import { sectionKey, type BotRecord } from "../store.ts";
import { cloudBackendChangeError } from "../cloud-backend.ts";
import { profileSnapshot } from "../profile-revision.ts";
import { recordProfileChange } from "../profile-versions.ts";
import { closeOpenApprovals } from "../turn-fold.ts";
import { revokeInternalCapabilitiesForThread } from "../internal-capabilities.ts";
import { directTurnBots, requestedTaskBot, threadBusy } from "../turn-admission.ts";
import { clientBotPatchViolation, requestSource } from "../request-auth.ts";
import type { ModelSelection } from "../contracts.ts";
import type { RoutineManager } from "../routines.ts";
import type { createBotViews } from "../bot-views.ts";
import type { createCheckedInputs } from "../checked-inputs.ts";
import type { createComputerLifecycle } from "../computer-lifecycle.ts";
import type { createGroupTurnOperations } from "../group-turn-operations.ts";
import type { createTurnIntegrations } from "../turn-integrations.ts";
import type { SessionRegistry } from "../sessions.ts";

type BotViews = ReturnType<typeof createBotViews>;
type CheckedInputs = ReturnType<typeof createCheckedInputs>;
type ComputerLifecycle = ReturnType<typeof createComputerLifecycle>;
type GroupTurnOperations = ReturnType<typeof createGroupTurnOperations>;
type TurnIntegrations = ReturnType<typeof createTurnIntegrations>;

export function createBotManagementRoutes(deps: {
  routines: () => RoutineManager | null;
  broadcast: ReturnType<typeof createEventsRoutes>["broadcast"];
  wireBot: BotViews["wireBot"];
  storedAvatarExists: BotViews["storedAvatarExists"];
  checkedModelSelection: CheckedInputs["checkedModelSelection"];
  activeGroupTurnForBot: GroupTurnOperations["activeGroupTurnForBot"];
  cancelGroupTurnOperations: GroupTurnOperations["cancelGroupTurnOperations"];
  sessions: SessionRegistry;
  DESKTOP_MANAGED: boolean;
  MAX_WORKSPACE_BOTS: number;
  interruptAllDirectThreads: (botId: string) => Promise<void>;
  runningTurnInstance: ComputerLifecycle["runningTurnInstance"];
  assertTeamComputerChangeIdle: ComputerLifecycle["assertTeamComputerChangeIdle"];
  activeVpsThreads: ComputerLifecycle["activeVpsThreads"];
  browserRuntime: TurnIntegrations["browserRuntime"];
  browserLive: TurnIntegrations["browserLive"];
  currentBrowserSession: TurnIntegrations["currentBrowserSession"];
  forgetTemporaryBrowser: TurnIntegrations["forgetTemporaryBrowser"];
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, auth } = rctx;
    /** scratch for route matches, shared by every `path.match` below */
    let m: RegExpMatchArray | null = null;
    const {
      routines,
      broadcast,
      wireBot,
      storedAvatarExists,
      checkedModelSelection,
      activeGroupTurnForBot,
      cancelGroupTurnOperations,
      sessions,
      DESKTOP_MANAGED,
      MAX_WORKSPACE_BOTS,
      interruptAllDirectThreads,
      runningTurnInstance,
      assertTeamComputerChangeIdle,
      activeVpsThreads,
      browserRuntime,
      browserLive,
      currentBrowserSession,
      forgetTemporaryBrowser,
    } = deps;
    const requirePinnedClientThread = createRequirePinnedClientThread(auth, req);
    if (method === "POST" && path === "/api/bots") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        json(res, 400, { error: "bot must be a JSON object" });
        return true;
      }
      if (body.requireAvailableModel !== undefined && typeof body.requireAvailableModel !== "boolean") {
        json(res, 400, { error: "requireAvailableModel must be true or false" });
        return true;
      }
      if (body.requireAvailableModel === true && body.modelSelection === undefined) {
        json(res, 400, { error: "requireAvailableModel requires modelSelection" });
        return true;
      }
      const profileInput = Object.fromEntries(
        ["name", "title", "description"]
          .filter((key) => body[key] !== undefined)
          .map((key) => [key, body[key]]),
      );
      const profile = parseBotProfilePatch(profileInput, true);
      if (!profile.ok) {
        json(res, 400, { error: profile.error });
        return true;
      }
      let section: string | undefined;
      if (body.section !== undefined && body.section !== null) {
        if (typeof body.section !== "string") {
          json(res, 400, { error: "section must be a string" });
          return true;
        }
        section = body.section.trim() || undefined;
        if (section && section.length > 60) {
          json(res, 400, { error: "section must be at most 60 characters" });
          return true;
        }
      }
      let selection: ModelSelection;
      if (body.modelSelection === undefined) {
        selection = await defaultSelection();
      } else {
        const checked = checkedModelSelection(body.modelSelection, undefined, body.requireAvailableModel === true);
        if (!checked.ok) {
          json(res, checked.status, { error: checked.error });
          return true;
        }
        selection = checked.selection;
      }
      // Keep the capacity check immediately beside the synchronous write.
      // Awaiting provider discovery before this point cannot race the cap.
      if (store.bots.length >= MAX_WORKSPACE_BOTS) {
        json(res, 409, { error: `this workspace is limited to ${MAX_WORKSPACE_BOTS} bots` });
        return true;
      }
      const bot = store.createBot({ ...profile.patch, section, modelSelection: selection });
      json(res, 201, {
        bot: {
          ...wireBot(bot),
          messages: store.messagesFor(bot.threadId),
          activeLeafId: store.activeLeaf(bot.threadId),
        },
      });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/avatar\/generate$/);
    if (m && method === "POST") {
      const existing = store.bot(m[1]);
      if (!existing) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      // Generation is slow and both desktop and companion clients may edit or
      // delete this bot while it is in flight. Snapshot the two fields this
      // request owns before the first await so a late result cannot win.
      const initialAvatar = snapshotAvatarGenerationState(existing);
      const parsed = avatarGenerationRequestSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        json(res, 400, { error: `prompt must be at most 400 characters` });
        return true;
      }
      const generated = await generateAvatarImage(cfg, existing, parsed.data.prompt);
      const current = store.bot(existing.id);
      if (!current) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      if (!avatarGenerationStateMatches(initialAvatar, current)) {
        json(res, 409, { error: "avatar changed while generation was in progress" });
        return true;
      }
      const saved = saveImage(generated.bytes, generated.mime);
      const avatarUrl = botAvatarUrlFromStoredPath(saved.path);
      if (!avatarUrl) throw Object.assign(new Error("Could not store the generated avatar"), { status: 500 });
      const avatarCrop = initialAvatar.avatarCrop && initialAvatar.avatarCrop !== "mascot"
        ? initialAvatar.avatarCrop
        : "circle";
      const bot = store.patchBot(current.id, { avatarUrl, avatarCrop });
      if (!bot) {
        // There are no awaits between the refreshed lookup and this patch, but
        // keep the attachment invariant explicit if the store ever changes.
        deleteAttachment(saved.path);
        json(res, 404, { error: "no such bot" });
        return true;
      }
      const visible = wireBot(bot);
      broadcast({ kind: "bot", bot: visible });
      json(res, 201, { avatarUrl, bot: visible });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/profile$/);
    if (m && method === "PATCH") {
      const parsed = parseBotProfilePatch(await readBody(req), true);
      if (!parsed.ok) {
        json(res, 400, { error: parsed.error });
        return true;
      }
      if (parsed.patch.avatarUrl && !storedAvatarExists(parsed.patch.avatarUrl)) {
        json(res, 400, { error: "avatarUrl must reference an existing stored image" });
        return true;
      }
      const existingBot = store.bot(m[1]);
      const beforeProfile = existingBot ? profileSnapshot(existingBot) : undefined;
      const bot = store.patchBotProfile(m[1], parsed.patch);
      if (!bot) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      if (beforeProfile) recordProfileChange(bot.id, "user", "api", beforeProfile, profileSnapshot(bot));
      const visible = wireBot(bot);
      broadcast({ kind: "bot", bot: visible });
      json(res, 200, { bot: visible });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/model$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const unsupported = Object.keys(body).find(
          (key) => key !== "instanceId" && key !== "model" && key !== "effort" && key !== "variant",
        );
        if (unsupported) {
          json(res, 400, { error: `unsupported model field: ${unsupported}` });
          return true;
        }
      }
      const existing = store.bot(m[1]);
      if (!existing) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      requirePinnedClientThread(existing.id, undefined);
      const selected = requestedTaskBot(existing.id, undefined);
      if (existing.approvalGrant) {
        json(res, 409, { error: "wait for the approval-level change to finish before changing models" });
        return true;
      }
      const checked = checkedModelSelection(
        body,
        { selection: selected.modelSelection, busy: threadBusy(selected.id, selected.threadId) },
        true,
      );
      if (!checked.ok) {
        json(res, checked.status, { error: checked.error });
        return true;
      }
      if (activeGroupTurnForBot(existing.id)) {
        const groupChecked = checkedModelSelection(checked.selection, { selection: existing.modelSelection, busy: true });
        if (!groupChecked.ok) {
          json(res, groupChecked.status, { error: groupChecked.error });
          return true;
        }
      }
      if ([existing, selected].some((owner) => {
        const mode = approvalModeFor(owner);
        return (mode === "full" || mode === "custom") &&
          (!supportsApprovalMode(registry.cliTarget(checked.selection.instanceId)?.driverKind, mode) ||
            registry.cliTarget(checked.selection.instanceId)?.driverKind !== registry.cliTarget(owner.modelSelection.instanceId)?.driverKind);
      })) {
        json(res, 400, {
          error: "Changing providers with elevated permissions requires choosing Ask first",
        });
        return true;
      }
      // patchBot persists first and emits the canonical bot change, which the
      // store listener above turns into the slim wire-format SSE broadcast.
      const bot = store.patchBot(existing.id, { modelSelection: checked.selection });
      if (!bot) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      store.patchTask(bot.id, selected.threadId, { modelSelection: checked.selection });
      json(res, 200, { bot: wireBot(bot) });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/read$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const current = requestedTaskBot(m[1], body?.threadId);
      store.patchTask(current.id, current.threadId, { unread: false });
      const bot = store.bot(current.id)!;
      const visible = wireBot(bot);
      broadcast({ kind: "bot", bot: visible });
      json(res, 200, { bot: visible });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/always-allow$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const allowKey = typeof body.allowKey === "string" ? body.allowKey : "";
      const bot = requestedTaskBot(m[1], body.threadId);
      if (!allowKey) {
        json(res, 400, { error: "allowKey required" });
        return true;
      }
      const pending = store.messagesFor(bot.threadId).some((message) =>
        message.card?.requestId &&
        !message.card.answered &&
        message.card.dismissed !== true &&
        message.card.allowKey === allowKey
      );
      if (!pending) {
        json(res, 409, { error: "that grant is not on a pending approval for this bot" });
        return true;
      }
      store.patchTask(bot.id, bot.threadId, {
        alwaysAllow: [...new Set([...(bot.alwaysAllow ?? []), allowKey])].slice(0, 200),
      });
      const live = directTurnBots.get(bot.threadId);
      if (live) live.alwaysAllow = [...new Set([...(live.alwaysAllow ?? []), allowKey])].slice(0, 200);
      const updated = store.bot(bot.id)!;
      const visible = wireBot(updated);
      broadcast({ kind: "bot", bot: visible });
      json(res, 200, { bot: visible });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        json(res, 400, { error: "body must be a JSON object" });
        return true;
      }
      if (auth.kind === "session" && !auth.scopes.includes("admin")) {
        const field = clientBotPatchViolation(body);
        if (field) {
          json(res, 403, { error: `forbidden: this session may change how a bot looks, not "${field}" (needs the admin scope)` });
          return true;
        }
      }
      const existingBot = store.bot(m[1]);
      const selectedTask = existingBot ? requestedTaskBot(existingBot.id, undefined) : null;
      const beforeProfile = existingBot ? profileSnapshot(existingBot) : undefined;
      if (body.requireAvailableModel !== undefined && typeof body.requireAvailableModel !== "boolean") {
        json(res, 400, { error: "requireAvailableModel must be true or false" });
        return true;
      }
      const beforeBrowserProfile = existingBot?.browserProfile;
      const beforeBrowserEnabled = existingBot?.browser;
      // Neither Codex (free-form string field) nor Grok (lazy, logs-only)
      // rejects an unknown effort level at their own boundary — this is the
      // only real gate, so it stays. But it fires only when the target
      // instance actually resolves. An instance that isn't there declares no
      // levels, and rejecting against that empty list would 400 the *whole*
      // request: this is the app's general-purpose bot endpoint, and
      // duplicateBot re-sends the source bot's entire modelSelection beside
      // its name, title and description, so a source engine that happens to
      // be offline would cost the copy all of them. Letting it through is
      // safe — startTurn refuses to run a turn on an unavailable instance
      // anyway, so an unverifiable level never reaches a CLI.
      const rawSelection = (body as Record<string, unknown>).modelSelection;
      if (rawSelection !== undefined) requirePinnedClientThread(m[1], undefined);
      if (
        existingBot?.approvalGrant &&
        (rawSelection !== undefined || body.approvalMode !== undefined || body.autoApprove !== undefined)
      ) {
        json(res, 409, { error: "wait for the approval-level change to finish before changing this setting" });
        return true;
      }
      if (body.requireAvailableModel === true && rawSelection === undefined) {
        json(res, 400, { error: "requireAvailableModel requires modelSelection" });
        return true;
      }
      let normalizedSelection: ModelSelection | undefined;
      if (rawSelection !== undefined) {
        const checked = checkedModelSelection(
          rawSelection,
          selectedTask ? { selection: selectedTask.modelSelection, busy: threadBusy(selectedTask.id, selectedTask.threadId) } : undefined,
          body.requireAvailableModel === true,
        );
        if (!checked.ok) {
          json(res, checked.status, { error: checked.error });
          return true;
        }
        normalizedSelection = checked.selection;
        if (existingBot && activeGroupTurnForBot(existingBot.id)) {
          const groupChecked = checkedModelSelection(normalizedSelection, { selection: existingBot.modelSelection, busy: true });
          if (!groupChecked.ok) {
            json(res, groupChecked.status, { error: groupChecked.error });
            return true;
          }
        }
      }
      // Persona/profile fields reach prompts and paired clients. Both this
      // broad desktop endpoint and the paired-safe profile endpoint pass
      // through the same validation and clear-value normalization.
      const profile = parseBotProfilePatch(body);
      if (!profile.ok) {
        json(res, 400, { error: profile.error });
        return true;
      }
      if (profile.patch.avatarUrl && !storedAvatarExists(profile.patch.avatarUrl)) {
        json(res, 400, { error: "avatarUrl must reference an existing stored image" });
        return true;
      }
      const patch: Record<string, unknown> = {};
      Object.assign(patch, profile.patch);
      let section: string | undefined | null;
      if (body.section !== undefined) {
        if (body.section === null) section = null;
        else if (typeof body.section !== "string") {
          json(res, 400, { error: "section must be a string" });
          return true;
        }
        else {
          const trimmed = body.section.trim();
          if (!trimmed) section = null;
          else if (trimmed.length > 60) {
            json(res, 400, { error: "section must be at most 60 characters" });
            return true;
          }
          else section = trimmed;
        }
      }
      for (const key of ["unread", "cloudBackend", "color", "mascotExpression", "mascotBody", "pinned", "hidden"] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      const computerSpecified = Object.prototype.hasOwnProperty.call(body, "computer");
      let requestedComputer = existingBot?.computer;
      if (computerSpecified) {
        if (body.computer === null) {
          // Auto is represented by an absent durable field. JSON needs a
          // concrete clear value, so clients send null at the PATCH boundary.
          requestedComputer = undefined;
          patch.computer = undefined;
        } else if (
          typeof body.computer === "string" &&
          ["cloud", "vm", "local", "browser", "off"].includes(body.computer)
        ) {
          requestedComputer = body.computer;
          patch.computer = body.computer;
        } else {
          json(res, 400, { error: "computer must be null (Auto), cloud, vm, local, browser, or off" });
          return true;
        }
      }
      if (normalizedSelection) patch.modelSelection = normalizedSelection;
      // one pinned message per thread; null/"" clears. The id is not
      // validated against the transcript here — a pin whose message was
      // edited to another branch or deleted simply resolves to nothing.
      if (body.pinnedMessageId !== undefined) {
        if (body.pinnedMessageId === null || body.pinnedMessageId === "") patch.pinnedMessageId = undefined;
        else if (typeof body.pinnedMessageId === "string" && /^[\w-]+$/.test(body.pinnedMessageId)) {
          patch.pinnedMessageId = body.pinnedMessageId;
        } else {
          json(res, 400, { error: "pinnedMessageId must be a message id" });
          return true;
        }
      }
      if (section !== undefined) patch.section = section ?? undefined;
      if (body.chiefOfStaff === false) patch.chiefOfStaff = false;
      // per-bot gate on the workspace's connected apps (Composio)
      if (body.composio !== undefined) {
        if (typeof body.composio !== "boolean") {
          json(res, 400, { error: "composio must be true or false" });
          return true;
        }
        patch.composio = body.composio;
      }
      // Queue this bot's direct messages behind outstanding delegated work
      // instead of steering the conversation immediately (#1194).
      if (body.parkDirectMessages !== undefined) {
        if (typeof body.parkDirectMessages !== "boolean") {
          json(res, 400, { error: "parkDirectMessages must be true or false" });
          return true;
        }
        patch.parkDirectMessages = body.parkDirectMessages;
      }
      // Per-bot selection of app-wide MCP servers. Omitted keeps the current
      // selection; null restores all enabled servers; [] explicitly mounts none.
      let requestedMcpServers = existingBot?.mcpServers;
      if (body.mcpServers !== undefined) {
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
          json(res, 401, { error: "unauthorized: this session has expired or was revoked" });
          return true;
        }
        if (body.mcpServers === null) {
          requestedMcpServers = undefined;
        } else if (!Array.isArray(body.mcpServers) || body.mcpServers.some((t: unknown) => typeof t !== "string" || mcpServerNameError(t) !== null)) {
          json(res, 400, { error: "mcpServers must be a list of server names, or null" });
          return true;
        } else {
          requestedMcpServers = [...new Set(body.mcpServers as string[])];
          if (requestedMcpServers.length > MAX_MCP_SERVERS) {
            json(res, 400, { error: `Select at most ${MAX_MCP_SERVERS} MCP servers.` });
            return true;
          }
        }
        patch.mcpServers = requestedMcpServers;
      }
      // per-bot gate on the app's built-in browser
      if (body.browser !== undefined) {
        if (typeof body.browser !== "boolean") {
          json(res, 400, { error: "browser must be true or false" });
          return true;
        }
        if (existingBot?.busy && body.browser !== (existingBot.browser !== false)) {
          json(res, 409, { error: "stop this bot's turn before changing its browser access" });
          return true;
        }
        patch.browser = body.browser;
      }
      // which named browser session this bot uses; null/"" = its own
      if (body.browserProfile !== undefined) {
        const requestedProfile = body.browserProfile === null || body.browserProfile === ""
          ? undefined
          : body.browserProfile;
        if (existingBot?.busy && requestedProfile !== existingBot.browserProfile) {
          json(res, 409, { error: "stop this bot's turn before changing its browser profile" });
          return true;
        }
        if (existingBot && requestedProfile !== existingBot.browserProfile &&
            browserRuntime.heldBy(currentBrowserSession(existingBot.id, existingBot.browserProfile))) {
          json(res, 409, { error: "Release browser control before changing its profile." });
          return true;
        }
        if (requestedProfile === undefined) patch.browserProfile = undefined;
        else if (
          typeof requestedProfile === "string" &&
          (requestedProfile === "guest" || (cfg.browserProfiles ?? []).some((profile) => profile.id === requestedProfile))
        ) {
          patch.browserProfile = requestedProfile;
        } else {
          json(res, 400, { error: "browserProfile must name an existing browser profile" });
          return true;
        }
      }
      if (body.cloudBackend !== undefined && !["box", "vps"].includes(String(body.cloudBackend))) {
        json(res, 400, { error: "cloudBackend must be box or vps" });
        return true;
      }
      if (body.autoStartVps !== undefined) {
        if (typeof body.autoStartVps !== "boolean") {
          json(res, 400, { error: "autoStartVps must be true or false" });
          return true;
        }
        patch.autoStartVps = body.autoStartVps;
      }
      if (body.chiefOfStaff !== undefined && typeof body.chiefOfStaff !== "boolean") {
        json(res, 400, { error: "chiefOfStaff must be true or false" });
        return true;
      }
      if (body.cloudBackend !== undefined) {
        const backendError = cloudBackendChangeError(Boolean(existingBot?.busy), activeVpsThreads.has(m[1]));
        if (backendError) {
          json(res, 409, { error: backendError });
          return true;
        }
      }
      if (body.cwd !== undefined) {
        const checked = validateBotCwd(body.cwd);
        if (!checked.ok) {
          json(res, 400, { error: checked.error });
          return true;
        }
        patch.cwd = checked.cwd ?? undefined;
      }
      if (body.hidden === true && existingBot?.chiefOfStaff && body.chiefOfStaff !== false) {
        json(res, 400, { error: "choose another Chief of Staff before hiding this bot" });
        return true;
      }
      // the permission fields decide what runs unattended, so they are
      // type-checked rather than copied through: a string alwaysAllow would
      // still answer .includes() — with substring matches, not tool names
      if (body.autoApprove !== undefined) {
        if (typeof body.autoApprove !== "boolean") {
          json(res, 400, { error: "autoApprove must be true or false" });
          return true;
        }
      }
      let requestedApprovalMode: ApprovalMode;
      if (body.approvalMode !== undefined) {
        if (!isApprovalMode(body.approvalMode)) {
          json(res, 400, {
            error: "approvalMode must be ask, auto, full, or custom",
          });
          return true;
        }
        requestedApprovalMode = body.approvalMode;
      } else if (body.autoApprove !== undefined) {
        // Compatibility for desktop/mobile builds that predate the four-level
        // selector. Their boolean can choose only safe Auto or Ask; it can
        // never silently create Full access.
        requestedApprovalMode = body.autoApprove ? "auto" : "ask";
      } else {
        requestedApprovalMode = approvalModeFor(existingBot ?? {});
      }
      const currentApprovalMode = approvalModeFor(existingBot ?? {});
      const approvalChangeRequested = body.approvalMode !== undefined || body.autoApprove !== undefined;
      if (existingBot?.busy && approvalChangeRequested && requestedApprovalMode !== currentApprovalMode) {
        json(res, 409, {
          error: "stop this bot's turn before changing its approval level",
        });
        return true;
      }
      if (body.approvalMode !== undefined || body.autoApprove !== undefined) {
        patch.approvalMode = requestedApprovalMode;
        // Keep the old wire field truthful for older paired apps. It means
        // specifically safe Auto, not "some mode that approves things".
        patch.autoApprove = requestedApprovalMode === "auto";
      }
      const targetSelection = normalizedSelection ?? existingBot?.modelSelection;
      if (normalizedSelection && selectedTask) {
        const mode = approvalModeFor(selectedTask);
        if ((mode === "full" || mode === "custom") &&
          (!supportsApprovalMode(registry.cliTarget(normalizedSelection.instanceId)?.driverKind, mode) ||
            registry.cliTarget(normalizedSelection.instanceId)?.driverKind !== registry.cliTarget(selectedTask.modelSelection.instanceId)?.driverKind)) {
          json(res, 400, { error: "Choose Ask for the selected thread before changing providers with elevated permissions" });
          return true;
        }
      }
      if (
        (requestedApprovalMode === "full" || requestedApprovalMode === "custom") &&
        (body.approvalMode !== undefined || normalizedSelection !== undefined) &&
        (!targetSelection || !supportsApprovalMode(registry.cliTarget(targetSelection.instanceId)?.driverKind, requestedApprovalMode) ||
          (existingBot && normalizedSelection && registry.cliTarget(normalizedSelection.instanceId)?.driverKind !== registry.cliTarget(existingBot.modelSelection.instanceId)?.driverKind))
      ) {
        json(res, 400, {
          error: "This provider does not support the selected approval level, or changing providers requires choosing Ask first",
        });
        return true;
      }
      const requiresPrivateApprovalTransition =
        ((requestedApprovalMode === "full" || requestedApprovalMode === "custom") &&
          currentApprovalMode !== requestedApprovalMode) ||
        (currentApprovalMode === "custom" && requestedApprovalMode !== "custom");
      if (requiresPrivateApprovalTransition) {
        json(res, 403, {
          error: "This approval-level change can only be made from the packaged desktop app",
        });
        return true;
      }
      // "Auto on this Mac" hands a bot the user's real session, so the grant
      // must prove a human saw the warning. The desktop dialog is the only
      // caller that sends acknowledgeLocalAuto; without it a PATCH that would
      // create the combination — a bot curling the loopback API from a tool
      // call, a script, a stale client — is refused. The renderer dialog
      // alone is not a boundary; this check is.
      const wantsComputer = computerSpecified ? requestedComputer : existingBot?.computer;
      const wantsAuto = requestedApprovalMode === "auto";
      const alreadyGranted =
        existingBot?.computer === "local" && approvalModeFor(existingBot) === "auto";
      if (wantsComputer === "local" && wantsAuto === true && !alreadyGranted && body.acknowledgeLocalAuto !== true) {
        json(res, 400, {
          error: "Auto mode on this computer requires confirming the warning first (acknowledgeLocalAuto)",
        });
        return true;
      }
      if (body.approvePeerComms !== undefined) {
        if (typeof body.approvePeerComms !== "boolean") {
          json(res, 400, { error: "approvePeerComms must be true or false" });
          return true;
        }
        patch.approvePeerComms = body.approvePeerComms;
      }
      // Who this bot may contact. null clears the list back to "everyone
      // visible in my section"; an array — including an empty one — is the
      // explicit wiring, so a bot can be given exactly one correspondent.
      //
      // Narrowing is free, widening is not. The bot this field constrains
      // can reach this endpoint: resolveRequestAuth hands admin+client to
      // any loopback caller, so a bot holding Bash is one curl from
      // deleting its own leash — the same adversary the acknowledgeLocalAuto
      // block above is written against, and the exact bot the allow-list
      // exists to contain. So cutting reach needs nothing (an operator, a
      // script, even the bot itself may only ever make it smaller), while
      // clearing the list or adding an id needs the proof of a human the
      // desktop dialog sends and a tool call cannot forge.
      if (body.peers !== undefined) {
        let nextPeers: string[] | undefined;
        if (body.peers === null) nextPeers = undefined;
        else if (
          !Array.isArray(body.peers) ||
          body.peers.some((peerId: unknown) => typeof peerId !== "string")
        ) {
          json(res, 400, { error: "peers must be a list of bot ids, or null for every bot in this section" });
          return true;
        } else {
          nextPeers = [...new Set<string>(body.peers)].slice(0, MAX_WORKSPACE_BOTS);
        }
        // A bot with no list is already at its widest, so the first list it
        // is ever given can only narrow it.
        const currentPeers = existingBot?.peers;
        const widensReach =
          Array.isArray(currentPeers) &&
          (nextPeers === undefined || nextPeers.some((peerId) => !currentPeers.includes(peerId)));
        if (widensReach && body.acknowledgePeerScope !== true) {
          json(res, 400, {
            error: "Widening a bot's allowed peers requires confirming it first (acknowledgePeerScope)",
          });
          return true;
        }
        patch.peers = nextPeers;
      }
      if (body.managedSections !== undefined) {
        const parsed = z.array(z.string().trim().max(60)).max(100).safeParse(body.managedSections);
        if (!parsed.success) {
          json(res, 400, { error: "managedSections must be a list of up to 100 team names (60 characters each)" });
          return true;
        }
        const sections = [...new Set(parsed.data)];
        const newSections = sections.filter(section => !(existingBot?.managedSections ?? []).includes(section));
        if (newSections.some(section => section !== "" && !store.sections.includes(section))) {
          json(res, 400, { error: "Create the named team before giving a Chief access to it" });
          return true;
        }
        if (sections.length && !(body.chiefOfStaff === true || (existingBot?.chiefOfStaff && body.chiefOfStaff !== false))) {
          json(res, 400, { error: "Only a Chief of Staff can be given access to additional teams" });
          return true;
        }
        if (newSections.length && body.acknowledgePeerScope !== true) {
          json(res, 400, { error: "Confirm which additional teams this Chief may work with (acknowledgePeerScope)" });
          return true;
        }
        patch.managedSections = sections;
      }
      // Removing the role revokes its grants, rather than leaving dormant
      // authority to return if this bot is elected Chief again later.
      if (body.chiefOfStaff === false) patch.managedSections = [];
      if (body.alwaysAllow !== undefined) {
        if (!Array.isArray(body.alwaysAllow) || body.alwaysAllow.some((t: unknown) => typeof t !== "string")) {
          json(res, 400, { error: "alwaysAllow must be a list of tool keys" });
          return true;
        }
        patch.alwaysAllow = [...new Set(body.alwaysAllow as string[])].slice(0, 200);
      }
      // What "the proof of a human" above actually rests on. In the packaged
      // desktop it is real: every mutation here already carried the owner
      // capability a tool call cannot forge. Outside it — `pnpm dev`, the
      // CLI, the Docker stack — loopback is the owner by design, so the
      // acknowledgement flag and the settings that loosen a bot's leash
      // (a wider peer list, the peer-approval gate switched off, a section
      // move that changes who is in reach, a standing always-allow grant)
      // are one curl away from the bot they constrain. What such a request
      // does NOT have is a paired session or a browser origin; and the one
      // moment a bot's shell can send it is while a turn is running. So an
      // originless, session-less loopback caller may loosen a bot only
      // while every bot is idle — and is logged when it does — while the
      // served UI (a browser, with its origin) and a paired device keep
      // working mid-turn as before. A bar, not a wall: the wall is the
      // desktop capability or a paired session, which is what the refusal
      // points at.
      const loosened: string[] = [];
      if (Array.isArray(patch.managedSections) && patch.managedSections.some(section => !(existingBot?.managedSections ?? []).includes(section))) {
        loosened.push("managedSections");
      }
      // A shell can forge an Origin header. New cross-team authority may
      // come from local scripts only when all bots are idle; paired owners
      // and the packaged desktop's private capability can grant it mid-turn.
      if (loosened.includes("managedSections") && auth.kind === "loopback" && !DESKTOP_MANAGED && store.bots.some(bot => bot.busy)) {
        json(res, 409, { error: "Stop running bots before granting access to another team, or use the desktop app or a paired owner session." });
        return true;
      }
      if (body.peers !== undefined && Array.isArray(existingBot?.peers)) {
        const nextPeers = patch.peers;
        if (nextPeers === undefined || (Array.isArray(nextPeers) && nextPeers.some((peerId) => !existingBot.peers!.includes(peerId)))) {
          loosened.push("peers");
        }
      }
      if (body.approvePeerComms === false && existingBot?.approvePeerComms === true) loosened.push("approvePeerComms");
      if (section !== undefined && sectionKey(existingBot?.section) !== sectionKey(section)) loosened.push("section");
      if (Array.isArray(patch.alwaysAllow) && patch.alwaysAllow.some((key) => !(existingBot?.alwaysAllow ?? []).includes(key))) {
        loosened.push("alwaysAllow");
      }
      if (body.mcpServers !== undefined && Array.isArray(existingBot?.mcpServers) &&
          (requestedMcpServers === undefined || requestedMcpServers.some((name) => !existingBot.mcpServers!.includes(name)))) {
        loosened.push("mcpServers");
      }
      const browserOrigin = typeof req.headers.origin === "string" && req.headers.origin.trim() !== "";
      if (loosened.length && auth.kind === "loopback" && !DESKTOP_MANAGED && !browserOrigin) {
        if (store.bots.some((candidate) => candidate.busy)) {
          json(res, 409, {
            error: "A bot is working right now, so this change has to come from the desktop app or a paired device. Try again once every bot is idle.",
          });
          return true;
        }
        console.warn(`bot ${m[1]}: ${loosened.join(", ")} loosened by ${requestSource(req)} through the local API with no paired session`);
      }
      if (existingBot?.computer === "local" && computerSpecified && requestedComputer !== "local") {
        await interruptAllDirectThreads(existingBot.id);
        const routine = routines()!.activeBotRunForBot(existingBot.id);
        if (routine) await routines()!.cancelRun(routine.id);
        const groupTurn = activeGroupTurnForBot(existingBot.id);
        if (groupTurn) {
          cancelGroupTurnOperations(groupTurn.group.id, groupTurn.threadId);
          revokeInternalCapabilitiesForThread(groupTurn.threadId);
          await runningTurnInstance(existingBot, groupTurn.threadId)?.adapter.interruptTurn(groupTurn.threadId).catch(() => {});
          closeOpenApprovals(groupTurn.threadId);
        }
      }
      const chiefMovedSections =
        Boolean(existingBot?.chiefOfStaff) &&
        body.chiefOfStaff !== false &&
        section !== undefined &&
        sectionKey(existingBot?.section) !== sectionKey(section);
      let bot: BotRecord | null;
      const freshBrowserBot = store.bot(m[1]);
      // Custom servers are process configuration: a running turn cannot
      // unmount them. Recheck after any awaited runtime revocation above.
      if (body.mcpServers !== undefined) {
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
          json(res, 401, { error: "unauthorized: this session has expired or was revoked" });
          return true;
        }
        if (Array.isArray(freshBrowserBot?.mcpServers) &&
            (requestedMcpServers === undefined || requestedMcpServers.some((name) => !freshBrowserBot.mcpServers!.includes(name))) &&
            auth.kind === "loopback" && !DESKTOP_MANAGED && !browserOrigin && store.bots.some((candidate) => candidate.busy)) {
          json(res, 409, { error: "A bot is working right now, so this change has to come from the desktop app or a paired device. Try again once every bot is idle." });
          return true;
        }
        if (freshBrowserBot &&
            JSON.stringify(requestedMcpServers?.toSorted()) !== JSON.stringify(freshBrowserBot.mcpServers?.toSorted()) &&
            (freshBrowserBot.busy || activeGroupTurnForBot(freshBrowserBot.id))) {
          json(res, 409, { error: "Stop this bot's turns before changing its MCP servers." });
          return true;
        }
      }
      if (normalizedSelection && selectedTask) {
        const current = store.projectBotForTask(selectedTask.id, selectedTask.threadId);
        if (!current) {
          json(res, 404, { error: "no such task" });
          return true;
        }
        const checked = checkedModelSelection(normalizedSelection, { selection: current.modelSelection, busy: threadBusy(current.id, current.threadId) });
        if (!checked.ok) {
          json(res, checked.status, { error: checked.error });
          return true;
        }
        if (freshBrowserBot && activeGroupTurnForBot(freshBrowserBot.id)) {
          const groupChecked = checkedModelSelection(normalizedSelection, { selection: freshBrowserBot.modelSelection, busy: true });
          if (!groupChecked.ok) {
            json(res, groupChecked.status, { error: groupChecked.error });
            return true;
          }
        }
      }
      if (freshBrowserBot && body.browserProfile !== undefined &&
          patch.browserProfile !== freshBrowserBot.browserProfile &&
          (freshBrowserBot.busy || browserRuntime.heldBy(currentBrowserSession(freshBrowserBot.id, freshBrowserBot.browserProfile)))) {
        json(res, 409, { error: "Stop the bot and release browser control before changing its profile." });
        return true;
      }
      if (profile.patch.soul !== undefined) {
        if (freshBrowserBot) assertTeamComputerChangeIdle(freshBrowserBot, { ...freshBrowserBot, ...patch } as BotRecord);
        // A mixed settings request must not turn a runtime revocation into
        // a persist-first edit. Apply runtime fields with their existing
        // fail-closed semantics; atomically commit only the profile fields.
        const runtimePatch = { ...patch };
        for (const field of Object.keys(profile.patch)) delete runtimePatch[field];
        if (Object.keys(runtimePatch).length) store.patchBot(m[1], runtimePatch);
        bot = store.patchBotProfile(m[1], profile.patch);
      } else {
        if (freshBrowserBot) assertTeamComputerChangeIdle(freshBrowserBot, { ...freshBrowserBot, ...patch } as BotRecord);
        bot = store.patchBot(m[1], patch);
      }
      if (!bot) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      if (normalizedSelection && selectedTask) store.patchTask(bot.id, selectedTask.threadId, { modelSelection: normalizedSelection });
      if (existingBot && (bot.browserProfile !== beforeBrowserProfile || bot.browser !== beforeBrowserEnabled)) {
        browserLive.closeForBot(bot.id);
        if (beforeBrowserProfile === "guest" && (bot.browserProfile !== "guest" || bot.browser === false)) {
          void forgetTemporaryBrowser(bot.id).catch((error) => console.warn("temporary browser cleanup failed", error));
        }
      }
      const chiefChanges =
        body.chiefOfStaff === true || chiefMovedSections
          ? store.setChiefOfStaff(bot.id)
          : [];
      if (chiefChanges === null) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      if (beforeProfile) {
        const now = store.bot(bot.id)!;
        recordProfileChange(bot.id, "user", "api", beforeProfile, profileSnapshot(now));
      }
      json(res, 200, { bot: wireBot(store.bot(bot.id)!) });
      return true;
    }
    return false;
  };
}
