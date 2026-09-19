// The computer HTTP routes (local-computer interrupt, the team-Boxes CRUD
// and provision/join/sleep/control actions, the account-wide Box and VPS
// inventory, and the shared and per-bot Local VM lifecycle with
// screenshots), extracted verbatim from index.ts's dispatch chain. Path
// matching, methods, and status codes are unchanged; the handler returns
// false for anything it does not own so the chain falls through in the
// same order. The interrupt block used to sit immediately after
// handleBotManagement; this module's call site is the old team-computers
// position, so interrupt now matches later. Every surviving matcher
// between those two slots is a /api/bots/:id/* subpath (skills, soul,
// system prompt, overview, history, memory, checkpoints, cards,
// messages, queue, branches, respond, projects, tasks),
// /api/section-context, or /api/threads/:id/respond — all disjoint from
// the exact /api/local-computer/interrupt path, so no request can change
// which handler wins. The lifecycle helpers, registries and busy flags
// are index-local and cross via deps: routines is a late-bound thunk over
// index.ts's let, the mutable localVmImageBusy/localVmProvisionBusy flags
// cross as get/set pairs, read-only localVmModeChangeBusy as a thunk, and
// the localVmLifecycleBusy set by reference; store/cfg are live bindings
// from ../runtime.ts and the provider helpers are imported from their
// source modules.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import { z } from "zod";
import { cfg, store } from "../runtime.ts";
import { sectionKey } from "../store.ts";
import * as box from "../box.ts";
import * as vps from "../vps-computer.ts";
import { teamComputerAssignment, teamComputerCreate, teamComputerOwner, type TeamComputers } from "../team-computers.ts";
import { redactSecretsInText } from "../redact.ts";
import {
  containerComputerAction,
  containerComputerExists,
  containerComputerScreenshot,
  containerComputerStatus,
  SHARED_LOCAL_VM_TARGET,
  setupCommands,
} from "../container-computer.ts";
import { localVmMaxInstances, localVmMode } from "../config.ts";
import { revokeInternalCapabilitiesForThread } from "../internal-capabilities.ts";
import { closeOpenApprovals } from "../turn-fold.ts";
import type { RoutineManager } from "../routines.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { createComputerLifecycle } from "../computer-lifecycle.ts";
import type { createTurnIntegrations } from "../turn-integrations.ts";
import type { createGroupTurnOperations } from "../group-turn-operations.ts";
import type { createLocalVmTurnPrep } from "../local-vm-turn-prep.ts";

type ComputerLifecycle = ReturnType<typeof createComputerLifecycle>;
type TurnIntegrations = ReturnType<typeof createTurnIntegrations>;
type GroupTurnOperations = ReturnType<typeof createGroupTurnOperations>;
type LocalVmTurnPrep = ReturnType<typeof createLocalVmTurnPrep>;

