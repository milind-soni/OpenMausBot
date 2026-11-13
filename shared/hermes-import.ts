import { botExportPrompt, botMovePlan, parseBotExport, type ImportedBot } from "./bot-import.ts";

export const HERMES_EXPORT_FORMAT = "hermes-bot-export";
export const HERMES_EXPORT_PROMPT = botExportPrompt(HERMES_EXPORT_FORMAT) + `
For Hermes Agent, export only the current profile, not other profiles. Read its SOUL.md for instructions, memories/MEMORY.md for memories, memories/USER.md for user_facts, and skills/**/SKILL.md for full skill text. Use the active HERMES_HOME (normally ~/.hermes), including when this is a named profile. List cron jobs read-only and map their actual prompt, schedule and time zone into routines; preserve a schedule you cannot represent as schedule_text instead of guessing a cron expression. List connected apps by name and public MCP URL only. Never read or include .env, auth.json, credentials, sessions, chat history or state.db. Do not run a job or change any source file. Do not include supporting skill files: tell me which ones I must copy separately.
`;

export function parseHermesExport(text: string) {
  return parseBotExport(text, [HERMES_EXPORT_FORMAT]);
}

export function hermesMovePlan(bot: ImportedBot, options: { timeZone?: string; takenServers?: ReadonlySet<string> } = {}) {
  return botMovePlan(bot, { name: "Hermes", notesFile: "memory/hermes-event-routines.md", identityPrefix: "hermes\n" }, options);
}
