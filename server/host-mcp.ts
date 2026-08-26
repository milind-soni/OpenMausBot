import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createCapabilityProfileManifest,
  type CapabilityProfileManifest,
  type TelemetryCaptureMode,
} from "./access-profile.ts";
import { augmentedPath } from "./env-path.ts";
import { writeFileAtomic } from "./atomic.ts";
import { BUILTIN_CAPABILITY_TOOLS, FLEET_BUILTIN_TOOLS } from "./builtin-capability-tools.ts";

export type HostMcpServer =
  | { type: "builtin"; family?: "host" | "fleet" }
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { type: "http"; url: string; headers: Record<string, string> };

type CatalogSourceState = "loaded" | "missing" | "invalid";

export interface HostMcpCatalog {
  servers: Record<string, HostMcpServer>;
  manifest: CapabilityProfileManifest;
  sources: {
    claude: CatalogSourceState;
    codex: CatalogSourceState;
    opencode?: CatalogSourceState;
    hermes?: CatalogSourceState;
  };
}

const BLOCKED_SERVER = /(?:^|[-_.])cred(?:ential)?vault(?:$|[-_.])|credvault/i;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;
function safeName(value: unknown): string | null {
  return typeof value === "string" && NAME.test(value) && !BLOCKED_SERVER.test(value) ? value : null;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function namedEnvironment(value: unknown, source: NodeJS.ProcessEnv): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [name, configured] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
    // A literal in a host config is allowed to reach only the MCP child. It
    // never enters the value-free profile manifest or the agent environment.
    if (typeof configured === "string") out[name] = configured;
    else if (typeof source[name] === "string") out[name] = source[name]!;
  }
  return out;
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function codexHttpHeaders(transport: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, string> {
  const headers = stringMap(transport.http_headers);
  for (const [header, variable] of Object.entries(stringMap(transport.env_http_headers))) {
    if (typeof env[variable] === "string") headers[header] = env[variable]!;
  }
  if (typeof transport.bearer_token_env_var === "string" && typeof env[transport.bearer_token_env_var] === "string") {
    headers.Authorization = `Bearer ${env[transport.bearer_token_env_var]}`;
  }
  return headers;
}

export function parseClaudeMcpServers(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, HostMcpServer> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const root = raw as Record<string, unknown>;
  const configured = root.mcpServers;
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) return {};
  const servers: Record<string, HostMcpServer> = {};
  for (const [rawName, value] of Object.entries(configured as Record<string, unknown>)) {
    const name = safeName(rawName);
    if (!name || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if ((row.type === "http" || row.type === "sse") && typeof row.url === "string" && /^https?:\/\//.test(row.url)) {
      servers[name] = { type: "http", url: row.url, headers: stringMap(row.headers) };
      continue;
    }
    const args = stringList(row.args ?? []);
    if (typeof row.command !== "string" || !row.command || !args || BLOCKED_SERVER.test(row.command)) continue;
    servers[name] = {
      type: "stdio",
      command: row.command,
      args,
      env: namedEnvironment(row.env, env),
      ...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}),
    };
  }
  return servers;
}

export function parseCodexMcpList(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, HostMcpServer> {
  if (!Array.isArray(raw)) return {};
  const servers: Record<string, HostMcpServer> = {};
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const name = safeName(row.name);
    if (!name || row.enabled === false || !row.transport || typeof row.transport !== "object") continue;
    const transport = row.transport as Record<string, unknown>;
    if (
      (transport.type === "streamable_http" || transport.type === "http" || transport.type === "sse") &&
      typeof transport.url === "string" &&
      /^https?:\/\//.test(transport.url)
    ) {
      servers[name] = { type: "http", url: transport.url, headers: codexHttpHeaders(transport, env) };
      continue;
    }
    const args = stringList(transport.args ?? []);
    if (transport.type !== "stdio" || typeof transport.command !== "string" || !args) continue;
    if (BLOCKED_SERVER.test(transport.command)) continue;
    const envNames = stringList(transport.env_vars ?? []) ?? [];
    const childEnv = namedEnvironment(transport.env, env);
    for (const key of envNames) if (typeof env[key] === "string") childEnv[key] = env[key]!;
    servers[name] = {
      type: "stdio",
      command: transport.command,
      args,
      env: childEnv,
      ...(typeof transport.cwd === "string" ? { cwd: transport.cwd } : {}),
    };
  }
  return servers;
}

