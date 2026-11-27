// A Chief of Staff turns named skills on or off for several of its teammates in one call. Each change passes the rules a
// bot's own switch does (skill-switch.ts), and they apply together or not at all: where the Chief's own skill changes
// apply directly, with one receipt and one Undo; otherwise on one card, approved only while every skill is still the one
// the card listed. Its record stays until Undo, which turns them back only while every skill is still as it was applied.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import type { SkillRequestCardData, TeammateSkillChange } from "../../shared/skill-request.ts";
import type { OptionCardData } from "../../shared/wire.ts";
import { writeFileAtomic } from "../atomic.ts";
import { chiefLevel } from "../chief-level.ts";
import { appendDecision } from "../decision-log.ts";
import { UNDO_STALE, type DirectApply } from "../direct-apply.ts";
import { conversationLanguage, serverLine } from "../server-lines.ts";
import { skillContentSha256, skillSwitchStillMatches, skillSwitchTarget, type SwitchableSkill } from "../skill-switch.ts";
import type { BotRecord, Message, Store } from "../store.ts";

export const TEAMMATE_SKILL_CHANGES_MAX = 40;

export interface TeammateSkillsHostDeps {
  store: Pick<Store, "bot" | "appendMessage" | "patchMessage" | "groupByThread">;
  dataDir: string;
  persistence(botId: string, threadId: string, opensCard: boolean): { ok: true } | { ok: false; status: number; error: string };
  /** Why `fromId` may not change `targetId`'s skills, or null when it may. */
  refusal(fromId: string, targetId: string): string | null;
  skill(bot: BotRecord, name: string): SwitchableSkill | undefined;
  turn(botId: string, name: string, on: boolean, kind: SwitchableSkill["kind"] | undefined): object;
  noteSkillChange(botId: string, threadId: string): void;
}

type Result = { status: number; body: Record<string, unknown> };
type Step = { botId: string; name: string; on: boolean };
type Checked = TeammateSkillChange & { contentSha256: string };

const recordSchema = z.object({
  chiefId: z.string(),
  changes: z.array(z.object({ botId: z.string(), name: z.string(), action: z.enum(["enable", "disable"]), contentSha256: z.string() })),
});
type TeammateSkillsRecord = z.infer<typeof recordSchema>;

const steps = (changes: ReadonlyArray<Pick<TeammateSkillChange, "botId" | "name" | "action">>, back = false): Step[] =>
  changes.map((change) => ({ botId: change.botId, name: change.name, on: (change.action === "enable") !== back }));

