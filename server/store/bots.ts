// Bot lifecycle: creation with onboarding seed, reviewed team setup,
// profile edits, section filing, Chief-of-Staff election and deletion.
import { rmSync } from "node:fs";
import { join } from "node:path";

import { removeBotFolder, soulHash, writeSoulMirror } from "../bot-folder.ts";
import { DATA_DIR } from "../config.ts";
import { workspaceDir } from "../workspace.ts";
import { newId } from "../contracts.ts";
import { pickBotName } from "../names.ts";
import type { BotProfilePatch } from "../bot-profile.ts";
import { approvalModeFor } from "../../shared/approval-mode.ts";
import type { TeamSetupRequest, TeamSetupResult } from "../../shared/team-setup.ts";
import type { MausColor } from "../../shared/wire.ts";
import { sectionKey, UNTITLED_THREAD, type BotRecord } from "./records.ts";
import type { StoreContext } from "./context.ts";
import { deleteThreadRecord } from "./messages.ts";

const COLORS: MausColor[] = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
];

export function bot(ctx: StoreContext, id: string) {
  return ctx.bots.find((b) => b.id === id) ?? null;
}

export function botByThread(ctx: StoreContext, threadId: string) {
  return ctx.bots.find((b) => b.threadId === threadId || b.tasks?.some((t) => t.threadId === threadId)) ?? null;
}

export function createBot(
  ctx: StoreContext,
  profile: Partial<
    Pick<
      BotRecord,
      "name" | "title" | "description" | "soul" | "color" | "mascotExpression" | "mascotBody" | "modelSelection" | "section"
    >
  > = {},
  opts: {
    /** false = no greeting/onboarding seed. Imported bots must not open
     * with a first-person greeting the user never asked for. */
    seedMessages?: boolean;
  } = {},
): BotRecord {
  ctx.rememberSections([profile.section]);
  const name = profile.name?.trim() || pickBotName(ctx.bots.map((b) => b.name));
  const section = sectionKey(profile.section);
  const record: BotRecord = {
    id: newId(),
    threadId: newId(),
    name,
    title: profile.title ?? "",
    description: profile.description ?? "",
    soul: profile.soul ?? "",
    soulHash: soulHash(profile.soul ?? ""),
    notifications: true,
    color: profile.color ?? COLORS[ctx.bots.length % COLORS.length],
    ...(profile.mascotExpression ? { mascotExpression: profile.mascotExpression } : {}),
    ...(profile.mascotBody ? { mascotBody: profile.mascotBody } : {}),
    unread: false,
    modelSelection: profile.modelSelection ?? ctx.defaultSelection(),
    resumeCursors: {},
    createdAt: Date.now(),
  };
  if (section) record.section = section;
  record.tasks = [{
    threadId: record.threadId,
    title: UNTITLED_THREAD,
    createdAt: record.createdAt,
    resumeCursors: {},
    modelSelection: structuredClone(record.modelSelection),
    unread: false,
    activity: "idle",
    busy: false,
  }];
  ctx.bots.unshift(record);
  ctx.saveBots();
  // The folder exists from the first moment, so the user can open
  // SOUL.md before the bot has said a word. The record is canonical: a
  // mirror-write failure must never fail bot creation.
  try {
    writeSoulMirror(record.id, record.soul ?? "");
  } catch (e) {
    console.warn(`[bot-folder] could not write SOUL.md mirror for ${record.id}: ${(e as Error).message}`);
  }
  // Announce the owner before its onboarding transcript. SSE clients need
  // the bot/thread mapping before they can place either message.
  ctx.emit({ type: "bot", botId: record.id });
  // Keep the greeting valid for configured bots and every engine.
  if (opts.seedMessages !== false) {
    ctx.appendMessage(record.threadId, {
      role: "bot",
      kind: "text",
      text: `Hi, I'm ${name}. What would you like me to do?`,
    });
  }
  return record;
}

/** All setup fields and the Chief's receipt commit before publishing any
 * mutation. Model defaults never rewrite saved thread selections. */
