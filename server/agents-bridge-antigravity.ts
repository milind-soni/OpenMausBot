// Whether a turn on Google's native Antigravity CLI may list the agents tools through the tool bridge.
// Security invariant: the CLI runs tool hooks from the launch folder's real-path ancestors (.agents/ and its legacy
// names, a personal_customization_dir), from the profile's config/ and from plugins, and a PreToolUse hook can deny or
// auto-approve an MCP tool by its name, mcp_agents_<tool> (measured on 1.5.16 over ACP). A bridged call reaches it as
// use_tool, so a turn is bridged only when none of those places holds anything beyond the few entries that cannot
// carry a hook, an MCP server or a rule, and an unreadable entry counts as present.
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { antigravityProfileDirectory } from "./drivers/antigravity-acp.ts";
import { isAntigravityNativeAlias, resolveAntigravityRuntime } from "./drivers/antigravity-runtime.ts";
import { unbridgeableFile, unbridgeableVersions } from "./drivers/antigravity-bridge-memory.ts";
import { parseVersionTriple, versionAtLeast } from "./drivers/acp/version-probe.ts";


/** The releases bridged: from 1.5.14, whose MCP permission requests were recorded as `mcp_agents_<tool>`,
 * `Run mcp_agents_<tool>`, kind `other`, with only allow_once and reject_once (1.5.14 from real turns, 1.5.16 measured),
 * to before 1.6.0. A later 1.5 release that spells a bridged call otherwise has it refused, never approved as another
 * tool, and is then recorded as unbridgeable (drivers/antigravity-bridge-memory.ts). */
export const BRIDGED_NATIVE_RANGE = { from: [1, 5, 14], before: [1, 6, 0] } as const;

function bridgedRelease(version: string): boolean {
  const triple = parseVersionTriple(version);
  return triple !== null && versionAtLeast(triple, [...BRIDGED_NATIVE_RANGE.from]) && !versionAtLeast(triple, [...BRIDGED_NATIVE_RANGE.before]);
}

export interface NativeCliRelease {
  executablePath: string;
  version: string;
}

const cliOf = (config: unknown): string | undefined => {
  const cli = (config as { cli?: unknown } | undefined)?.cli;
  return typeof cli === "string" ? cli : undefined;
};

/** Whether this account's turns run the native CLI and so lose their largest MCP tools past the CLI's budget
 * (google-antigravity/antigravity-cli#1530). Only the bare alias counts: it can start nothing but the native CLI. */
export function dropsToolsPastBudget(engine: { driverKind: string; config?: unknown } | null | undefined): boolean {
  return engine?.driverKind === "antigravityAgent" && isAntigravityNativeAlias(cliOf(engine.config));
}

/** The native CLI release a turn of this account would start, read from the install records without starting it. */
export async function antigravityNativeRelease(engine: { driverKind: string; config?: unknown }, env: NodeJS.ProcessEnv = process.env): Promise<NativeCliRelease | undefined> {
  if (!dropsToolsPastBudget(engine)) return undefined;
  try {
    const runtime = await resolveAntigravityRuntime(cliOf(engine.config), env);
    return runtime.harnessPath === null && runtime.version ? { executablePath: runtime.executablePath, version: runtime.version } : undefined;
  } catch {
    return undefined;
  }
}

export interface AntigravityBridgeEngine {
  instanceId?: string;
  config?: unknown;
  cwd?: string;
  nativeCli?: NativeCliRelease;
  customMcpServers?: readonly string[];
}

export interface AntigravityBridgeHost {
  home: string;
  /** The account's profile, the CLI's --gemini-dir; defaults to the one the driver prepares. */
  antigravityProfile?: string;
  /** The record of releases found unbridgeable; defaults to the one in the data folder. */
  unbridgeableFile?: string;
}

const FILE_MAX_BYTES = 1024 * 1024;
const AGENTS_FOLDER_ENTRIES: ReadonlySet<string> = new Set(["skills", "skills.json", ".skill-lock.json"]);
const LEGACY_FOLDERS = [".agent", "_agents", "_agent", ".antigravity"] as const;
const PROFILE_CONFIG_ENTRIES: ReadonlySet<string> = new Set([".migrated", "config.json", "mcp_config.json", "projects"]);

class Unclean extends Error {}

const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/** An entry's kind, or null when it does not exist. Never follows a link. */
function kindOf(path: string): "file" | "folder" | "other" | null {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? "file" : stat.isDirectory() ? "folder" : "other";
  } catch (error) {
    if (missing(error)) return null;
    throw new Unclean("a file the CLI reads cannot be read");
  }
}

/** A regular file's JSON, or undefined when absent; an empty file reads as null. Security: only a regular file of at
 * most 1 MB is opened, so a FIFO, socket or device never is. */
