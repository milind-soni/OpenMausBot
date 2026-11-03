import { blankCode, offersSkillCommand } from "../../shared/skill-command";

export type ComposerSlashCommandId = "goal" | "learn" | "setup";

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
  atStart: boolean;
}

/** The `/word` the caret is in, at the start of the text or after a space or line break, outside code, so a skill can be
 * picked anywhere in a message. `atStart` is whether only spaces come before it: the built-in commands work only there. */
export function composerSlashTrigger(text: string, caretInput: number): ComposerSlashTrigger | null {
  const caret = Math.max(0, Math.min(text.length, Math.floor(caretInput)));
  const prefix = text.slice(0, caret);
  const match = /(^|\s)\/([a-z0-9-]*)$/i.exec(prefix);
  if (!match) return null;
  const start = match.index + (match[1] ?? "").length;
  if (blankCode(text)[start] !== "/") return null;
  return { query: match[2] ?? "", start, end: caret, atStart: prefix.slice(0, start).trim() === "" };
}

export function goalTextFromComposer(text: string): string | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(text);
  return match ? (match[1] ?? "").trimStart() : null;
}

/** A skill runs only from the start of a line, so one picked later in a line moves onto a line of its own. A pick reaches
 * the server as plain text and nothing else travels with it, so nothing but a person's own line can pass for one. */
export function replaceComposerSlashTrigger(
  text: string,
  trigger: Omit<ComposerSlashTrigger, "atStart">,
  replacement: string,
): { text: string; caret: number } {
  const before = text.slice(0, trigger.start);
  const kept = before.trimEnd();
  const head = !replacement || /(?:^|\n) {0,3}$/.test(before) ? before : kept && `${kept}\n`;
  return { text: `${head}${replacement}${text.slice(trigger.end)}`, caret: head.length + replacement.length };
}