export function applyTeamSetup(ctx: StoreContext, request: TeamSetupRequest): TeamSetupResult {
  const chief = ctx.bot(request.botId);
  if (!chief) throw new Error("The requesting Chief no longer exists");
  if (chief.lastTeamSetupReceipt?.requestId === request.requestId) return chief.lastTeamSetupReceipt.result;
  const managedSections = [...new Set([...(chief.managedSections ?? []), ...request.newTeams])];
  if (managedSections.length > 100 || managedSections.some((name) => name.trim() !== name || name.length > 60) ||
      request.newTeams.some((name) => !name) || (request.newTeams.length && !chief.chiefOfStaff)) throw new Error("Invalid reviewed Chief team scope");
  const nextBots = [...ctx.bots];
  const changed: BotRecord[] = [];
  for (const operation of request.operations) {
    const at = nextBots.findIndex((candidate) => candidate.id === operation.botId);
    let next: BotRecord;
    if (operation.action === "create") {
      if (at >= 0 || !operation.threadId || !operation.fields.name || !operation.fields.modelSelection) throw new Error("Invalid new bot in team setup");
      const createdAt = Date.now();
      next = { id: operation.botId, threadId: operation.threadId, name: operation.fields.name,
        title: "", description: "", soul: "", notifications: true, color: COLORS[nextBots.length % COLORS.length], unread: false,
        modelSelection: operation.fields.modelSelection, resumeCursors: {}, createdAt, ...operation.fields,
        approvalMode: "ask", autoApprove: false, composio: false, approvePeerComms: false,
        tasks: [{ threadId: operation.threadId, title: UNTITLED_THREAD, createdAt, resumeCursors: {},
          modelSelection: structuredClone(operation.fields.modelSelection), approvalMode: "ask", autoApprove: false,
          unread: false, activity: "idle", busy: false }],
      };
      nextBots.unshift(next);
    } else {
      if (at < 0) throw new Error("A setup target no longer exists");
      const previous = nextBots[at];
      next = { ...previous, ...operation.fields };
      if (operation.fields.modelSelection) next.tasks = previous.tasks?.map((task) => ({
        ...task,
        modelSelection: structuredClone(task.modelSelection ?? previous.modelSelection),
        approvalMode: approvalModeFor(ctx.projectBotForTask(previous.id, task.threadId)!),
        autoApprove: task.autoApprove ?? previous.autoApprove,
        alwaysAllow: structuredClone(task.alwaysAllow ?? previous.alwaysAllow ?? []),
      }));
      nextBots[at] = next;
    }
    next.section = sectionKey(next.section) || undefined;
    if (operation.fields.soul !== undefined) { next.soulHash = soulHash(operation.fields.soul); next.soulDrift = false; }
    changed.push(next);
  }
  const result: TeamSetupResult = { state: "applied", newTeams: request.newTeams, bots: changed.map((candidate, index) => ({
    id: candidate.id, name: candidate.name, section: candidate.section, modelSelection: structuredClone(candidate.modelSelection),
    action: request.operations[index].action === "create" ? "created" : "updated",
  })) };
  const chiefAt = nextBots.findIndex((candidate) => candidate.id === chief.id);
  const nextChief = { ...nextBots[chiefAt], lastTeamSetupReceipt: { requestId: request.requestId, result } };
  // Only the newly-created teams explicitly named in the human review may
  // extend this Chief's reach. Existing teams require owner settings.
  if (request.newTeams.length) {
    nextChief.managedSections = managedSections;
  }
  nextBots[chiefAt] = nextChief;
  ctx.saveBots(nextBots);
  ctx.bots = nextBots;
  for (const candidate of changed) {
    try { writeSoulMirror(candidate.id, candidate.soul ?? ""); } catch (error) {
      console.warn(`[bot-folder] could not refresh reviewed setup mirror for ${candidate.id}: ${(error as Error).message}`);
    }
    ctx.emit({ type: "bot", botId: candidate.id });
  }
  ctx.emit({ type: "bot", botId: chief.id });
  return result;
}

