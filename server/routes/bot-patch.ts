import { z } from "zod";

import { approvalModeFor, isApprovalMode, type ApprovalMode } from "../../shared/approval-mode.ts";
import { normalizeConnectorScopes } from "../../shared/connector-scopes.ts";
import { normalizeOutboundPolicy } from "../../shared/outbound.ts";
import { parseToolScope, toolScopeWidens } from "../../shared/tool-scope.ts";
import { isMausColor, MAUS_COLOR_NAMES, type WireBot, type WireGroup } from "../../shared/wire.ts";
import { validateBotCwd } from "../bot-cwd.ts";
import { parseBotProfilePatch } from "../bot-profile.ts";
import { parseVisibility } from "../bot-visibility.ts";
import type { BrowserLive } from "../browser-live.ts";
import type { BrowserRuntime } from "../browser-runtime.ts";
import type { CacheKeepWarm } from "../cache-keepwarm.ts";
import { cloudBackendChangeError, vpsBotAliasChangeError, vpsLeftBehindNotice, VPS_BOT_ALIAS_CHANGE_ERROR, VPS_BOT_ALIAS_LIFECYCLE_ERROR, VPS_BOT_ALIAS_RESOURCES_ERROR } from "../cloud-backend.ts";
import * as composio from "../composio.ts";
import { isValidSshAlias, type AppConfig } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { validateMascotProfile } from "../custom-mascot-validation.ts";
import type { createApprovalModeSupport } from "../harness-capabilities.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import type { hostedModelPolicy } from "../hosted-models.ts";
import { MAX_MCP_SERVERS, mcpServerNameError } from "../mcp-registry.ts";
import type { MemoryUpkeep } from "../memory-upkeep.ts";
import { profileSnapshot } from "../profile-revision.ts";
import { recordProfileChange } from "../profile-versions.ts";
import { clientBotPatchViolation, requestSource } from "../request-auth.ts"; import { defaultBotPatchRefusal, ownsDefaultBot } from "../default-bot.ts";
import type { RoutineManager } from "../routines.ts";
import type { SessionRegistry } from "../sessions.ts";
import { parseConnectorTools } from "../connector-tools.ts";
import { sectionKey, type BotRecord, type GroupRecord, type Store } from "../store.ts";
import * as vps from "../vps-computer.ts";
import { vpsSshAliasForBot } from "../vps-hosts.ts";
import { pinnedClientThreadGuard } from "./pinned-client-thread.ts";
import type { ModelSelectionCheck } from "./bots-create.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotPatchRouteDeps {
  store: Store;
  cfg: AppConfig;
  registry: Pick<ProviderRegistry, "get">;
  sessions: Pick<SessionRegistry, "isLive">;
  browserRuntime: Pick<BrowserRuntime, "heldBy">;
  browserLive: Pick<BrowserLive, "closeForBot">;
  memoryUpkeep: Pick<MemoryUpkeep, "dropBot">;
  cacheKeepWarm: Pick<CacheKeepWarm, "refresh">;
  hostedModels: ReturnType<typeof hostedModelPolicy>;
  supportsApprovalMode: ReturnType<typeof createApprovalModeSupport>;
  routines(): RoutineManager | null;
  activeVpsThreads: { has(botId: string): boolean };
  /** Full access comes only from the workspace policy. */
  hostedWorkspace: boolean;
  hostedFullAccessRefusal: string;
  desktopManaged: boolean;
  maxWorkspaceBots: number;
  broadcast(payload: Record<string, unknown>): void;
  wireBot(bot: BotRecord): WireBot;
  publicGroupState(group: GroupRecord): WireGroup;
  audienceChanged(): void;
  storedAvatarExists(avatarUrl: string): boolean;
  requestedTaskBot(botId: string, rawThreadId: unknown): BotRecord;
  threadBusy(botId: string, threadId: string): boolean;
  activeGroupTurnForBot(botId: string): { group: GroupRecord; threadId: string } | null;
  checkedModelSelection(raw: unknown, current?: { selection: ModelSelection; busy: boolean }, requireAvailableModel?: boolean): ModelSelectionCheck;
  engineSwitchNeedsAsk(mode: ApprovalMode, from: ModelSelection, to: ModelSelection): boolean;
  currentBrowserSession(botId: string, profile: string | undefined): string;
  interruptAllDirectThreads(botId: string): Promise<void>;
  cancelGroupTurnOperations(groupId: string, threadId: string): void;
  revokeInternalCapabilitiesForThread(threadId: string): void;
  runningTurnInstance(bot: BotRecord | null | undefined, threadId: string): ReturnType<ProviderRegistry["get"]>;
  closeOpenApprovals(threadId: string): void;
  assertTeamComputerChangeIdle(before: BotRecord, after: BotRecord): void;
  forgetTemporaryBrowser(botId: string): Promise<void>;
}

