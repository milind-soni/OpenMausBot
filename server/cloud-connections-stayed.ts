// What stayed on the person's computer when the bots moved to My Cloud: said to the person in their own words, once when
// the move ends and once in the first conversation they start with each bot that could have used it. A bot's prompt
// says the same (cloud-connections-prompt.ts), but a line from the server is not left to a model.
import { readFileSync } from "node:fs";

import { canUseMcpServer } from "../shared/tool-scope.ts";
import { writeFileAtomic } from "./atomic.ts";
import { isMailConnector, launcherOf } from "./cloud-connections.ts";
import { isRemoteMcpServer, parseStoredMcpServer, type McpRunsOn } from "./mcp-registry.ts";
import { serverLine } from "./server-lines.ts";

export type StayedWhy = { kind: "mail" } | { kind: "program"; program: string } | { kind: "here" };

export interface StayedConnector {
  name: string;
  /** The computer it runs on, by the name the person knows it by. */
  computer: string;
  runsOn: McpRunsOn;
  why: StayedWhy;
  /** The one bot it serves, when it is that bot's own. */
  bot?: string;
}

/** The connectors on this Cloud that run on another computer, each with why. One switched off was not working anyway. */
export function stayedConnectors(servers: Record<string, unknown> | undefined, programs: readonly string[]): StayedConnector[] {
  return Object.entries(servers ?? {}).flatMap(([name, raw]): StayedConnector[] => {
    const parsed = parseStoredMcpServer(name, raw);
    if (!parsed.ok || !parsed.server.enabled || !parsed.server.runsOn) return [];
    const server = parsed.server;
    const remote = isRemoteMcpServer(server);
    const program = remote ? "" : launcherOf(server.command);
    const why: StayedWhy = isMailConnector(server) ? { kind: "mail" } : !remote && !/[\\/]/u.test(server.command) && !programs.includes(program) ? { kind: "program", program } : { kind: "here" };
    return [{ name, computer: server.runsOn!.label, runsOn: server.runsOn!, why, ...(!remote && server.bot ? { bot: server.bot } : {}) }];
  });
}

/** Why, as a model reads it: words a bot can pass on. */
export function stayedWhyText(stayed: StayedConnector): string {
  if (stayed.why.kind === "mail") return `a mail connector keeps its accounts on ${stayed.computer}, and a bot here cannot reach a mail server through it; the email tools do that job here, and request_credential with credential_id email connects them`;
  if (stayed.why.kind === "program") return `it needs ${stayed.why.program}, which this Cloud does not have`;
  return `it uses files or an address only ${stayed.computer} has`;
}

/** The person's line about one connector. */
export function stayedLine(language: string | undefined, stayed: StayedConnector): string {
  const { name, computer, why } = stayed;
  if (why.kind === "mail") return serverLine(language, "server.moves.connectorStayedMail", { name, computer });
  if (why.kind === "program") return serverLine(language, "server.moves.connectorStayedProgram", { name, computer, program: why.program });
  return serverLine(language, "server.moves.connectorStayedHere", { name, computer });
}

type Bot = { id: string; name: string; threadId: string; chiefOfStaff?: unknown; mcpServers?: string[]; toolScope?: unknown };

export interface StayedNoticesDeps {
  /** Who has been told what, by connector and bot. */
  file: string;
  /** My Cloud's public address. */
  origin: string;
  servers(): Record<string, unknown> | undefined;
  programs(): readonly string[];
  /** A mailbox is connected here, so a mail connector left behind is no longer missed. */
  mailConnected?(): boolean;
  /** The computer it runs on is lent here, so bots reach it through that computer and nothing stayed behind. */
  lent?(runsOn: McpRunsOn): boolean;
  bots(): readonly Bot[];
  /** A line in a bot's own chat, in the conversation the person is looking at. */
  say(threadId: string, text: string, kind: "line" | "row"): void;
  /** The person hears of it outside the chat too, when the move ends. */
  notify(text: string, bot: Bot, threadId: string): void;
  language(threadId: string): string | undefined;
}

export function createStayedNotices(deps: StayedNoticesDeps) {
  let told: Record<string, string[]> | null = null;
  const record = (): Record<string, string[]> => {
    if (told) return told;
    try { told = JSON.parse(readFileSync(deps.file, "utf8")) as Record<string, string[]>; } catch { told = {}; }
    return told;
  };
  const key = (stayed: StayedConnector) => `${stayed.computer}\u0000${stayed.name}`;
  const known = (stayed: StayedConnector, bot: Bot) => record()[key(stayed)]?.includes(bot.id) === true;
  const remember = (stayed: StayedConnector, bot: Bot) => {
    const all = record();
    (all[key(stayed)] ??= []).push(bot.id);
    try { writeFileAtomic(deps.file, JSON.stringify(all), { mode: 0o600 }); } catch (error) { console.warn("[connections] could not save what was said about what stayed:", error); }
  };
  const stayed = () => stayedConnectors(deps.servers(), deps.programs()).filter((connector) => (connector.why.kind !== "mail" || !deps.mailConnected?.()) && !deps.lent?.(connector.runsOn));
  const serves = (bot: Bot, connector: StayedConnector) => (connector.bot ? connector.bot === bot.id : !bot.mcpServers || bot.mcpServers.includes(connector.name)) && canUseMcpServer(bot.toolScope, connector.name);

  return {
    /** The move ended: one bot says what stayed, in its own chat, and the person is told outside the chat too. */
    moved(language?: string): void {
      const left = stayed().filter((connector) => !deps.bots().some((bot) => known(connector, bot)));
      if (!left.length) return;
      const bots = deps.bots();
      const speaker = bots.find((bot) => bot.chiefOfStaff && left.some((connector) => serves(bot, connector))) ?? bots.find((bot) => left.some((connector) => serves(bot, connector)));
      if (!speaker) return;
      const lines = left.filter((connector) => serves(speaker, connector));
      // In a chat line a link can be followed; `/?connect=email` opens where a mailbox connects.
      const link = lines.some((connector) => connector.why.kind === "mail") ? `\n\n${deps.origin}/?connect=email` : "";
      const text = `${lines.map((connector) => stayedLine(language ?? deps.language(speaker.threadId), connector)).join("\n\n")}${link}`;
      for (const connector of lines) remember(connector, speaker);
      deps.say(speaker.threadId, text, "line");
      deps.notify(text, speaker, speaker.threadId);
    },

    /** A person started a turn with this bot: what it could have used and has not been said here yet, once per bot. */
    personTurn(bot: Bot, threadId: string): void {
      for (const connector of stayed()) {
        if (!serves(bot, connector) || known(connector, bot)) continue;
        remember(connector, bot);
        deps.say(threadId, stayedLine(deps.language(threadId), connector), "row");
      }
    },
  };
}
