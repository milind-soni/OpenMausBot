// The /api/internal route family: the localhost API a spawned agent proxy
// calls with its per-turn bearer capability to reach peers, rooms, memory,
// routines, skills, connectors, and the computer. Extracted from index.ts's
// dispatch chain (see ./routines.ts for the pattern): path matching,
// methods, status codes, response bodies, and error messages are unchanged,
// and the handler returns false for anything it does not own so the chain
// falls through in the same order. Capability minting and revocation stay in
// index.ts; everything the family reads crosses through options. The route
// bodies live in ./internal/ family modules, moved verbatim; this file keeps
// the options, the per-request capability context, and the dispatch chain in
// its original order.
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AutoVmClaimTable } from "../auto-vm-claims.ts";
import type { BrowserRuntime } from "../browser-runtime.ts";
import type { CommsBus } from "../comms-visibility.ts";
import type { ComputerControl } from "../computer-control.ts";
import { sharedComputersEnabled, type AppConfig } from "../config.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { json as sendJson, readBody } from "../http.ts";
import { memorySourceLabel } from "../workspace.ts";
import type { Notification } from "../notify.ts";
import type { ApprovalBus } from "../peer-approval.ts";
import type { RoomHandoffs, RoomHandoff } from "../room-handoffs.ts";
import type { RoomPostBudget } from "../room-post-budget.ts";
import type { RoutineManager, RoutineRun } from "../routines.ts";
import type { RoutineRequestService } from "../routine-requests.ts";
import type { ProfileRequestService } from "../profile-requests.ts";
import type { TeamSetupRequestService } from "../team-setup-requests.ts";
import type { SharedComputers } from "../shared-computers.ts";
import type { BotRecord, GroupRecord, Message, Store } from "../store.ts";
import type { listStagedSkillWrites } from "../skills.ts";
import type { Surface } from "../surface.ts";
import type { LocalVmTarget } from "../container-computer.ts";
import type { TurnOwner } from "../turn-resources.ts";
import { browserMcp, computerControlRoute, computerSelect, sharedComputersList, sharedComputersSubmit } from "./internal/computer.ts";
import { connectorsMcp, connectorsRequest, requestCredential } from "./internal/connectors.ts";
import { delegateBot, delegationStatus } from "./internal/delegations.ts";
import { roomTargetsOrCoordinateBots } from "./internal/coordination.ts";
import { askBot } from "./internal/ask-bot.ts";
import { memoryLog, memoryUpdate, sessionRead, sessionSearch } from "./internal/memory.ts";
import { postToRoom } from "./internal/post-to-room.ts";
import { botDeletionRequestSubmit, profileRequestSubmit, routineRequestSubmit, routinesList, teamSetupCatalog, teamSetupRequestSubmit } from "./internal/requests.ts";
import { agentsList, roomsList, threadClose, threadsList } from "./internal/roster.ts";
import { skillsList, skillsStage } from "./internal/skills.ts";
import { createBot, createRoomOrManageRoom, startThread } from "./internal/threads.ts";
import { retryThread } from "./internal/retry-thread.ts";
import type { createTurnDispatch } from "../turn-dispatch.ts";

// Every mounted proxy receives a fresh, turn-scoped capability for localhost
// /api/internal calls. Identity, source thread, recursion depth and route
// family all come from this server-side record; caller fields are assertions,
// never authority. Full mode can inspect its own MCP environment, so a shared
// or reusable boot token would let one bot impersonate another later.
export type InternalCapability = {
  botId: string;
  threadId: string;
  generation: string;
  depth: number;
  kind: "agents" | "connectors" | "computer" | "browser";
  skillAuthoring: boolean;
  createdBots: number;
  createdRooms?: number;
  /** start_thread calls this turn has made — capped like createdBots, so a
   * turn cannot fan out into more real turns than a person could follow. */
  openedThreads: number;
  orphanExpiresAt: number;
  localVmTarget?: LocalVmTarget;
  teamComputerId?: string;
  browserSession?: string;
  roomHandoffId?: string;
  roomCoordination?: boolean;
  ownThreadCreation?: boolean;
};

export type AskBotOutcome = {
  status: "reply" | "failed" | "timeout" | "error";
  text: string;
  /** Provider's stop reason when the turn completed not-ok. */
  stopReason?: string | null;
};