function jsonOf(path: string): unknown {
  const kind = kindOf(path);
  if (kind === null) return undefined;
  if (kind !== "file" || lstatSync(path).size > FILE_MAX_BYTES) throw new Unclean("a file the CLI reads is not a small regular file");
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Unclean("a file the CLI reads is not JSON");
  }
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function ancestors(folder: string): string[] {
  const chain = [folder];
  for (let parent = dirname(folder); parent !== chain[chain.length - 1]; parent = dirname(parent)) chain.push(parent);
  return chain;
}

function checkFolder(folder: string): void {
  const agents = join(folder, ".agents");
  const kind = kindOf(agents);
  if (kind !== null) {
    if (kind !== "folder") throw new Unclean("an .agents entry the CLI reads is not a folder");
    const extra = readdirSync(agents).find((name) => !AGENTS_FOLDER_ENTRIES.has(name));
    if (extra !== undefined) throw new Unclean("an .agents folder the CLI reads holds more than skills");
  }
  for (const legacy of LEGACY_FOLDERS) if (kindOf(join(folder, legacy)) !== null) throw new Unclean(`a folder the CLI reads has ${legacy}`);
  if (kindOf(join(folder, ".gemini", "config.json")) !== null) throw new Unclean("a folder the CLI reads has a workspace .gemini/config.json");
}

function checkProfile(profile: string): void {
  const settings = jsonOf(join(profile, "antigravity-acp", "settings.json"));
  if (settings !== undefined && (!record(settings) || Object.keys(settings).some((key) => key !== "auth"))) throw new Unclean("the profile's settings hold more than the sign-in");
  const builtins = join(profile, "antigravity-acp", "builtin", "plugins");
  const builtinNames = kindOf(builtins) === "folder" ? readdirSync(builtins) : [];
  for (const name of builtinNames) if (kindOf(join(builtins, name, "hooks.json")) !== null) throw new Unclean("a built-in plugin has hooks");
  const config = join(profile, "config");
  const kind = kindOf(config);
  if (kind === null) return;
  if (kind !== "folder") throw new Unclean("the profile's config is not a folder");
  for (const name of readdirSync(config)) {
    if (!PROFILE_CONFIG_ENTRIES.has(name)) throw new Unclean("the profile's config holds more than its own files");
  }
  const plugins = jsonOf(join(config, "config.json"));
  if (plugins !== undefined && plugins !== null) {
    if (!record(plugins) || Object.keys(plugins).some((key) => key !== "plugins")) throw new Unclean("the profile's config.json holds more than plugins");
    if (plugins.plugins !== undefined && (!record(plugins.plugins) || Object.keys(plugins.plugins).some((name) => !builtinNames.includes(name)))) {
      throw new Unclean("the profile turns on a plugin that is not built in");
    }
  }
  const servers = jsonOf(join(config, "mcp_config.json"));
  if (servers !== undefined && servers !== null) {
    if (!record(servers) || Object.keys(servers).some((key) => key !== "mcpServers")) throw new Unclean("the profile's mcp_config.json holds more than servers");
    if (servers.mcpServers !== undefined && (!record(servers.mcpServers) || Object.keys(servers.mcpServers).length > 0)) throw new Unclean("the profile defines MCP servers");
  }
  const projects = join(config, "projects");
  const projectsKind = kindOf(projects);
  if (projectsKind !== null && (projectsKind !== "folder" || readdirSync(projects).length > 0)) throw new Unclean("the profile has project settings");
}

/** Why this native Antigravity turn is not bridged, or null. */
export function antigravityRefusal(engine: AntigravityBridgeEngine, host: AntigravityBridgeHost): string | null {
  if (!isAntigravityNativeAlias(cliOf(engine.config))) return "the account does not name the native Antigravity CLI";
  if (!engine.nativeCli) return "the native Antigravity CLI is not installed";
  if (!bridgedRelease(engine.nativeCli.version)) return `native Antigravity CLI ${engine.nativeCli.version} is outside the releases the bridge is used with`;
  if (unbridgeableVersions(host.unbridgeableFile ?? unbridgeableFile()).includes(engine.nativeCli.version)) {
    return `native Antigravity CLI ${engine.nativeCli.version} asked for a bridged tool in a form this version does not know`;
  }
  if (engine.customMcpServers === undefined) return "the turn's MCP servers are not known";
  if (engine.customMcpServers.some((name) => /^agents(?:_|$)/iu.test(name))) return "another MCP server's name starts like the agents server's";
  const workspace = (engine.config as { workspace?: unknown } | undefined)?.workspace;
  const folder = engine.cwd ?? (typeof workspace === "string" && workspace ? workspace : host.home);
  try {
    const real = realpathSync(folder);
    for (const ancestor of new Set([...ancestors(folder), ...ancestors(real)])) checkFolder(ancestor);
    const profile = host.antigravityProfile ?? (engine.instanceId ? antigravityProfileDirectory(engine.instanceId) : undefined);
    if (!profile) return "the account's Antigravity profile is not known";
    checkProfile(profile);
  } catch (error) {
    if (error instanceof Unclean) return error.message;
    if ((error as NodeJS.ErrnoException).code) return "the launch folder cannot be resolved";
    throw error;
  }
  return null;
}
