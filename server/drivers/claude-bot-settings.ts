// A bot's own Claude Code settings (`.claude/settings.json` in its working folder, else in its own folder) for a turn
// that runs in another folder: a thread's own folder, a room's, or one chosen for the thread.
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

type Settings = Record<string, unknown>;

/** Far above any real settings file; only bounds what is read for a turn. */
const MAX_BYTES = 1024 * 1024;

const isObject = (value: unknown): value is Settings => typeof value === "object" && value !== null && !Array.isArray(value);

/** `value`'s entries that `keep` maps to something, or undefined when none does. */
function entriesOf(value: unknown, keep: (entry: unknown, name: string) => unknown): Settings | undefined {
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value).map(([name, entry]) => [name, keep(entry, name)] as const).filter(([, entry]) => entry !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

const isMatcher = (entry: unknown) => isObject(entry) && (entry.matcher === undefined || typeof entry.matcher === "string") &&
  Array.isArray(entry.hooks) && entry.hooks.every((hook) => isObject(hook) && typeof hook.type === "string");

const nonEmpty = <T>(list: T[]): T[] | undefined => list.length ? list : undefined;

/** null when there is nothing to take: no regular file there, not JSON, or the turn's own folder's, which Claude Code reads itself. */
function readBotSettings(file: string, cwd: string): unknown {
  try {
    const real = realpathSync(file);
    // Never through a link: the bot can write this folder, and the file is read here, outside any box it runs in.
    if (real !== join(realpathSync(dirname(dirname(file))), ".claude", "settings.json")) return null;
    try {
      if (realpathSync(join(cwd, ".claude", "settings.json")) === real) return null;
    } catch {}
    // O_NONBLOCK: a planted FIFO must not hang the open.
    const fd = openSync(real, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    try {
      const stat = fstatSync(fd);
      return stat.isFile() && stat.size <= MAX_BYTES ? JSON.parse(readFileSync(fd, "utf8")) : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** What a turn takes from the bot's settings file: its hooks, plugins, permission rules and env. They ride in
 * OpenMausBot's own --settings file (Claude Code takes one), and Claude Code 2.1.312 drops a whole settings file when a
 * field it knows has the wrong type, so only these, each checked, come along. An env name the turn's process already
 * has keeps OpenMausBot's value. */
export function botSettingsFor(file: string | undefined, cwd: string, processEnv: Record<string, string | undefined>): Settings {
  const parsed = file ? readBotSettings(file, cwd) : null;
  if (!isObject(parsed)) return {};
  const carried: Settings = {
    hooks: entriesOf(parsed.hooks, (matchers) => Array.isArray(matchers) ? nonEmpty(matchers.filter(isMatcher)) : undefined),
    enabledPlugins: entriesOf(parsed.enabledPlugins, (on) =>
      typeof on === "boolean" || (Array.isArray(on) && on.every((item) => typeof item === "string")) ? on : undefined),
    extraKnownMarketplaces: entriesOf(parsed.extraKnownMarketplaces, (marketplace) => isObject(marketplace) ? marketplace : undefined),
    permissions: entriesOf(parsed.permissions, (rules, key) => ["allow", "ask", "deny", "additionalDirectories"].includes(key) && Array.isArray(rules)
      ? nonEmpty(rules.filter((rule) => typeof rule === "string")) : undefined),
    env: entriesOf(parsed.env, (value, name) => typeof value === "string" && !Object.hasOwn(processEnv, name) ? value : undefined),
  };
  return Object.fromEntries(Object.entries(carried).filter(([, value]) => value !== undefined));
}

/** Claude Code's rule for two settings sources, `own` the later: objects merge, lists join, a value replaces. */
export function withBotSettings(bot: Settings, own: Settings): Settings {
  return merged(bot, own) as Settings;
}

function merged(base: unknown, over: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(over)) return [...base, ...over.filter((item) => !base.includes(item))];
  if (!isObject(base) || !isObject(over)) return over;
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(over)])].map((key) => [key,
    !Object.hasOwn(over, key) ? base[key] : Object.hasOwn(base, key) ? merged(base[key], over[key]) : over[key]]));
}
