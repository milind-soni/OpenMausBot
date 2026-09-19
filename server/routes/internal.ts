// The /api/internal route family: the localhost API a spawned agent proxy
// calls with its per-turn bearer capability to reach peers, rooms, memory,
// routines, skills, connectors, and the computer. Extracted from index.ts's
// dispatch chain (see ./routines.ts for the pattern): path matching,
// methods, status codes, response bodies, and error messages are unchanged,
// and the handler returns false for anything it does not own so the chain
// falls through in the same order. Capability minting and revocation stay in
// index.ts; everything the family reads crosses through options.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";
import { startAutoVmClaim, type AutoVmClaimTable } from "../auto-vm-claims.ts";
import { fitsOnOneLine } from "../bot-profile.ts";
import { BrowserRuntime } from "../browser-runtime.ts";
import { getOrCreateChannel, mirrorActivity, mirrorExchange, mirrorReply, type CommsBus } from "../comms-visibility.ts";
import { ComputerControl } from "../computer-control.ts";
import * as composio from "../composio.ts";
import { appendDecision } from "../decision-log.ts";
import { skillAuthoringEnabled, sharedComputersEnabled, builtInBrowserEnabled, maxConcurrentBotThreads, DATA_DIR, type AppConfig } from "../config.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import { json as sendJson, readBody } from "../http.ts";
import { readMessageText, recallMessages, recentMessages } from "../message-db.ts";
import { buildNotification, blockedTarget, type Notification } from "../notify.ts";
import { requestPeerApproval, type ApprovalBus } from "../peer-approval.ts";
import { canAccessTeam, canReachPeer, peerAllowed, peerStatus, peerStatusWords, reachablePeers, resolveTeammate, PEER_ACCESS_HELP} from "../peer-roster.ts";
import { withPeerProvenance } from "../peer-provenance.ts";
import { claimRecallCrossings, recallCrossingLabel } from "../recall-disclosure.ts";
import { parseSince } from "../recent-work.ts";
import { redactSecretsInText } from "../redact.ts";
import { RoomHandoffs, type RoomHandoff } from "../room-handoffs.ts";
import { decideRoomPost, emptyRoomPostBudget, type RoomPostAttempt, type RoomPostBudget } from "../room-post-budget.ts";
import { RoutineManager, type RoutineRun } from "../routines.ts";
import { RoutineRequestService } from "../routine-requests.ts";
import { ProfileRequestService } from "../profile-requests.ts";
import { TeamSetupRequestService } from "../team-setup-requests.ts";
import { SharedComputers, sharedComputerOperation } from "../shared-computers.ts";
import { queuedThreadPosition } from "../steer-queue.ts";
import { DELEGATION_TTL_MS, findDelegationReceipt, pendingDelegationInfo, pendingDelegationSnapshot, queueDelegation, summarizeDelegatedActivity, type QueueResult } from "../delegations.ts";
import { Store, sectionKey, type BotRecord, type GroupRecord, type Message, type TaskRecord } from "../store.ts";
import { listSkills, listStagedSkillWrites, stageSkillWrite, applySkillWriteWithReceipt, rejectStagedSkillWrite } from "../skills.ts";
import { learnSource } from "../skill-learn.ts";
import { parseSurface, surfaceLabel, type Surface } from "../surface.ts";
import { teamComputerOwner } from "../team-computers.ts";
import { updateMemory, appendMemoryLog, memorySourceLabel, searchMemoryFiles } from "../workspace.ts";
import type { LocalVmTarget } from "../container-computer.ts";
import { newId } from "../contracts.ts";
import { CREDENTIAL_TARGETS, credentialIsConfigured, isReusableCredentialRequest, isCredentialTargetId, type CredentialTargetId } from "../../shared/credential-request.ts";
import type { TurnOwner } from "../turn-resources.ts";

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


/** A session_read answer competes with the transcript for the context
 * window; a computer-use turn's output can run to hundreds of KB. */
const SESSION_READ_MAX_CHARS = 8_000;

const routineRequestSourceSchema = {
  fromBotId: z.string().min(1).max(128),
  fromThreadId: z.string().min(1).max(128),
};
const routineRequestEnvelopeSchema = z.discriminatedUnion("action", [
  z.object({ ...routineRequestSourceSchema, action: z.literal("create"), routine: z.unknown(), forBotId: z.unknown().optional() }).strict(),
  z.object({
    ...routineRequestSourceSchema,
    action: z.literal("update"),
    routineId: z.unknown(),
    changes: z.unknown(),
  }).strict(),
  ...(["pause", "resume", "run_now", "delete"] as const).map((action) =>
    z.object({ ...routineRequestSourceSchema, action: z.literal(action), routineId: z.unknown() }).strict()
  ),
]);