/** OpenCode's JSON uses a command vector for local MCPs and a URL for remote
 * MCPs. Values remain inside the gateway; the persisted profile keeps names
 * only, exactly like the Claude and Codex loaders. */
export function parseOpenCodeMcpServers(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, HostMcpServer> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const configured = (raw as Record<string, unknown>).mcp;
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) return {};
  const servers: Record<string, HostMcpServer> = {};
  for (const [rawName, value] of Object.entries(configured as Record<string, unknown>)) {
    const name = safeName(rawName);
    if (!name || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (row.enabled === false) continue;
    if ((row.type === "remote" || row.type === "http" || row.type === "sse") && typeof row.url === "string" && /^https?:\/\//.test(row.url)) {
      servers[name] = { type: "http", url: row.url, headers: stringMap(row.headers) };
      continue;
    }
    const vector = stringList(row.command);
    if (!vector?.length || BLOCKED_SERVER.test(vector[0]!)) continue;
    servers[name] = {
      type: "stdio",
      command: vector[0]!,
      args: vector.slice(1),
      env: namedEnvironment(row.environment ?? row.env, env),
      ...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}),
    };
  }
  return servers;
}

/** Hermes YAML is projected to JSON by a bounded host-side reader before it
 * reaches this parser. Only enabled, lazy-compatible server definitions are
 * accepted; tool filters and descriptions remain owned by Hermes. */
export function parseHermesMcpServers(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, HostMcpServer> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const servers: Record<string, HostMcpServer> = {};
  for (const [rawName, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = safeName(rawName);
    if (!name || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (row.enabled === false) continue;
    if (typeof row.url === "string" && /^https?:\/\//.test(row.url)) {
      servers[name] = { type: "http", url: row.url, headers: stringMap(row.headers) };
      continue;
    }
    const args = stringList(row.args ?? []);
    if (
      typeof row.command !== "string" ||
      !row.command ||
      /\s/.test(row.command) ||
      !args ||
      BLOCKED_SERVER.test(row.command)
    ) continue;
    servers[name] = {
      type: "stdio",
      command: row.command,
      args,
      env: namedEnvironment(row.environment ?? row.env, env),
      ...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}),
    };
  }
  return servers;
}

function mergeCatalog(
  base: Record<string, HostMcpServer>,
  incoming: Record<string, HostMcpServer>,
  source: string,
): Record<string, HostMcpServer> {
  const merged = { ...base };
  for (const [name, server] of Object.entries(incoming)) {
    if (!merged[name]) {
      merged[name] = server;
      continue;
    }
    if (JSON.stringify(merged[name]) === JSON.stringify(server)) continue;
    let candidate = `${name}-${source}`;
    let suffix = 2;
    while (merged[candidate]) candidate = `${name}-${source}-${suffix++}`;
    merged[candidate] = server;
  }
  return merged;
}

