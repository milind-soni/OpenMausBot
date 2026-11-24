// skill_manage on all of the person's bots in one call: create (or import) with all_bots, and update or delete of a skill
// that is already on all their bots. Like the bot's own skill changes, it applies directly with a receipt and Undo where
// those do, and otherwise waits on a card; approval applies only the exact files the card showed, pinned on the server.
// "All their bots" is the calling bot's person's (skills-for-all-bots.ts): on a Team Cloud the member it reports to, so a
// bot nobody owns is refused. Turning one on or off stays a per-bot switch (skill-switch-host.ts).
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import type { SkillRequestCardData } from "../../shared/skill-request.ts";
import type { OptionCardData } from "../../shared/wire.ts";
import { writeFileAtomic } from "../atomic.ts";
import { appendDecision } from "../decision-log.ts";
import { UNDO_STALE, type DirectApply } from "../direct-apply.ts";
import { botOwner } from "../../shared/bot-owner.ts";
import { personKey } from "../person-key.ts";
import { redactSecretsInText } from "../redact.ts";
import { conversationLanguage, serverLine, type ServerLineKey } from "../server-lines.ts";
import { learnSource } from "../skill-learn.ts";
import { parseSkillManageReferences } from "../skill-request-card.ts";
import { listSkills, preparedLearnedSkill, STAGED_GIST_MAX, STAGED_SKILL_FILE_MAX_BYTES } from "../skills.ts";
import { allBotsScopeOfBot, allBotsSkills, SKILLS_FOR_ALL_BOTS_DIR, skillsForAllBotsOnTeam } from "../skills-for-all-bots.ts";
import { copyDigest, putOnAllBots, removeFromAllBots, restoreOwnCopies, sharedCopy, type RetiredCopy, type SkillCopy } from "../skills-for-all-bots-ops.ts";
import type { BotRecord, Message, Store } from "../store.ts";

type Action = "create" | "update" | "delete";
type Result = { status: number; body: Record<string, unknown> };

export interface SkillsForAllBotsHostDeps {
  store: Pick<Store, "bot" | "appendMessage" | "patchMessage">;
  dataDir: string;
  persistence(botId: string, threadId: string, opensCard: boolean): { ok: true } | { ok: false; status: number; error: string };
  noteSkillChange(botId: string, threadId: string): void;
}

const fileSchema = z.object({ path: z.string(), content: z.string(), base64: z.boolean().optional() });
const copySchema = z.object({ skillMd: z.string(), files: z.array(fileSchema), source: z.string() });
const recordSchema = z.object({
  scope: z.string(), action: z.enum(["create", "update", "delete"]), name: z.string(), digest: z.string(),
  copy: copySchema.optional(), previous: copySchema.optional(),
  retired: z.array(z.object({ botId: z.string(), wasOff: z.boolean(), copy: copySchema })).optional(),
});
type StoredCopy = z.infer<typeof copySchema>;
type SkillRecord = z.infer<typeof recordSchema>;

const stored = (copy: SkillCopy): StoredCopy => ({
  skillMd: copy.skillMd, source: copy.source,
  files: copy.files.map((file) => typeof file.content === "string" ? { path: file.path, content: file.content } : { path: file.path, content: Buffer.from(file.content).toString("base64"), base64: true }),
});
const loaded = (copy: StoredCopy): SkillCopy => ({
  skillMd: copy.skillMd, source: copy.source,
  files: copy.files.map((file) => ({ path: file.path, content: file.base64 ? new Uint8Array(Buffer.from(file.content, "base64")) : file.content })),
});

const OPTION: Record<Action, string> = { create: "Enable", update: "Update", delete: "Delete" };
const LINES = {
  create: { title: "server.allBotsSkill.create.title", done: "server.allBotsSkill.create.done" },
  update: { title: "server.allBotsSkill.update.title", done: "server.allBotsSkill.update.done" },
  delete: { title: "server.allBotsSkill.delete.title", done: "server.allBotsSkill.delete.done" },
} as const satisfies Record<Action, { title: ServerLineKey; done: ServerLineKey }>;