export function deleteBot(ctx: StoreContext, id: string, setupRequest?: TeamSetupRequest): boolean {
  const record = ctx.bot(id);
  if (!record) return false;
  let nextBots = ctx.bots.filter((b) => b.id !== id);
  if (setupRequest) {
    const chief = ctx.bot(setupRequest.botId);
    if (!chief || chief.id === id || setupRequest.deletion?.botId !== id) throw new Error("The reviewed deletion no longer has a valid owner");
    const lastTeamSetupReceipt: NonNullable<BotRecord["lastTeamSetupReceipt"]> = { requestId: setupRequest.requestId, result: { state: "applied", newTeams: [], bots: [
      { id: record.id, name: record.name, action: "deleted" },
    ] } };
    nextBots = nextBots.map((candidate) => candidate.id === chief.id ? { ...candidate, lastTeamSetupReceipt } : candidate);
  }
  // Persist removal and the review receipt before deleting conversation or
  // workspace data. A failed save must leave the bot recoverable in place.
  ctx.saveBots(nextBots);
  ctx.bots = nextBots;
  ctx.legacyActivities.delete(id);
  // every task's transcript goes with the bot, not just the open one
  for (const threadId of new Set([record.threadId, ...(record.tasks ?? []).map((t) => t.threadId)])) {
    deleteThreadRecord(ctx, threadId);
  }
  // the bot's workspace (files + memory) goes with it — same rule as its
  // transcripts: deleting a bot deletes what it knew
  try {
    rmSync(workspaceDir(id), { recursive: true, force: true });
  } catch {}
  // Generated task-workspaces are project files, not bot memory. Keep
  // them (and user-selected cwd folders) when deleting conversations.
  // Approval state deliberately lives outside the bot-writable workspace.
  // It still belongs to the bot, so deleting the bot must remove staged
  // proposals, manifests, and native-link ownership records with it.
  try {
    rmSync(join(DATA_DIR, "skill-state", id), { recursive: true, force: true });
  } catch {}
  // The bot folder (SOUL.md mirror) is the bot's too.
  removeBotFolder(id);
  ctx.emit({ type: "bot.deleted", botId: id });
  return true;
}

export function patchBot(ctx: StoreContext, id: string, patch: Partial<BotRecord>): BotRecord | null {
  const record = ctx.bot(id);
  if (!record) return null;
  // Runtime revocations must become effective in memory even when disk is
  // unavailable. Profile edits use the separate atomic path below.
  Object.assign(record, patch);
  const task = ctx.activeTask(id);
  if (task) {
    for (const key of ["resumeCursors", "rewound", "pinnedMessageId", "unread"] as const) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        Object.assign(task, { [key]: structuredClone(patch[key]) });
      }
    }
    record.unread = record.tasks!.some((candidate) => candidate.unread);
  }
  ctx.saveBots();
  ctx.emit({ type: "bot", botId: id });
  return record;
}

/** Voice ids belong to one provider's catalog. Changing the workspace
 * provider invalidates every per-agent selection as one durable mutation,
 * before clients are told to pick replacement voices. */
export function clearVoiceSelections(ctx: StoreContext): BotRecord[] {
  const changed = ctx.bots.filter((candidate) => candidate.voice !== undefined && candidate.voice !== "");
  if (!changed.length) return [];
  const next = ctx.bots.map((candidate) =>
    candidate.voice === undefined || candidate.voice === "" ? candidate : { ...candidate, voice: undefined });
  ctx.saveBots(next);
  for (const candidate of changed) {
    delete candidate.voice;
    ctx.emit({ type: "bot", botId: candidate.id });
  }
  return changed;
}

/** Commit a validated profile change before publishing its fields. Unlike
 * runtime revocation, a failed user edit must leave the old profile intact. */
export function patchBotProfile(ctx: StoreContext, id: string, patch: BotProfilePatch & Partial<Pick<BotRecord, "cwd" | "lastProfileRequestId">>): BotRecord | null {
  const record = ctx.bot(id);
  if (!record) return null;
  const next = { ...record, ...patch };
  if (patch.soul !== undefined) {
    next.soulHash = soulHash(patch.soul);
    next.soulDrift = false;
  }
  // Persist all fields together before publishing anything to the live
  // record. A failed write leaves both memory and disk at the old profile.
  ctx.saveBots(ctx.bots.map((candidate) => candidate.id === id ? next : candidate));
  Object.assign(record, next);
  if (patch.soul !== undefined) {
    try { writeSoulMirror(id, patch.soul); } catch (e) {
      console.warn(`[bot-folder] could not write SOUL.md mirror for ${id}: ${(e as Error).message}`);
    }
  }
  ctx.emit({ type: "bot", botId: id });
  return record;
}