/** One in-flight computer-selection offer, keyed by thread. index.ts writes
 * it when a person asks a bot to move computers; the family reads it to
 * decide whether a select call may still land. */
export interface ComputerSelectionTurn {
  generation: string;
  botId: string;
  source: Message;
  text: string;
  mounted?: Surface;
  selected?: Surface;
  previousSurface?: Surface;
}

/** A delegation still being watched for a late peer result, keyed by the
 * peer thread. index.ts drains it; ask_bot converts a timeout into one. */
export interface DelegationWatchEntry {
  channelId?: string;
  toBotId: string;
  toBotName?: string;
  taskId?: string;
  sourceThreadId?: string;
  sourceBotId?: string;
  routineRunId?: string;
  startedAtMs?: number;
}

/** One computer a bot may select, as computer/select lists it. */
interface SelectableComputerView {
  surface: "cloud" | "vm" | "local" | "browser";
  label: string;
  available: boolean;
  ready: boolean;
  canStart: boolean;
  canCreate: boolean;
  reason?: string;
}

type PersistenceCheck = { ok: true } | { ok: false; status: number; error: string };
type RoomHandoffNode = Pick<RoomHandoff, "groupId" | "threadId" | "botId"> & Partial<Pick<RoomHandoff, "kind">>;

/** Everything from index.ts the /api/internal family reads. Singletons pass
 * by reference (index keeps owning their lifecycle); helpers pass as the
 * index-local functions they are. */
export interface InternalRoutesOptions {
  store: Store;
  cfg: AppConfig;
  registry: ProviderRegistry;
  sharedComputers: SharedComputers;
  computerControl: ComputerControl;
  browserRuntime: BrowserRuntime;
  commsBus: CommsBus;
  approvalBus: ApprovalBus;
  roomHandoffs: RoomHandoffs;
  routineRequests: RoutineRequestService;
  profileRequests: ProfileRequestService;
  teamSetupRequests: TeamSetupRequestService;
  routines(): RoutineManager | null;
  computerSelectionTurns: Map<string, ComputerSelectionTurn>;
  delegationWatch: Map<string, DelegationWatchEntry>;
  turnComputerResources: Map<string, { owner: TurnOwner; resource: string }>;
  autoVmClaims: AutoVmClaimTable;
  personAskAt: Map<string, number>;
  roomPostBudgets: Map<string, RoomPostBudget>;
  ASK_BOT_TIMEOUT_MS: number;
  MAX_COMMS_DEPTH: number;
  MAX_THREADS_OPENED_PER_TURN: number;
  MAX_WORKSPACE_BOTS: number;
  ROOM_POST_MAX_CHARS: number;
  askBotAndWait(targetBotId: string, message: string, depth: number, fromBotId?: string, fromThreadId?: string, targetThreadId?: string): Promise<AskBotOutcome>;
  startTurn: ReturnType<typeof createTurnDispatch>["startTurn"];
  agentRoutine(routine: ReturnType<RoutineManager["listRoutines"]>[number], latestRun?: RoutineRun): Record<string, unknown>;
  appendSkillRequestCard(args: {
    botId: string;
    threadId: string;
    applied?: boolean;
    staged: {
      id: string;
      action: "create" | "update";
      name: string;
      gist: string;
      source: string;
      files: Array<{ path: string; content: string }>;
      sha256: string;
      warnings: string[];
    };
  }): { requestId: string; summary: string };
  botComputerControlSnapshot(botId: string, pinnedComputerId?: string): ReturnType<ComputerControl["snapshot"]>;
  startOrQueueOpenedThread(botId: string, threadId: string, text: string, unattended: boolean): Promise<{ state: "running" } | { state: "queued"; position: number } | { state: "failed"; error: string }>;
  selectableComputers(bot: BotRecord): Promise<SelectableComputerView[]>;
  computerPreviewSurface(bot: BotRecord, threadId?: string): Promise<string>;
  browserIntegration(botId: string, profile: string | undefined, turn?: { threadId: string; generation: string }): Promise<{ session: string; spec: Parameters<BrowserRuntime["agentRpc"]>[1] } | null>;
  currentBrowserSession(botId: string, profile: string | undefined): string;
  createChannel(value: unknown): GroupRecord;
  updateChannel(groupId: string, value: unknown): GroupRecord;
  activeGroupTurnForBot(botId: string): { group: GroupRecord; threadId: string } | null;
  activeRoutineRunForThread(threadId: string): RoutineRun | null;
  credentialDesktopHandoff(label: string): string;
  lastHumanRoomMessageAt(group: GroupRecord): number | undefined;
  maybeResumeConnectors(botId: string, threadId: string, resumeKey: string): boolean;
  notify(notification: Notification | null): void;
  proposalPersistence(botId: string, threadId: string): PersistenceCheck;
  skillProposalPersistence(botId: string, threadId: string): PersistenceCheck;
  roomHandoffProblem(node: RoomHandoffNode, parent?: RoomHandoffNode): string | undefined;
  roomPostEligibility(bot: BotRecord, group: GroupRecord): PersistenceCheck;
  routineTimeZone(): string;
  stagedSkillListing(staged: ReturnType<typeof listStagedSkillWrites>[number]): Record<string, unknown>;
  teamSetupTeams(): string[];
  threadBusy(botId: string, threadId: string): boolean;
  authorizedInternalCapability(header: string | string[] | undefined): InternalCapability | null;
  internalCapabilityIsActive(capability: InternalCapability): boolean;
  claimTurnResource(owner: TurnOwner, resource: string): boolean;
  connectorThread(botId: string, threadId: string): { bot: BotRecord; group: GroupRecord | undefined } | null;
  delegatedFullAccess(from: BotRecord, fromThreadId: string, target: BotRecord): boolean;
  fullAccessForSource(botId: string, threadId: string): boolean;
  grantDelegatedFullAccess(from: BotRecord, target: BotRecord, threadId: string): void;
  isUnattended(botId?: string | null, threadId?: string): boolean;
  peerReviewRequired(bot: BotRecord, threadId: string): boolean;
}

