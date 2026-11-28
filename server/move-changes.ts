// GET /api/cloud-send/changes?bots=<id>,<id>: what moving these bots to My Cloud changes for them, read from this
// computer's own setup (shared/move-changes.ts says which lines apply). Read only, admin scope like every
// /api/cloud-send route. It names no secret and no path but each bot's working folder, which its own settings show.
import type { MoveFacts } from "../shared/move-changes.ts";
import { canUseMcpServer } from "../shared/tool-scope.ts";
import { PERSONAL_SECRETS } from "../electron/personal-secrets.mjs";
import { addressHere, runsHere } from "./cloud-connections.ts";
import { isOllamaServer } from "./drivers/ollama.ts";
import { isRemoteMcpServer, parseStoredMcpServer } from "./mcp-registry.ts";
import { mentionedBots, sectionKey, type BotRecord } from "./store.ts";

/** A hand-off this recent still says who a bot works with. */
export const TEAMMATE_WINDOW_MS = 30 * 24 * 60 * 60_000;
const NAMED_MAX = 20;

export interface MoveChangesDeps {
  bots(): readonly BotRecord[];
  /** The engines this server has, as config.json keeps them. */
  instances(): Record<string, { displayName?: string; config?: unknown } | undefined>;
  mcpServers(): Record<string, unknown> | undefined;
  /** A bot's skills, by name, with each one's SKILL.md text (null when it can't be read). */
  skills(bot: BotRecord): ReadonlyArray<{ name: string; enabled: boolean; text: string | null }>;
  now?(): number;
}

/** A path into the person's home folder, as a skill writes it: "~/.claude/projects", "$HOME/.codex", "/Users/ash/.claude",
 * "C:\\Users\\ash\\.codex". The rest of the path, with "/" between parts. */
const HOME_PATH = /(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\/Users\/[^/\s"'`]+|\/home\/[^/\s"'`]+|[A-Za-z]:\\Users\\[^\\\s"'`]+)[/\\]([^\s"'`)\]]+)/gu;

/** The places in the person's home a skill's text reads that no lent folder ever reaches (personal-secrets.mjs), each as
 * "~/<place>". Any other path under home is reachable once lent. */
export function hiddenFoldersIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(HOME_PATH)) {
    const rest = match[1]!.replaceAll("\\", "/").replace(/[/.,;:]+$/u, "");
    const place = PERSONAL_SECRETS.find((entry) => rest === entry || rest.startsWith(`${entry}/`));
    if (place) found.add(`~/${place}`);
  }
  return [...found];
}

/** The engine's name when it answers at an address only this computer or its network reaches, which a move leaves here;
 * null otherwise. */
export function localEngine(entry: { displayName?: string; config?: unknown } | undefined, instanceId: string): string | null {
  const url = (entry?.config as { url?: unknown } | undefined)?.url;
  if (typeof url !== "string") return null;
  // The move's own rule for a model that stays on this computer (cloud-connections.ts modelStaysHere).
  if (!url.trim() || !addressHere(url)) return null;
  const catalog = (entry?.config as { catalog?: unknown } | undefined)?.catalog;
  return entry?.displayName?.trim() || (isOllamaServer(entry?.config) ? "Ollama" : catalog === "lmstudio" ? "LM Studio" : instanceId);
}

const visible = (bot: BotRecord) => !bot.hidden && !bot.movedTo && !bot.home;

/** Who these bots hand work to among the bots that stay: a teammate a hand-off opened a conversation with in the last
 * 30 days, one their standing instructions @mention, and, for a Chief, the bots of the departments it runs. */
export function teammatesOf(chosen: readonly BotRecord[], all: readonly BotRecord[], now: number): BotRecord[] {
  const going = new Set(chosen.map((bot) => bot.id));
  const staying = all.filter((bot) => !going.has(bot.id) && visible(bot));
  const picked = new Set<string>();
  for (const bot of chosen) {
    for (const other of staying) {
      if ((other.tasks ?? []).some((task) => task.openedBy?.botId === bot.id && now - (task.openedBy.at ?? 0) <= TEAMMATE_WINDOW_MS)) picked.add(other.id);
    }
    if (bot.soul?.trim()) for (const named of mentionedBots(bot.soul, staying)) picked.add(named.id);
    if (bot.chiefOfStaff) {
      const runs = new Set([sectionKey(bot.section), ...(bot.managedSections ?? []).map(sectionKey)]);
      for (const other of staying) if (!other.chiefOfStaff && !other.defaultBot && runs.has(sectionKey(other.section))) picked.add(other.id);
    }
  }
  return staying.filter((bot) => picked.has(bot.id));
}

export function moveFacts(deps: MoveChangesDeps, ids: readonly string[]): MoveFacts | null {
  const all = deps.bots();
  const asked = new Set(ids);
  const chosen = all.filter((bot) => asked.has(bot.id));
  if (!chosen.length) return null;
  const folders = chosen.flatMap((bot) => (bot.cwd?.trim() ? [bot.cwd.trim()] : []));
  const instances = deps.instances();
  const engine = chosen.map((bot) => localEngine(instances[bot.modelSelection?.instanceId ?? ""], bot.modelSelection?.instanceId ?? "")).find(Boolean) ?? null;
  const tools = new Set<string>();
  for (const [name, raw] of Object.entries(deps.mcpServers() ?? {})) {
    const parsed = parseStoredMcpServer(name, raw);
    // Only a command server that needs this computer stays: one My Cloud can start itself moves and runs there.
    if (!parsed.ok || !parsed.server.enabled || parsed.server.runsOn || isRemoteMcpServer(parsed.server) || !runsHere(parsed.server)) continue;
    const server = parsed.server;
    if (chosen.some((bot) => (server.bot ? server.bot === bot.id : !bot.mcpServers || bot.mcpServers.includes(name)) && canUseMcpServer(bot.toolScope, name))) tools.add(name);
  }
  const skills: string[] = [];
  const hidden = new Set<string>();
  for (const bot of chosen) {
    for (const skill of deps.skills(bot)) {
      if (!skill.enabled || !skill.text) continue;
      const found = hiddenFoldersIn(skill.text);
      if (!found.length) continue;
      if (!skills.includes(skill.name)) skills.push(skill.name);
      for (const folder of found) hidden.add(folder);
    }
  }
  return {
    folder: folders[0] ?? null,
    folders: folders.length,
    paths: [...new Set(folders)].slice(0, NAMED_MAX),
    engine,
    tools: [...tools].slice(0, NAMED_MAX),
    skills: skills.slice(0, NAMED_MAX),
    hidden: [...hidden].slice(0, NAMED_MAX),
    teammates: teammatesOf(chosen, all, deps.now?.() ?? Date.now()).map((bot) => bot.name).slice(0, NAMED_MAX),
  };
}
