// A bot asks to turn one of its skills on or off, or to delete it. That always waits for the person on a card, even with
// Full Access, and approval applies only if the skill is still the one the card showed (its SKILL.md sha256).
import { randomUUID } from "node:crypto";
import type { SkillRequestCardData, SkillSwitchAction } from "../../shared/skill-request.ts";
import type { OptionCardData } from "../../shared/wire.ts";
import { appendDecision } from "../decision-log.ts";
import { setImportedSkillEnabled } from "../imported-skills.ts";
import { listSkills, readSkillFile, removeSkill, setSkillEnabled } from "../skills.ts";
import { skillSwitchCardCopy, skillSwitchStillMatches, skillSwitchTarget, type SkillSwitchTarget, type SwitchableSkill } from "../skill-switch.ts";
import type { BotRecord, Store } from "../store.ts";

export interface SkillSwitchHostDeps {
  store: Pick<Store, "bot" | "appendMessage" | "patchMessage">;
  dataDir: string;
  /** The open-card checks every skill card passes; a switch card opens even with Full Access. */
  persistence(botId: string, threadId: string): { ok: true } | { ok: false; status: number; error: string };
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

export function createSkillSwitchHost(deps: SkillSwitchHostDeps) {
  const { store } = deps;

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

  function appendCard(args: { botId: string; threadId: string; action: SkillSwitchAction; name: string; target: SkillSwitchTarget }): { requestId: string; summary: string } {
    const requestId = randomUUID();
    const copy = skillSwitchCardCopy(args.action, args.name, args.target.gist);
    const payload: SkillRequestCardData = {
      version: 1,
      requestId,
      botId: args.botId,
      threadId: args.threadId,
      // Nothing is staged: approval binds to the current SKILL.md through sha256.
      stagedId: `switch-${requestId}`,
      action: args.action,
      name: args.name,
      gist: args.target.gist,
      ...(args.target.source ? { source: args.target.source } : {}),
      preview: args.target.preview,
      sha256: args.target.sha256,
      warnings: [],
      createdAt: Date.now(),
    };
    const from = store.bot(args.botId);
    store.appendMessage(args.threadId, {
      role: "bot",
      kind: "options",
      from: from ? { botId: from.id, name: from.name, color: from.color } : undefined,
      card: { title: copy.title, subtitle: copy.subtitle, options: [copy.option, "Deny"], requestId, tool: "stage_skill", skillRequest: payload },
    });
    return { requestId, summary: copy.title };
  }

  function apply(botId: string, name: string, action: SkillSwitchAction, kind: SwitchableSkill["kind"] | undefined) {
    if (action === "delete") return removeSkill(botId, name);
    return (kind === "imported" ? setImportedSkillEnabled : setSkillEnabled)(botId, name, action === "enable");
  }

  /** Turning a skill on or off, or deleting it, always waits for the person, even with Full Access. */
  function stage(from: BotRecord, threadId: string, action: SkillSwitchAction, body: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
    const name = typeof body.skill_name === "string" ? body.skill_name.trim() : "";
    if (!name) return { status: 400, body: { error: `skill_name is required when action is ${action}` } };
    const persistence = deps.persistence(from.id, threadId);
    if (!persistence.ok) return { status: persistence.status, body: { error: persistence.error } };
    const target = skillSwitchTarget(name, action, switchableSkill(from, name));
    if ("error" in target) return { status: 422, body: { error: target.error } };
    const card = appendCard({ botId: from.id, threadId, action, name, target });
    appendDecision(deps.dataDir, { threadId, requestId: card.requestId, botId: from.id, botName: from.name,
      tool: "stage_skill", summary: card.summary, decision: "card-shown", source: "skill" });
    return { status: 201, body: { state: "pending", name, action, gist: target.gist, warnings: [], summary: card.summary } };
  }

  function resolve(
    args: SkillSwitchResolveArgs,
    messageId: string,
    card: OptionCardData,
    request: SkillRequestCardData & { action: SkillSwitchAction },
  ): SkillSwitchResolution {
    if (card.answered || card.dismissed) {
      return { claimed: true, outcome: card.answered === "allow" ? "allowed-once" : "rejected", alreadySettled: true };
    }
    const decided = (decision: "user-approved" | "user-denied") => appendDecision(deps.dataDir, { threadId: args.threadId,
      requestId: args.requestId, botId: args.botId, botName: args.botName, tool: card.tool, summary: card.subtitle, decision, source: "user" });
    if (args.behavior !== "allow") {
      store.patchMessage(args.threadId, messageId, { card: { ...card, answered: "deny", dismissed: true, held: undefined } });
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
    const still = skillSwitchStillMatches(request.name, request.action, current, request.sha256);
    const applied = "error" in still ? still : apply(args.botId, request.name, request.action, current?.kind);
    if ("error" in applied) {
      store.patchMessage(args.threadId, messageId, { card: { ...card, held: applied.error } });
      return { claimed: true, status: 422, error: applied.error };
    }
    store.patchMessage(args.threadId, messageId, {
      card: { ...card, answered: "allow", held: undefined, title: skillSwitchCardCopy(request.action, request.name, "").done },
    });
    deps.noteSkillChange(args.botId, args.threadId);
    decided("user-approved");
    return { claimed: true, outcome: "allowed-once" };
  }

  return { stage, resolve };
}
