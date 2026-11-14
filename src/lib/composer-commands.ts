import { blankCode, offersSkillCommand } from "../../shared/skill-command";

export type ComposerSlashCommandId = "goal" | "learn" | "setup" | "burst";

export type ComposerSlashCommand =
  | { kind: "command"; id: ComposerSlashCommandId; label: `/${ComposerSlashCommandId}`; description: string }
  | { kind: "skill"; id: string; label: `/${string}`; description: string };

export interface SlashSkill {
  name: string;
  description: string;
}

export function skillSlashCommands(skills: readonly SlashSkill[]): ComposerSlashCommand[] {
  return skills
    .filter((skill) => offersSkillCommand(skill.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => ({ kind: "skill", id: skill.name, label: `/${skill.name}`, description: skill.description }));
}

export function slashCommandMatches(command: ComposerSlashCommand, query: string): boolean {
  const needle = query.toLowerCase();
  return !needle || command.id.startsWith(needle) || command.description.toLowerCase().includes(needle);
}

export interface ComposerSlashTrigger {
  query: string;
  start: number;
  end: number;
}

export function composerSlashTrigger(text: string, caretInput: number): ComposerSlashTrigger | null {
  const caret = Math.max(0, Math.min(text.length, Math.floor(caretInput)));
  const prefix = text.slice(0, caret);
  const match = /(?:^|\s)\/([\p{L}\p{N}\p{M}-]*)$/u.exec(prefix);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = caret - query.length - 1;
  return blankCode(text)[start] === "/" ? { query, start, end: caret } : null;
}

export function goalTextFromComposer(text: string): string | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(text);
  return match ? (match[1] ?? "").trimStart() : null;
}

/** The text a picked built-in leaves in the composer; /goal only flips the composer's mode. */
export function builtInCommandText(id: ComposerSlashCommandId): string {
  return id === "goal" ? "" : `/${id} `;
}

export function replaceComposerSlashTrigger(
  text: string,
  trigger: ComposerSlashTrigger,
  replacement: string,
): { text: string; caret: number } {
  const next = `${text.slice(0, trigger.start)}${replacement}${text.slice(trigger.end)}`;
  return { text: next, caret: trigger.start + replacement.length };
}
