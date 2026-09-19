// The learned-skill request lifecycle -- the proposal persistence gates,
// the staged-write listing/cleanup projections, the approval-card copy and
// append helpers, and the resolve/send pair the bot-thread routes fold --
// extracted verbatim from index.ts. index.ts calls createSkillLifecycle at
// the region's original site (between the room-post eligibility check and
// the phone-secret submission registry) and rebinds every name its later
// route and system-payload consumers use; skillCardCopy is internal to
// appendSkillRequestCard and stays unreturned. proposalPersistence is also
// consumed EARLIER in index.ts (the routine and team-setup lifecycles
// captured the old hoisted declaration by value), so those call sites now
// pass wrapper thunks over the name returned here.
import { createHash, randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { appendDecision } from "./decision-log.ts";
import { DATA_DIR } from "./config.ts";
import { json } from "./http.ts";
import {
  applyStagedSkillWrite,
  getStagedSkillWrite,
  listStagedSkillWrites,
  rejectStagedSkillWrite,
} from "./skills.ts";
import { store } from "./runtime.ts";
import type { SkillRequestCardData } from "../shared/skill-request.ts";
import type { createBotViews } from "./bot-views.ts";
import type { createDeferredResumes } from "./deferred-resumes.ts";

/** Everything the skill lifecycle reads from its host. Both helpers were
 * already-initialized consts above the region's original site. */
export interface SkillLifecycleDeps {
  helpers: {
    connectorThread: ReturnType<typeof createDeferredResumes>["connectorThread"];
    fullAccessForSource: ReturnType<typeof createBotViews>["fullAccessForSource"];
  };
}

export function createSkillLifecycle(deps: SkillLifecycleDeps) {
  const { connectorThread, fullAccessForSource } = deps.helpers;

function proposalPersistence(botId: string, threadId: string) {
  if (!store.bot(botId)) {
    return { ok: false as const, status: 403, error: "unknown sender" };
  }
  if (!connectorThread(botId, threadId)) {
    return { ok: false as const, status: 403, error: "source conversation does not belong to sender" };
  }
  if (fullAccessForSource(botId, threadId)) return { ok: true as const };
  // Only cards on the visible branch can be acted on from the composer.
  // Abandoned branches must not permanently consume the proposal quota.
  // Routine and profile proposals share one budget per bot per thread, so
  // one thread cannot pile up 8 of each.
  const openRequests = store.activePath(threadId).filter(
    (message) =>
      (message.card?.routineRequest?.botId === botId || message.card?.profileRequest?.botId === botId || message.card?.teamSetupRequest?.botId === botId) &&
      !message.card.answered &&
      !message.card.dismissed,
  ).length;
  return openRequests >= 8
    ? { ok: false as const, status: 429, error: "confirm or cancel an existing proposal first" }
    : { ok: true as const };
}

function skillProposalPersistence(botId: string, threadId: string) {
  if (!store.bot(botId)) {
    return { ok: false as const, status: 403, error: "unknown sender" };
  }
  if (!connectorThread(botId, threadId)) {
    return { ok: false as const, status: 403, error: "source conversation does not belong to sender" };
  }
  if (fullAccessForSource(botId, threadId)) return { ok: true as const };
  const openRequests = store.activePath(threadId).filter(
    (message) =>
      message.card?.skillRequest?.botId === botId &&
      !message.card.answered &&
      !message.card.dismissed,
  ).length;
  return openRequests >= 8
    ? { ok: false as const, status: 429, error: "confirm or cancel an existing learned-skill card first" }
    : { ok: true as const };
}

/** Listing endpoints expose lifecycle metadata, never the staged instructions
 * themselves. The exact review copy lives only on the durable approval card. */
function stagedSkillListing(staged: ReturnType<typeof listStagedSkillWrites>[number]) {
  const { files: _files, baseSha256: _baseSha256, baseAppliedStageId: _baseAppliedStageId, ...listing } = staged;
  return listing;
}

/** Capture proposal cleanup before a transcript is deleted. Staged writes
 * are bot-scoped and live outside the thread, so deleting the only card
 * without this would reserve its name for up to 30 days with no decision UI.
 * Ownership comes from the server-authored sender, never the card payload. */
function stagedSkillCleanupsForThread(threadId: string): Array<{ botId: string; stagedId: string }> {
  const directOwner = store.botByThread(threadId)?.id;
  const seen = new Set<string>();
  const cleanups: Array<{ botId: string; stagedId: string }> = [];
  for (const message of store.messagesFor(threadId)) {
    const request = message.card?.skillRequest;
    const botId = message.from?.botId ?? directOwner;
    if (!request || !botId) continue;
    const key = `${botId}:${request.stagedId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleanups.push({ botId, stagedId: request.stagedId });
  }
  return cleanups;
}

function rejectDeletedThreadSkillStages(cleanups: Array<{ botId: string; stagedId: string }>): void {
  for (const cleanup of cleanups) rejectStagedSkillWrite(cleanup.botId, cleanup.stagedId);
}

function skillCardCopy(staged: { action: "create" | "update"; name: string; gist: string; warnings: string[] }): {
  title: string;
  subtitle: string;
  tool: string;
} {
  const warnings = staged.warnings.length ? `\n\nWarnings:\n- ${staged.warnings.join("\n- ")}` : "";
  return {
    title: staged.action === "create"
      ? `Enable skill "${staged.name}"?`
      : `Update skill "${staged.name}"?`,
    subtitle: `${staged.gist || staged.name}\n\nAdds one line to the prompt index; the body is read only when used.${warnings}`,
    tool: "stage_skill",
  };
}

function appendSkillRequestCard(args: {
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
}): { requestId: string; summary: string } {
  const requestId = randomUUID();
  const copy = skillCardCopy(args.staged);
  const payload: SkillRequestCardData = {
    version: 1,
    requestId,
    botId: args.botId,
    threadId: args.threadId,
    stagedId: args.staged.id,
    action: args.staged.action,
    name: args.staged.name,
    gist: args.staged.gist,
    source: args.staged.source,
    preview: args.staged.files.find((file) => file.path === "SKILL.md")?.content ?? "",
    sha256: args.staged.sha256,
    warnings: args.staged.warnings,
    createdAt: Date.now(),
  };
  const from = store.bot(args.botId);
  store.appendMessage(args.threadId, {
    role: "bot",
    kind: "options",
    from: from ? { botId: from.id, name: from.name, color: from.color } : undefined,
    card: {
      title: copy.title,
      subtitle: copy.subtitle,
      options: args.applied ? [] : [args.staged.action === "create" ? "Enable" : "Update", "Deny"],
      ...(args.applied ? { answered: "allow", title: `Skill "${args.staged.name}" ${args.staged.action === "create" ? "enabled" : "updated"}` } : {}),
      requestId,
      tool: copy.tool,
      skillRequest: payload,
    },
  });
  return {
    requestId,
    summary: `${copy.title} ${args.staged.gist}`.trim(),
  };
}

function resolveSkillRequest(args: {
  botId: string;
  botName?: string;
  threadId: string;
  requestId: string;
  behavior: "allow" | "deny" | "answer";
  reviewedSha256?: string;
}):
  | { claimed: false }
  | { claimed: true; status: number; error: string }
  | { claimed: true; outcome: "allowed-once" | "rejected"; alreadySettled?: true } {
  const message = store.messagesFor(args.threadId).find(
    (candidate) => candidate.card?.requestId === args.requestId && candidate.card.skillRequest,
  );
  const card = message?.card;
  const request = card?.skillRequest;
  if (!request || !card || !message) return { claimed: false };
  if (request.botId !== args.botId) {
    return { claimed: true, status: 403, error: "this skill request belongs to a different bot" };
  }
  if (card.answered || card.dismissed) {
    // Settlement is durable before cleanup. Retry cleanup for either outcome
    // so a disk failure cannot leave a denied name permanently reserved.
    const cleanup = rejectStagedSkillWrite(args.botId, request.stagedId);
    if ("applied" in cleanup && cleanup.applied && card.answered !== "allow") {
      store.patchMessage(args.threadId, message.id, {
        card: { ...card, answered: "allow", dismissed: false, held: undefined },
      });
      return { claimed: true, outcome: "allowed-once", alreadySettled: true };
    }
    return { claimed: true, outcome: card.answered === "allow" ? "allowed-once" : "rejected", alreadySettled: true };
  }
  if (args.behavior !== "allow") {
    const rejected = rejectStagedSkillWrite(args.botId, request.stagedId);
    if ("error" in rejected && rejected.error !== "no such staged skill") {
      return { claimed: true, status: 409, error: rejected.error };
    }
    if ("applied" in rejected) {
      store.patchMessage(args.threadId, message.id, {
        card: { ...card, answered: "allow", dismissed: false, held: undefined },
      });
      appendDecision(DATA_DIR, {
        threadId: args.threadId,
        requestId: args.requestId,
        botId: args.botId,
        botName: args.botName,
        tool: card.tool,
        summary: card.subtitle,
        decision: "user-approved",
        source: "user",
      });
      return { claimed: true, outcome: "allowed-once" };
    }
    store.patchMessage(args.threadId, message.id, {
      card: { ...card, answered: "deny", dismissed: true, held: undefined },
    });
    appendDecision(DATA_DIR, {
      threadId: args.threadId,
      requestId: args.requestId,
      botId: args.botId,
      botName: args.botName,
      tool: card.tool,
      summary: card.subtitle,
      decision: "user-denied",
      source: "user",
    });
    return { claimed: true, outcome: "rejected" };
  }
  if (typeof request.preview !== "string" || typeof request.sha256 !== "string") {
    return {
      claimed: true,
      status: 409,
      error: "this proposal was created by an older build — deny it and ask the bot to create it again",
    };
  }
  if (args.reviewedSha256 !== request.sha256) {
    return {
      claimed: true,
      status: 409,
      error: "reviewedSha256 must match the skill shown on the approval card",
    };
  }
  const previewSha256 = createHash("sha256").update(request.preview).digest("hex");
  if (previewSha256 !== request.sha256) {
    return { claimed: true, status: 422, error: "the skill preview changed after review — deny and recreate it" };
  }
  const staged = getStagedSkillWrite(args.botId, request.stagedId);
  if (!staged) {
    // A later proposal may have pruned this already-applied replay record.
    // The protected manifest still binds the stage id and reviewed hash, so
    // the old card can be settled without asking the model to recreate it.
    const replayed = applyStagedSkillWrite(args.botId, request.stagedId, {
      expectedSha256: request.sha256,
    });
    if (
      "error" in replayed ||
      replayed.name !== request.name ||
      replayed.source !== request.source
    ) {
      return {
        claimed: true,
        status: 422,
        error: "the staged skill no longer matches this approval card",
      };
    }
    const patched = store.patchMessage(args.threadId, message.id, {
      card: { ...card, answered: "allow", held: undefined },
    });
    if (!patched) {
      return { claimed: true, status: 409, error: "the learned-skill approval card is no longer available" };
    }
    appendDecision(DATA_DIR, {
      threadId: args.threadId,
      requestId: args.requestId,
      botId: args.botId,
      botName: args.botName,
      tool: card.tool,
      summary: card.subtitle,
      decision: "user-approved",
      source: "user",
    });
    return { claimed: true, outcome: "allowed-once" };
  }
  if (
    request.requestId !== args.requestId ||
    request.threadId !== args.threadId ||
    staged.action !== request.action ||
    staged.name !== request.name ||
    staged.source !== request.source ||
    staged.sha256 !== request.sha256
  ) {
    return { claimed: true, status: 422, error: "the staged skill no longer matches this approval card" };
  }
  const applied = applyStagedSkillWrite(args.botId, request.stagedId, {
    expectedSha256: request.sha256,
    onApplied: () => {
      const patched = store.patchMessage(args.threadId, message.id, {
        card: { ...card, answered: "allow", held: undefined },
      });
      if (!patched) throw new Error("the learned-skill approval card is no longer available");
    },
  });
  if ("error" in applied) {
    store.patchMessage(args.threadId, message.id, {
      card: { ...card, held: applied.error },
    });
    return { claimed: true, status: 422, error: applied.error };
  }
  appendDecision(DATA_DIR, {
    threadId: args.threadId,
    requestId: args.requestId,
    botId: args.botId,
    botName: args.botName,
    tool: card.tool,
    summary: card.subtitle,
    decision: "user-approved",
    source: "user",
  });
  return { claimed: true, outcome: "allowed-once" };
}

function sendSkillResolution(
  res: ServerResponse,
  result: ReturnType<typeof resolveSkillRequest>,
): boolean {
  if (!result.claimed) return false;
  if ("error" in result) {
    json(res, result.status, { error: result.error });
    return true;
  }
  json(res, 200, { ok: true, outcome: result.outcome, alreadySettled: result.alreadySettled });
  return true;
}

  return {
    proposalPersistence, skillProposalPersistence, stagedSkillListing,
    stagedSkillCleanupsForThread, rejectDeletedThreadSkillStages,
    appendSkillRequestCard, resolveSkillRequest, sendSkillResolution,
  };
}
