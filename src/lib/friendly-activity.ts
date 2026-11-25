import type { LocaleKey } from "@/locales";
import type { Message } from "@/state/store";
import type { LiveStatus } from "@/state/turn-status";
import { SHARED_CHAT_TITLE } from "../../shared/wire";
import { t } from "./i18n";
import { turnNowPhrases, type LiveActivityPhrases } from "./live-activity";

const GENERIC: LocaleKey[] = ["chat.friendly.thinking", "chat.friendly.mulling", "chat.friendly.working", "chat.friendly.chipping"];

// Keys, not labels: t() reads the active language pack when called.
const BY_PHASE: Array<[readonly string[], LocaleKey[]]> = [
  [["chat.activity.reply"], ["chat.typing"]],
  [["chat.activity.readFile", "chat.activity.searchWeb", "chat.activity.readPage", "chat.activity.searching"], ["chat.friendly.digging"]],
  [["chat.activity.writeFile", "chat.activity.editFile"], ["chat.friendly.code"]],
  [["chat.activity.runCommand"], ["chat.friendly.commands"]],
  [["chat.activity.screen", "chat.activity.computer", "chat.activity.openPage"], ["chat.friendly.clicking"]],
  [["chat.activity.handoff", "chat.activity.askTeammate", "chat.activity.postRoom", "chat.activity.messagePerson", "chat.activity.rooms", "chat.activity.whosAround"], ["chat.friendly.team"]],
  [["chat.activity.publishPage"], ["chat.activity.publishPage"]],
  [["chat.activity.summarizing"], ["chat.activity.summarizing"]],
];

/** Servers of the app's own tools: their work reads as what it does, never as "Working in …". */
const OWN_SERVERS = new Set(["ogb", "agents", "omb", "openmausbot", "computer", "browser", "harness"]);

/** The outside service a tool call works in, by its MCP server or a connected-app tool's name, as a person names it. */
export function toolService(name: string | undefined): string | null {
  const server = /^mcp__([^_]+(?:-[^_]+)*)__(.+)$/.exec(name ?? "");
  if (!server) return null;
  const [, id, tool] = server;
  if (OWN_SERVERS.has(id!.toLowerCase())) return null;
  const raw = id!.toLowerCase() === "composio" ? /^([A-Za-z]+)_/.exec(tool!)?.[1] : id;
  if (!raw) return null;
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

function phrases(phase: string, keys: LocaleKey[]): LiveActivityPhrases {
  return { phase: `friendly:${phase}`, phrases: keys.map((key) => t(key)) };
}

/** A written file's kind, as what it makes for the person: a page or a write-up; code and anything else are neither. */
const MADE: Array<[RegExp, LocaleKey]> = [[/\.html?$/i, "chat.friendly.page"], [/\.(?:md|markdown|txt|rtf|docx?|odt|pdf)$/i, "chat.friendly.writeup"]];

/** What the running write or edit is making, from the engine's report or the call still running in the chat. */
export function madeKey(status: LiveStatus | null, message?: Message): LocaleKey | null {
  const step = message?.kind === "activity" && message.tool?.ok === undefined ? message.tool?.step : undefined;
  // The engine's report wins over the chat's call, as it does for the rest of the line.
  const file = status ? (status.activity === "write" || status.activity === "edit" ? status.file ?? status.target : undefined)
    : step?.activity === "write" || step?.activity === "edit" ? step.target : undefined;
  return (file && MADE.find(([kind]) => kind.test(file))?.[1]) || null;
}

/** Words that name only the tool: the conversation's subject says more. */
const TOOL_TALK: ReadonlySet<LocaleKey> = new Set(["chat.friendly.code", "chat.friendly.commands"]);

/** Titles the app gives a conversation itself (task-title.ts localizes the last two). */
const FACTORY_TITLES: ReadonlySet<string> = new Set(["New task", "New thread", SHARED_CHAT_TITLE]);

/** The conversation's title as the name of the work, once it is more than a factory title or the opening of one of the
 * person's own messages (the stand-in title a thread gets until its generated one arrives, pasted text included; cut
 * short, it ends in "…", which a generated title never does). */
export function taskSubject(title: string | undefined, userTexts: readonly string[]): string | undefined {
  const name = title?.trim();
  if (!name || FACTORY_TITLES.has(name) || name.endsWith("…")) return undefined;
  return userTexts.some((text) => text.includes(name)) ? undefined : name;
}

/** Simple mode's one rotating line for what the bot is doing now: plain words in place of file names, sizes and
 * timers, chosen by the kind of step (a tool's spoken narration is read by its name, as every other step is); a
 * command, search or page the server could name is said by name. A page or write-up says what it makes, and the
 * conversation's `subject`, when known, stands in for words that would only name the tool (thinking, code, commands). */
export function friendlyNowPhrases(status: LiveStatus | null, message?: Message, subject?: string): LiveActivityPhrases {
  const plain = message?.kind === "activity" && message.tool?.spoken ? { ...message, tool: { ...message.tool, spoken: undefined } } : message;
  const now = turnNowPhrases(status, plain);
  if (now?.phase.startsWith("step:") || now?.phase.startsWith("notice:")) return now;
  const tool = (status && "tool" in status ? status.tool : undefined) ?? (message?.kind === "activity" && message.tool?.ok === undefined ? message.tool?.name : undefined);
  const service = toolService(tool);
  if (service) return { phase: `friendly:service:${service}`, phrases: [t("chat.friendly.service", { service })] };
  const made = madeKey(status, message);
  if (made) return phrases(made, [made]);
  const task = (phase: string, keys: LocaleKey[]) => subject ? { phase: `friendly:task:${subject}`, phrases: [t("chat.friendly.task", { task: subject })] } : phrases(phase, keys);
  if (!now) return task("generic", GENERIC);
  if (now.phase.startsWith("live:read:")) return phrases("digging", ["chat.friendly.digging"]);
  if (now.phase.startsWith("live:")) return task("code", ["chat.friendly.code"]);
  const match = BY_PHASE.find(([phases]) => phases.includes(now.phase));
  if (!match) return task("generic", GENERIC);
  return TOOL_TALK.has(match[1][0]!) ? task(match[1][0]!, match[1]) : phrases(match[1][0]!, match[1]);
}