function readHermesMcpJson(userHome: string): string {
  const activeProfile = readFileSync(join(userHome, ".hermes", "active_profile"), "utf8").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(activeProfile)) throw new Error("invalid Hermes profile name");
  const config = join(userHome, ".hermes", "profiles", activeProfile, "config.yaml");
  const projection = [
    "import json,sys,yaml",
    "value=yaml.safe_load(open(sys.argv[1], encoding='utf-8')) or {}",
    "print(json.dumps(value.get('mcp_servers', {}), separators=(',', ':')))",
  ].join(";");
  return execFileSync("python3", ["-c", projection, config], {
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: augmentedPath() },
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function loadHostMcpCatalog(options: {
  telemetryMode: TelemetryCaptureMode;
  home?: string;
  env?: NodeJS.ProcessEnv;
  runCodexList?: () => string;
  readOpenCodeConfig?: () => string;
  runHermesList?: () => string;
}): HostMcpCatalog {
  const userHome = options.home ?? homedir();
  const env = options.env ?? process.env;
  let claude: Record<string, HostMcpServer> = {};
  let codex: Record<string, HostMcpServer> = {};
  let opencode: Record<string, HostMcpServer> = {};
  let hermes: Record<string, HostMcpServer> = {};
  let claudeState: HostMcpCatalog["sources"]["claude"] = "missing";
  let codexState: HostMcpCatalog["sources"]["codex"] = "missing";
  let opencodeState: CatalogSourceState = "missing";
  let hermesState: CatalogSourceState = "missing";
  try {
    claude = parseClaudeMcpServers(JSON.parse(readFileSync(join(userHome, ".claude.json"), "utf8")), env);
    claudeState = "loaded";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") claudeState = "invalid";
  }
  try {
    const output = options.runCodexList
      ? options.runCodexList()
      : execFileSync("codex", ["mcp", "list", "--json"], {
          encoding: "utf8",
          timeout: 10_000,
          env: { ...env, PATH: augmentedPath() },
          stdio: ["ignore", "pipe", "ignore"],
        });
    codex = parseCodexMcpList(JSON.parse(output), env);
    codexState = "loaded";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") codexState = "invalid";
  }
  try {
    const output = options.readOpenCodeConfig
      ? options.readOpenCodeConfig()
      : readFileSync(join(userHome, ".config", "opencode", "opencode.json"), "utf8");
    opencode = parseOpenCodeMcpServers(JSON.parse(output), env);
    opencodeState = "loaded";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") opencodeState = "invalid";
  }
  try {
    const output = options.runHermesList ? options.runHermesList() : readHermesMcpJson(userHome);
    hermes = parseHermesMcpServers(JSON.parse(output), env);
    hermesState = "loaded";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") hermesState = "invalid";
  }
  const merged = mergeCatalog(
    mergeCatalog(mergeCatalog(claude, codex, "codex"), opencode, "opencode"),
    hermes,
    "hermes",
  );
  const servers: Record<string, HostMcpServer> = {
    ...merged,
    // Provider-native shell/file tools are not available to Manus Desktop
    // or the Hermes route. Keep one app-owned core surface in the same
    // gateway so every full-task-scoped client receives the same baseline.
    "openmaus-host": { type: "builtin" },
    // The full fleet catalog is intentionally not copied into every prompt.
    // These four discovery tools read metadata only when a task asks for it.
    "openmaus-fleet": { type: "builtin", family: "fleet" },
  };
  const inventory = Object.entries(servers).flatMap(([name, server]) =>
    server.type === "builtin"
      ? server.family === "fleet"
        ? FLEET_BUILTIN_TOOLS.map((tool) => `${name}:${tool.name}`)
        : BUILTIN_CAPABILITY_TOOLS.map((tool) => `${name}:${tool.name}`)
      : [name],
  );
  return {
    servers,
    manifest: createCapabilityProfileManifest({
      toolInventory: inventory,
      telemetryMode: options.telemetryMode,
    }),
    sources: {
      claude: claudeState,
      codex: codexState,
      opencode: opencodeState,
      hermes: hermesState,
    },
  };
}

export function writeHostMcpManifest(dataDir: string, catalog: HostMcpCatalog): string {
  const directory = join(dataDir, "capability-profiles");
  const path = join(directory, "full-task-scoped.json");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileAtomic(
    path,
    JSON.stringify({ ...catalog.manifest, sources: catalog.sources }, null, 2),
    { mode: 0o600 },
  );
  return path;
}
