import { z, type ZodString } from "zod";
import * as boat from "../boat.ts";
import type { ComputerControl } from "../computer-control.ts";
import { isValidSshAlias, localVmMaxInstances, localVmMode, localVmSource, type AppConfig } from "../config.ts";
import {
  containerComputerAction,
  containerComputerExists,
  containerComputerScreenshot,
  containerComputerStatus,
  SHARED_LOCAL_VM_TARGET,
  setupCommands,
  type LocalVmTarget,
  type Runtime,
} from "../container-computer.ts";
import { viewerTargetId } from "../../shared/desktop-viewer.ts";
import { existingVmScreenshot } from "../existing-vm.ts";
import { localVmViewerStatus } from "../desktop-viewer-targets.ts";
import { keepFirefoxProfileBeforeRemove } from "../local-vm-profiles.ts";
import type { ComputerIdleTimer } from "../computer-idle.ts";
import type { LocalVmLease } from "../local-vm-lease.ts";
import { redactSecretsInText } from "../redact.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { RoutineManager } from "../routines.ts";
import type { SessionRegistry } from "../sessions.ts";
import { sectionKey, type BotRecord, type Store } from "../store.ts";
import { teamComputerAssignment, teamComputerCreate, teamComputerOwner, type TeamComputerRecord, type TeamComputers } from "../team-computers.ts";
import * as vps from "../vps-computer.ts";
import { vpsAliasesInPlay } from "../vps-hosts.ts";
import type { BusyFlag, RemoteComputerProvider } from "./config.ts";
import { createComputerFramesRoutes } from "./computer-frames.ts";
import { createComputerUsageRoutes } from "./computer-usage.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** "Delete" and "Delete and recreate" keep the desktop's website sign-ins: its Firefox profile moves into the workspace first. */
async function keepSignInsBeforeRemove(target: LocalVmTarget): Promise<void> {
  const before = await containerComputerStatus(undefined, undefined, target);
  await keepFirefoxProfileBeforeRemove(target, before, () => containerComputerAction("stop", undefined, undefined, target));
}

export interface ComputerRouteDeps {
  store: Pick<Store, "bot" | "bots" | "sections">;
  cfg: AppConfig;
  sessions: Pick<SessionRegistry, "isLive">;
  teamComputers: Pick<TeamComputers, "get" | "create" | "assign" | "setProblem" | "list">;
  computerControl: Pick<ComputerControl, "snapshot" | "take" | "release" | "acquireLease" | "releaseLease" | "ownsLease">;
  routines(): Pick<RoutineManager, "activeRunForBot"> | null;
  controlLeaseIdSchema: ZodString;
  boatLifecycleBusyBots: Pick<Set<string>, "has">;
  computerProviderConfigTransitions: Pick<Set<RemoteComputerProvider>, "has">;
  localVmActiveThreads: Pick<Map<string, string>, "has">;
  localVmLifecycleBusy: Pick<Set<string>, "has" | "add" | "delete">;
  localVmSeen: Pick<Set<string>, "add">;
  localVmImageBusy: BusyFlag;
  localVmProvisionBusy: BusyFlag;
  localVmModeChangeBusy: Pick<BusyFlag, "get">;
  localVmOwnerBusy(botId: string): boolean;
  localVmIdleMs(): number;
  localVmLeaseFor(target: LocalVmTarget): Pick<LocalVmLease, "current">;
  localVmIdleFor(target: LocalVmTarget): Pick<ComputerIdleTimer, "touch" | "cancel">;
  localVmTargetForBot(botId: string): LocalVmTarget;
  localVmTargetForStatus(botId: string, threadId?: string): LocalVmTarget;
  localVmPayload(target: LocalVmTarget, auth: RequestAuth): Promise<unknown>;
  localVmInventoryPayload(): Promise<unknown>;
  existingPerBotLocalVmCount(runtime: Runtime): Promise<number>;
  teamComputersPayload(): Promise<unknown>;
  teamComputerInUse(computer: TeamComputerRecord): boolean;
  managedBoatOwners(): boat.ManagedBoatOwner[];
  providerTransitionMessage(provider: RemoteComputerProvider): string;
  botHasActiveTurn(botId: string): boolean;
  botComputerControlKey(bot: BotRecord): string;
  botComputerControlSnapshot(botId: string): { held: boolean };
  computerPreviewBot(botId: string, url: URL): BotRecord | null;
  computerPreviewSurface(bot: BotRecord, threadId?: string): Promise<string | undefined>;
  claimTeamComputerLifecycle(computer: TeamComputerRecord): () => void;
  /** `allowPreview`: a desktop link only reads the screen, so a panel's preview in flight does not refuse it. */
  claimBotComputerLifecycle(botId: string, allowPreview?: boolean): () => void;
  claimBoatInventoryRequest(boxId: string): () => void;
  claimManagedBoatMutation(instance: boat.ManagedBoatInventoryInstance): () => void;
  claimManagedVpsMutation(containerName: string): () => void;
  /** A cloud computer was just woken, created or opened: its idle window starts again. */
  cloudComputerUsed(owner: string): void;
}