export function createComputersRoutes(deps: {
  routines: () => RoutineManager | null;
  sessions: SessionRegistry;
  interruptAllDirectThreads: (botId: string) => Promise<void>;
  cancelDirectTurnDispatch: TurnIntegrations["cancelDirectTurnDispatch"];
  activeGroupTurnForBot: GroupTurnOperations["activeGroupTurnForBot"];
  cancelGroupTurnOperations: GroupTurnOperations["cancelGroupTurnOperations"];
  runningTurnInstance: ComputerLifecycle["runningTurnInstance"];
  teamComputers: TeamComputers;
  teamComputersPayload: ComputerLifecycle["teamComputersPayload"];
  computerControl: TurnIntegrations["computerControl"];
  controlLeaseIdSchema: TurnIntegrations["controlLeaseIdSchema"];
  computerProviderConfigTransitions: ComputerLifecycle["computerProviderConfigTransitions"];
  providerTransitionMessage: ComputerLifecycle["providerTransitionMessage"];
  boxLifecycleBusyBots: ComputerLifecycle["boxLifecycleBusyBots"];
  assertTeamControlCanBeTaken: ComputerLifecycle["assertTeamControlCanBeTaken"];
  botHasActiveTurn: ComputerLifecycle["botHasActiveTurn"];
  botComputerControlSnapshot: ComputerLifecycle["botComputerControlSnapshot"];
  claimTeamComputerLifecycle: ComputerLifecycle["claimTeamComputerLifecycle"];
  claimBotComputerLifecycle: ComputerLifecycle["claimBotComputerLifecycle"];
  teamComputerInUse: ComputerLifecycle["teamComputerInUse"];
  managedBoxOwners: ComputerLifecycle["managedBoxOwners"];
  claimBoxInventoryRequest: ComputerLifecycle["claimBoxInventoryRequest"];
  claimManagedBoxMutation: ComputerLifecycle["claimManagedBoxMutation"];
  claimManagedVpsMutation: ComputerLifecycle["claimManagedVpsMutation"];
  localVmOwnerBusy: ComputerLifecycle["localVmOwnerBusy"];
  localVmLeaseFor: ComputerLifecycle["localVmLeaseFor"];
  localVmIdleFor: ComputerLifecycle["localVmIdleFor"];
  localVmTargetForBot: ComputerLifecycle["localVmTargetForBot"];
  localVmInventoryPayload: ComputerLifecycle["localVmInventoryPayload"];
  localVmLifecycleBusy: ComputerLifecycle["localVmLifecycleBusy"];
  localVmActiveThreads: ComputerLifecycle["localVmActiveThreads"];
  LOCAL_VM_IDLE_MS: ComputerLifecycle["LOCAL_VM_IDLE_MS"];
  computerPreviewBot: ComputerLifecycle["computerPreviewBot"];
  computerPreviewSurface: ComputerLifecycle["computerPreviewSurface"];
  localVmPayload: LocalVmTurnPrep["localVmPayload"];
  existingPerBotLocalVmCount: LocalVmTurnPrep["existingPerBotLocalVmCount"];
  localVmImageBusy: { get: () => boolean; set: (value: boolean) => void };
  localVmModeChangeBusy: () => boolean;
  localVmProvisionBusy: { get: () => boolean; set: (value: boolean) => void };
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, url, auth } = rctx;
    /** scratch for route matches, shared by every `path.match` below */
    let m: RegExpMatchArray | null = null;
    const {
      routines,
      sessions,
      interruptAllDirectThreads,
      cancelDirectTurnDispatch,
      activeGroupTurnForBot,
      cancelGroupTurnOperations,
      runningTurnInstance,
      teamComputers,
      teamComputersPayload,
      computerControl,
      controlLeaseIdSchema,
      computerProviderConfigTransitions,
      providerTransitionMessage,
      boxLifecycleBusyBots,
      assertTeamControlCanBeTaken,
      botHasActiveTurn,
      botComputerControlSnapshot,
      claimTeamComputerLifecycle,
      claimBotComputerLifecycle,
      teamComputerInUse,
      managedBoxOwners,
      claimBoxInventoryRequest,
      claimManagedBoxMutation,
      claimManagedVpsMutation,
      localVmOwnerBusy,
      localVmLeaseFor,
      localVmIdleFor,
      localVmTargetForBot,
      localVmInventoryPayload,
      localVmLifecycleBusy,
      localVmActiveThreads,
      LOCAL_VM_IDLE_MS,
      computerPreviewBot,
      computerPreviewSurface,
      localVmPayload,
      existingPerBotLocalVmCount,
      localVmImageBusy,
      localVmModeChangeBusy,
      localVmProvisionBusy,
    } = deps;
    if (method === "POST" && path === "/api/local-computer/interrupt") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      await Promise.allSettled(
        store.bots
          .filter((bot) => bot.computer === "local")
          .map(async (bot) => {
            await interruptAllDirectThreads(bot.id);
            const routineRun = routines()!.activeBotRunForBot(bot.id);
            if (routineRun) {
              cancelDirectTurnDispatch(bot.id, routineRun.threadId);
              if (routineRun.threadId) {
                revokeInternalCapabilitiesForThread(routineRun.threadId);
              }
              await routines()!.cancelRun(routineRun.id);
            }
            const groupTurn = activeGroupTurnForBot(bot.id);
            if (groupTurn) {
              cancelGroupTurnOperations(groupTurn.group.id, groupTurn.threadId);
              revokeInternalCapabilitiesForThread(groupTurn.threadId);
              await runningTurnInstance(bot, groupTurn.threadId)?.adapter.interruptTurn(groupTurn.threadId).catch(() => {});
              closeOpenApprovals(groupTurn.threadId);
            }
          }),
      );
      json(res, 200, { ok: true });
      return true;
    }

    // Named team Boxes use real independent ownership, never a hidden bot or
    // an arbitrary provider id. These new routes remain admin-only by default.
    if (path === "/api/team-computers" && method === "GET") {
      res.setHeader("cache-control", "private, no-store");
      json(res, 200, await teamComputersPayload());
      return true;
    }
    m = path.match(/^\/api\/team-computers(?:\/([\w-]+)(?:\/(provision|join|sleep|control))?)?$/);
    if (m) {
      const computerId = m[1];
      const action = m[2];
      let found = computerId ? teamComputers.get(computerId) : undefined;
      if (computerId && !found) {
        json(res, 404, { error: "No such team computer" });
        return true;
      }
      if (method === "GET" && action === "control" && found) {
        json(res, 200, computerControl.snapshot(teamComputerOwner(found.id)));
        return true;
      }
      // A GET carries no body, so the content-type gate below can only
      // mislead: the control snapshot is the sole GET on this subtree.
      if (method === "GET" && action !== "control") {
        json(res, 404, { error: "unknown team computer action" });
        return true;
      }
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      const body = await readBody(req);
      found = computerId ? teamComputers.get(computerId) : undefined;
      const assertCurrentOwner = () => {
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) throw Object.assign(new Error("Your session ended; sign in again"), { status: 401 });
        if (computerProviderConfigTransitions.has("box")) throw Object.assign(new Error(providerTransitionMessage("box")), { status: 409 });
      };
      assertCurrentOwner();
      if (action === "control" && method === "POST" && found) {
        const parsed = z.object({ action: z.enum(["take", "release"]), controlLeaseId: controlLeaseIdSchema.optional() }).strict().safeParse(body);
        if (!parsed.success) {
          json(res, 400, { error: "Choose take or release with a valid optional controlLeaseId" });
          return true;
        }
        const key = teamComputerOwner(found.id);
        if (parsed.data.action === "take" && boxLifecycleBusyBots.has(key)) {
          json(res, 409, { error: "Wait for this computer's action to finish before taking control" });
          return true;
        }
        if (parsed.data.action === "take") assertTeamControlCanBeTaken(found.id);
        if (parsed.data.controlLeaseId) {
          const result = parsed.data.action === "take"
            ? computerControl.acquireLease(key, parsed.data.controlLeaseId)
            : computerControl.releaseLease(key, parsed.data.controlLeaseId);
          json(res, 200, { ...result.snapshot, ...result });
          return true;
        }
        json(res, 200, parsed.data.action === "take" ? computerControl.take(key) : computerControl.release(key));
        return true;
      }
      if (method === "PATCH" && found && !action) {
        const parsed = teamComputerAssignment.safeParse(body);
        if (!parsed.success) {
          json(res, 400, { error: "Confirm shared desktop access with section and acknowledgeSharedAccess: true" });
          return true;
        }
        const section = parsed.data.section;
        const checkAssignment = () => {
          assertCurrentOwner();
          if (section !== null && section !== "" && !store.sections.includes(section)) throw Object.assign(new Error("Create the team before assigning a computer"), { status: 404 });
          if (section !== null && store.bots.some(bot => sectionKey(bot.section) === section && (
            botHasActiveTurn(bot.id) || routines()?.activeRunForBot(bot.id) || botComputerControlSnapshot(bot.id).held || boxLifecycleBusyBots.has(bot.id)
          ))) throw Object.assign(new Error("Stop the target team's work and release computer control before assigning this computer"), { status: 409 });
        };
        checkAssignment();
        const release = claimTeamComputerLifecycle(found);
        try {
          if (section !== null && !(await box.findBox(cfg, teamComputerOwner(found.id)))) {
            json(res, 409, { error: "Create or retry this computer before assigning it to a team" });
            return true;
          }
          checkAssignment();
          if (teamComputerInUse(found)) {
            json(res, 409, { error: "This team computer became busy; stop its work before assigning it" });
            return true;
          }
          teamComputers.assign(found.id, section);
          json(res, 200, { ok: true });
          return true;
        } finally { release(); }
      }
      if (method === "POST" && !computerId) {
        const parsed = teamComputerCreate.safeParse(body);
        if (!parsed.success) {
          json(res, 400, { error: "Provide requestId (UUID), a name, and acknowledgeCost: true to create a paid Box" });
          return true;
        }
        if (!box.boxConfigured(cfg)) {
          json(res, 409, { error: "Configure Box in Settings before creating a cloud computer" });
          return true;
        }
        const computer = teamComputers.create(parsed.data.name, parsed.data.requestId);
        const release = claimTeamComputerLifecycle(computer);
        try {
          await box.provisionBox(cfg, teamComputerOwner(computer.id), computer.name);
          teamComputers.setProblem(computer.id);
          json(res, 201, { id: computer.id });
          return true;
        } catch (error) {
          teamComputers.setProblem(computer.id, redactSecretsInText(error instanceof Error ? error.message : String(error)));
          throw error;
        } finally { release(); }
      }
      if (method === "POST" && found && action && action !== "control") {
        if (action === "provision" && body?.acknowledgeCost !== true) {
          json(res, 400, { error: "Confirm Box creation or wake costs with acknowledgeCost: true" });
          return true;
        }
        // A ready-only join never wakes, provisions or steals an agent's turn.
        // The caller takes a separate explicit human-control lease first.
        if (action === "join") {
          const key = teamComputerOwner(found.id);
          if (boxLifecycleBusyBots.has(key)) {
            json(res, 409, { error: "Wait for this computer's action to finish" });
            return true;
          }
          if (!computerControl.snapshot(key).held) {
            json(res, 409, { error: "Take control before opening this shared desktop" });
            return true;
          }
          const release = claimBotComputerLifecycle(key);
          try {
            json(res, 200, await box.joinReadyBox(cfg, key));
            return true;
          }
          finally { release(); }
        }
        const release = claimTeamComputerLifecycle(found);
        try {
          const result = action === "provision"
            ? await box.provisionBox(cfg, teamComputerOwner(found.id), found.name)
            : await box.sleepBox(cfg, teamComputerOwner(found.id));
          teamComputers.setProblem(found.id);
          json(res, 200, result);
          return true;
        } catch (error) {
          teamComputers.setProblem(found.id, redactSecretsInText(error instanceof Error ? error.message : String(error)));
          throw error;
        } finally { release(); }
      }
      json(res, 405, { error: "method not allowed" });
      return true;
    }

    // Account-wide Box inventory is a Settings surface, never a provisioning
    // path. Listing remains read-only; lifecycle changes require explicit
    // JSON actions and are revalidated against a fresh provider listing.
    if (method === "GET" && path === "/api/computers/boxes") {
      res.setHeader("cache-control", "private, no-store");
      json(res, 200, await box.listManagedBoxes(cfg, managedBoxOwners()));
      return true;
    }
    m = path.match(/^\/api\/computers\/boxes\/([\w-]+)\/(sleep|delete)$/);
    if (m && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      const body = await readBody(req);
      if (computerProviderConfigTransitions.has("box")) {
        json(res, 409, { error: providerTransitionMessage("box") });
        return true;
      }
      const releaseInventoryRequest = claimBoxInventoryRequest(m[1]);
      try {
        const owners = managedBoxOwners();
        if (m[2] === "sleep") {
          json(res, 200, await box.sleepManagedBox(cfg, owners, m[1], claimManagedBoxMutation));
          return true;
        }
        if (typeof body?.confirmName !== "string" || body.confirmName.length > 100) {
          json(res, 400, { error: "confirmName must be the cloud computer name shown in Settings" });
          return true;
        }
        json(res, 202, await box.deleteManagedBox(
          cfg,
          owners,
          m[1],
          body.confirmName,
          claimManagedBoxMutation,
        ));
        return true;
      } finally {
        releaseInventoryRequest();
      }
    }
    if (method === "GET" && path === "/api/computers/vps") {
      res.setHeader("cache-control", "private, no-store");
      json(res, 200, await vps.listManagedVpsComputers(cfg, managedBoxOwners()));
      return true;
    }
    m = path.match(/^\/api\/computers\/vps\/([\w-]+)\/remove$/);
    if (m && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      const body = await readBody(req);
      if (computerProviderConfigTransitions.has("vps")) {
        json(res, 409, { error: providerTransitionMessage("vps") });
        return true;
      }
      if (typeof body?.confirmName !== "string" || body.confirmName.length > 100) {
        json(res, 400, { error: "confirmName must be the VPS computer name shown in Settings" });
        return true;
      }
      const releaseComputerLifecycle = claimManagedVpsMutation(m[1]);
      try {
        json(res, 200, await vps.removeManagedVpsComputer(
          cfg,
          managedBoxOwners(),
          m[1],
          body.confirmName,
        ));
        return true;
      } finally {
        releaseComputerLifecycle();
      }
    }

    // what the user's machine can host: which runtime is installed, whether
    // its daemon is up, and whether the desktop image and container exist
    if (method === "GET" && path === "/api/local-computer") {
      json(res, 200, await localVmPayload(SHARED_LOCAL_VM_TARGET));
      return true;
    }
    if (method === "GET" && path === "/api/local-computer/instances") {
      res.setHeader("cache-control", "private, no-store");
      json(res, 200, await localVmInventoryPayload());
      return true;
    }
    m = path.match(/^\/api\/local-computer\/(pull|run|start|stop|remove)$/);
    if (m && method === "POST") {
      // Requiring JSON makes these localhost lifecycle mutations non-simple
      // browser requests. A hostile web page cannot submit them with a form,
      // and its cross-origin JSON request is stopped by the browser preflight
      // because this server deliberately emits no CORS permission.
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      const action = z.enum(["pull", "run", "start", "stop", "remove"]).parse(m[1]);
      if (localVmImageBusy.get() || localVmModeChangeBusy() || localVmLifecycleBusy.has(SHARED_LOCAL_VM_TARGET.key)) {
        json(res, 409, { error: "another Local VM setup action is still running" });
        return true;
      }
      if (localVmMode(cfg) === "per-bot" && action === "run") {
        json(res, 409, { error: "Per-bot mode creates each desktop from that bot's Computer panel" });
        return true;
      }
      const vmOwner = localVmLeaseFor(SHARED_LOCAL_VM_TARGET).current(localVmOwnerBusy);
      if (vmOwner && (action === "stop" || action === "remove" || action === "run")) {
        json(res, 409, { error: "the Local VM is being used by a bot — stop that turn first" });
        return true;
      }
      // A lease can lapse under a long, quiet turn whose thread still holds
      // the desktop, so stop/remove must also refuse while the thread
      // registry or a setup action pins it — the same guard bot deletion uses.
      if ((action === "stop" || action === "remove") && (localVmActiveThreads.has(SHARED_LOCAL_VM_TARGET.key) || localVmLifecycleBusy.has(SHARED_LOCAL_VM_TARGET.key))) {
        json(res, 409, { error: localVmActiveThreads.has(SHARED_LOCAL_VM_TARGET.key) ? "the Local VM is being used by a bot — stop that turn first" : "another Local VM setup action is still running" });
        return true;
      }
      if (action === "pull") localVmImageBusy.set(true);
      else localVmLifecycleBusy.add(SHARED_LOCAL_VM_TARGET.key);
      try {
        const status = await containerComputerAction(action, undefined, undefined, SHARED_LOCAL_VM_TARGET);
        if (action === "run" || action === "start") localVmIdleFor(SHARED_LOCAL_VM_TARGET).touch();
        if (action === "stop" || action === "remove") localVmIdleFor(SHARED_LOCAL_VM_TARGET).cancel();
        json(res, 200, {
          ...status,
          commands: setupCommands(status.runtime, process.platform, SHARED_LOCAL_VM_TARGET),
          idle_timeout_ms: LOCAL_VM_IDLE_MS,
          mode: localVmMode(cfg),
          max_instances: localVmMaxInstances(cfg),
        });
        return true;
      } finally {
        if (action === "pull") localVmImageBusy.set(false);
        else localVmLifecycleBusy.delete(SHARED_LOCAL_VM_TARGET.key);
      }
    }
    if (method === "POST" && path === "/api/local-computer/screenshot") {
      localVmIdleFor(SHARED_LOCAL_VM_TARGET).touch();
      res.setHeader("cache-control", "private, no-store");
      json(res, 200, {
        image: await containerComputerScreenshot(undefined, undefined, SHARED_LOCAL_VM_TARGET),
      });
      return true;
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer$/);
    if (m && method === "GET") {
      const bot = computerPreviewBot(m[1], url);
      if (!bot) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      json(res, 200, await localVmPayload(localVmTargetForBot(bot.id)));
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer\/(run|stop|remove)$/);
    if (m && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      const bot = store.bot(m[1]);
      if (!bot) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      if (boxLifecycleBusyBots.has(bot.id)) {
        json(res, 409, { error: "this bot's computer is being changed or deleted — wait for it to finish" });
        return true;
      }
      const action = z.enum(["run", "stop", "remove"]).parse(m[2]);
      const target = localVmTargetForBot(bot.id);
      if (target.key === SHARED_LOCAL_VM_TARGET.key) {
        json(res, 409, { error: "Shared mode manages this desktop in App Settings → Computers" });
        return true;
      }
      if (localVmImageBusy.get() || localVmModeChangeBusy() || localVmLifecycleBusy.has(target.key)) {
        json(res, 409, { error: "this bot's Local VM setup action is still running" });
        return true;
      }
      if (action === "run" && localVmProvisionBusy.get()) {
        json(res, 409, { error: "another per-bot Local VM is being created — retry after it finishes" });
        return true;
      }
      const vmOwner = localVmLeaseFor(target).current(localVmOwnerBusy);
      if (vmOwner) {
        json(res, 409, { error: "this bot is using its Local VM — stop the turn first" });
        return true;
      }
      // Mirrors the shared-target guard above: the lease alone can miss a
      // long, quiet turn, and a setup action must not be torn down mid-call.
      if ((action === "stop" || action === "remove") && (localVmActiveThreads.has(target.key) || localVmLifecycleBusy.has(target.key))) {
        json(res, 409, { error: localVmActiveThreads.has(target.key) ? "this bot is using its Local VM — stop the turn first" : "this bot's Local VM setup action is still running" });
        return true;
      }
      // Fence this target, and the cross-target capacity decision for creates,
      // before the first await so two requests cannot both pass the limit.
      localVmLifecycleBusy.add(target.key);
      if (action === "run") localVmProvisionBusy.set(true);
      try {
        if (action === "run") {
          const before = await containerComputerStatus(undefined, undefined, target);
          if (!before.runtime) {
            json(res, 409, { error: before.problem ?? "No container runtime is installed" });
            return true;
          }
          if (!(await containerComputerExists(before.runtime, target))) {
            const count = await existingPerBotLocalVmCount(before.runtime);
            if (count >= localVmMaxInstances(cfg)) {
              json(res, 409, {
                error: `The per-bot Local VM limit is ${localVmMaxInstances(cfg)} — delete an unused bot VM or raise the limit in App Settings`,
              });
              return true;
            }
          }
        }
        const status = await containerComputerAction(action, undefined, undefined, target);
        if (action === "run") localVmIdleFor(target).touch();
        if (action === "stop" || action === "remove") localVmIdleFor(target).cancel();
        json(res, 200, {
          ...status,
          commands: setupCommands(status.runtime, process.platform, target),
          idle_timeout_ms: LOCAL_VM_IDLE_MS,
          mode: localVmMode(cfg),
          max_instances: localVmMaxInstances(cfg),
        });
        return true;
      } finally {
        if (action === "run") localVmProvisionBusy.set(false);
        localVmLifecycleBusy.delete(target.key);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer\/screenshot$/);
    if (m && method === "POST") {
      const bot = computerPreviewBot(m[1], url);
      if (!bot) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      if (url.searchParams.has("threadId") && await computerPreviewSurface(bot, bot.threadId) !== "vm") {
        json(res, 409, { error: "This conversation is not using the Local VM" });
        return true;
      }
      const target = localVmTargetForBot(bot.id);
      localVmIdleFor(target).touch();
      res.setHeader("cache-control", "private, no-store");
      json(res, 200, {
        image: await containerComputerScreenshot(undefined, undefined, target),
      });
      return true;
    }
    return false;
  };
}
