import { botExportPrompt, botMovePlan, parseBotExport, type ImportedBot } from "./bot-import.ts";

export {
  BOT_EXPORT_MAX_CHARS as GROK_EXPORT_MAX_CHARS,
  BotImportError as GrokImportError, mergeImportedBots as mergeGrokBots,
} from "./bot-import.ts";
export type {
  BotImportErrorCode as GrokImportErrorCode, BotMovePlan as GrokMovePlan,
  ImportedBot as GrokBot, ImportedSkill as GrokSkill, ImportedRoutine as GrokRoutine, ImportedApp as GrokApp,
} from "./bot-import.ts";

export const GROK_EXPORT_FORMAT = "grok-bot-export";
export const GROK_EXPORT_FILE = /^grok-bot-export[^/\\]*\.(?:json|md|txt)$/i;
export const GROK_EXPORT_PROMPT = botExportPrompt(GROK_EXPORT_FORMAT);
export const GROK_NOTES_FILE = "memory/grok-bot-event-routines.md";

export function parseGrokExport(text: string) {
  return parseBotExport(text, [GROK_EXPORT_FORMAT, "openmaus.grok/1"]);
}

export function grokMovePlan(bot: ImportedBot, options: { timeZone?: string; takenServers?: ReadonlySet<string> } = {}) {
  return botMovePlan(bot, { name: "Grok Bot", notesFile: GROK_NOTES_FILE, identityPrefix: "" }, options);
}
