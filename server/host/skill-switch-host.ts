// A bot turns one of its own skills on or off, or deletes it. Where the bot's own skill writes apply directly, this does too,
// with a receipt and Undo. Otherwise the person decides on a card, and approval applies only if the skill is still the one the
// card showed: the digest of its full SKILL.md, secrets included, is pinned on the server when the card opens, since the card's
// own sha256 covers only the redacted preview.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SkillRequestCardData, SkillSwitchAction } from "../../shared/skill-request.ts";
import type { OptionCardData } from "../../shared/wire.ts";
import { writeFileAtomic } from "../atomic.ts";
import { appendDecision } from "../decision-log.ts";
import { UNDO_STALE, type DirectApply } from "../direct-apply.ts";
import { setImportedSkillEnabled } from "../imported-skills.ts";
import { applySkillWriteWithReceipt, listSkills, readSkillFile, readSkillReferences, rejectStagedSkillWrite, removeSkill, setSkillEnabled, stageSkillWrite } from "../skills.ts";
import { skillSwitchCardCopy, skillSwitchStillMatches, skillSwitchTarget, type SkillSwitchTarget, type SwitchableSkill } from "../skill-switch.ts";
import { conversationLanguage } from "../server-lines.ts";
import type { BotRecord, Message, Store } from "../store.ts";

export interface SkillSwitchHostDeps {
  store: Pick<Store, "bot" | "appendMessage" | "patchMessage">;
  dataDir: string;
  /** The checks every skill change passes; opensCard adds the open-card limit. */
  persistence(botId: string, threadId: string, opensCard: boolean): { ok: true } | { ok: false; status: number; error: string };
  listBotSkills(bot: BotRecord): Array<{ name: string; enabled: boolean; source: string; description: string }>;
  readBotSkillFile(bot: BotRecord, name: string): string | null;
  noteSkillChange(botId: string, threadId: string): void;
}

export interface SkillSwitchResolveArgs {
  botId: string;
  botName?: string;
  threadId: string;
  requestId: string;
  behavior: "allow" | "deny" | "answer";
  reviewedSha256?: string;
}

export type SkillSwitchResolution =
  | { claimed: true; status: number; error: string }
  | { claimed: true; outcome: "allowed-once" | "rejected"; alreadySettled?: true };

export type SkillSwitchUndo =
  | { claimed: true; state: "already_undone" | "undone" }
  | { claimed: true; state: "invalid"; error: string; status: number; stale?: true };

const UNDO_ACTION: Record<"enable" | "disable", "enable" | "disable"> = { enable: "disable", disable: "enable" };

