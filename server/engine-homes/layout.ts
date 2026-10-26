// Where a Team Cloud's engines keep their state: each audience (audience.ts) has its own engine home, which a spawn for
// that audience's turn gets as HOME, so a conversation's transcript and session files never sit where another audience's
// turn can list them. Only the engines' sign-ins are the team's, reached from every audience's home (sign-ins.ts).
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { Audience } from "../audience.ts";
import { under } from "../bot-box/plan.ts";
import { audienceBrowserSuffix } from "../browser/audience.ts";

export const ENGINE_HOMES_DIR = "engine-homes";
/** Unmatched engine state from before the split; nothing serves it, no box binds it, and it is deleted after HELD_DAYS. */
export const HELD_DIR = ".held";
export const HELD_DAYS = 30;
const MOVED_FOLDERS = ".omb-folders";

/** `team`, `room-<16 hex>` or `member-<16 hex>`: the browsers' keys, short enough for a socket path inside the home. */
export function audienceHomeKey(audience: Audience): string {
  return audience === "team" ? "team" : audienceBrowserSuffix(audience).slice(2);
}

export function engineHomesRoot(dataDir: string): string {
  return join(resolve(dataDir), ENGINE_HOMES_DIR);
}

export function audienceHome(dataDir: string, audience: Audience): string {
  return join(engineHomesRoot(dataDir), audienceHomeKey(audience));
}

const HOME_KEY = /^(?:team|(?:room|member)-[0-9a-f]{16})$/;

/** Every audience's engine home made so far. */
export function audienceHomes(dataDir: string): string[] {
  const root = engineHomesRoot(dataDir);
  try {
    return readdirSync(root).filter((name) => HOME_KEY.test(name)).map((name) => join(root, name));
  } catch {
    return [];
  }
}

/** An engine's own folder: what `env` names when set, else `home` under HOME. `shared` are its sign-in files there. */
export interface EngineFolder {
  env?: string;
  home: string;
  shared: readonly string[];
}

/** File names as each engine's sign-in keeps them (the drivers' own sign-in checks read the same ones). */
export const ENGINE_FOLDERS: readonly EngineFolder[] = [
  { env: "CLAUDE_CONFIG_DIR", home: ".claude", shared: [".credentials.json"] },
  { env: "CODEX_HOME", home: ".codex", shared: ["auth.json", "config.toml"] },
  { env: "GROK_HOME", home: ".grok", shared: ["auth.json", "config.toml"] },
  { env: "KIMI_CODE_HOME", home: ".kimi-code", shared: ["credentials/kimi-code.json", "config.toml"] },
  { env: "DSH_HOME", home: ".dsh", shared: [".credentials.yaml", ".env"] },
  { env: "FACTORY_HOME_OVERRIDE", home: "", shared: [".factory/auth.v2.file", ".factory/auth.v2.keyring", ".factory/settings.json"] },
  { env: "XDG_CONFIG_HOME", home: ".config", shared: ["muse/auth.json"] },
  { env: "XDG_DATA_HOME", home: ".local/share", shared: ["opencode/auth.json"] },
  { home: ".gemini", shared: ["oauth_creds.json", "google_accounts.json", "settings.json"] },
  { home: ".pi/agent", shared: ["auth.json"] },
];

/** Folder variables that move with HOME besides those above. */
const OTHER_FOLDER_ENV = ["HERMES_HOME", "OPENCODE_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;

export interface SharedFile {
  /** The team's file. */
  source: string;
  /** Where the audience's engine looks for it. */
  target: string;
}

export interface HomedSpawn {
  env: Record<string, string | undefined>;
  home: string;
  /** The engine folders the environment names inside `home`, to exist before the spawn. */
  folders: string[];
  shared: SharedFile[];
}

const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** The spawn's environment with HOME and every engine folder it names moved into `home`. A folder in the server's HOME
 * keeps its place there; any other gets one of its own. Sign-ins are named from where the engine would have kept them. */
export function homedSpawn(env: Record<string, string | undefined>, input: { dataDir: string; serverHome: string; home: string }): HomedSpawn {
  const dataDir = resolve(input.dataDir), home = resolve(input.home);
  const given = env.HOME && isAbsolute(env.HOME) ? resolve(env.HOME) : null;
  const realHome = given && !under(given, engineHomesRoot(dataDir)) ? given : resolve(input.serverHome);
  const out: Record<string, string | undefined> = { ...env, HOME: home };
  const folders: string[] = [];
  const moved = (variable: string, value: string): string => {
    const path = resolve(value);
    if (under(path, home)) return path;
    if (under(path, realHome) && !under(path, dataDir)) return join(home, relative(realHome, path));
    return join(home, MOVED_FOLDERS, `${variable}-${short(path)}`);
  };
  const variables = [...new Set([...ENGINE_FOLDERS.flatMap((folder) => (folder.env ? [folder.env] : [])), ...OTHER_FOLDER_ENV])];
  for (const variable of variables) {
    const value = env[variable];
    if (!value || !isAbsolute(value)) continue;
    out[variable] = moved(variable, value);
    folders.push(out[variable]!);
  }
  const shared: SharedFile[] = [];
  for (const folder of ENGINE_FOLDERS) {
    const named = folder.env ? env[folder.env] : undefined;
    const set = named !== undefined && isAbsolute(named);
    const source = set ? resolve(named) : join(realHome, folder.home);
    const target = set ? out[folder.env!]! : join(home, folder.home);
    if (under(source, engineHomesRoot(dataDir))) continue;
    for (const file of folder.shared) {
      const entry = { source: join(source, file), target: join(target, file) };
      if (!shared.some((known) => known.target === entry.target)) shared.push(entry);
    }
  }
  return { env: out, home, folders, shared };
}