export function createBotPatchRoutes(deps: BotPatchRouteDeps): RouteHandler {
  const {
    store, cfg, registry, sessions, browserRuntime, browserLive, memoryUpkeep, cacheKeepWarm, hostedModels, supportsApprovalMode, activeVpsThreads,
    hostedWorkspace: HOSTED_WORKSPACE, hostedFullAccessRefusal: HOSTED_FULL_ACCESS_REFUSAL, desktopManaged: DESKTOP_MANAGED, maxWorkspaceBots: MAX_WORKSPACE_BOTS,
    broadcast, wireBot, publicGroupState, audienceChanged, storedAvatarExists, requestedTaskBot, threadBusy, activeGroupTurnForBot,
    checkedModelSelection, engineSwitchNeedsAsk, currentBrowserSession, interruptAllDirectThreads, cancelGroupTurnOperations,
    revokeInternalCapabilitiesForThread, runningTurnInstance, closeOpenApprovals, assertTeamComputerChangeIdle, forgetTemporaryBrowser,
  } = deps;
  const pinnedClientThread = pinnedClientThreadGuard(store);
  return async ({ req, res, path, method, auth, json, readBody }) => {
    let m: RegExpMatchArray | null = null;
    const routines = deps.routines();
    const requirePinnedClientThread = pinnedClientThread(auth, req);
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const pairedDevice = req.headers["x-openmausbot-companion"] === "1";
      if ((auth.kind === "session" && !auth.scopes.includes("admin")) || pairedDevice) {
        const field = clientBotPatchViolation(body, ownsDefaultBot(store.bot(m[1]), auth.kind === "session" ? auth.session.email : undefined));
        if (field) {
          return json(res, 403, {
            error: pairedDevice
              ? `forbidden: a paired device may change how a bot looks, not "${field}"; change it on the host computer`
              : `forbidden: this session may change how a bot looks, not "${field}" (needs the admin scope)`,
          });
        }
      }
      if (body.color !== undefined && !isMausColor(body.color)) {
        return json(res, 400, { error: `color must be ${MAUS_COLOR_NAMES.slice(0, -1).join(", ")}, or ${MAUS_COLOR_NAMES.at(-1)}` });
      }
      if (body.mascotExpression !== undefined && body.mascotExpression !== null &&
        (typeof body.mascotExpression !== "string" || body.mascotExpression.length > 80)) {
        return json(res, 400, { error: "mascotExpression must be null or a state name of at most 80 characters" });
      }
      if (body.pinned !== undefined && typeof body.pinned !== "boolean") {
        return json(res, 400, { error: "pinned must be true or false" });
      }
      const existingBot = store.bot(m[1]); const defaultBotRefused = defaultBotPatchRefusal(existingBot, body);
      if (defaultBotRefused) return json(res, 400, { error: defaultBotRefused });
      const rawSelection = (body as Record<string, unknown>).modelSelection;
      if (body.threadId !== undefined && rawSelection === undefined) {
        return json(res, 400, { error: "threadId goes with modelSelection" });
      }
      if (rawSelection !== undefined) requirePinnedClientThread(m[1], body.threadId);
      const selectedTask = existingBot ? requestedTaskBot(existingBot.id, body.threadId) : null;
      const beforeProfile = existingBot ? profileSnapshot(existingBot) : undefined;
      const beforeVisibility = existingBot?.visibility;
      if (body.requireAvailableModel !== undefined && typeof body.requireAvailableModel !== "boolean") {
        return json(res, 400, { error: "requireAvailableModel must be true or false" });
      }
      const beforeBrowserProfile = existingBot?.browserProfile;
      const beforeBrowserEnabled = existingBot?.browser;
      // Codex and Grok accept any effort string, so this is the only gate on it; an unresolved
      // instance declares no levels and is let through (startTurn refuses an unavailable instance).
      if (body.keepThreadModels !== undefined) {
        if (typeof body.keepThreadModels !== "boolean") return json(res, 400, { error: "keepThreadModels must be true or false" });
        if (body.keepThreadModels && rawSelection === undefined) return json(res, 400, { error: "keepThreadModels goes with modelSelection" });
      }
      const movedTask = selectedTask && !(body.keepThreadModels === true &&
        store.taskByThread(selectedTask.id, selectedTask.threadId)?.modelSelection !== undefined) ? selectedTask : null;
      if (
        existingBot?.approvalGrant &&
        (rawSelection !== undefined || body.approvalMode !== undefined || body.autoApprove !== undefined)
      ) {
        return json(res, 409, { error: "wait for the approval-level change to finish before changing this setting" });
      }
      if (body.requireAvailableModel === true && rawSelection === undefined) {
        return json(res, 400, { error: "requireAvailableModel requires modelSelection" });
      }
      let normalizedSelection: ModelSelection | undefined;
      if (rawSelection !== undefined) {
        const checked = checkedModelSelection(
          rawSelection,
          movedTask ? { selection: movedTask.modelSelection, busy: threadBusy(movedTask.id, movedTask.threadId) } : undefined,
          body.requireAvailableModel === true,
        );
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
        normalizedSelection = checked.selection;
        if (existingBot && activeGroupTurnForBot(existingBot.id)) {
          const groupChecked = checkedModelSelection(normalizedSelection, { selection: existingBot.modelSelection, busy: true });
          if (!groupChecked.ok) return json(res, groupChecked.status, { error: groupChecked.error });
        }
      }
      const profile = parseBotProfilePatch(body);
      if (!profile.ok) return json(res, 400, { error: profile.error });
      if (profile.patch.avatarUrl && !storedAvatarExists(profile.patch.avatarUrl)) {
        return json(res, 400, { error: "avatarUrl must reference an existing stored image" });
      }
      const patch: Record<string, unknown> = {};
      Object.assign(patch, profile.patch);
      if (Object.hasOwn(body, "mascotProfile")) {
        try {
          patch.mascotProfile = validateMascotProfile(body.mascotProfile);
        } catch (error) {
          return json(res, 400, { error: error instanceof Error ? error.message : "mascotProfile is invalid" });
        }
      }
      let section: string | undefined | null;
      if (body.section !== undefined) {
        if (body.section === null) section = null;
        else if (typeof body.section !== "string") return json(res, 400, { error: "section must be a string" });
        else {
          const trimmed = body.section.trim();
          if (!trimmed) section = null;
          else if (trimmed.length > 60) return json(res, 400, { error: "section must be at most 60 characters" });
          else section = trimmed;
        }
      }
      for (const key of ["unread", "cloudBackend", "color", "mascotExpression", "mascotBody", "pinned", "hidden", "sidebarHidden", "welcomed"] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      const computerSpecified = Object.prototype.hasOwnProperty.call(body, "computer");
      let requestedComputer = existingBot?.computer;
      if (computerSpecified) {
        if (body.computer === null) {
          // Clients send null for Auto; the durable field is then absent.
          requestedComputer = undefined;
          patch.computer = undefined;
        } else if (
          typeof body.computer === "string" &&
          ["cloud", "vm", "local", "browser", "off"].includes(body.computer)
        ) {
          requestedComputer = body.computer;
          patch.computer = body.computer;
        } else {
          return json(res, 400, { error: "computer must be null (Auto), cloud, vm, local, browser, or off" });
        }
      }
      if (normalizedSelection) patch.modelSelection = normalizedSelection;
      // null/"" clears; the id is not checked against the transcript.
      if (body.pinnedMessageId !== undefined) {
        if (body.pinnedMessageId === null || body.pinnedMessageId === "") patch.pinnedMessageId = undefined;
        else if (typeof body.pinnedMessageId === "string" && /^[\w-]+$/.test(body.pinnedMessageId)) {
          patch.pinnedMessageId = body.pinnedMessageId;
        } else return json(res, 400, { error: "pinnedMessageId must be a message id" });
      }
      if (section !== undefined) patch.section = section ?? undefined;
      if (body.chiefOfStaff === false) patch.chiefOfStaff = false;
      if (body.fallback !== undefined) {
        if (!Array.isArray(body.fallback) || body.fallback.length > 5) {
          return json(res, 400, { error: "fallback must be a list of up to five { instanceId, model } entries" });
        }
        const chain: Array<{ instanceId: string; model: string }> = [];
        for (const entry of body.fallback as unknown[]) {
          const row = entry && typeof entry === "object" ? (entry as { instanceId?: unknown; model?: unknown }) : null;
          if (!row || typeof row.instanceId !== "string" || !/^[\w.-]+$/.test(row.instanceId) || typeof row.model !== "string" || !row.model.trim() || row.model.length > 500) {
            return json(res, 400, { error: "fallback must be a list of up to five { instanceId, model } entries" });
          }
          if (!registry.get(row.instanceId)) return json(res, 400, { error: `fallback engine "${row.instanceId}" is not available` });
          if (chain.some((seen) => seen.instanceId === row.instanceId)) continue;
          chain.push({ instanceId: row.instanceId, model: row.model.trim() });
        }
        patch.fallback = chain;
      }
      // null clears back to every connected app.
      if (body.connectorScopes !== undefined) {
        if (body.connectorScopes === null) patch.connectorScopes = undefined;
        else {
          const scopes = normalizeConnectorScopes(body.connectorScopes);
          if (!scopes) return json(res, 400, { error: "connectorScopes must be { apps: { <toolkit>: read | write } } or null" });
          patch.connectorScopes = scopes;
        }
      }
      if (body.outbound !== undefined) {
        const policy = normalizeOutboundPolicy(body.outbound);
        if (!policy) return json(res, 400, { error: "outbound must be { policy: ask | allow, dailyCap: 1..1000 }" });
        patch.outbound = policy;
      }
      if (body.composio !== undefined) {
        if (typeof body.composio !== "boolean") return json(res, 400, { error: "composio must be true or false" });
        patch.composio = body.composio;
      }
      // An admin decision, so not on the client-writable profile surface.
      if (body.voiceNotes !== undefined) {
        if (typeof body.voiceNotes !== "boolean") return json(res, 400, { error: "voiceNotes must be true or false" });
        patch.voiceNotes = body.voiceNotes;
      }
      // Spends the Cloud plan's monthly X research calls: an admin decision too.
      if (body.xResearch !== undefined) {
        if (typeof body.xResearch !== "boolean") return json(res, 400, { error: "xResearch must be true or false" });
        patch.xResearch = body.xResearch;
      }
      if (body.memoryEnabled !== undefined) {
        if (typeof body.memoryEnabled !== "boolean") return json(res, 400, { error: "memoryEnabled must be true or false" });
        if (existingBot && (existingBot.busy || activeGroupTurnForBot(existingBot.id)) &&
            body.memoryEnabled !== (existingBot.memoryEnabled !== false)) {
          return json(res, 409, { error: "stop this bot's turn before changing its memory setting" });
        }
        patch.memoryEnabled = body.memoryEnabled;
      }
      // null drops the per-tool grants; {} means no tools.
      if (body.connectorTools !== undefined) {
        if (body.connectorTools === null) {
          patch.connectorTools = undefined;
        } else {
          const parsed = parseConnectorTools(body.connectorTools);
          if (!parsed.ok) return json(res, 400, { error: parsed.error });
          // An unreachable backend never blocks the patch: the call-time check stays the authority.
          const semantic = await composio.validateConnectorGrants(cfg, parsed.grants);
          if (semantic) return json(res, 400, { error: semantic });
          patch.connectorTools = parsed.grants;
        }
      }
      if (body.parkDirectMessages !== undefined) {
        if (typeof body.parkDirectMessages !== "boolean") return json(res, 400, { error: "parkDirectMessages must be true or false" });
        patch.parkDirectMessages = body.parkDirectMessages;
      }
      // Omitted keeps the selection; null restores all enabled servers; [] mounts none.
      let requestedMcpServers = existingBot?.mcpServers;
      if (Object.hasOwn(body, "toolScope")) {
        const parsed = parseToolScope(body.toolScope === null ? undefined : body.toolScope);
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        patch.toolScope = parsed.scope;
      }
      if (body.mcpServers !== undefined) {
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
          return json(res, 401, { error: "unauthorized: this session has expired or was revoked" });
        }
        if (body.mcpServers === null) {
          requestedMcpServers = undefined;
        } else if (!Array.isArray(body.mcpServers) || body.mcpServers.some((t: unknown) => typeof t !== "string" || mcpServerNameError(t) !== null)) {
          return json(res, 400, { error: "mcpServers must be a list of server names, or null" });
        } else {
          requestedMcpServers = [...new Set(body.mcpServers as string[])];
          if (requestedMcpServers.length > MAX_MCP_SERVERS) {
            return json(res, 400, { error: `Select at most ${MAX_MCP_SERVERS} MCP servers.` });
          }
        }
        patch.mcpServers = requestedMcpServers;
      }
      if (body.memoryUpkeep !== undefined) {
        if (typeof body.memoryUpkeep !== "boolean") return json(res, 400, { error: "memoryUpkeep must be true or false" });
        patch.memoryUpkeep = body.memoryUpkeep;
      }
      // true/false overrides the workspace, null follows it.
      if (body.cacheKeepWarm !== undefined) {
        if (body.cacheKeepWarm !== null && typeof body.cacheKeepWarm !== "boolean") return json(res, 400, { error: "cacheKeepWarm must be true, false or null" });
        patch.cacheKeepWarm = body.cacheKeepWarm ?? undefined;
      }
      if (body.helperModel !== undefined) {
        if (typeof body.helperModel !== "boolean") return json(res, 400, { error: "helperModel must be true or false" });
        patch.helperModel = body.helperModel;
      }
      if (body.browser !== undefined) {
        if (typeof body.browser !== "boolean") return json(res, 400, { error: "browser must be true or false" });
        if (existingBot?.busy && body.browser !== (existingBot.browser !== false)) {
          return json(res, 409, { error: "stop this bot's turn before changing its browser access" });
        }
        patch.browser = body.browser;
      }
      if (body.recordBrowserSteps !== undefined) {
        if (typeof body.recordBrowserSteps !== "boolean") return json(res, 400, { error: "recordBrowserSteps must be true or false" });
        patch.recordBrowserSteps = body.recordBrowserSteps;
      }
      // null/"" = the bot's own session.
      if (body.browserProfile !== undefined) {
        const requestedProfile = body.browserProfile === null || body.browserProfile === ""
          ? undefined
          : body.browserProfile;
        if (existingBot?.busy && requestedProfile !== existingBot.browserProfile) {
          return json(res, 409, { error: "stop this bot's turn before changing its browser profile" });
        }
        if (existingBot && requestedProfile !== existingBot.browserProfile &&
            browserRuntime.heldBy(currentBrowserSession(existingBot.id, existingBot.browserProfile))) {
          return json(res, 409, { error: "Release browser control before changing its profile." });
        }
        if (requestedProfile === undefined) patch.browserProfile = undefined;
        else if (
          typeof requestedProfile === "string" &&
          (requestedProfile === "guest" || (cfg.browserProfiles ?? []).some((profile) => profile.id === requestedProfile))
        ) {
          patch.browserProfile = requestedProfile;
        } else return json(res, 400, { error: "browserProfile must name an existing browser profile" });
      }
      if (body.cloudBackend !== undefined && !["box", "vps"].includes(String(body.cloudBackend))) {
        return json(res, 400, { error: "cloudBackend must be box or vps" });
      }
      if (body.autoStartVps !== undefined) {
        if (typeof body.autoStartVps !== "boolean") return json(res, 400, { error: "autoStartVps must be true or false" });
        patch.autoStartVps = body.autoStartVps;
      }
      if (body.vpsAlias !== undefined) {
        if (body.vpsAlias === null || body.vpsAlias === "") {
          patch.vpsAlias = undefined;
        } else if (isValidSshAlias(body.vpsAlias)) {
          patch.vpsAlias = body.vpsAlias;
        } else {
          return json(res, 400, {
            error: "vpsAlias must be a simple SSH config alias (letters, numbers, dot, dash, or underscore), or null to use the default server",
          });
        }
      }
      if (body.chiefOfStaff !== undefined && typeof body.chiefOfStaff !== "boolean") {
        return json(res, 400, { error: "chiefOfStaff must be true or false" });
      }
      if (body.cloudBackend !== undefined) {
        const backendError = cloudBackendChangeError(Boolean(existingBot?.busy), activeVpsThreads.has(m[1]));
        if (backendError) return json(res, 409, { error: backendError });
      }
      // Moving a bot to another server is refused while its own computer still lives on the old one.
      // Resolved hosts, not raw text: pinning a bot to the server it already uses moves nothing.
      let vpsLeftOn: string | null = null;
      if (body.vpsAlias !== undefined && existingBot &&
          vpsSshAliasForBot(cfg, { ...existingBot, vpsAlias: patch.vpsAlias as string | undefined }) !== vpsSshAliasForBot(cfg, existingBot)) {
        // The scan awaits on SSH; a turn can start or another PATCH can land mid-scan, so every attempt
        // re-reads the bot first and the scan only counts when the re-read after it is unchanged.
        const VPS_ALIAS_MOVE_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= VPS_ALIAS_MOVE_ATTEMPTS; attempt++) {
          const current = store.bot(m[1]);
          if (!current) return json(res, 404, { error: "no such bot" });
          // A concurrent PATCH may have already made this move; persisting the same host moves nothing.
          if (vpsSshAliasForBot(cfg, { ...current, vpsAlias: patch.vpsAlias as string | undefined }) === vpsSshAliasForBot(cfg, current)) break;
          const aliasError = vpsBotAliasChangeError(Boolean(current.busy), activeVpsThreads.has(m[1]));
          if (aliasError) return json(res, 409, { error: aliasError });
          // A Start or Remove still running on the old host would land after the scan, like the default alias's guard.
          if (vps.vpsLifecycleBusy()) return json(res, 409, { error: VPS_BOT_ALIAS_LIFECYCLE_ERROR });
          // Primitives, not the record: the store hands out its live object and patchBot mutates it in place.
          const scannedVpsAlias = current.vpsAlias;
          const scannedBusy = current.busy;
          const scannedName = current.name;
          const currentAlias = vpsSshAliasForBot(cfg, current);
          // Scanned with this bot as the only owner: the guard only ever cares about its own container,
          // and naming the owner keeps a legacy unlabeled container visible to the check.
          const inventory = currentAlias ? await vps.listManagedVpsComputers(
            { vps: { sshAlias: currentAlias } },
            [{ botId: current.id, name: scannedName, inUse: false }],
          ) : null;
          const settled = store.bot(m[1]);
          if (!settled) return json(res, 404, { error: "no such bot" });
          if (settled.vpsAlias !== scannedVpsAlias || settled.busy !== scannedBusy || activeVpsThreads.has(m[1]) || vps.vpsLifecycleBusy()) {
            if (attempt === VPS_ALIAS_MOVE_ATTEMPTS) return json(res, 409, { error: VPS_BOT_ALIAS_CHANGE_ERROR });
            continue;
          }
          if (!inventory) break;
          // A server that cannot answer never keeps the bot: it moves, and the answer says what may be left there.
          if (!inventory.available) vpsLeftOn = currentAlias;
          else if (inventory.instances.some((instance) => instance.name === vps.vpsContainerName(current.id))) {
            return json(res, 409, { error: VPS_BOT_ALIAS_RESOURCES_ERROR });
          }
          break;
        }
      }
      if (body.cwd !== undefined) {
        const checked = validateBotCwd(body.cwd);
        if (!checked.ok) return json(res, 400, { error: checked.error });
        patch.cwd = checked.cwd ?? undefined;
      }
      if (body.hidden === true && existingBot?.chiefOfStaff && body.chiefOfStaff !== false) {
        return json(res, 400, { error: "choose another Chief of Staff before hiding this bot" });
      }
      // Type-checked, not copied: a string alwaysAllow would answer .includes() with substring matches.
      if (body.autoApprove !== undefined) {
        if (typeof body.autoApprove !== "boolean") return json(res, 400, { error: "autoApprove must be true or false" });
      }
      let requestedApprovalMode: ApprovalMode;
      if (body.approvalMode !== undefined) {
        if (!isApprovalMode(body.approvalMode)) {
          return json(res, 400, {
            error: "approvalMode must be ask, auto, full, or custom",
          });
        }
        requestedApprovalMode = body.approvalMode;
      } else if (body.autoApprove !== undefined) {
        // Older clients' boolean can choose only Auto or Ask, never Full access.
        requestedApprovalMode = body.autoApprove ? "auto" : "ask";
      } else {
        requestedApprovalMode = approvalModeFor(existingBot ?? {});
      }
      const currentApprovalMode = approvalModeFor(existingBot ?? {});
      const approvalChangeRequested = body.approvalMode !== undefined || body.autoApprove !== undefined;
      if (existingBot?.busy && approvalChangeRequested && requestedApprovalMode !== currentApprovalMode) {
        return json(res, 409, {
          error: "stop this bot's turn before changing its approval level",
        });
      }
      if (body.approvalMode !== undefined || body.autoApprove !== undefined) {
        patch.approvalMode = requestedApprovalMode;
        // Older paired apps read autoApprove as exactly Auto.
        patch.autoApprove = requestedApprovalMode === "auto";
      }
      const targetSelection = normalizedSelection ?? existingBot?.modelSelection;
      if (normalizedSelection && movedTask) {
        const mode = approvalModeFor(movedTask);
        if (mode === "custom" &&
          (!supportsApprovalMode(normalizedSelection, mode) || engineSwitchNeedsAsk(mode, movedTask.modelSelection, normalizedSelection))) {
          return json(res, 400, { error: "Choose Ask for the selected thread before changing providers with elevated permissions" });
        }
      }
      if (
        requestedApprovalMode === "custom" &&
        (body.approvalMode !== undefined || normalizedSelection !== undefined) &&
        (!targetSelection || !supportsApprovalMode(targetSelection, requestedApprovalMode) ||
          (existingBot && normalizedSelection && engineSwitchNeedsAsk(requestedApprovalMode, existingBot.modelSelection, normalizedSelection)))
      ) {
        return json(res, 400, {
          error: "This provider does not support the selected approval level, or changing providers requires choosing Ask first",
        });
      }
      // Full access applies from any client that can reach this API; Custom moves only through the
      // desktop's private channel because it holds restrictions the person wrote.
      const requiresPrivateApprovalTransition =
        (requestedApprovalMode === "custom" && currentApprovalMode !== "custom") ||
        (currentApprovalMode === "custom" && requestedApprovalMode !== "custom");
      if (requiresPrivateApprovalTransition) {
        return json(res, 403, {
          error: "This approval-level change can only be made from the packaged desktop app",
        });
      }
      if (HOSTED_WORKSPACE && requestedApprovalMode === "full" &&
        (currentApprovalMode !== "full" || body.applyToAllThreads === true)) {
        return json(res, 403, { error: HOSTED_FULL_ACCESS_REFUSAL });
      }
      if (body.applyToAllThreads !== undefined) {
        if (typeof body.applyToAllThreads !== "boolean") return json(res, 400, { error: "applyToAllThreads must be true or false" });
        if (body.applyToAllThreads && (body.approvalMode === undefined || requestedApprovalMode === "custom")) {
          return json(res, 400, { error: "applyToAllThreads goes with an approvalMode other than custom" });
        }
      }
      if (body.applyToAllThreads === true && existingBot) {
        const threads = store.tasks(existingBot.id);
        if (threads.some((task) => threadBusy(existingBot.id, task.threadId))) {
          return json(res, 409, { error: "stop this bot's turns before changing its approval level" });
        }
        if (threads.some((task) => approvalModeFor(store.projectBotForTask(existingBot.id, task.threadId) ?? {}) === "custom")) {
          return json(res, 403, { error: "A thread on Custom approval can only leave it from the packaged desktop app" });
        }
        if (threads.some((task) => !supportsApprovalMode(task.modelSelection ?? targetSelection, requestedApprovalMode))) {
          return json(res, 400, { error: "Every thread's provider must support this approval level" });
        }
      }
      // Auto on this Mac hands a bot the user's real session: only the desktop's warning dialog sends
      // acknowledgeLocalAuto, so a bot curling the loopback API is refused.
      const wantsComputer = computerSpecified ? requestedComputer : existingBot?.computer;
      const wantsAuto = requestedApprovalMode === "auto";
      const alreadyGranted =
        existingBot?.computer === "local" && approvalModeFor(existingBot) === "auto" &&
        (body.applyToAllThreads !== true || store.tasks(existingBot.id).every((task) =>
          approvalModeFor(store.projectBotForTask(existingBot.id, task.threadId) ?? {}) === "auto"));
      if (wantsComputer === "local" && wantsAuto === true && !alreadyGranted && body.acknowledgeLocalAuto !== true) {
        return json(res, 400, {
          error: "Auto mode on this computer requires confirming the warning first (acknowledgeLocalAuto)",
        });
      }
      if (body.approvePeerComms !== undefined) {
        if (typeof body.approvePeerComms !== "boolean") {
          return json(res, 400, { error: "approvePeerComms must be true or false" });
        }
        patch.approvePeerComms = body.approvePeerComms;
      }
      // null: everyone visible in the section; an array (even empty) is the explicit wiring. Narrowing is free;
      // widening needs acknowledgePeerScope, since any loopback caller (a bot with Bash) gets admin.
      if (body.peers !== undefined) {
        let nextPeers: string[] | undefined;
        if (body.peers === null) nextPeers = undefined;
        else if (
          !Array.isArray(body.peers) ||
          body.peers.some((peerId: unknown) => typeof peerId !== "string")
        ) {
          return json(res, 400, { error: "peers must be a list of bot ids, or null for every bot in this section" });
        } else {
          nextPeers = [...new Set<string>(body.peers)].slice(0, MAX_WORKSPACE_BOTS);
        }
        const currentPeers = existingBot?.peers;
        const widensReach =
          Array.isArray(currentPeers) &&
          (nextPeers === undefined || nextPeers.some((peerId) => !currentPeers.includes(peerId)));
        if (widensReach && body.acknowledgePeerScope !== true) {
          return json(res, 400, {
            error: "Widening a bot's allowed peers requires confirming it first (acknowledgePeerScope)",
          });
        }
        patch.peers = nextPeers;
      }
      if (body.managedSections !== undefined) {
        const parsed = z.array(z.string().trim().max(60)).max(100).safeParse(body.managedSections);
        if (!parsed.success) return json(res, 400, { error: "managedSections must be a list of up to 100 department names (60 characters each)" });
        const sections = [...new Set(parsed.data)];
        const newSections = sections.filter(section => !(existingBot?.managedSections ?? []).includes(section));
        if (newSections.some(section => section !== "" && !store.sections.includes(section))) {
          return json(res, 400, { error: "Create the named department before giving a Chief access to it" });
        }
        if (sections.length && !(body.chiefOfStaff === true || (existingBot?.chiefOfStaff && body.chiefOfStaff !== false))) {
          return json(res, 400, { error: "Only a Chief of Staff can be given access to additional teams" });
        }
        if (newSections.length && body.acknowledgePeerScope !== true) {
          return json(res, 400, { error: "Confirm which additional teams this Chief may work with (acknowledgePeerScope)" });
        }
        patch.managedSections = sections;
      }
      // Losing the role revokes its grants: no dormant authority returns if it is elected again.
      if (body.chiefOfStaff === false) patch.managedSections = [];
      // "everyone" (default), "admins" or { people: [...] }; members' PATCHes never get here.
      if (Object.hasOwn(body, "visibility")) {
        const parsed = parseVisibility(body.visibility);
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        patch.visibility = parsed.visibility;
      }
      if (body.alwaysAllow !== undefined) {
        if (!Array.isArray(body.alwaysAllow) || body.alwaysAllow.some((t: unknown) => typeof t !== "string")) {
          return json(res, 400, { error: "alwaysAllow must be a list of tool keys" });
        }
        patch.alwaysAllow = [...new Set(body.alwaysAllow as string[])].slice(0, 200);
      }
      // Known gap: outside the packaged desktop, loopback is the owner, so these loosenings are one curl from
      // the bot they constrain. An originless, session-less loopback caller may loosen only while every bot is idle.
      const loosened: string[] = [];
      const trustPatch = patch as Pick<Partial<BotRecord>, "outbound" | "connectorScopes" | "fallback">;
      if (body.outbound !== undefined && trustPatch.outbound?.policy === "allow" &&
          (existingBot?.outbound?.policy !== "allow" || trustPatch.outbound.dailyCap > existingBot.outbound.dailyCap)) loosened.push("outbound");
      if (body.connectorScopes !== undefined && existingBot?.connectorScopes &&
          (!trustPatch.connectorScopes || Object.entries(trustPatch.connectorScopes.apps).some(([slug, scope]) =>
            !existingBot.connectorScopes!.apps[slug] || (scope === "write" && existingBot.connectorScopes!.apps[slug] === "read")))) loosened.push("connectorScopes");
      if (body.fallback !== undefined && trustPatch.fallback?.some(candidate =>
          !existingBot?.fallback?.some(previous => previous.instanceId === candidate.instanceId && previous.model === candidate.model))) loosened.push("fallback");
      if (Array.isArray(patch.managedSections) && patch.managedSections.some(section => !(existingBot?.managedSections ?? []).includes(section))) {
        loosened.push("managedSections");
      }
      // A shell can forge an Origin header: new cross-team authority from local scripts only while every bot is idle.
      if (loosened.includes("managedSections") && auth.kind === "loopback" && !DESKTOP_MANAGED && store.bots.some(bot => bot.busy)) {
        return json(res, 409, { error: "Stop running bots before granting access to another department, or use the desktop app or a paired Full-access session." });
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
      if (Object.hasOwn(body, "toolScope") && toolScopeWidens(existingBot?.toolScope, patch.toolScope)) loosened.push("toolScope");
      const browserOrigin = typeof req.headers.origin === "string" && req.headers.origin.trim() !== "";
      if (loosened.length && auth.kind === "loopback" && !DESKTOP_MANAGED && !browserOrigin) {
        if (store.bots.some((candidate) => candidate.busy)) {
          return json(res, 409, {
            error: "A bot is working right now, so this change has to come from the desktop app or a paired device. Try again once every bot is idle.",
          });
        }
        console.warn(`bot ${m[1]}: ${loosened.join(", ")} loosened by ${requestSource(req)} through the local API with no paired session`);
      }
      if (existingBot?.computer === "local" && computerSpecified && requestedComputer !== "local") {
        await interruptAllDirectThreads(existingBot.id);
        const routine = routines!.activeBotRunForBot(existingBot.id);
        if (routine) await routines!.cancelRun(routine.id);
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
      // Rechecked: the awaits above can yield after the first memory check.
      if (freshBrowserBot && body.memoryEnabled !== undefined &&
          body.memoryEnabled !== (freshBrowserBot.memoryEnabled !== false) &&
          (freshBrowserBot.busy || activeGroupTurnForBot(freshBrowserBot.id))) {
        return json(res, 409, { error: "stop this bot's turn before changing its memory setting" });
      }
      if (Object.hasOwn(body, "toolScope")) {
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
          return json(res, 401, { error: "unauthorized: this session has expired or was revoked" });
        }
        if (toolScopeWidens(freshBrowserBot?.toolScope, patch.toolScope) && auth.kind === "loopback" && !DESKTOP_MANAGED && !browserOrigin && store.bots.some((candidate) => candidate.busy)) {
          return json(res, 409, { error: "A bot is working right now, so this change has to come from the desktop app or a paired device. Try again once every bot is idle." });
        }
        if (freshBrowserBot && JSON.stringify(freshBrowserBot.toolScope) !== JSON.stringify(patch.toolScope)
          && (freshBrowserBot.busy || activeGroupTurnForBot(freshBrowserBot.id))) {
          return json(res, 409, { error: "Stop this bot's turns before changing its tool selection." });
        }
      }
      // A running turn cannot unmount custom servers; rechecked after the awaits above.
      if (body.mcpServers !== undefined) {
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
          return json(res, 401, { error: "unauthorized: this session has expired or was revoked" });
        }
        if (Array.isArray(freshBrowserBot?.mcpServers) &&
            (requestedMcpServers === undefined || requestedMcpServers.some((name) => !freshBrowserBot.mcpServers!.includes(name))) &&
            auth.kind === "loopback" && !DESKTOP_MANAGED && !browserOrigin && store.bots.some((candidate) => candidate.busy)) {
          return json(res, 409, { error: "A bot is working right now, so this change has to come from the desktop app or a paired device. Try again once every bot is idle." });
        }
        if (freshBrowserBot &&
            JSON.stringify(requestedMcpServers?.toSorted()) !== JSON.stringify(freshBrowserBot.mcpServers?.toSorted()) &&
            (freshBrowserBot.busy || activeGroupTurnForBot(freshBrowserBot.id))) {
          return json(res, 409, { error: "Stop this bot's turns before changing its MCP servers." });
        }
      }
      if (normalizedSelection && movedTask) {
        const current = store.projectBotForTask(movedTask.id, movedTask.threadId);
        if (!current) return json(res, 404, { error: "no such task" });
        const checked = checkedModelSelection(normalizedSelection, { selection: current.modelSelection, busy: threadBusy(current.id, current.threadId) });
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
        if (freshBrowserBot && activeGroupTurnForBot(freshBrowserBot.id)) {
          const groupChecked = checkedModelSelection(normalizedSelection, { selection: freshBrowserBot.modelSelection, busy: true });
          if (!groupChecked.ok) return json(res, groupChecked.status, { error: groupChecked.error });
        }
      }
      if (freshBrowserBot && body.browserProfile !== undefined &&
          patch.browserProfile !== freshBrowserBot.browserProfile &&
          (freshBrowserBot.busy || browserRuntime.heldBy(currentBrowserSession(freshBrowserBot.id, freshBrowserBot.browserProfile)))) {
        return json(res, 409, { error: "Stop the bot and release browser control before changing its profile." });
      }
      if (profile.patch.soul !== undefined) {
        if (freshBrowserBot) assertTeamComputerChangeIdle(freshBrowserBot, { ...freshBrowserBot, ...patch } as BotRecord);
      // Runtime fields keep their fail-closed order; only the profile fields commit atomically.
        const runtimePatch = { ...patch };
        for (const field of Object.keys(profile.patch)) delete runtimePatch[field];
        if (Object.keys(runtimePatch).length) store.patchBot(m[1], runtimePatch);
        bot = store.patchBotProfile(m[1], profile.patch);
      } else {
        if (freshBrowserBot) assertTeamComputerChangeIdle(freshBrowserBot, { ...freshBrowserBot, ...patch } as BotRecord);
        bot = store.patchBot(m[1], patch);
      }
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (body.applyToAllThreads === true && requestedApprovalMode !== "custom") store.setAllThreadApprovalMode(bot.id, requestedApprovalMode);
      if (body.memoryUpkeep === false || body.memoryEnabled === false) memoryUpkeep.dropBot(bot.id);
      if (body.cacheKeepWarm !== undefined) cacheKeepWarm.refresh();
      if (computerSpecified && requestedComputer !== undefined) store.clearAutoSurfacePins(m[1], requestedComputer);
      if (normalizedSelection && movedTask) store.patchTask(bot.id, movedTask.threadId, { modelSelection: undefined,
        ...hostedModels?.resetTask(movedTask.modelSelection, normalizedSelection) });
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
      if (chiefChanges === null) return json(res, 404, { error: "no such bot" });
      if (beforeProfile) {
        const now = store.bot(bot.id)!;
        recordProfileChange(bot.id, "user", "api", beforeProfile, profileSnapshot(now));
      }
      if (Object.hasOwn(patch, "visibility") && JSON.stringify(beforeVisibility ?? "everyone") !== JSON.stringify(bot.visibility ?? "everyone")) {
        for (const group of store.groups.filter((candidate) => candidate.memberIds.includes(bot!.id))) {
          broadcast({ kind: "group", group: publicGroupState(group) });
        }
        broadcast({ kind: "sections", sections: store.sections });
        audienceChanged();
      }
      return json(res, 200, { bot: wireBot(store.bot(bot.id)!),
        ...(vpsLeftOn ? { notice: vpsLeftBehindNotice("Moved", vpsLeftOn, vps.vpsContainerName(bot.id)) } : {}) });
    }
    return PASS;
  };
}