/** The skill a bot's skill_manage call means to change on all of the person's bots, or null when it is about the bot's own. */
function claimed(bot: BotRecord, body: Record<string, unknown>): { action: Action; name: string } | null {
  const name = typeof body.skill_name === "string" ? body.skill_name.trim() : "";
  if ((body.action === "create" || body.action === "import") && body.all_bots === true) return { action: "create", name };
  if (body.action !== "update" && body.action !== "delete") return null;
  if (body.all_bots !== true && (!name || listSkills(bot.id).some((skill) => skill.name === name) || !allBotsSkills(bot.id).some((skill) => skill.name === name))) return null;
  return { action: body.action, name };
}

export function createSkillsForAllBotsHost(deps: SkillsForAllBotsHostDeps) {
  const { store } = deps;
  const recordPath = (requestId: string) => join(deps.dataDir, SKILLS_FOR_ALL_BOTS_DIR, "requests", `${requestId}.json`);
  const readRecord = (requestId: string): SkillRecord | null => {
    try {
      const parsed = recordSchema.safeParse(JSON.parse(readFileSync(recordPath(requestId), "utf8")));
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  };
  const writeRecord = (requestId: string, record: SkillRecord) => {
    mkdirSync(dirname(recordPath(requestId)), { recursive: true, mode: 0o700 });
    writeFileAtomic(recordPath(requestId), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  };
  const dropRecord = (requestId: string) => rmSync(recordPath(requestId), { force: true });

  /** The new files a create or update brings, checked as a bot's own learned skill is. An update keeps the files beside
   * SKILL.md it does not mention, and a reference sent empty removes that one, as a bot's own update does. */
  function proposed(body: Record<string, unknown>, action: "create" | "update", name: string, current: SkillCopy | null): { copy: SkillCopy; name: string; gist: string; warnings: string[] } | { error: string } {
    const skillMd = redactSecretsInText(typeof body.skill_md === "string" ? body.skill_md : "");
    if (!skillMd.trim()) return { error: "skill_manage needs skill_md: the full SKILL.md including YAML frontmatter" };
    if (Buffer.byteLength(skillMd, "utf8") > STAGED_SKILL_FILE_MAX_BYTES) return { error: `SKILL.md files must be at most ${STAGED_SKILL_FILE_MAX_BYTES / 1024}KB` };
    const source = typeof body.source === "string" ? body.source.trim() : "";
    if (!source) return { error: 'source must be a URL, folder, or "conversation"' };
    const references = parseSkillManageReferences(body.references);
    if ("error" in references) return references;
    const removals = new Set(references.filter((file) => !file.content.trim()).map((file) => file.path));
    if (removals.size && action !== "update") return { error: `empty reference content removes a file only on update; give ${[...removals][0]} its content` };
    const prepared = preparedLearnedSkill([{ path: "SKILL.md", content: skillMd }, ...references.filter((file) => !removals.has(file.path)).map((file) => ({ path: file.path, content: redactSecretsInText(file.content) }))]);
    if ("error" in prepared) return prepared;
    if (action === "update" && prepared.parsed.name !== name) return { error: `updated SKILL.md name must remain "${name}"` };
    const files = new Map((action === "update" ? current?.files ?? [] : []).map((file) => [file.path, file] as const));
    for (const path of removals) if (!files.delete(path)) return { error: `cannot remove ${path}: the skill has no such reference file` };
    for (const file of prepared.files.slice(1)) files.set(file.path, file);
    const gist = redactSecretsInText(typeof body.gist === "string" ? body.gist : "").replace(/\s+/g, " ").trim().slice(0, STAGED_GIST_MAX) || prepared.parsed.description.slice(0, STAGED_GIST_MAX);
    const kept = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { copy: { skillMd: prepared.files[0]!.content, files: kept, source: learnSource(source) }, name: prepared.parsed.name, gist, warnings: prepared.warnings };
  }

  function appendCard(args: { requestId: string; bot: BotRecord; threadId: string; action: Action; name: string; gist: string; preview: string; source: string; warnings: string[]; applied?: { previous?: SkillRequestCardData["previous"] } }): string {
    const language = conversationLanguage(args.threadId);
    const preview = redactSecretsInText(args.preview);
    const payload: SkillRequestCardData = {
      version: 1, requestId: args.requestId, botId: args.bot.id, threadId: args.threadId, stagedId: `all-bots-${args.requestId}`,
      action: args.action, name: args.name, gist: args.gist, source: args.source, preview, sha256: createHash("sha256").update(preview).digest("hex"),
      warnings: args.warnings, createdAt: Date.now(), allBots: true, ...(args.applied?.previous ? { previous: args.applied.previous } : {}),
    };
    const title = serverLine(language, LINES[args.action].title, { name: args.name });
    const done = serverLine(language, LINES[args.action].done, { name: args.name });
    const body = serverLine(language, args.action === "delete" ? "server.allBotsSkill.deleteBody" : "server.allBotsSkill.body");
    const warnings = args.warnings.length ? `\n\nWarnings:\n- ${args.warnings.join("\n- ")}` : "";
    store.appendMessage(args.threadId, {
      role: "bot", kind: "options", from: { botId: args.bot.id, name: args.bot.name, color: args.bot.color },
      card: {
        title, subtitle: `${args.gist ? `${args.gist}\n\n` : ""}${body}${warnings}`, options: args.applied ? [] : [OPTION[args.action], "Deny"],
        ...(args.applied ? { answered: "allow" as const, autoApplied: true, title: done } : {}),
        requestId: args.requestId, tool: "stage_skill", skillRequest: payload,
      },
    });
    return args.applied ? done : title;
  }

  /** Applies a recorded change; what Undo needs goes back into the record. */
  function apply(record: SkillRecord): { ok: true; record: SkillRecord; kept: string[] } | { error: string } {
    const current = sharedCopy(record.scope, record.name);
    if (record.action === "delete") {
      if (!current || copyDigest(current) !== record.digest) return { error: `skill "${record.name}" changed after this card was shown; ask the bot to propose it again` };
      const removed = removeFromAllBots(record.scope, record.name);
      return "error" in removed ? removed : { ok: true, record: { ...record, previous: stored(removed.removed) }, kept: [] };
    }
    if (record.action === "create" && current) return { error: `"${record.name}" is already on all your bots; update it instead` };
    if (record.action === "update" && (!current || copyDigest(current) !== record.digest)) return { error: `skill "${record.name}" changed after this card was shown; ask the bot to propose it again` };
    const copy = loaded(record.copy!);
    const put = putOnAllBots(record.scope, record.name, copy, { fresh: record.action === "create" });
    if ("error" in put) return put;
    return { ok: true, record: { ...record, digest: copyDigest(copy), ...(current ? { previous: stored(current) } : {}), retired: put.retired.map((one) => ({ ...one, copy: stored(one.copy) })) }, kept: put.kept };
  }

  const keptLine = (kept: readonly string[]) => {
    const names = kept.map((id) => store.bot(id)?.name).filter(Boolean);
    return names.length ? ` Kept their own different copy: ${names.join(", ")}.` : "";
  };

  /** Null when the call is about the bot's own skill; then the usual paths take it. `actsFor`: on a Team Cloud, the person
   * key the turn acts for (host/acting-person.ts); only the bot's own person's turn may change all of their bots, so a
   * teammate chatting with a shared bot cannot reach its owner's private bots through it. */
  async function stage(from: BotRecord, threadId: string, received: Record<string, unknown>, direct: () => DirectApply | null,
    withImport: (body: Record<string, unknown>) => Promise<Record<string, unknown> | { importError: string }>, active: () => boolean,
    actsFor: () => string | null = () => null): Promise<Result | null> {
    const claim = claimed(from, received);
    if (!claim) return null;
    const live = store.bot(from.id), scope = allBotsScopeOfBot(live);
    if (!scope) return { status: 422, body: { error: "This bot belongs to no one on this team, so it has no \"all my bots\". Ask the person to have their own Chief of Staff do it, or add the skill to this bot alone without all_bots." } };
    const owner = live ? botOwner(live) : null;
    if (skillsForAllBotsOnTeam() && (!owner || actsFor() !== personKey({ id: "", email: owner }))) {
      return { status: 403, body: { error: "Only the person this bot reports to can change the skills on all of their bots, in their own conversation with it." } };
    }
    const body = claim.action === "create" ? await withImport(received) : received;
    if ("importError" in body) return { status: 422, body: { error: body.importError } };
    if (!active()) return { status: 401, body: { error: "This turn has ended." } };
    const applies = direct();
    const persistence = deps.persistence(from.id, threadId, !applies);
    if (!persistence.ok) return { status: persistence.status, body: { error: persistence.error } };
    let record: SkillRecord, gist: string, warnings: string[] = [], preview: string, source: string;
    if (claim.action === "delete") {
      const current = sharedCopy(scope, claim.name);
      if (!current) return { status: 422, body: { error: `no skill named "${claim.name}" is on all your bots; copy the exact name from skills_list` } };
      record = { scope, action: "delete", name: claim.name, digest: copyDigest(current) };
      gist = ""; preview = current.skillMd; source = current.source;
    } else {
      const change = proposed(body, claim.action, claim.name, claim.action === "update" ? sharedCopy(scope, claim.name) : null);
      if ("error" in change) return { status: 422, body: { error: change.error } };
      const current = sharedCopy(scope, change.name);
      if (claim.action === "create" && current) return { status: 422, body: { error: `"${change.name}" is already on all your bots; update it instead (action "update")` } };
      if (claim.action === "update" && !current) return { status: 422, body: { error: `no skill named "${claim.name}" is on all your bots; to put one on all of them, call create with all_bots and its full SKILL.md` } };
      record = { scope, action: claim.action, name: change.name, digest: current ? copyDigest(current) : "", copy: stored(change.copy) };
      ({ gist, warnings } = change); preview = change.copy.skillMd; source = change.copy.source;
    }
    const requestId = randomUUID();
    if (applies) {
      const applied = apply(record);
      if ("error" in applied) return { status: 422, body: { state: "failed", error: applied.error } };
      writeRecord(requestId, applied.record);
      const previous = applied.record.previous ? { preview: applied.record.previous.skillMd, source: applied.record.previous.source } : undefined;
      const done = appendCard({ requestId, bot: from, threadId, action: claim.action, name: record.name, gist, preview, source, warnings, applied: { previous } });
      appendDecision(deps.dataDir, { threadId, requestId, botId: from.id, botName: from.name, tool: "stage_skill", summary: done, decision: "auto-approved", source: applies });
      deps.noteSkillChange(from.id, threadId);
      return { status: 201, body: { state: "applied", name: record.name, action: claim.action, allBots: true, warnings, summary: `${done}.${keptLine(applied.kept)}` } };
    }
    writeRecord(requestId, record);
    let summary: string;
    try {
      summary = appendCard({ requestId, bot: from, threadId, action: claim.action, name: record.name, gist, preview, source, warnings });
    } catch (error) {
      dropRecord(requestId);
      throw error;
    }
    appendDecision(deps.dataDir, { threadId, requestId, botId: from.id, botName: from.name, tool: "stage_skill", summary, decision: "card-shown", source: "skill" });
    return { status: 201, body: { state: "pending", name: record.name, action: claim.action, allBots: true, warnings, summary } };
  }

  function resolve(args: { botId: string; botName?: string; threadId: string; requestId: string; behavior: "allow" | "deny" | "answer"; reviewedSha256?: string },
    messageId: string, card: OptionCardData, request: SkillRequestCardData):
    | { claimed: true; status: number; error: string }
    | { claimed: true; outcome: "allowed-once" | "rejected"; alreadySettled?: true } {
    if (card.answered || card.dismissed) return { claimed: true, outcome: card.answered === "allow" ? "allowed-once" : "rejected", alreadySettled: true };
    const decided = (decision: "user-approved" | "user-denied") => appendDecision(deps.dataDir, { threadId: args.threadId,
      requestId: args.requestId, botId: args.botId, botName: args.botName, tool: card.tool, summary: card.subtitle, decision, source: "user" });
    if (args.behavior !== "allow") {
      store.patchMessage(args.threadId, messageId, { card: { ...card, answered: "deny", dismissed: true, held: undefined } });
      dropRecord(request.requestId);
      decided("user-denied");
      return { claimed: true, outcome: "rejected" };
    }
    if (!request.sha256 || args.reviewedSha256 !== request.sha256) return { claimed: true, status: 409, error: "reviewedSha256 must match the skill shown on the approval card" };
    const record = readRecord(request.requestId);
    const applied = record && record.name === request.name ? apply(record) : { error: "this approval card no longer matches its skill" };
    if ("error" in applied) {
      store.patchMessage(args.threadId, messageId, { card: { ...card, held: applied.error } });
      return { claimed: true, status: 422, error: applied.error };
    }
    writeRecord(request.requestId, applied.record);
    const done = serverLine(conversationLanguage(args.threadId), LINES[applied.record.action].done, { name: request.name });
    store.patchMessage(args.threadId, messageId, { card: { ...card, answered: "allow", held: undefined, title: done } });
    deps.noteSkillChange(args.botId, args.threadId);
    decided("user-approved");
    return { claimed: true, outcome: "allowed-once" };
  }

  /** Puts things back as they were before the change, while nothing has changed the skill since. */
  function undo(botId: string, threadId: string, message: Message, request: SkillRequestCardData):
    | { claimed: true; state: "undone" }
    | { claimed: true; state: "invalid"; error: string; status: number; stale?: true } {
    const record = readRecord(request.requestId);
    if (!record) return { claimed: true, state: "invalid", error: "This change can't be undone here.", status: 409 };
    const current = sharedCopy(record.scope, record.name);
    const stale = { claimed: true as const, state: "invalid" as const, error: UNDO_STALE, status: 409, stale: true as const };
    let undone: { ok: true } | { error: string };
    if (record.action === "delete") {
      if (current || !record.previous) return stale;
      const put = putOnAllBots(record.scope, record.name, loaded(record.previous), { fresh: false });
      undone = "error" in put ? put : { ok: true };
    } else {
      if (!current || copyDigest(current) !== record.digest) return stale;
      if (record.previous) {
        const put = putOnAllBots(record.scope, record.name, loaded(record.previous), { fresh: false });
        undone = "error" in put ? put : { ok: true };
      } else {
        const removed = removeFromAllBots(record.scope, record.name);
        undone = "error" in removed ? removed : { ok: true };
      }
      if ("ok" in undone) restoreOwnCopies(record.name, (record.retired ?? []).map((one): RetiredCopy => ({ ...one, copy: loaded(one.copy) })));
    }
    if ("error" in undone) return { claimed: true, state: "invalid", error: undone.error, status: 409 };
    dropRecord(request.requestId);
    if (message.card) store.patchMessage(threadId, message.id, { card: { ...message.card, undone: true } });
    deps.noteSkillChange(botId, threadId);
    return { claimed: true, state: "undone" };
  }

  return { stage, resolve, undo };
}

export type SkillsForAllBotsHost = ReturnType<typeof createSkillsForAllBotsHost>;