export function createComputerRoutes(deps: ComputerRouteDeps): RouteHandler {
  const {
    store, cfg, sessions, teamComputers, computerControl, controlLeaseIdSchema, boatLifecycleBusyBots,
    computerProviderConfigTransitions, localVmActiveThreads, localVmLifecycleBusy, localVmSeen, localVmImageBusy,
    localVmProvisionBusy, localVmModeChangeBusy, localVmOwnerBusy, localVmIdleMs, localVmLeaseFor, localVmIdleFor,
    localVmTargetForBot, localVmTargetForStatus, localVmPayload, localVmInventoryPayload, existingPerBotLocalVmCount,
    teamComputersPayload, teamComputerInUse, managedBoatOwners, providerTransitionMessage, botHasActiveTurn,
    botComputerControlKey, botComputerControlSnapshot, computerPreviewBot, computerPreviewSurface,
    claimTeamComputerLifecycle, claimBotComputerLifecycle, claimBoatInventoryRequest, claimManagedBoatMutation,
    claimManagedVpsMutation, cloudComputerUsed,
  } = deps;
  const usage = createComputerUsageRoutes(deps);
  const frames = createComputerFramesRoutes(deps);
  return async (context) => {
    if (await usage(context) !== PASS) return;
    if (await frames(context) !== PASS) return;
    const { req, res, url, path, method, auth, json, readBody } = context;
    const routines = deps.routines();
    let m: RegExpMatchArray | null = null;
    // Team Boats have real ownership, never a hidden bot or an arbitrary provider id. Admin-only.
    if (path === "/api/team-computers" && method === "GET") {
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, await teamComputersPayload());
    }
    m = path.match(/^\/api\/team-computers(?:\/([\w-]+)(?:\/(provision|join|sleep|control))?)?$/);
    if (m) {
      const computerId = m[1];
      const action = m[2];
      let found = computerId ? teamComputers.get(computerId) : undefined;
      if (computerId && !found) return json(res, 404, { error: "No such team computer" });
      if (method === "GET" && action === "control" && found) {
        return json(res, 200, computerControl.snapshot(teamComputerOwner(found.id)));
      }
      if (method === "GET" && action !== "control") {
        return json(res, 404, { error: "unknown team computer action" });
      }
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
      const body = await readBody(req);
      found = computerId ? teamComputers.get(computerId) : undefined;
      const assertCurrentOwner = () => {
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) throw Object.assign(new Error("Your session ended; sign in again"), { status: 401 });
        if (computerProviderConfigTransitions.has("box")) throw Object.assign(new Error(providerTransitionMessage("box")), { status: 409 });
      };
      assertCurrentOwner();
      if (action === "control" && method === "POST" && found) {
        const parsed = z.object({ action: z.enum(["take", "release"]), controlLeaseId: controlLeaseIdSchema.optional() }).strict().safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Choose take or release with a valid optional controlLeaseId" });
        const key = teamComputerOwner(found.id);
        if (parsed.data.action === "take" && boatLifecycleBusyBots.has(key)) return json(res, 409, { error: "Wait for this computer's action to finish before taking control" });
        if (parsed.data.controlLeaseId) {
          const result = parsed.data.action === "take"
            ? computerControl.acquireLease(key, parsed.data.controlLeaseId)
            : computerControl.releaseLease(key, parsed.data.controlLeaseId);
          return json(res, 200, { ...result.snapshot, ...result });
        }
        return json(res, 200, parsed.data.action === "take" ? computerControl.take(key) : computerControl.release(key));
      }
      if (method === "PATCH" && found && !action) {
        const parsed = teamComputerAssignment.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Confirm shared desktop access with section and acknowledgeSharedAccess: true" });
        const section = parsed.data.section;
        const checkAssignment = () => {
          assertCurrentOwner();
          if (section !== null && section !== "" && !store.sections.includes(section)) throw Object.assign(new Error("Create the team before assigning a computer"), { status: 404 });
          if (section !== null && store.bots.some(bot => sectionKey(bot.section) === section && (
            botHasActiveTurn(bot.id) || routines?.activeRunForBot(bot.id) || botComputerControlSnapshot(bot.id).held || boatLifecycleBusyBots.has(bot.id)
          ))) throw Object.assign(new Error("Stop the target team's work and release computer control before assigning this computer"), { status: 409 });
        };
        checkAssignment();
        const release = claimTeamComputerLifecycle(found);
        try {
          if (section !== null && !(await boat.findBoat(cfg, teamComputerOwner(found.id)))) return json(res, 409, { error: "Create or retry this computer before assigning it to a team" });
          checkAssignment();
          if (teamComputerInUse(found)) return json(res, 409, { error: "This team computer became busy; stop its work before assigning it" });
          teamComputers.assign(found.id, section);
          return json(res, 200, { ok: true });
        } finally { release(); }
      }
      if (method === "POST" && !computerId) {
        const parsed = teamComputerCreate.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Provide requestId (UUID), a name, and acknowledgeCost: true to create a paid cloud computer" });
        if (!boat.boatConfigured(cfg)) return json(res, 409, { error: "Configure Boat in Settings before creating a cloud computer" });
        const computer = teamComputers.create(parsed.data.name, parsed.data.requestId);
        const release = claimTeamComputerLifecycle(computer);
        try {
          await boat.provisionBoat(cfg, teamComputerOwner(computer.id), computer.name);
          teamComputers.setProblem(computer.id);
          return json(res, 201, { id: computer.id });
        } catch (error) {
          teamComputers.setProblem(computer.id, redactSecretsInText(error instanceof Error ? error.message : String(error)));
          throw error;
        } finally { release(); cloudComputerUsed(teamComputerOwner(computer.id)); }
      }
      if (method === "POST" && found && action && action !== "control") {
        if (action === "provision" && body?.acknowledgeCost !== true) return json(res, 400, { error: "Confirm cloud computer creation or wake costs with acknowledgeCost: true" });
        // A ready-only join never wakes, provisions or steals an agent's turn: human control takes its own lease first.
        if (action === "join") {
          const key = teamComputerOwner(found.id);
          if (boatLifecycleBusyBots.has(key)) return json(res, 409, { error: "Wait for this computer's action to finish" });
          if (!computerControl.snapshot(key).held) return json(res, 409, { error: "Take control before opening this shared desktop" });
          const release = claimBotComputerLifecycle(key, true);
          try { return json(res, 200, await boat.joinReadyBoat(cfg, key)); }
          finally { release(); cloudComputerUsed(key); }
        }
        const release = claimTeamComputerLifecycle(found);
        try {
          const result = action === "provision"
            ? await boat.provisionBoat(cfg, teamComputerOwner(found.id), found.name)
            : await boat.sleepBoat(cfg, teamComputerOwner(found.id));
          teamComputers.setProblem(found.id);
          return json(res, 200, result);
        } catch (error) {
          teamComputers.setProblem(found.id, redactSecretsInText(error instanceof Error ? error.message : String(error)));
          throw error;
        } finally { release(); if (action === "provision") cloudComputerUsed(teamComputerOwner(found.id)); }
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // Read-only; lifecycle changes are revalidated against a fresh provider listing. The path keeps its historical /boxes segment.
    if (method === "GET" && path === "/api/computers/boxes") {
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, await boat.listManagedBoats(cfg, managedBoatOwners()));
    }
    m = path.match(/^\/api\/computers\/boxes\/([\w-]+)\/(sleep|delete)$/);
    if (m && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (computerProviderConfigTransitions.has("box")) {
        return json(res, 409, { error: providerTransitionMessage("box") });
      }
      const releaseInventoryRequest = claimBoatInventoryRequest(m[1]);
      try {
        const owners = managedBoatOwners();
        if (m[2] === "sleep") {
          return json(res, 200, await boat.sleepManagedBoat(cfg, owners, m[1], claimManagedBoatMutation));
        }
        if (typeof body?.confirmName !== "string" || body.confirmName.length > 100) {
          return json(res, 400, { error: "confirmName must be the cloud computer name shown in Settings" });
        }
        return json(res, 202, await boat.deleteManagedBoat(
          cfg,
          owners,
          m[1],
          body.confirmName,
          claimManagedBoatMutation,
        ));
      } finally {
        releaseInventoryRequest();
      }
    }
    if (method === "GET" && path === "/api/computers/vps") {
      res.setHeader("cache-control", "private, no-store");
      // Computers live on the default server and on each bot's own: list them all, tagged by alias.
      return json(res, 200, await vps.listManagedVpsComputers(
        cfg,
        managedBoatOwners(),
        undefined,
        vpsAliasesInPlay(cfg, store.bots),
      ));
    }
    m = path.match(/^\/api\/computers\/vps\/([\w-]+)\/remove$/);
    if (m && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (computerProviderConfigTransitions.has("vps")) {
        return json(res, 409, { error: providerTransitionMessage("vps") });
      }
      if (typeof body?.confirmName !== "string" || body.confirmName.length > 100) {
        return json(res, 400, { error: "confirmName must be the VPS computer name shown in Settings" });
      }
      const alias = body?.alias;
      if (alias !== undefined && !isValidSshAlias(alias)) {
        return json(res, 400, { error: "alias must be a simple SSH config alias" });
      }
      // An explicit alias may only name a server the inventory scans: anything else would open
      // docker-over-SSH to an arbitrary host from the user's SSH config.
      if (alias !== undefined && !vpsAliasesInPlay(cfg, store.bots).includes(alias)) {
        return json(res, 400, { error: "alias must be the default server or a bot's own SSH alias" });
      }
      const releaseComputerLifecycle = claimManagedVpsMutation(m[1]);
      try {
        return json(res, 200, await vps.removeManagedVpsComputer(
          alias ? { vps: { sshAlias: alias } } : cfg,
          managedBoatOwners(),
          m[1],
          body.confirmName,
        ));
      } finally {
        releaseComputerLifecycle();
      }
    }

    if (method === "GET" && path === "/api/local-computer") {
      return json(res, 200, await localVmPayload(SHARED_LOCAL_VM_TARGET, auth));
    }
    if (method === "GET" && path === "/api/local-computer/instances") {
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, await localVmInventoryPayload());
    }
    m = path.match(/^\/api\/local-computer\/(pull|run|start|stop|remove)$/);
    if (m && method === "POST") {
      // JSON-only makes these non-simple requests: a hostile page cannot form-post them, and with no CORS the preflight stops them.
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const action = z.enum(["pull", "run", "start", "stop", "remove"]).parse(m[1]);
      if (localVmSource(cfg) === "existing") {
        return json(res, 409, {
          error: "Existing VM is user-managed; OpenMausBot does not create, start, stop, replace, or delete it",
        });
      }
      if (localVmImageBusy.get() || localVmModeChangeBusy.get() || localVmLifecycleBusy.has(SHARED_LOCAL_VM_TARGET.key)) {
        return json(res, 409, { error: "another Local VM setup action is still running" });
      }
      if (localVmMode(cfg) === "per-bot" && action === "run") {
        return json(res, 409, { error: "Per-bot mode creates each desktop from that bot's Computer panel" });
      }
      if (localVmMode(cfg) === "pool" && action === "run") {
        return json(res, 409, { error: "Pool mode creates its desktops automatically from conversation turns" });
      }
      const vmOwner = localVmLeaseFor(SHARED_LOCAL_VM_TARGET).current(localVmOwnerBusy);
      if (vmOwner && (action === "stop" || action === "remove" || action === "run")) {
        return json(res, 409, { error: "the Local VM is being used by a bot — stop that turn first" });
      }
      // A lease can lapse under a long, quiet turn, so also refuse while the thread registry or a setup action pins it.
      if ((action === "stop" || action === "remove") && (localVmActiveThreads.has(SHARED_LOCAL_VM_TARGET.key) || localVmLifecycleBusy.has(SHARED_LOCAL_VM_TARGET.key))) {
        return json(res, 409, { error: localVmActiveThreads.has(SHARED_LOCAL_VM_TARGET.key) ? "the Local VM is being used by a bot — stop that turn first" : "another Local VM setup action is still running" });
      }
      if (action === "pull") localVmImageBusy.set(true);
      else localVmLifecycleBusy.add(SHARED_LOCAL_VM_TARGET.key);
      try {
        if (action === "remove") await keepSignInsBeforeRemove(SHARED_LOCAL_VM_TARGET);
        const status = await containerComputerAction(action, undefined, undefined, SHARED_LOCAL_VM_TARGET);
        if (action === "run" || action === "start") {
          localVmSeen.add(SHARED_LOCAL_VM_TARGET.key);
          localVmIdleFor(SHARED_LOCAL_VM_TARGET).touch();
        }
        if (action === "stop" || action === "remove") localVmIdleFor(SHARED_LOCAL_VM_TARGET).cancel();
        return json(res, 200, {
          ...localVmViewerStatus(status, auth),
          commands: setupCommands(status.runtime, process.platform, SHARED_LOCAL_VM_TARGET),
          idle_timeout_ms: localVmIdleMs(),
          mode: localVmMode(cfg),
          max_instances: localVmMaxInstances(cfg),
        });
      } finally {
        if (action === "pull") localVmImageBusy.set(false);
        else localVmLifecycleBusy.delete(SHARED_LOCAL_VM_TARGET.key);
      }
    }
    if (method === "POST" && path === "/api/local-computer/screenshot") {
      if (localVmSource(cfg) === "existing") {
        const frame = await existingVmScreenshot(cfg);
        return json(res, 200, { image: `data:image/${frame.format};base64,${frame.png}` });
      }
      localVmIdleFor(SHARED_LOCAL_VM_TARGET).touch();
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, {
        image: await containerComputerScreenshot(undefined, undefined, SHARED_LOCAL_VM_TARGET),
      });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer$/);
    if (m && method === "GET") {
      const bot = computerPreviewBot(m[1], url);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, await localVmPayload(localVmTargetForStatus(bot.id, bot.threadId), auth));
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer\/(run|start|stop|remove)$/);
    if (m && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (localVmSource(cfg) === "existing") {
        return json(res, 409, {
          error: "Existing VM is user-managed; OpenMausBot does not create, start, stop, replace, or delete it",
        });
      }
      if (boatLifecycleBusyBots.has(bot.id)) {
        return json(res, 409, { error: "this bot's computer is being changed or deleted — wait for it to finish" });
      }
      const action = z.enum(["run", "start", "stop", "remove"]).parse(m[2]);
      const target = localVmTargetForBot(bot.id);
      if (target.key === SHARED_LOCAL_VM_TARGET.key) {
        return json(res, 409, { error: "Shared mode manages this desktop in App Settings → Computers" });
      }
      if (localVmImageBusy.get() || localVmModeChangeBusy.get() || localVmLifecycleBusy.has(target.key)) {
        return json(res, 409, { error: "this bot's Local VM setup action is still running" });
      }
      if (action === "run" && localVmProvisionBusy.get()) {
        return json(res, 409, { error: "another per-bot Local VM is being created — retry after it finishes" });
      }
      const vmOwner = localVmLeaseFor(target).current(localVmOwnerBusy);
      if (vmOwner) return json(res, 409, { error: "this bot is using its Local VM — stop the turn first" });
      if ((action === "stop" || action === "remove") && (localVmActiveThreads.has(target.key) || localVmLifecycleBusy.has(target.key))) {
        return json(res, 409, { error: localVmActiveThreads.has(target.key) ? "this bot is using its Local VM — stop the turn first" : "this bot's Local VM setup action is still running" });
      }
      // Fenced before the first await, so two requests cannot both pass the limit.
      localVmLifecycleBusy.add(target.key);
      if (action === "run") localVmProvisionBusy.set(true);
      try {
        if (action === "run") {
          const before = await containerComputerStatus(undefined, undefined, target);
          if (!before.runtime) return json(res, 409, { error: before.problem ?? "No container runtime is installed" });
          if (!(await containerComputerExists(before.runtime, target))) {
            const count = await existingPerBotLocalVmCount(before.runtime);
            if (count >= localVmMaxInstances(cfg)) {
              return json(res, 409, {
                error: `The per-bot Local VM limit is ${localVmMaxInstances(cfg)} — delete an unused bot VM or raise the limit in App Settings`,
              });
            }
          }
        }
        if (action === "remove") await keepSignInsBeforeRemove(target);
        const status = await containerComputerAction(action, undefined, undefined, target);
        if (action === "run" || action === "start") {
          localVmSeen.add(target.key);
          localVmIdleFor(target).touch();
        }
        if (action === "stop" || action === "remove") localVmIdleFor(target).cancel();
        return json(res, 200, {
          ...localVmViewerStatus(status, auth),
          commands: setupCommands(status.runtime, process.platform, target),
          idle_timeout_ms: localVmIdleMs(),
          mode: localVmMode(cfg),
          max_instances: localVmMaxInstances(cfg),
        });
      } finally {
        if (action === "run") localVmProvisionBusy.set(false);
        localVmLifecycleBusy.delete(target.key);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer\/screenshot$/);
    if (m && method === "POST") {
      const bot = computerPreviewBot(m[1], url);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (localVmSource(cfg) === "existing") {
        const frame = await existingVmScreenshot(cfg);
        return json(res, 200, { image: `data:image/${frame.format};base64,${frame.png}` });
      }
      if (url.searchParams.has("threadId") && await computerPreviewSurface(bot, bot.threadId) !== "vm") {
        return json(res, 409, { error: "This conversation is not using the Local VM" });
      }
      const target = localVmTargetForStatus(bot.id, url.searchParams.has("threadId") ? bot.threadId : undefined);
      localVmIdleFor(target).touch();
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, {
        image: await containerComputerScreenshot(undefined, undefined, target),
      });
    }
    // Granted only to the control lease holding this bot's computer, and only with admin scope. The loopback companion
    // sidecar gets the noVNC address (VNC password included); a directly paired phone gets only the lease-bound proxy.
    m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer\/join$/);
    if (m && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const bot = computerPreviewBot(m[1], url);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const threadId = url.searchParams.has("threadId") ? bot.threadId : undefined;
      if (threadId && await computerPreviewSurface(bot, threadId) !== "vm") {
        return json(res, 409, { error: "This conversation is not using the Local VM" });
      }
      if (localVmMode(cfg) !== "per-bot") {
        return json(res, 409, { error: "Phone control requires a per-bot Local VM. Select per-bot mode in Settings → Computers." });
      }
      const lease = controlLeaseIdSchema.safeParse(url.searchParams.get("controlLeaseId") ?? undefined);
      if (!lease.success) return json(res, 400, { error: "controlLeaseId is required" });
      const controlBot = store.bot(bot.id);
      if (!controlBot || !computerControl.ownsLease(botComputerControlKey(controlBot), lease.data)) {
        return json(res, 409, { error: "Take control of this computer first" });
      }
      const target = localVmTargetForStatus(bot.id, threadId);
      const status = await containerComputerStatus(undefined, undefined, target);
      if (!status.ready || !status.managed || status.container !== "running" || status.network !== "loopback"
        || !status.viewer_url) {
        return json(res, 409, { error: status.problem ?? "The Local VM is not ready" });
      }
      localVmIdleFor(target).touch();
      res.setHeader("cache-control", "private, no-store");
      if (auth.kind === "loopback") return json(res, 200, { joinUrl: status.viewer_url });
      const socket = new URLSearchParams({ botId: bot.id, ...(threadId ? { threadId } : {}), controlLeaseId: lease.data });
      return json(res, 200, {
        socketPath: `api/desktop-viewer/${viewerTargetId(target)}/websockify?${socket}`,
        password: new URLSearchParams(new URL(status.viewer_url).hash.slice(1)).get("password"),
      });
    }
    return PASS;
  };
}