/** Convenience for a soul-only change. The record is canonical; a failed
 * mirror write is reported in logs and can be retried by discarding drift. */
export function setSoul(ctx: StoreContext, id: string, soul: string): BotRecord | null {
  return ctx.patchBotProfile(id, { soul });
}

/** File visible bots into one sidebar section as a single durable write.
 *
 * This deliberately stages the complete next file before touching the
 * live records. A missing/hidden target therefore changes nothing, and a
 * failed atomic write cannot leave memory ahead of disk. A Chief collision
 * is refused rather than silently removing somebody's coordinator role. */
export function setBotsSection(
  ctx: StoreContext,
  botIds: string[],
  section: string,
): { ok: true; bots: BotRecord[] } | { ok: false; reason: "unavailable" | "chief-conflict" } {
  const ids = [...new Set(botIds)];
  const targets = ids.map((id) => ctx.bot(id));
  if (targets.some((candidate) => !candidate || candidate.hidden)) return { ok: false, reason: "unavailable" };

  const targetSection = sectionKey(section);
  const selected = targets as BotRecord[];
  const destinationChiefIds = new Set([
    ...selected.filter((candidate) => candidate.chiefOfStaff).map((candidate) => candidate.id),
    ...ctx.bots
      .filter((candidate) => candidate.chiefOfStaff && sectionKey(candidate.section) === targetSection)
      .map((candidate) => candidate.id),
  ]);
  if (destinationChiefIds.size > 1) return { ok: false, reason: "chief-conflict" };

  const patches = new Map<string, Partial<BotRecord>>();
  for (const candidate of selected) {
    patches.set(candidate.id, { section: targetSection || undefined });
  }

  const changedIds = new Set<string>();
  const nextBots = ctx.bots.map((candidate) => {
    const patch = patches.get(candidate.id);
    if (!patch) return candidate;
    const next = { ...candidate, ...patch };
    if (JSON.stringify(next) !== JSON.stringify(candidate)) changedIds.add(candidate.id);
    return next;
  });
  if (changedIds.size) {
    ctx.saveBots(nextBots);
    for (const candidate of ctx.bots) {
      const patch = patches.get(candidate.id);
      if (patch) Object.assign(candidate, patch);
    }
    for (const botId of changedIds) ctx.emit({ type: "bot", botId });
  }
  ctx.rememberSections([targetSection]);
  return { ok: true, bots: ids.map((id) => ctx.bot(id)!) };
}

/** Elect one Chief of Staff in its section (or clear one section) as one persisted change.
 * The changed records are returned so the server can update every open
 * window, including the bot that just handed the role over. */
export function setChiefOfStaff(ctx: StoreContext, id: string | null, section?: string | null): BotRecord[] | null {
  const selected = id ? ctx.bot(id) : null;
  if (id && !selected) return null;
  const targetSection = sectionKey(selected?.section ?? section);
  const changed: BotRecord[] = [];
  for (const candidate of ctx.bots) {
    if (sectionKey(candidate.section) !== targetSection) continue;
    const next = candidate.id === id;
    if (Boolean(candidate.chiefOfStaff) === next && !(next && candidate.hidden)) continue;
    if (next) {
      candidate.chiefOfStaff = true;
      // A section's main contact must stay reachable in the sidebar.
      candidate.hidden = false;
    } else {
      candidate.chiefOfStaff = false;
      delete candidate.managedSections;
    }
    changed.push(candidate);
  }
  if (changed.length) ctx.saveBots();
  for (const candidate of changed) ctx.emit({ type: "bot", botId: candidate.id });
  return changed;
}

/** First-run seed: one bot so the app never opens empty — it gets a
 * random friendly name like every other bot. */
export function seedIfEmpty(ctx: StoreContext) {
  if (ctx.bots.length) return;
  ctx.createBot();
}