export function createSkillSwitchHost(deps: SkillSwitchHostDeps) {
  const { store } = deps;
  const pinPath = (requestId: string) => join(deps.dataDir, "skill-switch", `${requestId}.sha256`);
  const readPin = (requestId: string) => {
    try { return readFileSync(pinPath(requestId), "utf8"); } catch { return ""; }
  };
  const dropPin = (requestId: string) => rmSync(pinPath(requestId), { force: true });

  /** The skill a bot asked to turn on, turn off or delete, as it is now. */
  function switchableSkill(bot: BotRecord, name: string): SwitchableSkill | undefined {
    const own = listSkills(bot.id).find((skill) => skill.name === name);
    // Org skills an Admin pushed stay the person's to change, like library skills.
    if (own) return { kind: own.source.startsWith("org:") ? "fixed" : "own", enabled: own.enabled, text: readSkillFile(bot.id, name), source: own.source, description: own.description };
    const seen = deps.listBotSkills(bot).find((skill) => skill.name === name);
    if (!seen) return undefined;
    const imported = (seen as { origin?: string }).origin === "imported";
    return { kind: imported ? "imported" : "fixed", enabled: seen.enabled, text: imported ? deps.readBotSkillFile(bot, name) : null, source: seen.source, description: seen.description };
  }

  /** What Undo needs to bring a deleted skill back: its files as they are now, and whether it was on. */
  function deletedSkillFiles(botId: string, name: string, skill: SwitchableSkill): SkillRequestCardData["previous"] {
    if (skill.kind !== "own" || skill.text === null || !skill.source) return undefined;
    const references = readSkillReferences(botId, name);
    if (references === null) return undefined;
    return { preview: skill.text, source: skill.source, ...(references.length ? { references } : {}), ...(skill.enabled ? {} : { enabled: false }) };
  }

  function appendCard(args: {
    requestId: string; botId: string; threadId: string; action: SkillSwitchAction; name: string; target: SkillSwitchTarget;
    applied?: { previous?: SkillRequestCardData["previous"] };
  }): { title: string; done: string } {
    const { requestId, applied } = args;
    const copy = skillSwitchCardCopy(args.action, args.name, args.target.gist, conversationLanguage(args.threadId));
    const payload: SkillRequestCardData = {
      version: 1,
      requestId,
      botId: args.botId,
      threadId: args.threadId,
      // Nothing is staged: approval binds to the SKILL.md digest pinned on the server.
      stagedId: `switch-${requestId}`,
      action: args.action,
      name: args.name,
      gist: args.target.gist,
      ...(args.target.source ? { source: args.target.source } : {}),
      preview: args.target.preview,
      sha256: args.target.sha256,
      warnings: [],
      createdAt: Date.now(),
      ...(applied?.previous ? { previous: applied.previous } : {}),
    };
    const from = store.bot(args.botId);
    store.appendMessage(args.threadId, {
      role: "bot",
      kind: "options",
      from: from ? { botId: from.id, name: from.name, color: from.color } : undefined,
      card: {
        title: copy.title,
        subtitle: copy.subtitle,
        options: applied ? [] : [copy.option, "Deny"],
        ...(applied ? { answered: "allow" as const, autoApplied: true, title: copy.done } : {}),
        requestId,
        tool: "stage_skill",
        skillRequest: payload,
      },
    });
    return { title: copy.title, done: copy.done };
  }

  async function apply(botId: string, name: string, action: SkillSwitchAction, kind: SwitchableSkill["kind"] | undefined) {
    if (action === "delete") return removeSkill(botId, name);
    return (kind === "imported" ? setImportedSkillEnabled : setSkillEnabled)(botId, name, action === "enable");
  }

  /** Where the bot's own skill writes apply directly, so does this, with a receipt; otherwise the person decides on a card. */
  async function stage(from: BotRecord, threadId: string, action: SkillSwitchAction, body: Record<string, unknown>, direct: DirectApply | null): Promise<{ status: number; body: Record<string, unknown> }> {
    const name = typeof body.skill_name === "string" ? body.skill_name.trim() : "";
    if (!name) return { status: 400, body: { error: `skill_name is required when action is ${action}` } };
    const persistence = deps.persistence(from.id, threadId, !direct);
    if (!persistence.ok) return { status: persistence.status, body: { error: persistence.error } };
    const current = switchableSkill(from, name);
    const target = skillSwitchTarget(name, action, current);
    if ("error" in target) return { status: 422, body: { error: target.error } };
    const requestId = randomUUID();
    if (direct) {
      const previous = action === "delete" && current ? deletedSkillFiles(from.id, name, current) : undefined;
      const applied = await apply(from.id, name, action, current?.kind);
      if ("error" in applied) return { status: 422, body: { state: "failed", error: applied.error } };
      const { done } = appendCard({ requestId, botId: from.id, threadId, action, name, target, applied: { previous } });
      appendDecision(deps.dataDir, { threadId, requestId, botId: from.id, botName: from.name,
        tool: "stage_skill", summary: done, decision: "auto-approved", source: direct });
      deps.noteSkillChange(from.id, threadId);
      return { status: 201, body: { state: "applied", name, action, gist: target.gist, warnings: [], summary: `${done}.` } };
    }
    mkdirSync(dirname(pinPath(requestId)), { recursive: true, mode: 0o700 });
    writeFileAtomic(pinPath(requestId), target.contentSha256, { mode: 0o600 });
    let summary: string;
    try {
      summary = appendCard({ requestId, botId: from.id, threadId, action, name, target }).title;
    } catch (error) {
      dropPin(requestId);
      throw error;
    }
    appendDecision(deps.dataDir, { threadId, requestId, botId: from.id, botName: from.name,
      tool: "stage_skill", summary, decision: "card-shown", source: "skill" });
    return { status: 201, body: { state: "pending", name, action, gist: target.gist, warnings: [], summary } };
  }

  async function resolve(
    args: SkillSwitchResolveArgs,
    messageId: string,
    card: OptionCardData,
    request: SkillRequestCardData & { action: SkillSwitchAction },
  ): Promise<SkillSwitchResolution> {
    if (card.answered || card.dismissed) {
      return { claimed: true, outcome: card.answered === "allow" ? "allowed-once" : "rejected", alreadySettled: true };
    }
    const decided = (decision: "user-approved" | "user-denied") => appendDecision(deps.dataDir, { threadId: args.threadId,
      requestId: args.requestId, botId: args.botId, botName: args.botName, tool: card.tool, summary: card.subtitle, decision, source: "user" });
    if (args.behavior !== "allow") {
      store.patchMessage(args.threadId, messageId, { card: { ...card, answered: "deny", dismissed: true, held: undefined } });
      dropPin(request.requestId);
      decided("user-denied");
      return { claimed: true, outcome: "rejected" };
    }
    if (!request.sha256 || args.reviewedSha256 !== request.sha256) {
      return { claimed: true, status: 409, error: "reviewedSha256 must match the skill shown on the approval card" };
    }
    if (request.requestId !== args.requestId || request.threadId !== args.threadId) {
      return { claimed: true, status: 422, error: "this approval card no longer matches its skill" };
    }
    const bot = store.bot(args.botId);
    const current = bot ? switchableSkill(bot, request.name) : undefined;
    const still = skillSwitchStillMatches(request.name, request.action, current, readPin(request.requestId));
    const applied = "error" in still ? still : await apply(args.botId, request.name, request.action, current?.kind);
    if ("error" in applied) {
      store.patchMessage(args.threadId, messageId, { card: { ...card, held: applied.error } });
      return { claimed: true, status: 422, error: applied.error };
    }
    store.patchMessage(args.threadId, messageId, {
      card: { ...card, answered: "allow", held: undefined, title: skillSwitchCardCopy(request.action, request.name, "", conversationLanguage(args.threadId)).done },
    });
    deps.noteSkillChange(args.botId, args.threadId);
    decided("user-approved");
    dropPin(request.requestId);
    return { claimed: true, outcome: "allowed-once" };
  }

  /** Brings a deleted skill back as the bot's own learned skill. */
  function recreate(botId: string, previous: NonNullable<SkillRequestCardData["previous"]>, gist: string): { ok: true } | { error: string } {
    const staged = stageSkillWrite(botId, {
      action: "create",
      files: [{ path: "SKILL.md", content: previous.preview }, ...(previous.references ?? [])],
      gist,
      source: previous.source,
    });
    if ("error" in staged) return staged;
    const applied = applySkillWriteWithReceipt(botId, staged, () => {});
    if ("error" in applied) {
      rejectStagedSkillWrite(botId, staged.id);
      return applied;
    }
    if (previous.enabled === false) {
      const off = setSkillEnabled(botId, staged.name, false);
      if ("error" in off) return off;
    }
    return { ok: true };
  }

  /** Undo from the receipt of a change that applied on its own; refuses, changing nothing, once the skill moved on since. */
  async function undo(botId: string, threadId: string, message: Message, request: SkillRequestCardData & { action: SkillSwitchAction }): Promise<SkillSwitchUndo> {
    const card = message.card!;
    const bot = store.bot(botId);
    if (!bot) return { claimed: true, state: "invalid", error: "this change has no valid owner", status: 400 };
    const current = switchableSkill(bot, request.name);
    let undone: { ok: true } | { error: string } | { stale: true };
    if (request.action === "delete") {
      if (!request.previous) return { claimed: true, state: "invalid", error: "This change can't be undone here.", status: 409 };
      undone = current ? { stale: true } : recreate(botId, request.previous, request.gist);
    } else {
      const back = UNDO_ACTION[request.action];
      if (!current || current.kind === "fixed" || current.enabled !== (request.action === "enable")) undone = { stale: true };
      else {
        const flipped = await apply(botId, request.name, back, current.kind);
        undone = "error" in flipped ? flipped : { ok: true };
      }
    }
    if ("stale" in undone) return { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
    if ("error" in undone) return { claimed: true, state: "invalid", error: undone.error, status: 409 };
    store.patchMessage(threadId, message.id, { card: { ...card, undone: true } });
    deps.noteSkillChange(botId, threadId);
    return { claimed: true, state: "undone" };
  }

  return { stage, resolve, undo };
}
