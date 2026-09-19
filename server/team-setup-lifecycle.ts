// The team-setup/profile request lifecycle -- the ProfileRequestService
// and TeamSetupRequestService wiring with their shared roster projection,
// and the card resolution/send helpers for both -- extracted verbatim from
// index.ts. The wiring cluster sat at profileRequests' original site,
// between deleteBotWithLifecycle and the routine timezone block;
// resolveAndSendProfile physically sat after that block, just before the
// WebhookManager wiring, and joins this factory because it is the profile
// half of the same request lifecycle (as a function declaration its
// original position was hoisted, so joining earlier changes nothing).
// index.ts calls createTeamSetupLifecycle at profileRequests' original
// site and rebinds the region's names from its result.
// deleteBotWithLifecycle stays in index.ts and crosses by value; routines
// is an index.ts let already assigned when this factory runs and crosses
// as a thunk; MAX_WORKSPACE_BOTS keeps its index.ts consumers and crosses
// by value.
import type { ServerResponse } from "node:http";
import { approvalModeFor, supportsApprovalMode } from "../shared/approval-mode.ts";
import type { TeamSetupRequest } from "../shared/team-setup.ts";
import { appendDecision } from "./decision-log.ts";
import { DATA_DIR } from "./config.ts";
import { json } from "./http.ts";
import { canAccessTeam, canReachPeer } from "./peer-roster.ts";
import { ProfileRequestService } from "./profile-requests.ts";
import { readSections } from "./section-context.ts";
import { sectionKey } from "./store.ts";
import { TeamSetupError, TeamSetupRequestService } from "./team-setup-requests.ts";
import { directTurnDispatchClaims, hasDirectDispatch, threadBusy } from "./turn-admission.ts";
import { registry, store } from "./runtime.ts";
import type { RoutineManager } from "./routines.ts";
import type { createBotViews } from "./bot-views.ts";
import type { createCheckedInputs } from "./checked-inputs.ts";
import type { createComputerLifecycle } from "./computer-lifecycle.ts";
import type { createDeferredResumes } from "./deferred-resumes.ts";
import type { createGroupTurnOperations } from "./group-turn-operations.ts";

/** Everything the lifecycle reads from its host. The helper families keep
 * the shapes of the factories index.ts destructured them from; routines is
 * a host let resolved at call time. */
export interface TeamSetupLifecycleDeps {
  helpers: {
    fullAccessForSource: ReturnType<typeof createBotViews>["fullAccessForSource"];
    proposalPersistence(botId: string, threadId: string): { ok: true } | { ok: false; status: number; error: string };
    assertTeamComputerChangeIdle: ReturnType<typeof createComputerLifecycle>["assertTeamComputerChangeIdle"];
    connectorThread: ReturnType<typeof createDeferredResumes>["connectorThread"];
    activeGroupTurnForBot: ReturnType<typeof createGroupTurnOperations>["activeGroupTurnForBot"];
    checkedModelSelection: ReturnType<typeof createCheckedInputs>["checkedModelSelection"];
    wireBot: ReturnType<typeof createBotViews>["wireBot"];
    teamSetupResumeGenerations: ReturnType<typeof createDeferredResumes>["teamSetupResumeGenerations"];
    dispatchTeamSetupResume: ReturnType<typeof createDeferredResumes>["dispatchTeamSetupResume"];
    broadcast(payload: Record<string, unknown>): void;
    deleteBotWithLifecycle(botId: string, revalidate?: () => void, setupRequest?: TeamSetupRequest): Promise<{ status: number; body: { error?: string; ok?: boolean } }>;
  };
  lateBound: {
    routines(): RoutineManager | null;
  };
  limits: {
    maxWorkspaceBots: number;
  };
}

