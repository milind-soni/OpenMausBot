import type { LocaleKey } from "@/locales";
import type { Message } from "@/state/store";
import type { LiveStatus } from "@/state/turn-status";
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

/** Simple mode's one rotating line for what the bot is doing now: plain words in place of file names, sizes and
 * timers, chosen by the kind of step (a tool's spoken narration is read by its name, as every other step is); a
 * command, search or page the server could name is said by name. */
export function friendlyNowPhrases(status: LiveStatus | null, message?: Message): LiveActivityPhrases {
  const plain = message?.kind === "activity" && message.tool?.spoken ? { ...message, tool: { ...message.tool, spoken: undefined } } : message;
  const now = turnNowPhrases(status, plain);
  if (now?.phase.startsWith("step:")) return now;
  const tool = (status && "tool" in status ? status.tool : undefined) ?? (message?.kind === "activity" && message.tool?.ok === undefined ? message.tool?.name : undefined);
  const service = toolService(tool);
  if (service) return { phase: `friendly:service:${service}`, phrases: [t("chat.friendly.service", { service })] };
  if (!now) return phrases("generic", GENERIC);
  if (now.phase.startsWith("live:read:")) return phrases("digging", ["chat.friendly.digging"]);
  if (now.phase.startsWith("live:")) return phrases("code", ["chat.friendly.code"]);
  const match = BY_PHASE.find(([phases]) => phases.includes(now.phase));
  return match ? phrases(match[1][0]!, match[1]) : phrases("generic", GENERIC);
}