const CONNECTOR_SLUG = /^[a-z0-9][a-z0-9_-]{0,80}$/;

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
  LAZY_VM_CLAIM_GRACE_MS: number;
  askBotAndWait(targetBotId: string, message: string, depth: number, fromBotId?: string, fromThreadId?: string, targetThreadId?: string): Promise<AskBotOutcome>;
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
  startTurn(botId: string, text: string, opts?: { threadId?: string; unattended?: boolean; peerAsk?: { botId: string; name: string; unattended?: true } }): Promise<unknown>;
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
      ASK_BOT_TIMEOUT_MS, MAX_COMMS_DEPTH, MAX_THREADS_OPENED_PER_TURN, MAX_WORKSPACE_BOTS, ROOM_POST_MAX_CHARS, LAZY_VM_CLAIM_GRACE_MS,
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
      if (path === "/api/internal/computer/select" && (method === "GET" || method === "POST")) {
        const source = computerSelectionTurns.get(internalCapability.threadId);
        const bot = store.projectBotForTask(internalSender.id, internalCapability.threadId);
        const canSelect = Boolean(source && source.generation === internalCapability.generation && bot && bot.computer !== "off");
        if (!bot) return json(res, 403, { error: "Computer selection belongs to a direct bot conversation." });
        const requested = method === "POST" ? (await readInternalBody()).surface : undefined;
        if (method === "POST" && !canSelect) return json(res, 403, { error: "Computer selection is only available once per direct user request, with computer access enabled." });
        if (method === "POST" && requested !== "auto" && !parseSurface(requested)) {
          return json(res, 400, { error: "surface must be auto, cloud, vm, local, or browser" });
        }
        const options = await selectableComputers(bot);
        const current = source ? source.mounted ?? "off" : await computerPreviewSurface(bot, bot.threadId);
        requireActiveInternalCapability();
        if (method === "GET") return json(res, 200, { current, canSelect, options });
        if (computerSelectionTurns.get(internalCapability.threadId) !== source) return json(res, 409, { error: "The user request ended before its computer was selected." });
        const option = requested === "auto"
          ? options.find(option => option.ready && option.surface === current) ?? options.find(option => option.ready && option.surface === "vm") ?? options.find(option => option.ready) ?? options.find(option => option.canStart) ?? options.find(option => option.canCreate && option.surface === "vm") ?? options.find(option => option.canCreate)
          : options.find(option => option.surface === requested);
        if (!option?.available) return json(res, 409, { error: option?.reason ?? "No configured computer or browser is available. Open the Computer panel to set one up.", options });
        if (source!.selected) {
          if (source!.selected !== option.surface) return json(res, 409, { error: "A computer switch is already pending. End this turn to continue there." });
        } else {
          if (option.surface === current && option.ready) return json(res, 200, { status: "ready", surface: current, message: "This computer is already selected. Use its mounted tools." });
          source!.selected = option.surface;
          source!.previousSurface = store.taskByThread(bot.id, bot.threadId)?.surface;
        }
        return json(res, 200, { status: "pending", surface: option.surface,
          message: `End this turn now without using the previous computer tools. OpenMausBot will continue the original request on ${option.label} with a fresh tool connection.` });
      }
      if (method === "POST" && path === "/api/internal/memory") {
        const body = await readInternalBody();
        const result = updateMemory(internalSender.id, { action: body.action, text: body.text, oldText: body.oldText }, { source: memorySource() });
        return json(res, result.ok ? 200 : result.code === "conflict" ? 409 : result.code === "over-budget" ? 413 : 400, result);
      }
      if (method === "POST" && path === "/api/internal/memory/log") {
        const body = await readInternalBody();
        const result = appendMemoryLog(internalSender.id, body.text, { source: memorySource() });
        return json(res, result.ok ? 200 : 400, result);
      }
      if (method === "POST" && path === "/api/internal/browser/mcp") {
        const body = await readInternalBody();
        const bot = store.bot(internalCapability.botId);
        if (!bot || bot.browser === false || bot.computer === "off" || !builtInBrowserEnabled(cfg)) {
          return json(res, 403, { error: "browser tools are not enabled for this bot" });
        }
        const browser = await browserIntegration(bot.id, bot.browserProfile);
        if (!browser || browser.session !== internalCapability.browserSession) {
          return json(res, 409, { error: "this browser profile changed; start a new turn" });
        }
        if (body?.method !== "tools/list" && body?.method !== "tools/call") {
          return json(res, 400, { error: "unsupported browser method" });
        }
        const result = await browserRuntime.agentRpc(browser.session, browser.spec, body.method, body.params, () => {
          requireActiveInternalCapability();
          const current = store.bot(bot.id);
          if (!current || current.browser === false || current.computer === "off" || !builtInBrowserEnabled(cfg) ||
              currentBrowserSession(current.id, current.browserProfile) !== browser.session) {
            throw Object.assign(new Error("Browser access changed while connecting."), { status: 409 });
          }
          if (body.method === "tools/call" && !claimTurnResource(internalCapability, `browser:${browser.session}`)) {
            throw Object.assign(new Error("another thread is using this browser — pause browser work until that thread finishes"), { status: 409 });
          }
        });
        requireActiveInternalCapability();
        return json(res, 200, { result });
      }
      // Off by default: both fall through to the same "unknown internal
      // endpoint" 404 a never-implemented route returns.
      if (method === "GET" && path === "/api/internal/shared-computers" && sharedComputersEnabled(cfg)) return json(res, 200, { computers: sharedComputers.list() });
      if (method === "POST" && path === "/api/internal/shared-computers" && sharedComputersEnabled(cfg)) {
        const parsed = sharedComputerOperation.safeParse(await readInternalBody());
        if (!sharedComputersEnabled(cfg)) return json(res, 404, { error: "unknown internal endpoint" });
        if (!parsed.success) return json(res, 400, { error: "Invalid shared computer operation" });
        return json(res, 200, { result: await sharedComputers.request(parsed.data, () => sharedComputersEnabled(cfg) && internalCapabilityIsActive(internalCapability)) });
      }
      if (method === "GET" && path === "/api/internal/agents") {
        const sender = internalSender;
        // title/description included so the caller can judge the team (who
        // does what, who has no job description yet). Every bot reads this
        // now, not just the Chief, so it answers the same reachability
        // question the roster does — same peers, same order.
        const bots = reachablePeers(store.bots, sender)
          .map((b) => {
            const status = peerStatus(b.activity, b.busy);
            return {
              id: b.id,
              name: b.name,
              section: b.section?.trim() || "",
              model: b.modelSelection.model,
              busy: !!b.busy,
              status,
              statusText: peerStatusWords(status),
              title: b.title || undefined,
              description: b.description || undefined,
            };
          });
        return json(res, 200, { bots });
      }
      // Nothing else ever tells a bot a room id, so this is the discovery
      // half of post_to_room: it lists exactly the rooms that tool would
      // accept, resolved from the sender's own membership. A room a post
      // would be refused for gets no id — an id would only teach the model
      // to keep trying — but it is still NAMED, with the refusal it would
      // have met. Without that the bot can only say it is in no room at
      // all, while the person is looking at it in that very room.
      // list_threads: the caller's own threads, plus — on every peer it can
      // reach — only the threads the caller itself opened. A peer's other
      // threads are its own business (and the person's), so the scope is
      // "what you started", never "what that bot is doing". State is read
      // the way the sidebar reads it, so the bot and the person agree.
      if (method === "GET" && path === "/api/internal/threads") {
        const from = internalSender;
        const fromThreadId = internalCapability.threadId;
        if (!connectorThread(from.id, fromThreadId)) {
          return json(res, 403, { error: "source conversation does not belong to sender" });
        }
        const rows: Array<{
          threadId: string; botId: string; botName: string; title: string;
          state: "running" | "waiting-on-you" | "queued" | "idle" | "closed";
          unread: boolean; openedAt: number; delegationId?: string; own: boolean;
        }> = [];
        const stateOf = (bot: BotRecord, task: TaskRecord) => {
          if (task.activity === "waiting-on-you") return "waiting-on-you" as const;
          if (threadBusy(bot.id, task.threadId)) return "running" as const;
          if (queuedThreadPosition(bot.id, task.threadId) !== null) return "queued" as const;
          if (roomHandoffs.activeDirect(task.threadId)) return "queued" as const;
          if (task.closedBy) return "closed" as const;
          return "idle" as const;
        };
        for (const task of store.tasks(from.id)) {
          rows.push({
            threadId: task.threadId, botId: from.id, botName: from.name, title: task.title,
            state: stateOf(from, task), unread: task.unread === true, openedAt: task.openedBy?.at ?? task.createdAt,
            delegationId: task.openedBy?.delegationId, own: true,
          });
        }
        for (const peer of reachablePeers(store.bots, from)) {
          for (const task of store.tasks(peer.id)) {
            if (task.openedBy?.botId !== from.id) continue;
            rows.push({
              threadId: task.threadId, botId: peer.id, botName: peer.name, title: task.title,
              state: stateOf(peer, task), unread: task.unread === true, openedAt: task.openedBy.at,
              delegationId: task.openedBy.delegationId, own: false,
            });
          }
        }
        rows.sort((a, b) => b.openedAt - a.openedAt);
        return json(res, 200, { threads: rows.slice(0, 100) });
      }
      // close_thread: a bot tidies a thread it opened (or one of its own)
      // once its result has been read. Closing is the sidebar's idle state
      // plus a chip saying who closed it — never a deletion, which stays a
      // person's confirmed action, and never while the thread is running.
      const closeMatch = method === "POST" ? path.match(/^\/api\/internal\/threads\/([\w-]+)\/close$/) : null;
      if (closeMatch) {
        const from = internalSender;
        const fromThreadId = internalCapability.threadId;
        if (!connectorThread(from.id, fromThreadId)) {
          return json(res, 403, { error: "source conversation does not belong to sender" });
        }
        const threadId = closeMatch[1]!;
        const owner = [from, ...reachablePeers(store.bots, from)].find((bot) => store.taskByThread(bot.id, threadId));
        const task = owner ? store.taskByThread(owner.id, threadId) : undefined;
        if (!owner || !task) return json(res, 404, { error: "no such thread — call list_threads for the ones you can see" });
        if (owner.id !== from.id && task.openedBy?.botId !== from.id) {
          return json(res, 403, { error: "that thread is not yours to close — only the bot that opened it, or its own bot, can" });
        }
        if (threadId === fromThreadId) return json(res, 400, { error: "you cannot close the thread you are speaking in — finish your turn instead" });
        if (threadBusy(owner.id, threadId) || queuedThreadPosition(owner.id, threadId) !== null || roomHandoffs.activeDirect(threadId)) {
          return json(res, 409, { error: `#${task.title} is still running — wait for it to finish (list_threads), or the person can stop it from the app` });
        }
        // Closing twice is not an error and leaves no second chip: the
        // thread is already folded away, so there is nothing more to do.
        if (task.closedBy) {
          return json(res, 200, { closed: true, alreadyClosed: true, threadId, title: task.title, botName: owner.name, closedBy: task.closedBy.name });
        }
        store.appendMessage(threadId, {
          role: "bot",
          kind: "activity",
          from: { botId: from.id, name: from.name, color: from.color },
          tool: { name: `Closed by @${from.name}`, ok: true },
        });
        if (task.unread) store.patchTask(owner.id, threadId, { unread: false });
        // The stamp is what the sidebar folds on and what list_threads
        // reports; the chip above is only the transcript's record of it.
        store.setTaskClosedBy(owner.id, threadId, { botId: from.id, name: from.name, at: Date.now() });
        return json(res, 200, { closed: true, threadId, title: task.title, botName: owner.name });
      }
      if (method === "GET" && path === "/api/internal/rooms") {
        const from = internalSender;
        const fromThreadId = internalCapability.threadId;
        if (!connectorThread(from.id, fromThreadId)) {
          return json(res, 403, { error: "source conversation does not belong to sender" });
        }
        const rooms: Array<{ id: string; name: string; members: string[] }> = [];
        const unpostable: Array<{ name: string; reason: string }> = [];
        for (const group of store.groups) {
          if (group.dm || !group.memberIds.includes(from.id)) continue;
          const eligibility = roomPostEligibility(from, group);
          if (!eligibility.ok) {
            unpostable.push({ name: group.name, reason: eligibility.error });
            continue;
          }
          rooms.push({
            id: group.id,
            name: group.name,
            members: group.memberIds
              .map((id) => store.bot(id))
              .filter((member): member is BotRecord => Boolean(member))
              .map((member) => member.name),
          });
        }
        return json(res, 200, { rooms: rooms.slice(0, 50), unpostable: unpostable.slice(0, 50) });
      }
      if (method === "GET" && path === "/api/internal/routines") {
        const from = internalSender;
        const fromThreadId = internalCapability.threadId;
        if (!connectorThread(from.id, fromThreadId)) {
          return json(res, 403, { error: "source conversation does not belong to sender" });
        }
        const latestRuns = new Map<string, RoutineRun>();
        // listRuns is newest-first. Keep the first receipt per definition so
        // the agent can answer "did it run?" from scheduler truth rather
        // than guessing from conversation history.
        for (const run of routines!.listRuns()) {
          if (run.botId === from.id && !latestRuns.has(run.routineId)) latestRuns.set(run.routineId, run);
        }
        return json(res, 200, {
          now: new Date().toISOString(),
          timeZone: routineTimeZone(),
          routines: routines!.listRoutines()
            .filter((routine) => routine.botId === from.id)
            .slice(0, 100)
            .map((routine) => agentRoutine(routine, latestRuns.get(routine.id))),
        });
      }
      if (method === "POST" && path === "/api/internal/routine-requests") {
        const parsed = routineRequestEnvelopeSchema.safeParse(await readInternalBody());
        if (!parsed.success) return json(res, 400, { error: "invalid routine proposal" });
        const body = parsed.data;
        const from = internalSender;
        const fromThreadId = internalCapability.threadId;
        const owner = connectorThread(from.id, fromThreadId);
        if (!owner) return json(res, 403, { error: "source conversation does not belong to sender" });
        // "Make a routine for @B": resolve the target up front so the model
        // gets a teaching error now, not a mis-bound routine later. Omitted
        // (or the sender's own id) keeps the schedule-for-self path unchanged.
        let forBot: { botId: string; name: string } | undefined;
        if (body.action === "create" && body.forBotId !== undefined) {
          const parsedForBotId = z.string().max(128).safeParse(body.forBotId);
          const forBotId = parsedForBotId.success ? parsedForBotId.data.trim() : "";
          if (!forBotId) {
            return json(res, 400, { error: 'for_bot_id must be a bot id from list_bots, e.g. { "for_bot_id": "bot-abc123" }' });
          }
          if (forBotId !== from.id) {
            const target = store.bot(forBotId);
            if (!target) {
              return json(res, 404, { error: "no bot with that id — call list_bots and copy the exact id from the result" });
            }
            if (!canReachPeer(from, target)) {
              return json(res, 403, { error: `that bot belongs to a different section or is unavailable. ${PEER_ACCESS_HELP}` });
            }
            forBot = { botId: target.id, name: target.name };
          }
        }
        const persistence = proposalPersistence(from.id, fromThreadId);
        if (!persistence.ok) {
          return json(res, persistence.status, { error: persistence.error });
        }
        const proposedInput = body.action === "create"
          ? { action: body.action, routine: body.routine, forBot }
          : body.action === "update"
            ? { action: body.action, routineId: body.routineId, changes: body.changes }
            : { action: body.action, routineId: body.routineId };
        const proposed = await routineRequests.submit({
          botId: from.id,
          threadId: fromThreadId,
          proposal: proposedInput,
          from: owner.group ? { botId: from.id, name: from.name, color: from.color } : undefined,
          canCommit: () => internalCapabilityIsActive(internalCapability),
        });
        const proposedCard = store.messagesFor(fromThreadId).find((message) => message.id === proposed.messageId)?.card;
        appendDecision(DATA_DIR, {
          threadId: fromThreadId,
          requestId: proposed.requestId,
          botId: from.id,
          botName: from.name,
          tool: proposedCard?.tool,
          // Audit what the human was actually shown, not the shorter tool
          // response returned to the model.
          summary: proposedCard?.subtitle ?? proposed.summary,
          decision: proposed.state === "applied" ? "auto-approved" : "card-shown",
          source: proposed.state === "applied" ? "full-access" : "routine",
        });
        return json(res, 201, proposed);
      }
      if (method === "POST" && path === "/api/internal/profile-requests") {
        const parsed = z.object({
          fromBotId: z.string().min(1).max(128),
          fromThreadId: z.string().min(1).max(128),
          forBotId: z.string().max(128).optional(),
          changes: z.unknown(),
          reason: z.unknown(),
        }).strict().safeParse(await readInternalBody());
        if (!parsed.success) return json(res, 400, { error: "invalid profile proposal" });
        const body = parsed.data;
        const from = store.bot(body.fromBotId);
        if (!from) return json(res, 403, { error: "unknown sender" });
        const owner = connectorThread(from.id, body.fromThreadId);
        if (!owner) return json(res, 403, { error: "source conversation does not belong to sender" });
        const targetBotId = body.forBotId?.trim() || from.id;
        const proposed = profileRequests.submit({
          botId: from.id,
          threadId: body.fromThreadId,
          targetBotId,
          changes: body.changes,
          reason: body.reason,
          from: owner.group ? { botId: from.id, name: from.name, color: from.color } : undefined,
        });
        appendDecision(DATA_DIR, {
          threadId: body.fromThreadId, requestId: proposed.requestId, botId: from.id, botName: from.name,
          tool: "update_profile", summary: proposed.detail, decision: proposed.state === "applied" ? "auto-approved" : "card-shown",
          source: proposed.state === "applied" ? "full-access" : "profile",
        });
        return json(res, 201, proposed);
      }
      if (method === "GET" && path === "/api/internal/team-setup-catalog") {
        let chief = store.bot(internalCapability.botId)!;
        if (!chief.chiefOfStaff || chief.hidden) return json(res, 403, { error: "Only an active Chief may plan team setup" });
        const instances = await registry.describe();
        requireActiveInternalCapability();
        chief = store.bot(internalCapability.botId)!;
        if (!chief.chiefOfStaff || chief.hidden) return json(res, 403, { error: "Only an active Chief may plan team setup" });
        return json(res, 200, {
          teams: teamSetupTeams().filter((name) => canAccessTeam(chief, name)),
          bots: store.bots.filter((bot) => !bot.hidden && canAccessTeam(chief, bot.section) && (bot.id === chief.id || peerAllowed(chief, bot.id)))
            .map((bot) => ({ id: bot.id, name: bot.name, title: bot.title, section: bot.section ?? "", modelSelection: bot.modelSelection })),
          instances: instances.map((instance) => ({ instanceId: instance.instanceId, driverKind: instance.driverKind, displayName: instance.displayName,
            state: instance.snapshot.state, models: instance.models, effortLevels: instance.capabilities?.effortLevels ?? [] })),
          scope: "Bot model defaults apply to groups and new threads; existing threads retain their models. Full Access applies requested team setup immediately; other modes return a review card. Existing unauthorized teams remain outside this Chief's scope.",
        });
      }
      if (method === "POST" && path === "/api/internal/team-setup-requests") {
        const parsed = z.object({ fromBotId: z.string().optional(), fromThreadId: z.string().optional(), plan: z.unknown() }).strict().safeParse(await readInternalBody());
        if (!parsed.success) return json(res, 400, { error: "Invalid team setup request" });
        const chief = store.bot(internalCapability.botId)!;
        const owner = connectorThread(chief.id, internalCapability.threadId);
        if (!owner) return json(res, 403, { error: "Source conversation no longer belongs to the Chief" });
        const proposed = await teamSetupRequests.submit({ botId: chief.id, threadId: internalCapability.threadId, plan: parsed.data.plan,
          canCommit: () => internalCapabilityIsActive(internalCapability),
          ...(owner.group ? { from: { botId: chief.id, name: chief.name, color: chief.color } } : {}) });
        if (proposed.state === "applied" || proposed.state === "pending") appendDecision(DATA_DIR, { threadId: internalCapability.threadId, requestId: proposed.requestId, botId: chief.id,
          tool: "set_up_team", summary: proposed.detail, decision: proposed.state === "applied" ? "auto-approved" : "card-shown",
          source: proposed.state === "pending" ? "profile" : "full-access" });
        return json(res, 201, proposed);
      }
      if (method === "POST" && path === "/api/internal/bot-deletion-requests") {
        const parsed = z.object({ fromBotId: z.string().optional(), fromThreadId: z.string().optional(), targetBotId: z.string().min(1), reason: z.string().trim().min(1).max(500) }).strict().safeParse(await readInternalBody());
        if (!parsed.success) return json(res, 400, { error: "An exact bot id and deletion reason are required" });
        const chief = store.bot(internalCapability.botId)!;
        const owner = connectorThread(chief.id, internalCapability.threadId);
        if (!owner) return json(res, 403, { error: "Source conversation no longer belongs to the Chief" });
        const proposed = await teamSetupRequests.submitDeletion({ botId: chief.id, threadId: internalCapability.threadId, targetBotId: parsed.data.targetBotId, reason: parsed.data.reason,
          canCommit: () => internalCapabilityIsActive(internalCapability),
          ...(owner.group ? { from: { botId: chief.id, name: chief.name, color: chief.color } } : {}) });
        if (proposed.state === "applied" || proposed.state === "pending") appendDecision(DATA_DIR, { threadId: internalCapability.threadId, requestId: proposed.requestId, botId: chief.id,
          tool: "delete_bot", summary: proposed.detail, decision: proposed.state === "applied" ? "auto-approved" : "card-shown",
          source: proposed.state === "pending" ? "profile" : "full-access" });
        return json(res, 201, proposed);
      }
      // session_search: ranked recall over the calling bot's OWN threads,
      // every task included. Own-bot only, on purpose — a bot's transcripts
      // are its notebook the same way MEMORY.md is (section-context.ts draws
      // that line), and search across bots would be an isolation change.
      // Announce in the room that a bot reached outside it. Silent when the
      // room has already been told about that thread, so a bot searching
      // three times in one turn leaves one chip per source, not per search.
      const discloseRecall = (bot: BotRecord, roomThreadId: string, sourceThreadIds: readonly string[]): void => {
        const crossing = claimRecallCrossings(roomThreadId, sourceThreadIds);
        if (!crossing.count) return;
        store.appendMessage(roomThreadId, {
          role: "bot",
          kind: "activity",
          from: { botId: bot.id, name: bot.name, color: bot.color },
          tool: { name: recallCrossingLabel(bot.name, crossing.count), ok: true },
        });
      };
      if (method === "GET" && path === "/api/internal/session-search") {
        const fromBotId = String(url.searchParams.get("fromBotId") ?? "");
        const from = store.bot(fromBotId);
        if (!from) return json(res, 403, { error: "unknown sender" });
        const fromThreadId = internalCapability.threadId;
        if (!connectorThread(from.id, fromThreadId)) {
          return json(res, 403, { error: "source conversation does not belong to sender" });
        }
        const q = String(url.searchParams.get("q") ?? "").trim();
        // A recall by time needs no words: "what happened since yesterday"
        // is the standup question, and it has no keyword.
        const now = Date.now();
        const sinceRaw = url.searchParams.get("since");
        const untilRaw = url.searchParams.get("until");
        const since = sinceRaw ? parseSince(sinceRaw, now) : null;
        const until = untilRaw ? parseSince(untilRaw, now) : null;
        if (sinceRaw && since === null) return json(res, 400, { error: "since must be a date, or a span like 24h, 3d, today, yesterday" });
        if (untilRaw && until === null) return json(res, 400, { error: "until must be a date, or a span like 24h, 3d, today, yesterday" });
        if (!q && since === null) return json(res, 400, { error: "q or since is required" });
        const range = since !== null || until !== null
          ? { ...(since !== null ? { since } : {}), ...(until !== null ? { until } : {}) }
          : undefined;
        const rawLimit = Number(url.searchParams.get("limit"));
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), 25) : 12;
        // Memory files ride along by default: the bot's own notes are as
        // much its notebook as its transcripts, and scoped the same way —
        // the caller's own bot, never another's. A recall by time alone
        // has no words to match a file with.
        const scope = url.searchParams.get("scope") ?? "all";
        if (scope !== "all" && scope !== "conversations" && scope !== "memory") {
          return json(res, 400, { error: "scope must be all, conversations, or memory" });
        }
        const memoryHits = scope === "conversations" || !q ? [] : searchMemoryFiles(from.id, q, limit);
        if (scope === "memory") return json(res, 200, { hits: [], memoryHits });
        // Own threads: the bot's main chat and tasks, and the rooms it is a
        // member of with their tasks — conversations it already saw in full.
        // Still own-bot: another bot's threads never enter this list.
        const roomByThread = new Map<string, GroupRecord>();
        for (const group of store.groups) {
          if (!group.memberIds.includes(from.id)) continue;
          roomByThread.set(group.threadId, group);
          for (const task of group.tasks ?? []) roomByThread.set(task.threadId, group);
        }
        const ownThreads = [...new Set([from.threadId, ...(from.tasks ?? []).map((task) => task.threadId), ...roomByThread.keys()])];
        // A room is the only place a recall can be a disclosure, and only a
        // private chat is one: in a 1:1 the user already owns every thread
        // the bot can reach, and a room's lines were said in the open.
        const inRoom = Boolean(store.groupByThread(fromThreadId));
        const found = q ? recallMessages(q, ownThreads, limit, range) : recentMessages(ownThreads, range ?? {}, limit);
        const hits = found.map((hit) => {
          const room = roomByThread.get(hit.threadId);
          return {
            ...hit,
            task: room
              ? (room.tasks ?? []).find((task) => task.threadId === hit.threadId)?.title
              : store.taskByThread(from.id, hit.threadId)?.title,
            ...(room ? { room: room.name } : {}),
            current: hit.threadId === fromThreadId,
            crossed: inRoom && !room && hit.threadId !== fromThreadId,
          };
        });
        if (inRoom) {
          discloseRecall(from, fromThreadId, hits.filter((hit) => hit.crossed).map((hit) => hit.threadId));
        }
        return json(res, 200, { hits, memoryHits });
      }
      // session_read: the whole message behind a session_search hit. Same
      // own-bot scope — a message id from another bot's thread reads as
      // missing, not as forbidden, so the id space leaks nothing.
      if (method === "GET" && path === "/api/internal/session-read") {
        const fromBotId = String(url.searchParams.get("fromBotId") ?? "");
        const from = store.bot(fromBotId);
        if (!from) return json(res, 403, { error: "unknown sender" });
        const fromThreadId = internalCapability.threadId;
        if (!connectorThread(from.id, fromThreadId)) {
          return json(res, 403, { error: "source conversation does not belong to sender" });
        }
        const threadId = String(url.searchParams.get("threadId") ?? "").trim();
        const messageId = String(url.searchParams.get("messageId") ?? "").trim();
        if (!threadId || !messageId) return json(res, 400, { error: "threadId and messageId are required" });
        const own = threadId === from.threadId || Boolean(store.taskByThread(from.id, threadId));
        const message = own ? readMessageText(threadId, messageId) : null;
        if (!message) return json(res, 404, { error: "no such message in your conversations" });
        const readInRoom = Boolean(store.groupByThread(fromThreadId));
        const readCrossed = readInRoom && threadId !== fromThreadId;
        if (readCrossed) discloseRecall(from, fromThreadId, [threadId]);
        return json(res, 200, {
          ...message,
          crossed: readCrossed,
          text: message.text.length > SESSION_READ_MAX_CHARS ? `${message.text.slice(0, SESSION_READ_MAX_CHARS)}…` : message.text,
          task: store.taskByThread(from.id, threadId)?.title,
        });
      }
      if (method === "GET" && path === "/api/internal/skills") {
        if (!skillAuthoringEnabled(cfg)) return json(res, 403, { error: "skill authoring is not enabled in Settings" });
        if (!internalCapability.skillAuthoring) {
          return json(res, 403, { error: "skill authoring is not enabled for this turn" });
        }
        const from = internalSender;
        const fromThreadId = internalCapability.threadId;
        if (!connectorThread(from.id, fromThreadId)) {
          return json(res, 403, { error: "source conversation does not belong to sender" });
        }
        return json(res, 200, {
          skills: listSkills(from.id),
          staged: listStagedSkillWrites(from.id).map(stagedSkillListing),
        });
      }
      if (method === "POST" && path === "/api/internal/skills/stage") {
        if (!skillAuthoringEnabled(cfg)) return json(res, 403, { error: "skill authoring is not enabled in Settings" });
        if (!internalCapability.skillAuthoring) {
          return json(res, 403, { error: "skill authoring is not enabled for this turn" });
        }
        const body = await readInternalBody();
        const from = internalSender;
        const fromThreadId = internalCapability.threadId;
        if (!connectorThread(from.id, fromThreadId)) {
          return json(res, 403, { error: "source conversation does not belong to sender" });
        }
        const persistence = skillProposalPersistence(from.id, fromThreadId);
        if (!persistence.ok) return json(res, persistence.status, { error: persistence.error });
        const action = body.action === "create" || body.action === "update" ? body.action : "";
        if (!action) return json(res, 400, { error: 'action must be "create" or "update"' });
        const skillMd = typeof body.skill_md === "string" ? body.skill_md : "";
        if (!skillMd.trim()) {
          return json(res, 400, { error: 'skill_manage needs skill_md: the full SKILL.md including YAML frontmatter, for example ---\\nname: file-expense\\ndescription: Files an expense in the company portal.\\n---\\n\\n# File expense\\n' });
        }
        const source = typeof body.source === "string" ? body.source.trim() : "";
        if (!source) return json(res, 400, { error: 'source must be a URL, folder, or "conversation"' });
        const targetName = typeof body.skill_name === "string" ? body.skill_name.trim() : "";
        if (action === "update" && !targetName) {
          return json(res, 400, { error: "skill_name is required when action is update" });
        }
        const staged = stageSkillWrite(from.id, {
          action,
          targetName: targetName || undefined,
          files: [{ path: "SKILL.md", content: skillMd }],
          gist: typeof body.gist === "string" ? body.gist : undefined,
          source: learnSource(source),
        });
        if ("error" in staged) return json(res, 422, { error: staged.error });
        if (fullAccessForSource(from.id, fromThreadId)) {
          const applied = applySkillWriteWithReceipt(from.id, staged, () => {
            const receipt = appendSkillRequestCard({ botId: from.id, threadId: fromThreadId, staged, applied: true });
            appendDecision(DATA_DIR, { threadId: fromThreadId, requestId: receipt.requestId, botId: from.id, botName: from.name,
              tool: "stage_skill", summary: receipt.summary, decision: "auto-approved", source: "full-access" });
          });
          if ("error" in applied) {
            rejectStagedSkillWrite(from.id, staged.id);
            return json(res, 422, { state: "failed", error: applied.error });
          }
          return json(res, 201, { state: "applied", stagedId: staged.id, name: staged.name, action: staged.action,
            gist: staged.gist, warnings: staged.warnings, ...applied, summary: `Skill ${staged.name} ${staged.action === "create" ? "enabled" : "updated"}.` });
        }
        let card: ReturnType<typeof appendSkillRequestCard>;
        try {
          card = appendSkillRequestCard({ botId: from.id, threadId: fromThreadId, staged });
        } catch (error) {
          rejectStagedSkillWrite(from.id, staged.id);
          throw error;
        }
        appendDecision(DATA_DIR, {
          threadId: fromThreadId,
          requestId: card.requestId,
          botId: from.id,
          botName: from.name,
          tool: "stage_skill",
          summary: card.summary,
          decision: "card-shown",
          source: "skill",
        });
        return json(res, 201, {
          state: "pending",
          stagedId: staged.id,
          name: staged.name,
          action: staged.action,
          gist: staged.gist,
          warnings: staged.warnings,
          summary: card.summary,
        });
      }
      if (method === "POST" && path === "/api/internal/ask-bot") {
        const body = await readInternalBody();
        const fromBotId = internalSender.id;
        const toBotRef = String(body.toBotId ?? "");
        const message = String(body.message ?? "").trim();
        if (
          body.depth !== undefined &&
          (!Number.isInteger(body.depth) || body.depth < 0 || body.depth !== internalCapability.depth)
        ) {
          return json(res, 403, { error: "the recursion depth does not match this turn" });
        }
        const depth = internalCapability.depth;
        if (!toBotRef || !message) return json(res, 400, { error: "toBotId and message required" });
        if (toBotRef === fromBotId) return json(res, 400, { error: "a bot cannot message itself" });
        if (depth >= MAX_COMMS_DEPTH) return json(res, 200, { error: "message chains are limited to one hop" });
        // A unique reachable teammate name is accepted where an id is
        // expected; see resolveTeammate for why.
        const resolvedTo = resolveTeammate(store.bots, internalSender, toBotRef);
        if ("error" in resolvedTo) return json(res, 404, { error: `no such bot: ${resolvedTo.error}` });
        if (resolvedTo.id === fromBotId) return json(res, 400, { error: "a bot cannot message itself" });
        const toBotId = resolvedTo.id;
        const target = store.bot(toBotId);
        if (!target) return json(res, 404, { error: "no such bot" });
        // An unknown sender used to fall through: no mirroring AND no
        // approval, while still running the peer turn. That made an
        // unresolvable id the cheapest way past the gate, so it is now a
        // hard refusal — every peer turn has an accountable sender.
        const from = internalSender;
        if (!canAccessTeam(from, target.section) || target.hidden) {
          return json(res, 403, { error: `that bot belongs to a different section or is unavailable. ${PEER_ACCESS_HELP}` });
        }
        // The sender's allow-list, when it has one. Checked here rather than
        // trusted from the roster: the tool call carries a bot id, and an id
        // the model held from an earlier turn must not outlive the grant.
        if (!peerAllowed(from, target.id)) {
          return json(res, 403, { error: `that bot is not on this bot's allowed peers. ${PEER_ACCESS_HELP}` });
        }
        const fromThreadId = internalCapability.threadId;
        // Rooms are conversations too. The task-only lookup here refused every
        // ask made from a room turn — the bot could see its teammates and not
        // reach them — while create_bot and the routine endpoints already
        // accepted a group thread the sender belongs to. One ownership rule,
        // and it is still the sender's own membership that decides.
        if (!connectorThread(from.id, fromThreadId)) {
          return json(res, 403, { error: "source thread does not belong to sender" });
        }
        // A busy peer used to be a flat bounce ("try again later") — a
        // dead-end mid-turn that models rarely retry, so the exchange just
        // evaporated. Demote the synchronous ask into a durable handoff
        // instead: the message waits in the delegation ledger (up to 24
        // hours, receipts, restart-safe) and the asker gets a task id it
        // can check next turn. If the ledger refuses (cap/depth), fall back
        // to the plain busy bounce rather than dropping the refusal reason.
        const queueBusyFallback = (approvalAlreadyGranted = false) => {
          const queued = queueDelegation(
            commsBus,
            from,
            { toBotId, message, reason: "asked while busy", depth, approvalAlreadyGranted },
            MAX_COMMS_DEPTH,
            fromThreadId,
          );
          if (queued.result !== "ok" || !queued.id) return json(res, 200, { busy: true });
          return json(res, 200, { busy: true, taskId: queued.id, toBotName: target.name });
        };
        if (target.busy) return queueBusyFallback();
        let currentFrom = from;
        let currentTarget = target;

        // the exchange is mirrored into a bot⇄bot channel: it shows up in
        // the sidebar like any room, keeps the pair's full history, and the
        // user can open it and chip in. Both 1:1 threads get a clickable
        // chip that opens the channel, so bot-to-bot turns are never
        // invisible (they cost the user tokens).
        //
        // per-bot approval gate: a chief-of-staff bot without this on is
        // free to coordinate; one with it on must wait for a human card
        // (15-min timeout → deny) before its peer turn starts. The channel
        // and the chips are created only AFTER the verdict, so a denied
        // contact leaves no trace of an exchange that never happened.
        if (peerReviewRequired(from, fromThreadId)) {
          const verdict = await requestPeerApproval(
            approvalBus,
            from,
            target,
            message,
            "ask_bot",
            fromThreadId,
          );
          requireActiveInternalCapability();
          if (verdict !== "allow") return json(res, 200, { error: "denied by user" });
          // The card may have been open for minutes. Re-read both records so
          // deleted bots cannot recreate transcripts through stale objects.
          const freshFrom = store.bot(fromBotId);
          const freshTarget = store.bot(toBotId);
          if (!freshFrom || !freshTarget) return json(res, 404, { error: "no such bot" });
          if (!canAccessTeam(freshFrom, freshTarget.section) || freshTarget.hidden) {
            return json(res, 200, { error: "that bot moved to a different section" });
          }
          if (!peerAllowed(freshFrom, freshTarget.id)) {
            return json(res, 200, { error: "that bot is no longer an allowed peer" });
          }
          // Membership can be revoked while the card is open: re-check the
          // same way, so a bot removed from a room mid-approval cannot go on
          // speaking through it.
          if (!connectorThread(freshFrom.id, fromThreadId)) {
            return json(res, 404, { error: "source conversation no longer belongs to sender" });
          }
          // The user just approved this exact ask_bot request. Preserve that
          // decision if it has to become an async handoff; asking twice makes
          // the fallback look stuck behind a second, surprising card.
          if (freshTarget.busy) return queueBusyFallback(true);
          currentFrom = freshFrom;
          currentTarget = freshTarget;
        }
        // An ask made from inside a room is mirrored into that room — the
        // conversation the person is actually reading — the way delegate_bot
        // already does. The pair channel is for asks made from a bot's own
        // thread; sending a room's ask there put the whole exchange behind
        // an unbadged "A ⇄ B" entry nobody had a reason to open.
        const channel = getOrCreateChannel(
          store,
          currentFrom,
          currentTarget,
          connectorThread(currentFrom.id, fromThreadId)?.group,
        );
        mirrorExchange(commsBus, currentFrom, currentTarget, message, channel, fromThreadId);
        const prefixed = withPeerProvenance(message, {
          botName: currentFrom.name,
          delivery: "ask_bot",
          unattended: isUnattended(currentFrom.id, fromThreadId),
        });
        const targetThreadId = currentTarget.threadId;
        const outcome = await askBotAndWait(toBotId, prefixed, depth, fromBotId, fromThreadId, targetThreadId);
        requireActiveInternalCapability();
        const replySender = store.bot(fromBotId);
        const replyTarget = store.bot(toBotId);
        if (!replySender || !replyTarget || !canReachPeer(replySender, replyTarget)) {
          return json(res, 403, { error: "Result withheld: team access changed while the teammate was working" });
        }
        if (outcome.status === "timeout" && !delegationWatch.has(targetThreadId)) {
          // The peer's turn is still running — only the wait ended. Convert
          // the ask into a delegation claim ticket: the watch mirrors the
          // terminal state into the channel AND the asker's thread when the
          // turn settles, and check/wait_delegation read the same receipt.
          // Losing the reply was the old behavior, and it read as "the bots
          // don't respond to each other".
          const taskId = newId();
          delegationWatch.set(targetThreadId, {
            channelId: channel.id,
            toBotId,
            toBotName: currentTarget.name,
            taskId,
            sourceThreadId: fromThreadId,
            sourceBotId: currentFrom.id,
            routineRunId: activeRoutineRunForThread(fromThreadId)?.id,
          });
          store.appendMessage(fromThreadId, {
            role: "bot",
            kind: "activity",
            tool: { name: `@${currentTarget.name} is still working — ask converted to a delegation` },
          });
          return json(res, 200, { timeout: true, taskId, toBotName: currentTarget.name, waitedMs: ASK_BOT_TIMEOUT_MS });
        }
        if (outcome.status === "failed" && !outcome.text.trim()) {
          // No partial answer to hand back — mirror the failure where the
          // exchange lives, with the provider's reason instead of silence.
          const why = outcome.stopReason?.trim() ? ` — ${outcome.stopReason.trim().slice(0, 120)}` : "";
          mirrorActivity(commsBus, currentTarget, channel, `Turn failed${why}`, false);
          return json(res, 200, { botName: currentTarget.name, text: `(the bot's turn failed${why})` });
        }
        const reply = outcome.status === "timeout"
          ? outcome.text || "(timed out waiting for the bot to reply)"
          : outcome.text;
        mirrorReply(commsBus, currentTarget, reply, channel);
        return json(res, 200, { botName: currentTarget.name, text: reply });
      }
      // Async handoff: the source bot queues a task for a peer and goes
      // back to the user; the peer turn runs after the source's
      // turn.completed. Returns immediately (the caller does not wait).
      const delegationMatch = method === "GET" ? path.match(/^\/api\/internal\/delegations\/([\w-]{4,64})$/) : null;
      if (delegationMatch) {
        const taskId = delegationMatch[1];
        const fromThreadId = internalCapability.threadId;
        const from = internalSender;
        if (!connectorThread(from.id, fromThreadId)) return json(res, 403, { error: "unknown sender" });
        const waitMs = Math.min(Math.max(Number(url.searchParams.get("wait_ms")) || 0, 0), 240_000);
        const deadline = Date.now() + waitMs;
        // Bounded long-poll: the delegating bot parks ONE cheap HTTP request
        // here instead of burning a model inference per status check.
        for (;;) {
          const receipt = findDelegationReceipt(taskId);
          if (receipt) {
            if (receipt.sourceThreadId !== fromThreadId) {
              return json(res, 403, { error: "that task belongs to a different conversation" });
            }
            return json(res, 200, { status: receipt.status, toBotName: receipt.toBotName, result: receipt.result ?? "" });
          }
          const stillQueued = pendingDelegationInfo(taskId);
          const runningEntry = [...delegationWatch.entries()].find(([, watch]) => watch.taskId === taskId);
          const running = runningEntry?.[1];
          const owner = stillQueued?.sourceThreadId ?? running?.sourceThreadId;
          if (!owner) return json(res, 404, { error: "unknown task id — delegation receipts are kept for about 48 hours" });
          if (owner !== fromThreadId) return json(res, 403, { error: "that task belongs to a different conversation" });
          if (Date.now() >= deadline) {
            const toBotId = stillQueued?.toBotId ?? running?.toBotId ?? "";
            if (running && runningEntry) {
              const recent = summarizeDelegatedActivity(
                store.messagesFor(runningEntry[0]),
                running.startedAtMs ?? Date.now(),
              );
              return json(res, 200, {
                status: "running",
                toBotName: store.bot(toBotId)?.name ?? toBotId,
                elapsedMs: Math.max(0, Date.now() - (running.startedAtMs ?? Date.now())),
                recentActivity: recent,
              });
            }
            const queuedTarget = store.bot(toBotId);
            return json(res, 200, {
              status: "queued",
              toBotName: queuedTarget?.name ?? toBotId,
              ...(stillQueued
                ? {
                  // A deleted target must never read as "available" — peerStatus's
                  // undefined/undefined fallback is "available", which is wrong here.
                  targetStatus: queuedTarget ? peerStatus(queuedTarget.activity, queuedTarget.busy) : "unavailable",
                  expiresInMs: Math.max(0, stillQueued.queuedAt + DELEGATION_TTL_MS - Date.now()),
                }
                : {}),
            });
          }
          await new Promise((wake) => setTimeout(wake, 500));
        }
      }
      // A Chief resumes a teammate's broken thread (server/incidents.ts): the
      // same thread, its conversation and files, one more turn, with a line
      // saying who asked and why. Chief-only, for a teammate it can reach,
      // never a room (coordinate there) and never a thread still running.
      if (method === "POST" && path === "/api/internal/retry-thread") {
        const body = await readInternalBody();
        const from = internalSender;
        const fromThreadId = internalCapability.threadId;
        if (!from.chiefOfStaff || from.hidden) return json(res, 403, { error: "only a Chief of Staff can retry a teammate's thread" });
        // `toBotId`/`toThreadId`: the guard above reads bare botId/threadId as
        // the caller's own identity, the way every internal route does.
        const botId = typeof body.toBotId === "string" ? body.toBotId : "";
        const threadId = typeof body.toThreadId === "string" ? body.toThreadId : "";
        const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
        const target = store.bot(botId);
        if (!target || target.id === from.id) return json(res, 404, { error: "no such teammate" });
        if (target.hidden || !canAccessTeam(from, target.section) || !peerAllowed(from, target.id)) {
          return json(res, 403, { error: "that bot is not on this Chief's team — call list_bots for the ones you can reach" });
        }
        if (store.groupByThread(threadId)) return json(res, 400, { error: "that is a room thread — use coordinate_bots in the room instead" });
        const task = store.taskByThread(target.id, threadId);
        if (!task) return json(res, 404, { error: "no such thread on that bot" });
        if (threadBusy(target.id, threadId) || queuedThreadPosition(target.id, threadId) !== null) {
          return json(res, 409, { error: "that thread is still running — wait for it to settle before retrying" });
        }
        requireActiveInternalCapability();
        const unattended = isUnattended(from.id, fromThreadId);
        const text = `[Retry requested by ${from.name}, your Chief of Staff, after this thread's last run stopped.${note ? ` Note from ${from.name}: ${note}` : ""} Continue the request above from where it stopped and finish it. If the same problem comes back, say exactly what is blocking and stop.]`;
        try {
          await startTurn(target.id, text, { threadId, unattended, peerAsk: { botId: from.id, name: from.name, ...(unattended ? { unattended: true } : {}) } });
        } catch (error) {
          return json(res, 409, { error: error instanceof Error ? error.message : String(error) });
        }
        store.appendMessage(fromThreadId, {
          role: "bot",
          kind: "activity",
          tool: { name: `Retried ${target.name}'s thread #${task.title}`, ok: true },
          threadRef: { botId: target.id, threadId, title: task.title },
        });
        return json(res, 200, { started: true, message: `${target.name}'s thread #${task.title} is running again. Its result stays in that thread; you are not woken for it — check later with list_threads or session_search if you need to.` });
      }
      if (method === "POST" && path === "/api/internal/delegate-bot") {
        const body = await readInternalBody();
        const toBotRef = String(body.toBotId ?? "");
        const message = String(body.message ?? "").trim();
        const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;
        if (
          body.depth !== undefined &&
          (!Number.isInteger(body.depth) || body.depth < 0 || body.depth !== internalCapability.depth)
        ) {
          return json(res, 403, { error: "the recursion depth does not match this turn" });
        }
        const depth = internalCapability.depth;
        if (!toBotRef || !message) return json(res, 400, { error: "toBotId and message required" });
        const from = internalSender;
        const resolvedTo = resolveTeammate(store.bots, from, toBotRef);
        if ("error" in resolvedTo) return json(res, 404, { error: `no such bot: ${resolvedTo.error}` });
        const toBotId = resolvedTo.id;
        const target = store.bot(toBotId);
        if (!target) return json(res, 404, { error: "no such bot" });
        if (!canAccessTeam(from, target.section) || target.hidden) {
          return json(res, 403, { error: `that bot belongs to a different section or is unavailable. ${PEER_ACCESS_HELP}` });
        }
        if (!peerAllowed(from, target.id)) {
          return json(res, 403, { error: `that bot is not on this bot's allowed peers. ${PEER_ACCESS_HELP}` });
        }
        const fromThreadId = internalCapability.threadId;
        if (!connectorThread(from.id, fromThreadId)) {
          return json(res, 403, { error: "source thread does not belong to sender" });
        }
        const queued = queueDelegation(
          commsBus,
          from,
          { toBotId, message, reason, depth },
          MAX_COMMS_DEPTH,
          fromThreadId,
        );
        if (queued.result !== "ok" || !queued.id) {
          // the agent reads this string — a bare enum ("too_deep") tells it
          // nothing about what to do instead
          const said: Record<Exclude<QueueResult, "ok">, string> = {
            self: "a bot cannot delegate to itself",
            too_deep: "delegation chains are limited to one hop — do this one yourself",
            no_target: "no such bot",
            too_many: "too many delegations queued on this turn — finish some first",
          };
          return json(res, 200, { error: said[queued.result === "ok" ? "no_target" : queued.result] });
        }
        const targetName = store.bot(toBotId)?.name ?? toBotId;
        return json(res, 200, {
          queued: true,
          taskId: queued.id,
          message: peerReviewRequired(from, internalCapability.threadId)
            ? `Queued for review — @${targetName} will only pick it up if the user approves after your turn finishes.`
            : `Delegation queued — @${targetName} will pick it up after your current turn finishes.`,
        });
      }
      if (path === "/api/internal/room-targets" || path === "/api/internal/coordinate-bots") {
        const source = store.groupByThread(internalCapability.threadId);
        if (!internalCapability.roomCoordination || (source && (source.dm || !source.memberIds.includes(internalSender.id)))) {
          return json(res, 403, { error: "Coordination requires an active chat turn. Finish together already manages its own teammate turns." });
        }
        const address = { groupId: source?.id, threadId: internalCapability.threadId, botId: internalSender.id };
        const problem = roomHandoffProblem(address);
        if (problem) return json(res, 403, { error: problem });
        if (method === "GET" && path === "/api/internal/room-targets") {
          const rooms = store.groups.filter(g => !g.dm).map(g => ({
            id: g.id, name: g.name, workingFolder: g.cwd || null,
            members: g.memberIds.map(id => store.bot(id)).filter(b => b && b.id !== internalSender.id &&
              !roomHandoffProblem({ groupId: g.id, threadId: g.id === source?.id ? address.threadId : g.threadId, botId: b.id }, address))
              .map(b => ({ id: b!.id, name: b!.name, title: b!.title, busy: b!.busy })),
          })).filter(g => g.members.length);
          return json(res, 200, { currentRoom: source ? { id: source.id, name: source.name, workingFolder: source.cwd || null } : null,
            bots: reachablePeers(store.bots, internalSender).map(bot => ({ id: bot.id, name: bot.name, title: bot.title, section: bot.section, busy: bot.busy })),
            rooms, note: "Without group_id: use this room when in a room, otherwise your standing conversation with that teammate — every assignment you send it continues the same thread, so write as if it remembers the last one. Each bot uses its own environment and permissions. Files are not transferred: pass absolute paths only when accessible to the recipient, otherwise pass the content." });
        }
        if (method === "POST" && path === "/api/internal/coordinate-bots") {
          const parsed = z.object({
            groupId: z.string().min(1).max(128).optional(),
            botIds: z.array(z.string().min(1).max(128)).min(1).max(4).refine(ids => new Set(ids).size === ids.length),
            message: z.string().trim().min(1).max(4000), requestKey: z.string().regex(/^[\w-]{1,100}$/),
            rework: z.boolean().default(false),
            // Only ever a name for a thread, so it travels under the same
            // one-line rule as a peer thread title.
            label: z.string().trim().min(1).max(60).refine(fitsOnOneLine).optional(),
          }).safeParse(await readInternalBody());
          if (!parsed.success) return json(res, 400, { error: "Provide 1-4 distinct botIds, message (1-4000 characters), a short requestKey (letters, digits, underscores or hyphens) and an optional one-line label of at most 60 characters." });
          const groupId = parsed.data.groupId ?? source?.id;
          const destination = groupId ? store.group(groupId) : undefined;
          if (groupId && !destination) return json(res, 404, { error: "No such room; use list_room_targets." });
          // A slot may carry a teammate's name instead of its id — the
          // roster shows both, list_bots shows both, and a Chief reading its
          // prompt reaches for the name. A unique reachable name resolves;
          // anything else is refused with the id or name the caller sent
          // and the way to the real ids (peer-roster.ts).
          const botIds: string[] = [];
          for (const raw of parsed.data.botIds) {
            const resolved = resolveTeammate(store.bots, internalSender, raw);
            if ("error" in resolved) return json(res, 403, { error: resolved.error });
            botIds.push(resolved.id);
          }
          if (new Set(botIds).size !== botIds.length) return json(res, 400, { error: "bot_ids name the same teammate twice — send each teammate once" });
          const targets = botIds.map(botId => ({ groupId: destination?.id,
            threadId: destination ? destination.id === source?.id ? address.threadId : destination.threadId : store.bot(botId)?.threadId ?? "", botId,
          }));
          for (const target of targets) {
            // roomHandoffProblem's "no longer exists" is written for a route
            // that was valid and went away. Here the id is the model's own
            // argument — usually a display name dropped into a bot_ids slot —
            // so say which id failed and where the real ones are, instead of
            // telling the model a teammate it can still reach is gone. Only
            // the id the caller sent is echoed back, never a bot's name.
            const addressed = store.bot(target.botId);
            const eligibility =
              target.botId === internalSender.id ? "Choose a teammate, not yourself"
              : !addressed ? `No bot with id "${target.botId}" — call list_bots and copy the exact id from the result`
              : addressed.hidden ? `The bot with id "${target.botId}" is no longer available — call list_bots for the ones you can reach`
              : roomHandoffProblem(target, address);
            if (eligibility) return json(res, 403, { error: eligibility });
          }
          let approvalGranted = false;
          if (peerReviewRequired(internalSender, address.threadId)) {
            const verdicts = await Promise.all(targets.map(target =>
              requestPeerApproval(approvalBus, internalSender, store.bot(target.botId)!, parsed.data.message, "delegate_bot", address.threadId)));
            requireActiveInternalCapability();
            if (verdicts.some(verdict => verdict !== "allow")) return json(res, 403, { error: "Denied by user; no work sent." });
            approvalGranted = true;
          }
          const accepted: { requestId: string; botId: string; duplicate: boolean; status: string }[] = [];
          const errors: { botId: string; error: string }[] = [];
          for (const target of targets) {
            let createdThread: string | undefined;
            try {
              requireActiveInternalCapability();
              if (!destination) {
                // One durable conversation per pair of bots, resolved from
                // the recipient's own threads — never from this turn, the
                // request key, or the thread the person has selected there.
                const resolved = store.resolvePairConversation(internalSender, target.botId, {
                  label: parsed.data.label,
                  // "Still working" exactly as close_thread reads it: a
                  // running turn, a queued one, or coordinated work already
                  // addressed at that thread.
                  working: threadId => threadBusy(target.botId, threadId)
                    || queuedThreadPosition(target.botId, threadId) !== null
                    || roomHandoffs.activeDirect(threadId),
                });
                if (!resolved) throw new Error("The recipient no longer exists");
                target.threadId = resolved.task.threadId;
                if (resolved.created) createdThread = resolved.task.threadId;
                if (delegatedFullAccess(internalSender, internalCapability.threadId, store.bot(target.botId)!)) {
                  grantDelegatedFullAccess(internalSender, store.bot(target.botId)!, target.threadId);
                }
              }
              const { node, duplicate } = roomHandoffs.enqueue(address, internalCapability.generation, internalCapability.roomHandoffId,
                target, parsed.data.requestKey + ":" + target.botId, parsed.data.message, approvalGranted, parsed.data.rework, [...store.messagesFor(address.threadId)].reverse().find(m => m.role === "user" && m.kind === "text")?.text ?? "");
              // A re-dispatched request_key is answered by the request it
              // already made, so a thread resolved for the retry (the pair
              // conversation was busy with that very request) goes back
              // before anyone sees a row that leads nowhere.
              if (duplicate && createdThread && createdThread !== node.threadId) store.deleteTask(target.botId, createdThread);
              createdThread = undefined; // The durable coordinator now owns this task.
              accepted.push({ requestId: node.id, botId: node.botId, duplicate, status: node.status });
              if (!duplicate) {
                const recipient = store.bot(target.botId)!;
                store.appendMessage(address.threadId, { role: "bot", kind: "activity",
                  from: { botId: internalSender.id, name: internalSender.name, color: internalSender.color },
                  tool: { name: "Sent to " + recipient.name + (destination && destination.id !== source?.id ? " · " + destination.name : ""), ok: true },
                  ...(destination ? { comm: { groupId: destination.id, threadId: node.threadId, withBotId: recipient.id, withName: recipient.name, withColor: recipient.color } }
                    : { threadRef: { botId: recipient.id, threadId: node.threadId, title: store.taskByThread(recipient.id, node.threadId)!.title } }),
                });
              }
            } catch (error) {
              if (createdThread) store.deleteTask(target.botId, createdThread);
              errors.push({ botId: target.botId, error: error instanceof Error ? error.message : String(error) });
            }
          }
          return json(res, accepted.length ? 200 : 409, { accepted, errors,
            ...(accepted.length ? { message: "End your turn after sending all work. These actual teammates will reply and resume you automatically. Do not poll or wait." } : { error: errors.map(e => e.error).join("; ") }),
          });
        }
      }
      // post_to_room: a bot puts ONE message into a room it belongs to,
      // without a turn being started for anyone. Everything about it is a
      // deliberate non-event:
      //
      //   role "bot", never "user". A user-role append is what the composer
      //   writes, and it re-enters responder selection — one tool call would
      //   become a round of real turns, which is the notification storm this
      //   whole surface exists to avoid.
      //
      //   no startGroupTurn and no queue kick. The post lands, the room is
      //   marked unread, the person reads it when they look. A bot wanting a
      //   reply has ask_bot and delegate_bot, both of which are accounted for.
      //
      //   membership from the record, never from the argument: the argument
      //   only says which room to look up.
      if (method === "POST" && path === "/api/internal/post-to-room") {
        const body = await readInternalBody();
        const from = internalSender;
        const fromThreadId = internalCapability.threadId;
        const owner = connectorThread(from.id, fromThreadId);
        if (!owner) return json(res, 403, { error: "source conversation does not belong to sender" });
        const groupId = String(body.groupId ?? "").trim();
        const message = String(body.message ?? "").trim();
        if (!groupId || !message) {
          return json(res, 400, { error: "post_to_room needs group_id (from list_rooms) and message" });
        }
        if (message.length > ROOM_POST_MAX_CHARS) {
          return json(res, 400, {
            error: `a room post is at most ${ROOM_POST_MAX_CHARS} characters — post the short version and keep the detail in your own reply`,
          });
        }
        let room = store.group(groupId);
        if (!room) return json(res, 404, { error: "no such room — call list_rooms and copy the exact id from the result" });
        // Posting into the room you are already speaking in is not a peer
        // message, it is your own reply arriving twice — and it feeds your
        // words back into the context the same turn is answering from.
        if (room.id === owner.group?.id) {
          return json(res, 409, { error: "you are already speaking in that room — say it in your reply instead" });
        }
        const eligibility = roomPostEligibility(from, room);
        if (!eligibility.ok) return json(res, eligibility.status, { error: eligibility.error });
        // The budget is read BEFORE any approval card and CHARGED only on
        // the path that actually appends. Reading it early is what stops a
        // bot in a loop turning that loop into a queue of cards for a person
        // to work through: the refusal lands on the bot, not in the inbox.
        // Charging it early would have been a lie in the other direction —
        // a denied card, a room deleted while the card was open, or a
        // roster change that ends the post all leave the room with nothing
        // in it, and a room that took no post must not be told it did. The
        // model would then be refused its retry with "you already posted
        // that", which is the one thing worse than a refusal: a false
        // receipt for a message nobody can read.
        const askBudget = (bot: BotRecord, group: GroupRecord) => {
          const attempt: RoomPostAttempt = {
            botId: bot.id,
            botName: bot.name,
            text: message,
            now: Date.now(),
          };
          // The person attending is whoever wrote last: in the room, or —
          // when the post was asked for in the sender's own conversation —
          // there. A room-sourced post has no such person; its room is the
          // conversation, and what a person wrote in it is already counted.
          const askedAt = owner.group ? undefined : personAskAt.get(fromThreadId);
          const spokeAt = Math.max(lastHumanRoomMessageAt(group) ?? -Infinity, askedAt ?? -Infinity);
          if (Number.isFinite(spokeAt)) attempt.lastHumanAt = spokeAt;
          return decideRoomPost(roomPostBudgets.get(group.id) ?? emptyRoomPostBudget(), attempt);
        };
        // A refusal is stored, an allowance is not: the budget a refusal
        // hands back never contains the attempt — it is the pruning, plus
        // the breaker if this call is what tripped it — so keeping it costs
        // the room nothing and losing it would let a ring re-form one call
        // later.
        const preflight = askBudget(from, room);
        if (!preflight.allowed) {
          roomPostBudgets.set(room.id, preflight.budget);
          return json(res, 429, { error: preflight.message });
        }
        let poster = from;
        if (peerReviewRequired(from, fromThreadId)) {
          // Same gate ask_bot carries, aimed at the room instead of a peer:
          // a bot the user asked to be consulted about must be consulted here
          // too, or the newest way to reach other bots is the one way round it.
          const verdict = await requestPeerApproval(
            approvalBus,
            from,
            { id: room.id, name: room.name },
            message,
            "post_to_room",
            fromThreadId,
          );
          requireActiveInternalCapability();
          if (verdict !== "allow") return json(res, 200, { error: "denied by user" });
          // The card may have been open for minutes. Re-read both records so a
          // roster change, a section move, or a deletion during that window
          // cannot be posted through on a stale decision.
          const freshFrom = store.bot(internalSender.id);
          const freshRoom = store.group(groupId);
          if (!freshFrom || !freshRoom) return json(res, 404, { error: "that bot or room no longer exists" });
          const stillEligible = roomPostEligibility(freshFrom, freshRoom);
          if (!stillEligible.ok) return json(res, stillEligible.status, { error: stillEligible.error });
          poster = freshFrom;
          room = freshRoom;
        }
        // The room's budget is charged here, against the records the append
        // below will actually use. Between the preflight and this line the
        // room may have taken another bot's post, so this decision — not the
        // preflight — is the one that can refuse.
        const decision = askBudget(poster, room);
        roomPostBudgets.set(room.id, decision.budget);
        if (!decision.allowed) return json(res, 429, { error: decision.message });
        // Unattended inheritance: the mark rides the sender, and reading it
        // here is also what keeps its window alive through a turn that only
        // posts — an aged-out mark would hand the next hop to auto-approve.
        const unattended = isUnattended(poster.id, internalCapability.threadId);
        const posted = store.appendMessage(room.threadId, {
          role: "bot",
          kind: "text",
          text: message,
          from: { botId: poster.id, name: poster.name, color: poster.color },
          peerPost: unattended ? { unattended: true } : {},
        });
        store.patchGroup(room.id, { unread: true });
        // The same visibility contract the peer tools keep: whatever a bot
        // does elsewhere shows up in the conversation it is actually in.
        // The chip is settled — the post has already landed — and carries
        // the same link a "Messaged @X" chip does, which is what makes it a
        // receipt rather than a log line: linked chips stay visible with
        // tool calls off, and open the room they name.
        const chip: Omit<Message, "id" | "at"> = {
          role: "bot",
          kind: "activity",
          tool: { name: `Posted in ${room.name}`, ok: true },
          comm: { groupId: room.id, withBotId: poster.id, withName: room.name, withColor: poster.color },
        };
        if (owner.group) chip.from = { botId: poster.id, name: poster.name, color: poster.color };
        store.appendMessage(fromThreadId, chip);
        return json(res, 201, { ok: true, messageId: posted.id, roomName: room.name });
      }
      // start_thread: a bot opens a real thread — on itself for separate
      // work, or on a teammate as a handoff that should run on its own.
      // Never activates: a bot must not move what the person is looking at.
      if (method === "POST" && path === "/api/internal/threads") {
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
      if (method === "POST" && path === "/api/internal/create-bot") {
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
      if (method === "POST" && (path === "/api/internal/create-room" || path === "/api/internal/manage-room")) {
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
      if (method === "POST" && path === "/api/internal/request-credential") {
        const body = await readInternalBody();
        const from = internalSender;
        const fromThreadId = internalCapability.threadId;
        const owner = connectorThread(from.id, fromThreadId);
        if (!owner) return json(res, 403, { error: "source conversation does not belong to sender" });
        if (!isCredentialTargetId(body.credentialId)) {
          return json(res, 400, { error: "unsupported credential id" });
        }
        const credentialId: CredentialTargetId = body.credentialId;
        const target = CREDENTIAL_TARGETS[credentialId];
        if (credentialIsConfigured(cfg, credentialId)) {
          return json(res, 200, { alreadyConfigured: true, label: target.label });
        }
        const existing = store.activePath(fromThreadId).find((message) =>
          isReusableCredentialRequest(message, credentialId, from.id, Boolean(owner.group))
        );
        if (existing) {
          if (!existing.text?.trim()) {
            store.patchMessage(fromThreadId, existing.id, {
              text: credentialDesktopHandoff(target.label),
            });
          }
          return json(res, 200, { messageId: existing.id, label: target.label });
        }
        const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 240) : "";
        const message = store.appendMessage(fromThreadId, {
          role: "bot",
          kind: "secret",
          text: credentialDesktopHandoff(target.label),
          ...(owner.group ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
          secret: {
            target: credentialId,
            label: target.label,
            description: `${reason ? `${target.description} ${reason}` : target.description} ${from.name} can use it but never read it back.`,
            placeholder: target.placeholder,
            helpUrl: target.helpUrl,
            requestKey: randomUUID(),
          },
        });
        return json(res, 201, { messageId: message.id, label: target.label });
      }
      if (method === "POST" && path === "/api/internal/connectors/mcp") {
        const body = await readInternalBody();
        // Reading a streamed MCP body yields to ordinary settings requests.
        // Re-read the live bot immediately before relay so turning Connected
        // Apps off wins over a request that authenticated under the old value.
        const currentSender = store.bot(internalCapability.botId);
        if (!currentSender || currentSender.composio === false || !composio.configured(cfg)) {
          return json(res, 403, { error: "connected apps are not enabled for this bot" });
        }
        const upstream = await composio.relayMcp(
          cfg,
          body,
          Array.isArray(req.headers["mcp-session-id"])
            ? req.headers["mcp-session-id"][0]
            : req.headers["mcp-session-id"],
        );
        const headers: Record<string, string> = {
          "content-type": upstream.contentType,
          "cache-control": "no-store",
        };
        if (upstream.transportSessionId) headers["mcp-session-id"] = upstream.transportSessionId;
        res.writeHead(upstream.status, headers);
        res.end(Buffer.from(upstream.bytes));
        return true;
      }
      // ── computer control: proxies read the hold, bots plead for help ──
      if (path === "/api/internal/computer-control") {
        const botId = url.searchParams.get("botId") ?? "";
        const bot = store.bot(botId);
        if (!bot) return json(res, 404, { error: "no such bot" });
        if (method === "GET") {
          const snapshot = botComputerControlSnapshot(botId, internalCapability.teamComputerId);
          const slot = autoVmClaims.get(internalCapability.threadId);
          const lazyClaim = slot && slot.owner.generation === internalCapability.generation ? slot : undefined;
          if (!snapshot.held && lazyClaim?.lazy && !lazyClaim.begin) {
            // First screen tools/call on a lazily-attached Auto VM (issue
            // #1361): fire the exclusive claim — once — and give it a moment
            // to land. A free, ready VM claims in the time of one container
            // inspect, so this call then proceeds with an honest answer;
            // only a claim still queued behind another holder answers held
            // below, and then the contention text is true. Keyed on the
            // slot, never on the thread's turn-computer entry: a bind this
            // turn abandoned earlier (a VPS that turned out to be asleep)
            // must not hide the unclaimed VM and let the call through.
            startAutoVmClaim(autoVmClaims, internalCapability.threadId, internalCapability.generation);
            await Promise.race([
              lazyClaim.begin ?? Promise.resolve(),
              new Promise<void>((resolve) => setTimeout(resolve, LAZY_VM_CLAIM_GRACE_MS)),
            ]);
          }
          if (!snapshot.held && lazyClaim?.failed === true) {
            // A rejected lazy claim (gate finding F1, issue #1361): the
            // computer MCP mounted at dispatch is still live, and the claim
            // may even have left a turn-computer entry behind (it can reject
            // after bindTurnComputer succeeded — lease lost to a person,
            // lifecycle busy, boot failure). Either way this turn owns no
            // usable VM, so keep refusing every screen call for the rest of
            // the generation; the bridge must never forward one onto a VM
            // this turn never claimed. Turn settle GC clears the slot. Say
            // why, and say not to retry: the contention text would send the
            // model into a screenshot loop against a claim that cannot land.
            return json(res, 200, {
              held: true, helpOpen: false,
              blockedReason: `This turn could not claim ${lazyClaim.label ?? "this computer"}${lazyClaim.failure ? ` (${lazyClaim.failure})` : ""}. This call was not performed. Do not retry computer work in this turn; tell the person what you could not do.`,
            });
          }
          if (!snapshot.held && lazyClaim?.lazy && lazyClaim.begin && !lazyClaim.claimed) {
            // The claim fired and is still waiting on the exclusive bind:
            // another turn genuinely holds this desktop right now.
            return json(res, 200, {
              held: true, helpOpen: false,
              blockedReason: "Another thread is using this computer. This call was not performed. Pause computer work until that thread finishes, then take a fresh screenshot before acting.",
            });
          }
          const computer = turnComputerResources.get(internalCapability.threadId);
          if (!snapshot.held && computer && computer.owner.generation === internalCapability.generation &&
              !claimTurnResource(computer.owner, computer.resource)) {
            return json(res, 200, {
              held: true, helpOpen: false,
              blockedReason: "Another thread is using this computer. This call was not performed. Pause computer work until that thread finishes, then take a fresh screenshot before acting.",
            });
          }
          return json(res, 200, { held: snapshot.held, helpOpen: snapshot.helpReason !== null });
        }
        if (method === "POST") {
          const body = await readInternalBody();
          const controlKey = internalCapability.teamComputerId ? teamComputerOwner(internalCapability.teamComputerId) : botId;
          const { snapshot, requestId } = computerControl.requestHelpLease(controlKey, body.reason);
          // worth a buzz: the bot is blocked on the person's hands, which
          // is exactly the "blocked on you" rule notify.ts encodes.
          // A bot stuck mid-room is not in its 1:1 thread — the turn and the
          // screen it needs hands on are in the room — so send the person
          // where the work is, and say which room it was.
          const roomTurn = activeGroupTurnForBot(bot.id);
          const target = blockedTarget({ ...bot, threadId: internalCapability.threadId }, roomTurn && { ...roomTurn.group, threadId: roomTurn.threadId });
          const helpPlace = store.taskByThread(bot.id, internalCapability.threadId)?.surface ?? bot.computer;
          const helpWhere = helpPlace && helpPlace !== "off" ? ` on ${surfaceLabel(helpPlace)}` : "";
          notify(
            buildNotification("takeover", bot, target.threadId, `${snapshot.helpReason ?? "asked you to take over"}${helpWhere}`, {
              group: target.group,
            }),
          );
          return json(res, 200, { held: snapshot.held, helpOpen: snapshot.helpReason !== null, requestId });
        }
        if (method === "DELETE") {
          const body = await readInternalBody();
          const snapshot = computerControl.expireHelp(internalCapability.teamComputerId ? teamComputerOwner(internalCapability.teamComputerId) : botId, body.requestId);
          return json(res, 200, { held: snapshot.held, helpOpen: snapshot.helpReason !== null });
        }
        return json(res, 405, { error: "method not allowed" });
      }
      if (method === "POST" && path === "/api/internal/connectors/request") {
        const body = await readInternalBody();
        const botId = String(body.botId ?? "");
        const threadId = String(body.threadId ?? "");
        const resumeKey = String(body.resumeKey ?? "");
        const rawItems = Array.isArray(body.items) ? body.items : Array.isArray(body.slugs) ? body.slugs : [];
        const items: { slug: string; alias?: string }[] = [];
        for (const raw of rawItems as unknown[]) {
          if (typeof raw === "string") {
            const slug = raw.trim().toLowerCase();
            if (CONNECTOR_SLUG.test(slug)) items.push({ slug });
            continue;
          }
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const row = raw as { slug?: unknown; toolkit?: unknown; alias?: unknown; account?: unknown };
          const slug = typeof row.slug === "string" ? row.slug : typeof row.toolkit === "string" ? row.toolkit : undefined;
          if (!slug || !CONNECTOR_SLUG.test(slug.toLowerCase())) continue;
          const alias = composio.normalizeAccountAlias((row.alias ?? row.account) as string | undefined);
          items.push({ slug: slug.toLowerCase(), ...(alias ? { alias } : {}) });
        }
        const slugs = [...new Set(items.map((item) => item.slug))];
        const owner = connectorThread(botId, threadId);
        if (!owner) return json(res, 403, { error: "conversation does not belong to this bot" });
        if (!/^[\w-]{8,100}$/.test(resumeKey)) return json(res, 400, { error: "invalid resume key" });
        if (!items.length || items.length > 12) return json(res, 400, { error: "one to twelve valid connection requests are required" });
        if (!composio.configured(cfg) || owner.bot.composio === false) {
          return json(res, 409, { error: "connected apps are not enabled for this bot" });
        }
        const connectionState: Record<string, { connected?: boolean }> = await composio.connectionStatus(cfg, slugs).catch(() => ({}));
        requireActiveInternalCapability();
        const messageIds: string[] = [];
        for (const item of items) {
          const existing = store.messagesFor(threadId).find(
            (message) => message.connector?.resumeKey === resumeKey && message.connector.slug === item.slug
              && (message.connector.alias ?? "").toLowerCase() === (item.alias ?? "").toLowerCase(),
          );
          if (existing) {
            messageIds.push(existing.id);
            continue;
          }
          const toolkit = await composio.toolkitCard(cfg, item.slug);
          requireActiveInternalCapability();
          const connected = connectionState[item.slug]?.connected === true;
          const status = item.alias ? "required" : connected ? "connected" : "required";
          const description = item.alias
            ? `Connect ${toolkit.label} as “${item.alias}” so the bot can continue`
            : toolkit.blurb || `Connect ${toolkit.label} so the bot can continue`;
          const message = store.appendMessage(threadId, {
            role: "bot",
            kind: "connector",
            ...(owner.group ? { from: { botId: owner.bot.id, name: owner.bot.name, color: owner.bot.color } } : {}),
            connector: {
              slug: item.slug,
              label: toolkit.label,
              description,
              status,
              resumeKey,
              ...(item.alias ? { alias: item.alias } : {}),
            },
          });
          messageIds.push(message.id);
        }
        maybeResumeConnectors(botId, threadId, resumeKey);
        return json(res, 200, { messageIds });
      }
      return json(res, 404, { error: "unknown internal endpoint" });
    }
    return false;
  };
}