export function createTeammateSkillsHost(deps: TeammateSkillsHostDeps) {
  const { store } = deps;
  const recordPath = (requestId: string) => join(deps.dataDir, "teammate-skills", `${requestId}.json`);
  const readRecord = (requestId: string): TeammateSkillsRecord | null => {
    try {
      const parsed = recordSchema.safeParse(JSON.parse(readFileSync(recordPath(requestId), "utf8")));
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  };
  const writeRecord = (requestId: string, record: TeammateSkillsRecord) => {
    mkdirSync(dirname(recordPath(requestId)), { recursive: true, mode: 0o700 });
    writeFileAtomic(recordPath(requestId), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  };
  const dropRecord = (requestId: string) => rmSync(recordPath(requestId), { force: true });
  const botName = (id: string) => store.bot(id)?.name ?? id;
  /** One step's result; a write that throws (a full disk) comes back as an error, so the batch can still be put back. */
  const turnOne = (step: Step): object => {
    const bot = store.bot(step.botId);
    if (!bot) return { error: "that bot no longer exists" };
    try {
      return deps.turn(step.botId, step.name, step.on, deps.skill(bot, step.name)?.kind);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      return { error: code ? `could not save the change (${code})` : "could not save the change" };
    }
  };

  /** Turns every step, or, when one fails, turns back those already turned so nothing is changed. */
  function turnAll(all: readonly Step[]): { ok: true } | { error: string } {
    const turned: Step[] = [];
    for (const step of all) {
      const result = turnOne(step);
      if ("error" in result) {
        const stuck = turned.reverse().filter((back) => "error" in turnOne({ ...back, on: !back.on }));
        const failed = `${botName(step.botId)}, "${step.name}": ${String(result.error)}.`;
        if (!stuck.length) return { error: `${failed} Nothing was changed.` };
        return { error: `${failed} These could not be turned back and are still changed: ${stuck.map((back) => `${botName(back.botId)}, "${back.name}"`).join("; ")}.` };
      }
      turned.push(step);
    }
    return { ok: true };
  }

  /** Every change the call asked for, checked; when any fails, every problem and nothing changed. */
  function checked(from: BotRecord, body: Record<string, unknown>): { changes: Checked[] } | Result {
    const asked = body.changes;
    if (!Array.isArray(asked) || !asked.length) return { status: 400, body: { error: "changes must list at least one { bot_id, skill_name, on }" } };
    if (asked.length > TEAMMATE_SKILL_CHANGES_MAX) return { status: 400, body: { error: `changes can list at most ${TEAMMATE_SKILL_CHANGES_MAX} skills in one call` } };
    const seen = new Set<string>();
    const problems: string[] = [];
    const changes: Checked[] = [];
    for (const [index, item] of asked.entries()) {
      const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      const botId = typeof entry.bot_id === "string" ? entry.bot_id.trim() : "";
      const name = typeof entry.skill_name === "string" ? entry.skill_name.trim() : "";
      if (!botId || !name || typeof entry.on !== "boolean") return { status: 400, body: { error: `changes[${index}] needs bot_id, skill_name and on (true or false)` } };
      const key = `${botId}\n${name}`;
      if (seen.has(key)) return { status: 400, body: { error: `changes lists "${name}" for ${botId} more than once` } };
      seen.add(key);
      const target = store.bot(botId);
      if (!target) { problems.push(`${botId}: no such bot; copy its id from list_bots`); continue; }
      if (target.id === from.id) { problems.push(`${target.name}: that is you; turn your own skills on or off with action enable or disable`); continue; }
      const refused = deps.refusal(from.id, target.id);
      if (refused) { problems.push(`${target.name}: ${refused}`); continue; }
      const action = entry.on ? "enable" as const : "disable" as const;
      const switched = skillSwitchTarget(name, action, deps.skill(target, name));
      if ("error" in switched) { problems.push(`${target.name}: ${switched.error}`); continue; }
      changes.push({ botId: target.id, botName: target.name, name, action, contentSha256: switched.contentSha256 });
    }
    if (problems.length) return { status: 422, body: { error: `Nothing was changed. ${problems.join("; ")}` } };
    return { changes };
  }

  function appendCard(args: { requestId: string; from: BotRecord; threadId: string; changes: readonly Checked[]; applied: boolean }): string {
    const language = conversationLanguage(args.threadId);
    const count = args.changes.length;
    const teammates = args.changes.map(({ botId, botName, name, action }) => ({ botId, botName, name, action }));
    const preview = teammates.map((change) =>
      serverLine(language, change.action === "enable" ? "server.teammateSkills.on" : "server.teammateSkills.off", { bot: change.botName, name: change.name })).join("\n");
    const payload: SkillRequestCardData = {
      version: 1, requestId: args.requestId, botId: args.from.id, threadId: args.threadId, stagedId: `teammates-${args.requestId}`,
      action: teammates.every((change) => change.action === "disable") ? "disable" : "enable",
      name: [...new Set(teammates.map((change) => change.name))].join(", "), gist: "",
      preview, sha256: createHash("sha256").update(preview).digest("hex"), warnings: [], createdAt: Date.now(), teammates,
    };
    const title = serverLine(language, "server.teammateSkills.title", { count });
    const done = serverLine(language, "server.teammateSkills.done", { count });
    store.appendMessage(args.threadId, {
      role: "bot", kind: "options", from: { botId: args.from.id, name: args.from.name, color: args.from.color },
      card: {
        title, subtitle: serverLine(language, "server.teammateSkills.body"), options: args.applied ? [] : ["Apply", "Deny"],
        ...(args.applied ? { answered: "allow" as const, autoApplied: true, title: done } : {}),
        requestId: args.requestId, tool: "stage_skill", skillRequest: payload,
      },
    });
    return args.applied ? done : title;
  }

  /** skill_manage action "teammates", from a Chief of Staff. */
  function stage(from: BotRecord, threadId: string, body: Record<string, unknown>, direct: DirectApply | null): Result {
    if (!chiefLevel(from)) return { status: 403, body: { error: "Only a Chief of Staff can change its teammates' skills. Turn your own on or off with action enable or disable." } };
    const asked = checked(from, body);
    if ("status" in asked) return asked;
    // In a room, always the card: words a teammate posted there must not change bots' skills by themselves.
    const applies = store.groupByThread(threadId) ? null : direct;
    const persistence = deps.persistence(from.id, threadId, !applies);
    if (!persistence.ok) return { status: persistence.status, body: { error: persistence.error } };
    const requestId = randomUUID();
    const record: TeammateSkillsRecord = { chiefId: from.id, changes: asked.changes.map(({ botId, name, action, contentSha256 }) => ({ botId, name, action, contentSha256 })) };
    writeRecord(requestId, record);
    if (applies) {
      const turned = turnAll(steps(asked.changes));
      if ("error" in turned) {
        dropRecord(requestId);
        return { status: 422, body: { state: "failed", error: turned.error } };
      }
      const done = appendCard({ requestId, from, threadId, changes: asked.changes, applied: true });
      appendDecision(deps.dataDir, { threadId, requestId, botId: from.id, botName: from.name, tool: "stage_skill", summary: done, decision: "auto-approved", source: applies });
      deps.noteSkillChange(from.id, threadId);
      return { status: 201, body: { state: "applied", changes: asked.changes.length, summary: `${done}.` } };
    }
    let summary: string;
    try {
      summary = appendCard({ requestId, from, threadId, changes: asked.changes, applied: false });
    } catch (error) {
      dropRecord(requestId);
      throw error;
    }
    appendDecision(deps.dataDir, { threadId, requestId, botId: from.id, botName: from.name, tool: "stage_skill", summary, decision: "card-shown", source: "skill" });
    return { status: 201, body: { state: "pending", changes: asked.changes.length, summary } };
  }

  /** The person's answer on the card: approval turns every listed skill, while each is still as the card showed it. */
  function resolve(args: { botId: string; botName?: string; threadId: string; requestId: string; behavior: "allow" | "deny" | "answer"; reviewedSha256?: string },
    messageId: string, card: OptionCardData, request: SkillRequestCardData):
    | { claimed: true; status: number; error: string }
    | { claimed: true; outcome: "allowed-once" | "rejected"; alreadySettled?: true } {
    if (card.answered || card.dismissed) return { claimed: true, outcome: card.answered === "allow" ? "allowed-once" : "rejected", alreadySettled: true };
    const decided = (decision: "user-approved" | "user-denied") => appendDecision(deps.dataDir, { threadId: args.threadId,
      requestId: args.requestId, botId: args.botId, botName: args.botName, tool: card.tool, summary: card.title ?? card.subtitle, decision, source: "user" });
    if (args.behavior !== "allow") {
      store.patchMessage(args.threadId, messageId, { card: { ...card, answered: "deny", dismissed: true, held: undefined } });
      dropRecord(request.requestId);
      decided("user-denied");
      return { claimed: true, outcome: "rejected" };
    }
    if (!request.sha256 || args.reviewedSha256 !== request.sha256) return { claimed: true, status: 409, error: "reviewedSha256 must match the changes shown on the approval card" };
    const record = request.requestId === args.requestId ? readRecord(request.requestId) : null;
    if (!record || record.chiefId !== args.botId) return { claimed: true, status: 422, error: "this approval card no longer matches its changes" };
    const problems = record.changes.flatMap((change) => {
      const target = store.bot(change.botId);
      if (!target) return [`${change.botId}: that bot no longer exists`];
      const refused = deps.refusal(args.botId, target.id);
      const still = refused ? { error: refused } : skillSwitchStillMatches(change.name, change.action, deps.skill(target, change.name), change.contentSha256);
      return "error" in still ? [`${target.name}: ${still.error}`] : [];
    });
    const turned = problems.length ? { error: `Nothing was changed. ${problems.join("; ")}` } : turnAll(steps(record.changes));
    if ("error" in turned) {
      store.patchMessage(args.threadId, messageId, { card: { ...card, held: turned.error } });
      return { claimed: true, status: 422, error: turned.error };
    }
    const done = serverLine(conversationLanguage(args.threadId), "server.teammateSkills.done", { count: record.changes.length });
    store.patchMessage(args.threadId, messageId, { card: { ...card, answered: "allow", held: undefined, title: done } });
    deps.noteSkillChange(args.botId, args.threadId);
    decided("user-approved");
    return { claimed: true, outcome: "allowed-once" };
  }

  /** Turns every listed skill back, or none: refuses, changing nothing, once any of them moved on since. */
  function undo(botId: string, threadId: string, message: Message, request: SkillRequestCardData):
    | { claimed: true; state: "undone" }
    | { claimed: true; state: "invalid"; error: string; status: number; stale?: true } {
    const record = readRecord(request.requestId);
    const changes = record?.chiefId === botId ? record.changes : [];
    const refused = changes.flatMap((change) => {
      const why = deps.refusal(botId, change.botId);
      return why ? [`${botName(change.botId)}: ${why}`] : [];
    });
    if (refused.length) return { claimed: true, state: "invalid", error: `Nothing was changed. ${[...new Set(refused)].join("; ")}`, status: 403 };
    const moved = changes.some((change) => {
      const target = store.bot(change.botId);
      const current = target ? deps.skill(target, change.name) : undefined;
      return !current || current.kind === "fixed" || current.enabled !== (change.action === "enable") || current.text === null
        || skillContentSha256({ kind: current.kind, text: current.text }) !== change.contentSha256;
    });
    if (!changes.length || moved) return { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
    const undone = turnAll(steps(changes, true));
    if ("error" in undone) return { claimed: true, state: "invalid", error: undone.error, status: 409 };
    dropRecord(request.requestId);
    if (message.card) store.patchMessage(threadId, message.id, { card: { ...message.card, undone: true } });
    deps.noteSkillChange(botId, threadId);
    return { claimed: true, state: "undone" };
  }

  return { stage, resolve, undo };
}
