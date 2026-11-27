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

/** Documents a person reads; a Markdown file only when it isn't the bot's own notes or a project's file (below). */
const DOCUMENT = /\.(?:docx?|odt|rtf|pdf)$/i;
const MARKDOWN = /\.(?:md|markdown)$/i;
/** Hidden, memory, notes and skills folders hold the bot's own files, never the person's write-up. */
const OWN_FOLDER = /(?:^|[\\/])(?:\.[^\\/]*|memory|memories|notes|skills|node_modules)[\\/]/i;
/** MEMORY.md, SOUL.md, README.md and the like, a dated journal, or a notes file: the bot's or a project's own. */
const OWN_MARKDOWN = /^(?:\.|[A-Z0-9_-]+\.|\d{4}-\d{2}-\d{2}|(?:notes?|memory|todo|scratch|changelog|readme)\.)/;

function madeOf(file: string, path: string | undefined): LocaleKey | null {
  if (/\.html?$/i.test(file)) return "chat.friendly.page";
  if (DOCUMENT.test(file)) return "chat.friendly.writeup";
  if (!MARKDOWN.test(file) || OWN_MARKDOWN.test(file) || (path && OWN_FOLDER.test(path))) return null;
  return "chat.friendly.writeup";
}

/** What the running write or edit is making for the person, from the engine's report or the call still running in the
 * chat: a page, a write-up, or (null) code, notes and anything else. */
export function madeKey(status: LiveStatus | null, message?: Message): LocaleKey | null {
  const tool = message?.kind === "activity" && message.tool?.ok === undefined ? message.tool : undefined;
  const step = tool?.step;
  // The engine's report wins over the chat's call, as it does for the rest of the line.
  const file = status ? (status.activity === "write" || status.activity === "edit" ? status.file ?? status.target : undefined)
    : step?.activity === "write" || step?.activity === "edit" ? step.target : undefined;
  if (!file) return null;
  // The call's input arrives as JSON text, its path near the start: read just that, never parse a whole file's content.
  const path = /"(?:file_path|path)"\s*:\s*"((?:[^"\\]|\\.){1,500})"/.exec(tool?.input?.slice(0, 2_000) ?? "")?.[1];
  return madeOf(file.replace(/…$/, ""), path);
}

/** Words that name only the tool: the conversation's subject says more. */
const TOOL_TALK: ReadonlySet<LocaleKey> = new Set(["chat.friendly.code", "chat.friendly.commands"]);

/** Titles the app gives a conversation itself (task-title.ts localizes the last two). */
const FACTORY_TITLES: ReadonlySet<string> = new Set(["New task", "New thread", "Conversation", "work", SHARED_CHAT_TITLE]);
const TITLE_MAX = 48;

/** The conversation's title as the name of the work, only when it is a title the engine generated. Anything else, or
 * anything unsure, is undefined and the line keeps today's words: a factory title; a hand-off thread's "@Bot · " prefix
 * is dropped first, and any other " · " title is the app's own (a room job, a routine's results); "From <bot>"; a title
 * starting with "#" or "@"; one longer than a generated title, or cut short with "…"; or the start of a line in one of
 * the conversation's messages (the stand-in title a thread or fork takes from a message until its generated one
 * arrives, pasted text included). A trailing ?, ! or . is left out, so a question reads as the work. */
export function taskSubject(title: string | undefined, texts: readonly string[]): string | undefined {
  const name = title?.trim().replace(/^@[^·]{1,80} · /, "").replace(/[?!.？！。]+$/u, "").trim();
  if (!name || FACTORY_TITLES.has(name) || name.length > TITLE_MAX || name.endsWith("…") || name.includes(" · ")) return undefined;
  if (/^(?:#|@|From\s)/.test(name)) return undefined;
  const raw = title!.trim().replace(/^@[^·]{1,80} · /, "");
  return texts.some((text) => text.split("\n").some((line) => line.trim().startsWith(raw) || line.trim().startsWith(name))) ? undefined : name;
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
  // The work leads and the usual words still rotate after it, so a long turn's line never sits still.
  const task = (phase: string, keys: LocaleKey[]) => subject
    ? { phase: `friendly:task:${subject}`, phrases: [t("chat.friendly.task", { task: subject }), ...keys.map((key) => t(key))] } : phrases(phase, keys);
  if (!now) return task("generic", GENERIC);
  if (now.phase.startsWith("live:read:")) return phrases("digging", ["chat.friendly.digging"]);
  if (now.phase.startsWith("live:")) return task("code", ["chat.friendly.code"]);
  const match = BY_PHASE.find(([phases]) => phases.includes(now.phase));
  if (!match) return task("generic", GENERIC);
  return TOOL_TALK.has(match[1][0]!) ? task(match[1][0]!, match[1]) : phrases(match[1][0]!, match[1]);
}
