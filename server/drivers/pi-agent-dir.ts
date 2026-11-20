// MausBot's Pi turns run in a Pi agent folder of its own (PI_CODING_AGENT_DIR, pi-coding-agent 1.6.0), so a bot's turn
// never loads what the person set up for their own Pi in ~/.pi/agent: their AGENTS.md or CLAUDE.md, SYSTEM.md and
// APPEND_SYSTEM.md, skills, prompts, themes, extensions and packages, MCP servers (mcp.json) and project trust. Only what
// Pi needs to reach the person's providers comes along: their sign-ins and keys (auth.json, linked, so a refreshed login
// stays theirs), their own providers (models.json) and the model and connection parts of settings.json (both copied, so
// MausBot's local models never land in their files), and the search tools Pi downloaded (bin, linked).
import { createHash } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import { engineHomes } from "../engine-homes/engine-homes.ts";

/** settings.json entries that choose a model and how Pi reaches it (pi-coding-agent 1.6.0 SettingsManager). Never its
 * packages, extensions, skills or prompts. */
const SETTINGS_KEPT = ["defaultProvider", "defaultModel", "defaultThinkingLevel", "transport", "retry", "httpProxy",
  "httpIdleTimeoutMs", "websocketConnectTimeoutMs", "shellPath"] as const;

const noted = new Set<string>();
function note(path: string, message: string): void {
  if (noted.has(path)) return;
  noted.add(path);
  console.error(`pi: ${message}`);
}

const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

/** The Pi agent folder `env` points Pi at: PI_CODING_AGENT_DIR when set, else ~/.pi/agent. */
export function piAgentDir(env: Record<string, string | undefined>): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  const named = env.PI_CODING_AGENT_DIR;
  if (!named) return join(home, ".pi", "agent");
  return named === "~" ? home : named.startsWith("~/") ? join(home, named.slice(2)) : resolve(named);
}

/** `provider/model` from the agent folder's settings.json; "" when unset or unreadable. */
export function readPiDefaultModel(env: Record<string, string | undefined>): string {
  try {
    const s = JSON.parse(readFileSync(join(piAgentDir(env), "settings.json"), "utf8")) as { defaultProvider?: string; defaultModel?: string };
    return s.defaultProvider && s.defaultModel ? `${s.defaultProvider}/${s.defaultModel}` : "";
  } catch {
    return "";
  }
}

/** Links the person's entry into MausBot's folder; true when it is there (or the person has none). */
function linked(target: string, link: string): boolean {
  let want;
  try {
    want = statSync(target, { bigint: true });
  } catch {
    // A link left from when the person had one would send Pi's writes to a file that is gone.
    try { statSync(link); } catch { rmSync(link, { force: true }); }
    return true;
  }
  try {
    const have = statSync(link, { bigint: true });
    if (have.ino === want.ino && have.dev === want.dev) return true;
  } catch {}
  // A link that points elsewhere (removed as a link, never followed), or what Pi made here while the person had none.
  let stale;
  try { stale = lstatSync(link); } catch {}
  if (stale) rmSync(link, { recursive: stale.isDirectory() && !stale.isSymbolicLink(), force: true });
  const folder = want.isDirectory();
  try {
    symlinkSync(target, link, folder ? "junction" : "file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return true;
  }
  if (folder) return false;
  // Windows refuses a file link without Developer Mode; Pi writes auth.json in place, so a hard link stays shared.
  try {
    linkSync(target, link);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EEXIST";
  }
}

/** Copies `text` (the person's version, or null when they have none) into MausBot's folder when it changed since the
 * last copy. When the person never had one, MausBot's own stays (the local models a turn adds to models.json). */
function seeded(own: string, name: string, text: string | null): void {
  const path = join(own, name), mark = join(own, `.${name}.from`);
  const hash = text === null ? null : createHash("sha256").update(text).digest("hex");
  let last: string | null = null;
  try { last = readFileSync(mark, "utf8"); } catch {}
  if (hash === last) return;
  if (text === null || hash === null) {
    rmSync(path, { force: true });
    rmSync(mark, { force: true });
    return;
  }
  writeFileAtomic(path, text, { mode: 0o600 });
  writeFileAtomic(mark, hash, { mode: 0o600 });
}

function settingsText(path: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const kept: Record<string, unknown> = {};
  for (const key of SETTINGS_KEPT) if ((parsed as Record<string, unknown>)[key] !== undefined) kept[key] = (parsed as Record<string, unknown>)[key];
  return `${JSON.stringify(kept, null, 2)}\n`;
}

/** MausBot's Pi agent folder for this instance, made and brought up to date with the person's. Null when the person's
 * folder stays in use: on a Team Cloud (each audience's engine home already has its own, with only auth.json shared),
 * when theirs is MausBot's already (in the data folder), or when their login cannot be linked in. */
export function ownPiAgentDir(env: Record<string, string | undefined>, instanceId: string, dataDir = DATA_DIR,
  teamCloud = engineHomes.active()): string | null {
  const person = piAgentDir(env);
  const own = join(resolve(dataDir), "providers", "pi-own", createHash("sha256").update(instanceId).digest("hex"), "agent");
  if (teamCloud || inside(resolve(dataDir), person) || inside(person, own)) return null;
  try {
    mkdirSync(own, { recursive: true, mode: 0o700 });
    if (!linked(join(person, "auth.json"), join(own, "auth.json"))) {
      note(own, "could not link your Pi login into MausBot's Pi folder, so turns use your own ~/.pi/agent");
      return null;
    }
    // A download cache only: Pi fetches fd and rg again when it cannot be linked.
    linked(join(person, "bin"), join(own, "bin"));
    let models: string | null = null;
    try { models = readFileSync(join(person, "models.json"), "utf8"); } catch {}
    seeded(own, "models.json", models);
    seeded(own, "settings.json", settingsText(join(person, "settings.json")));
  } catch (error) {
    note(own, `could not make MausBot's Pi folder, so turns use your own ~/.pi/agent: ${(error as Error).message}`);
    return null;
  }
  return own;
}

/** `env` with Pi pointed at MausBot's own agent folder for this instance; `env` itself where the person's stays in use. */
export function withOwnPiAgentDir(env: Record<string, string | undefined>, instanceId: string, dataDir = DATA_DIR,
  teamCloud = engineHomes.active()): Record<string, string | undefined> {
  const own = ownPiAgentDir(env, instanceId, dataDir, teamCloud);
  return own ? { ...env, PI_CODING_AGENT_DIR: own } : env;
}