export function createInternalRoutes(options: InternalRoutesOptions) {
  return async (req: IncomingMessage, res: ServerResponse, path: string, method: string, url: URL): Promise<boolean> => {
    const {
      store, cfg, registry, sharedComputers, computerControl, browserRuntime, commsBus, approvalBus,
      roomHandoffs, routineRequests, profileRequests, teamSetupRequests, routines: getRoutines,
      computerSelectionTurns, delegationWatch, turnComputerResources, autoVmClaims, personAskAt, roomPostBudgets,
      ASK_BOT_TIMEOUT_MS, MAX_COMMS_DEPTH, MAX_THREADS_OPENED_PER_TURN, MAX_WORKSPACE_BOTS, ROOM_POST_MAX_CHARS,
      askBotAndWait, agentRoutine, appendSkillRequestCard, botComputerControlSnapshot, startOrQueueOpenedThread, startTurn,
      selectableComputers, computerPreviewSurface, browserIntegration, currentBrowserSession, createChannel, updateChannel,
      activeGroupTurnForBot, activeRoutineRunForThread, credentialDesktopHandoff, lastHumanRoomMessageAt,
      maybeResumeConnectors, notify, proposalPersistence, skillProposalPersistence, roomHandoffProblem,
      roomPostEligibility, routineTimeZone, stagedSkillListing, teamSetupTeams, threadBusy,
      authorizedInternalCapability, internalCapabilityIsActive, claimTurnResource, connectorThread,
      delegatedFullAccess, fullAccessForSource, grantDelegatedFullAccess, isUnattended, peerReviewRequired,
    } = options;
    // The dispatch chain in index.ts stops at the first truthy return; the
    // family's bodies end in json(...) replies, so reply through a
    // boolean-returning alias and keep them as they were written.
    const json = (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): boolean => {
      sendJson(res, status, body, headers);
      return true;
    };
    // index.ts owns the RoutineManager lifecycle; read the current one per
    // request, exactly as the inline handler read the module-level let.
    const routines = getRoutines();
    if (path.startsWith("/api/internal/")) {
      const internalCapability = authorizedInternalCapability(req.headers.authorization);
      if (!internalCapability) {
        return json(res, 401, { error: "unauthorized" });
      }
      const internalSender = store.bot(internalCapability.botId);
      if (!internalSender) {
        return json(res, 401, { error: "unauthorized" });
      }
      const requiredCapabilityKind = path === "/api/internal/browser/mcp"
        ? "browser"
        : path.startsWith("/api/internal/connectors/")
        ? "connectors"
        : path === "/api/internal/computer-control"
          ? "computer"
          : "agents";
      if (internalCapability.kind !== requiredCapabilityKind) {
        return json(res, 403, { error: "this internal capability cannot access that service" });
      }
      if (internalCapability.roomCoordination && method === "POST" && ["/api/internal/ask-bot", "/api/internal/delegate-bot"].includes(path)) {
        return json(res, 409, { error: "Use coordinate_bots for teamwork; it queues actual teammates and resumes you automatically." });
      }
      // Query/body sender ids remain on the wire for proxy compatibility,
      // but the opaque bearer is the authority. Refuse disagreement instead
      // of letting a Full bot reuse its own token to impersonate a peer.
      for (const key of ["self", "fromBotId", "botId"] as const) {
        const claimed = url.searchParams.get(key);
        if (claimed !== null && claimed !== internalSender.id) {
          return json(res, 403, { error: "the internal capability belongs to a different bot" });
        }
      }
      const claimedThread = url.searchParams.get("fromThreadId");
      if (claimedThread !== null && claimedThread !== internalCapability.threadId) {
        return json(res, 403, { error: "the internal capability belongs to a different conversation" });
      }
      const readInternalBody = async () => {
        const body = await readBody(req);
        // The body may arrive slowly. Authorization at header time is not a
        // lease: if the owning turn settled while bytes were in flight, this
        // request must die before it reaches any side effect.
        if (!internalCapabilityIsActive(internalCapability)) {
          throw Object.assign(new Error("the internal turn capability has expired"), { status: 401 });
        }
        if (body && typeof body === "object" && !Array.isArray(body)) {
          for (const key of ["fromBotId", "botId"] as const) {
            if (body[key] !== undefined && String(body[key]) !== internalSender.id) {
              throw Object.assign(new Error("the internal capability belongs to a different bot"), { status: 403 });
            }
          }
          for (const key of ["fromThreadId", "threadId"] as const) {
            if (body[key] !== undefined && String(body[key]) !== internalCapability.threadId) {
              throw Object.assign(new Error("the internal capability belongs to a different conversation"), { status: 403 });
            }
          }
        }
        return body;
      };
      const requireActiveInternalCapability = () => {
        if (!internalCapabilityIsActive(internalCapability)) {
          throw Object.assign(new Error("the internal turn capability has expired"), { status: 401 });
        }
      };
      // Where an entry came from, as the person will read it in MEMORY.md:
      // the room or the thread title, never a bare id unless nothing else
      // names the conversation.
      const memorySource = (): string => memorySourceLabel({
        room: store.groupByThread(internalCapability.threadId),
        task: store.taskByThread(internalSender.id, internalCapability.threadId),
        threadId: internalCapability.threadId,
      });

      // One ctx per request: every option member the families read plus the
      // per-request closures above. Each family handler narrows it to the
      // members it uses, so moved bodies keep their bare closure names.
      const internalCtx = {
        store, cfg, registry, sharedComputers, computerControl, browserRuntime, commsBus, approvalBus,
        roomHandoffs, routineRequests, profileRequests, teamSetupRequests, routines,
        computerSelectionTurns, delegationWatch, turnComputerResources, autoVmClaims, personAskAt, roomPostBudgets,
        ASK_BOT_TIMEOUT_MS, MAX_COMMS_DEPTH, MAX_THREADS_OPENED_PER_TURN, MAX_WORKSPACE_BOTS, ROOM_POST_MAX_CHARS,
        askBotAndWait, agentRoutine, appendSkillRequestCard, botComputerControlSnapshot, startOrQueueOpenedThread, startTurn,
        selectableComputers, computerPreviewSurface, browserIntegration, currentBrowserSession, createChannel, updateChannel,
        activeGroupTurnForBot, activeRoutineRunForThread, credentialDesktopHandoff, lastHumanRoomMessageAt,
        maybeResumeConnectors, notify, proposalPersistence, skillProposalPersistence, roomHandoffProblem,
        roomPostEligibility, routineTimeZone, stagedSkillListing, teamSetupTeams, threadBusy,
        internalCapabilityIsActive, claimTurnResource, connectorThread,
        delegatedFullAccess, fullAccessForSource, grantDelegatedFullAccess, isUnattended, peerReviewRequired,
        internalCapability, internalSender, json, readInternalBody, requireActiveInternalCapability, memorySource,
      };
      if (path === "/api/internal/computer/select" && (method === "GET" || method === "POST")) {
        return computerSelect(internalCtx, res, method);
      }
      if (method === "POST" && path === "/api/internal/memory") {
        return memoryUpdate(internalCtx, res);
      }
      if (method === "POST" && path === "/api/internal/memory/log") {
        return memoryLog(internalCtx, res);
      }
      if (method === "POST" && path === "/api/internal/browser/mcp") {
        return browserMcp(internalCtx, res);
      }
      // Off by default: both fall through to the same "unknown internal
      // endpoint" 404 a never-implemented route returns.
      if (method === "GET" && path === "/api/internal/shared-computers" && sharedComputersEnabled(cfg)) return sharedComputersList(internalCtx, res);
      if (method === "POST" && path === "/api/internal/shared-computers" && sharedComputersEnabled(cfg)) {
        return sharedComputersSubmit(internalCtx, res);
      }
      if (method === "GET" && path === "/api/internal/agents") {
        return agentsList(internalCtx, res);
      }
      if (method === "GET" && path === "/api/internal/threads") {
        return threadsList(internalCtx, res);
      }
      const closeMatch = method === "POST" ? path.match(/^\/api\/internal\/threads\/([\w-]+)\/close$/) : null;
      if (closeMatch) {
        return threadClose(internalCtx, res, closeMatch);
      }
      if (method === "GET" && path === "/api/internal/rooms") {
        return roomsList(internalCtx, res);
      }
      if (method === "GET" && path === "/api/internal/routines") {
        return routinesList(internalCtx, res);
      }
      if (method === "POST" && path === "/api/internal/routine-requests") {
        return routineRequestSubmit(internalCtx, res);
      }
      if (method === "POST" && path === "/api/internal/profile-requests") {
        return profileRequestSubmit(internalCtx, res);
      }
      if (method === "GET" && path === "/api/internal/team-setup-catalog") {
        return teamSetupCatalog(internalCtx, res);
      }
      if (method === "POST" && path === "/api/internal/team-setup-requests") {
        return teamSetupRequestSubmit(internalCtx, res);
      }
      if (method === "POST" && path === "/api/internal/bot-deletion-requests") {
        return botDeletionRequestSubmit(internalCtx, res);
      }
      if (method === "GET" && path === "/api/internal/session-search") {
        return sessionSearch(internalCtx, res, url);
      }
      if (method === "GET" && path === "/api/internal/session-read") {
        return sessionRead(internalCtx, res, url);
      }
      if (method === "GET" && path === "/api/internal/skills") {
        return skillsList(internalCtx, res);
      }
      if (method === "POST" && path === "/api/internal/skills/stage") {
        return skillsStage(internalCtx, res);
      }
      if (method === "POST" && path === "/api/internal/ask-bot") {
        return askBot(internalCtx, res);
      }
      if (method === "POST" && path === "/api/internal/retry-thread") {
        return retryThread(internalCtx, res);
      }
      const delegationMatch = method === "GET" ? path.match(/^\/api\/internal\/delegations\/([\w-]{4,64})$/) : null;
      if (delegationMatch) {
        return delegationStatus(internalCtx, res, url, delegationMatch);
      }
      if (method === "POST" && path === "/api/internal/delegate-bot") {
        return delegateBot(internalCtx, res);
      }
      if (path === "/api/internal/room-targets" || path === "/api/internal/coordinate-bots") {
        if (await roomTargetsOrCoordinateBots(internalCtx, res, method, path)) return true;
      }
      if (method === "POST" && path === "/api/internal/post-to-room") {
        return postToRoom(internalCtx, res);
      }
      if (method === "POST" && path === "/api/internal/threads") {
        return startThread(internalCtx, res);
      }
      if (method === "POST" && path === "/api/internal/create-bot") {
        return createBot(internalCtx, res);
      }
      if (method === "POST" && (path === "/api/internal/create-room" || path === "/api/internal/manage-room")) {
        return createRoomOrManageRoom(internalCtx, res, path);
      }
      if (method === "POST" && path === "/api/internal/request-credential") {
        return requestCredential(internalCtx, res);
      }
      if (method === "POST" && path === "/api/internal/connectors/mcp") {
        return connectorsMcp(internalCtx, req, res);
      }
      if (path === "/api/internal/computer-control") {
        return computerControlRoute(internalCtx, res, url, method);
      }
      if (method === "POST" && path === "/api/internal/connectors/request") {
        return connectorsRequest(internalCtx, res);
      }
      return json(res, 404, { error: "unknown internal endpoint" });
    }
    return false;
  };
}
