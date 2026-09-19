// Routines listing and the proposal endpoints: routine, profile, team
// setup, and bot-deletion requests. Bodies moved verbatim from
// ../internal.ts; the dispatch chain there owns order.
import type { ServerResponse } from "node:http";

import { z } from "zod";
import { DATA_DIR } from "../../config.ts";
import { appendDecision } from "../../decision-log.ts";
import { canAccessTeam, canReachPeer, peerAllowed, PEER_ACCESS_HELP} from "../../peer-roster.ts";
import type { RoutineRun } from "../../routines.ts";
import type { InternalRoutesOptions } from "../internal.ts";
import type { InternalRequestCtx } from "./types.ts";

export type RequestsCtx = InternalRequestCtx & {
  store: InternalRoutesOptions["store"];
  registry: InternalRoutesOptions["registry"];
  routineRequests: InternalRoutesOptions["routineRequests"];
  profileRequests: InternalRoutesOptions["profileRequests"];
  teamSetupRequests: InternalRoutesOptions["teamSetupRequests"];
  agentRoutine: InternalRoutesOptions["agentRoutine"];
  routineTimeZone: InternalRoutesOptions["routineTimeZone"];
  teamSetupTeams: InternalRoutesOptions["teamSetupTeams"];
  proposalPersistence: InternalRoutesOptions["proposalPersistence"];
  connectorThread: InternalRoutesOptions["connectorThread"];
  internalCapabilityIsActive: InternalRoutesOptions["internalCapabilityIsActive"];
}

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

export async function routinesList(ctx: RequestsCtx, res: ServerResponse): Promise<boolean> {
  const {
    routines, agentRoutine, routineTimeZone, connectorThread, internalCapability, internalSender, json,
  } = ctx;
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

export async function routineRequestSubmit(ctx: RequestsCtx, res: ServerResponse): Promise<boolean> {
  const {
    store, routineRequests, proposalPersistence, connectorThread, internalCapabilityIsActive,
    internalCapability, internalSender, json, readInternalBody,
  } = ctx;
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

export async function profileRequestSubmit(ctx: RequestsCtx, res: ServerResponse): Promise<boolean> {
  const {
    store, profileRequests, connectorThread, json, readInternalBody,
  } = ctx;
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

export async function teamSetupCatalog(ctx: RequestsCtx, res: ServerResponse): Promise<boolean> {
  const {
    store, registry, teamSetupTeams, requireActiveInternalCapability, internalCapability, json,
  } = ctx;
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

export async function teamSetupRequestSubmit(ctx: RequestsCtx, res: ServerResponse): Promise<boolean> {
  const {
    store, teamSetupRequests, connectorThread, internalCapabilityIsActive, internalCapability, json, readInternalBody,
  } = ctx;
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

export async function botDeletionRequestSubmit(ctx: RequestsCtx, res: ServerResponse): Promise<boolean> {
  const {
    store, teamSetupRequests, connectorThread, internalCapabilityIsActive, internalCapability, json, readInternalBody,
  } = ctx;
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

