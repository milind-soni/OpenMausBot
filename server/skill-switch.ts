import { createHash } from "node:crypto";

import { redactSecretsInText } from "./redact.ts";
import { STAGED_GIST_MAX } from "./skills.ts";
import type { SkillSwitchAction } from "../shared/skill-request.ts";

/** own: in this bot's own skills; imported: brought in from this computer for every bot, switched per bot;
 * fixed: shared from the team library or the engine's own, which only the person changes. */
export type SwitchableSkillKind = "own" | "imported" | "fixed";

export interface SwitchableSkill {
  kind: SwitchableSkillKind;
  enabled: boolean;
  /** The current SKILL.md, or null when it no longer verifies. */
  text: string | null;
  source?: string;
  description?: string;
}

export interface SkillSwitchTarget {
  /** The current SKILL.md as the card shows it; approval binds to its hash. */
  preview: string;
  sha256: string;
  /** Digest of the full SKILL.md, secrets included. Approval binds to this one; it stays on the server, never on the card. */
  contentSha256: string;
  source?: string;
  gist: string;
}

/** Refuses what a bot may not change on its own card, before any card is shown. */
export function skillSwitchTarget(
  name: string,
  action: SkillSwitchAction,
  skill: SwitchableSkill | undefined,
): SkillSwitchTarget | { error: string } {
  if (!skill) return { error: `no skill named "${name}"; copy the exact name from skills_list` };
  if (skill.kind === "fixed") {
    return { error: `skill "${name}" is shared with this bot, not its own; only the person can change it, in the bot's Skills settings` };
  }
  if (action === "delete" && skill.kind === "imported") {
    return { error: `skill "${name}" comes from this computer and can't be deleted from one bot; turn it off instead (action "disable")` };
  }
  // Its scan warnings and helper files are reviewed in Settings, not on this card.
  if (action === "enable" && skill.kind === "imported") {
    return { error: `skill "${name}" comes from this computer; only the person can turn it on, in the bot's Skills settings` };
  }
  if (action === "enable" && skill.enabled) return { error: `skill "${name}" is already on` };
  if (action === "disable" && !skill.enabled) return { error: `skill "${name}" is already off` };
  if (skill.text === null) {
    return { error: `skill "${name}" changed outside OpenMausBot and can't be shown for review; the person can fix it in the bot's Skills settings` };
  }
  const preview = redactSecretsInText(skill.text);
  return {
    preview,
    sha256: createHash("sha256").update(preview).digest("hex"),
    contentSha256: createHash("sha256").update(skill.text).digest("hex"),
    ...(skill.source ? { source: redactSecretsInText(skill.source) } : {}),
    gist: redactSecretsInText(skill.description ?? "").replace(/\s+/g, " ").trim().slice(0, STAGED_GIST_MAX),
  };
}

/** At approval the skill must still be the one the card showed, in the state it described. */
export function skillSwitchStillMatches(
  name: string,
  action: SkillSwitchAction,
  skill: SwitchableSkill | undefined,
  contentSha256: string,
): { ok: true } | { error: string } {
  const target = skillSwitchTarget(name, action, skill);
  if ("error" in target) return target;
  return target.contentSha256 === contentSha256
    ? { ok: true }
    : { error: `skill "${name}" changed after this card was shown; ask the bot to propose it again` };
}

export function skillSwitchCardCopy(action: SkillSwitchAction, name: string, gist: string): {
  title: string;
  subtitle: string;
  option: string;
  done: string;
} {
  const lead = gist ? `${gist}\n\n` : "";
  if (action === "enable") {
    return { title: `Turn on skill "${name}"?`, option: "Turn on", done: `Skill "${name}" turned on`,
      subtitle: `${lead}The bot can use this skill again.` };
  }
  if (action === "disable") {
    return { title: `Turn off skill "${name}"?`, option: "Turn off", done: `Skill "${name}" turned off`,
      subtitle: `${lead}The bot stops using this skill until it is turned on again. Nothing is deleted.` };
  }
  return { title: `Delete skill "${name}"?`, option: "Delete", done: `Skill "${name}" deleted`,
    subtitle: `${lead}Removes this skill and all its files from the bot for good. Its SKILL.md is shown below, with any secrets hidden.` };
}