export function createTeamSetupLifecycle(deps: TeamSetupLifecycleDeps) {
  const {
    fullAccessForSource, proposalPersistence, assertTeamComputerChangeIdle, connectorThread,
    activeGroupTurnForBot, checkedModelSelection, wireBot, teamSetupResumeGenerations,
    dispatchTeamSetupResume, broadcast, deleteBotWithLifecycle,
  } = deps.helpers;
  const routines = deps.lateBound.routines;
  const MAX_WORKSPACE_BOTS = deps.limits.maxWorkspaceBots;

const profileRequests = new ProfileRequestService({
  store,
  autoApply: fullAccessForSource,
  canPersist: proposalPersistence,
  // A Chief may change a section peer; anyone else only itself. Re-checked at confirm.
  validateTarget: (proposerBotId, targetBotId) => {
    const proposer = store.bot(proposerBotId);
    const target = store.bot(targetBotId);
    if (!target) return "that bot no longer exists";
    if (!proposer?.chiefOfStaff) return "only a section's Chief of Staff can change another bot's profile";
    if (!canReachPeer(proposer, target)) return "that bot is not in a team this Chief is allowed to manage";
    return null;
  },
});
const teamSetupTeams = () => [...new Set(["", ...readSections(), ...store.bots.map((bot) => sectionKey(bot.section)), ...store.groups.map((group) => sectionKey(group.section))])];
const teamSetupRequests = new TeamSetupRequestService({
  store, teams: teamSetupTeams, canAccessTeam, canPersist: proposalPersistence, maxBots: MAX_WORKSPACE_BOTS,
  autoApply: fullAccessForSource,
  validateChange: (before, fields) => assertTeamComputerChangeIdle(before, { ...before, ...fields }),
  ownsThread: (botId, threadId) => Boolean(connectorThread(botId, threadId)),
  targetBusy: (botId, sourceThreadId) => {
    if (!sourceThreadId) return Boolean(store.bot(botId)?.busy || hasDirectDispatch(botId) || activeGroupTurnForBot(botId) || routines()?.activeRunForBot(botId));
    const group = activeGroupTurnForBot(botId);
    const run = routines()?.activeRunForBot(botId);
    return store.tasks(botId).some(task => task.threadId !== sourceThreadId && threadBusy(botId, task.threadId)) ||
      [...directTurnDispatchClaims].some(([threadId, claim]) => threadId !== sourceThreadId && claim.botId === botId) ||
      Boolean(group && group.threadId !== sourceThreadId) || Boolean(run && run.threadId !== sourceThreadId);
  },
  validateModel: (selection, current) => {
    const checked = checkedModelSelection(selection, undefined, true);
    if (!checked.ok) return checked.error;
    if (current?.approvalGrant) return "Wait for the approval-level confirmation before changing this bot's model";
    if (current) {
      const mode = approvalModeFor(current);
      const driver = registry.cliTarget(selection.instanceId)?.driverKind;
      if (!supportsApprovalMode(driver, mode) || ((mode === "full" || mode === "custom") && driver !== registry.cliTarget(current.modelSelection.instanceId)?.driverKind)) {
        return `@${current.name}'s existing permissions are incompatible with that provider. Change its permissions in bot settings, then propose the model change again.`;
      }
    }
    return null;
  },
  deleteBot: async (botId, revalidate, request) => {
    const result = await deleteBotWithLifecycle(botId, revalidate, request);
    if (result.status >= 400) throw new TeamSetupError(result.body.error ?? "The bot could not be deleted", result.status);
  },
});

async function resolveAndSendTeamSetup(res: ServerResponse, args: { botId: string; threadId: string; requestId: string; behavior: string }, ownerReview: boolean): Promise<boolean> {
  const card = store.messagesFor(args.threadId).find((item) => item.card?.requestId === args.requestId && item.card.teamSetupRequest)?.card;
  if (!card) return false;
  if (args.behavior === "allow" && !ownerReview) { json(res, 403, { error: "Approve team setup or deletion from the desktop app or a paired owner device. In a local browser, wait until every bot is idle." }); return true; }
  if (args.behavior === "allow" && !card.answered && !card.dismissed) {
    // Confirmed Chief setup can move bots without the ordinary PATCH route.
    // Keep that atomic Store operation behind the same shared-machine fence.
    for (const operation of card.teamSetupRequest!.operations) {
      const before = store.bot(operation.botId);
      if (before && operation.action === "update") assertTeamComputerChangeIdle(before, { ...before, ...operation.fields });
    }
  }
  const resumeGeneration = teamSetupResumeGenerations.get(args.threadId) ?? 0;
  const resolved = await teamSetupRequests.resolve(args);
  if (!resolved) return false;
  if (!resolved.duplicate) {
    appendDecision(DATA_DIR, { threadId: args.threadId, requestId: args.requestId, botId: args.botId, tool: card.tool,
      summary: card.subtitle, decision: resolved.result.state === "applied" ? "user-approved" : "user-denied", source: "user" });
  }
  const current = store.messagesFor(args.threadId).find((item) => item.id === resolved.messageId);
  if (current?.card?.teamSetupRequest?.result && !current.card.teamSetupRequest.resumed) {
    store.patchMessage(args.threadId, current.id, { card: { ...current.card, teamSetupRequest: { ...current.card.teamSetupRequest, resumed: true } } });
    dispatchTeamSetupResume({ request: resolved.request, messageId: resolved.messageId, generation: resumeGeneration });
  }
  json(res, 200, { ok: true, outcome: resolved.result.state === "applied" ? "allowed-once" : "rejected", result: resolved.result, alreadySettled: resolved.duplicate });
  return true;
}

function resolveAndSendProfile(
  res: ServerResponse,
  args: { botId: string; botName?: string; threadId: string; requestId: string; behavior: string },
): boolean {
  const card = store.messagesFor(args.threadId).find(
    (message) => message.card?.requestId === args.requestId && message.card.profileRequest,
  )?.card;
  if (!card) return false;
  const result = profileRequests.resolve(args);
  if (!result.claimed) return false;
  if (result.state === "applied" || result.state === "denied") {
    appendDecision(DATA_DIR, {
      threadId: args.threadId, requestId: args.requestId, botId: args.botId, botName: args.botName,
      tool: "update_profile", summary: card.subtitle,
      decision: result.state === "applied" ? "user-approved" : "user-denied", source: "user",
    });
  }
  if (result.state === "applied") {
    const target = store.bot(result.targetBotId);
    if (target) broadcast({ kind: "bot", bot: wireBot(target) });
    json(res, 200, {
      ok: true, outcome: "allowed-once", profileFields: result.fields,
      ...(result.settlementPending ? { settlementPending: true, message: result.message } : {}),
    });
    return true;
  }
  if (result.state === "invalid") { json(res, result.status, { error: result.error }); return true; }
  if (result.state === "already_settled") {
    json(res, 200, { ok: true, outcome: result.behavior === "allow" ? "allowed-once" : "rejected", alreadySettled: true });
    return true;
  }
  json(res, 200, { ok: true, outcome: "rejected" });
  return true;
}

  return {
    profileRequests, teamSetupTeams, teamSetupRequests, resolveAndSendTeamSetup,
    resolveAndSendProfile,
  };
}
