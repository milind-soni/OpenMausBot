import { createHash } from "node:crypto";

import { redactSecretsInText } from "./redact.ts";
import { serverLine, type ServerLineKey } from "./server-lines.ts";
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
  /** Digest of the skill's kind and full SKILL.md, secrets included, so an imported skill with the same text never stands in
   * for the bot's own. Approval binds to this one; it stays on the server, never on the card. */
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
    contentSha256: createHash("sha256").update(`${skill.kind}\0${skill.text}`).digest("hex"),
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

const CARD_LINES = {
  enable: { option: "Turn on", title: "server.skillSwitch.enable.title", body: "server.skillSwitch.enable.body", done: "server.skillSwitch.enable.done" },
  disable: { option: "Turn off", title: "server.skillSwitch.disable.title", body: "server.skillSwitch.disable.body", done: "server.skillSwitch.disable.done" },
  delete: { option: "Delete", title: "server.skillSwitch.delete.title", body: "server.skillSwitch.delete.body", done: "server.skillSwitch.delete.done" },
} as const satisfies Record<SkillSwitchAction, { option: string; title: ServerLineKey; body: ServerLineKey; done: ServerLineKey }>;

/** The card's words in the person's language. The option is the answer the card sends back, so it stays as written. */
export function skillSwitchCardCopy(action: SkillSwitchAction, name: string, gist: string, language?: string): {
  title: string;
  subtitle: string;
  option: string;
  done: string;
} {
  const lines = CARD_LINES[action];
  const lead = gist ? `${gist}\n\n` : "";
  return {
    title: serverLine(language, lines.title, { name }),
    subtitle: `${lead}${serverLine(language, lines.body)}`,
    option: lines.option,
    done: serverLine(language, lines.done, { name }),
  };
}
