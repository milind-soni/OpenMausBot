// A bot coming back from one of the person's places to another: from My Cloud to this computer, or to My Cloud again
// after it went from there (server/bot-moves.ts holds it on both sides). This keeps what the arriving side says about it
// afterwards (which routines are on, what stayed off here and why), who may write a move into this computer, and what the
// Cloud keeps of the person's when one of its bots leaves for a computer.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import type { CloudOwner } from "./cloud-owner-lines.ts";
import { customMcpServers, type AppConfig } from "./config.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { BotRecord } from "./store.ts";

/** A routine, webhook or app event by its id and name. */
export interface MovedAutomation { id: string; name: string }

/** What the arriving side did when a bot came back, kept so the person can be told it afterwards. */
export interface ArrivedFacts {
  v: 1;
  /** Where it came from: My Cloud, or one of the person's computers. */
  from: { id: string; name: string };
  /** When the hold that brought it began, so a second ask for the same arrival answers the same. */
  hold: number;
  at: number;
  /** "computer": this computer took it; "cloud": My Cloud took it again. */
  place: "computer" | "cloud";
  /** What was on there and is on here now. */
  on: { routines: MovedAutomation[]; webhooks: MovedAutomation[]; appEvents: MovedAutomation[] };
  /** What was on there and stays off here: a webhook no one can reach on a computer, an app event this computer may not
   * be connected for, and an MCP server that runs a command here the bot did not use here before. */
  offHere: { webhooks: MovedAutomation[]; appEvents: MovedAutomation[]; mcpServers: string[] };
}

/** What My Cloud keeps of the person's when one of its bots goes to a computer: nothing of it is sent or changed. Counts and
 * names only, never a value. */
export interface StaysOnCloud { logins: number; secrets: number; onePassword: boolean; connections: string[] }

const FILE = "bot-arrivals.json";
const KEPT = 50;

/** The facts of each bot's last arrival here, in `<dataDir>/bot-arrivals.json`. */
export function arrivalsFile(dataDir: string) {
  const path = join(dataDir, FILE);
  const read = (): Record<string, ArrivedFacts> => {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, ArrivedFacts> : {};
    } catch { return {}; }
  };
  return {
    get: (botId: string): ArrivedFacts | null => read()[botId] ?? null,
    put(botId: string, facts: ArrivedFacts): void {
      const all = { ...read(), [botId]: facts };
      const kept = Object.entries(all).sort(([, a], [, b]) => b.at - a.at).slice(0, KEPT);
      writeFileAtomic(path, JSON.stringify(Object.fromEntries(kept)), { mode: 0o600 });
    },
  };
}
export type Arrivals = ReturnType<typeof arrivalsFile>;

/** The app's own main process on this computer, asking its own server: the desktop's capability (request-auth.ts), from
 * no browser page and no paired phone, on a server the desktop runs and nobody else signs in to. Security: this is the
 * only caller besides My Cloud's owner that may write a move into a server; a renderer, a bot's shell, the network and a
 * shared or hosted workspace never are. */
export function desktopMainMover(auth: RequestAuth, place: { desktopManaged: boolean; managed: boolean }): boolean {
  return place.desktopManaged && !place.managed && auth.kind === "loopback" && auth.desktopMain === true && auth.trust !== "service"
    && auth.companionDevice === undefined;
}

/** The person on their own computer, as a move into it names them: nothing they wrote is stamped with it (`here`). */
export const thisComputerOwner = (name: string | undefined): CloudOwner => ({ person: "this-computer", name: name?.trim() || "User", here: true });

/** The MCP servers this server would mount for the bot, and which of them run a command on this machine. */
export function mcpServersHere(cfg: AppConfig, botId: string): { all: string[]; command: string[] } {
  const servers = customMcpServers(cfg, undefined, botId);
  const all = Object.keys(servers);
  return { all, command: all.filter((name) => "command" in servers[name]!) };
}

/** What My Cloud keeps when this bot leaves it for a computer: the person's logins, secrets and 1Password, and the
 * connections the bot uses here, which a computer has only once the person connects them there. */
export function staysOnCloud(bot: Pick<BotRecord, "mcpServers" | "connectorTools"> | null | undefined, held: {
  logins: number; secrets: number; onePassword: boolean; mcpServers: readonly string[];
}): StaysOnCloud {
  const mcp = bot?.mcpServers ?? held.mcpServers;
  return { logins: held.logins, secrets: held.secrets, onePassword: held.onePassword, connections: [...new Set([...mcp, ...Object.keys(bot?.connectorTools ?? {})])].sort() };
}
