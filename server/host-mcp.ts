import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import {
  createCapabilityProfileManifest,
  createObserverRouterProfileManifest,
  type CapabilityProfileManifest,
} from "./access-profile.ts";
import { augmentedPath } from "./env-path.ts";
import { writeFileAtomic } from "./atomic.ts";
import { BUILTIN_CAPABILITY_TOOLS } from "./builtin-capability-tools.ts";
import { FLEET_CAPABILITY_TOOL_DEFINITIONS } from "./fleet-capabilities.ts";

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
const FLEET_BRIDGE_NAME = "aos-fleet-bridge";
const FLEET_BRIDGE_SOURCE_DUPLICATE = /^aos-fleet-bridge-(?:codex|opencode|hermes)(?:-\d+)?$/;
const FLEET_BRIDGE_SCRIPT = /(?:^|[\\/])aos_fleet_bridge_mcp\.py$/;
const OPENMAUS_SURFACE = "openmausbot";
const BRIDGE_VALUE_FLAGS = new Set(["--surface", "--state-dir", "--ledger", "--ledger-timeout", "--inbox"]);

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

function pinnedFleetBridge(server: HostMcpServer | undefined): Extract<HostMcpServer, { type: "stdio" }> | null {
  if (!server || server.type !== "stdio") return null;
  const commandName = basename(server.command).toLowerCase();
  if (!/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/.test(commandName)) return null;
  if (server.args.length < 3 || !isAbsolute(server.args[0]) || !FLEET_BRIDGE_SCRIPT.test(server.args[0])) return null;
  if (server.args.filter((argument) => FLEET_BRIDGE_SCRIPT.test(argument)).length !== 1) return null;
  const args = [...server.args];
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!BRIDGE_VALUE_FLAGS.has(flag) || seen.has(flag) || typeof value !== "string" || !value.trim() || value.startsWith("-")) return null;
    seen.add(flag);
  }
  if (!seen.has("--surface")) return null;
  const surfaceIndex = args.indexOf("--surface");
  args[surfaceIndex + 1] = OPENMAUS_SURFACE;
  // The observer bridge needs no credential or provider environment. Strip it
  // rather than importing arbitrary values from a host IDE configuration.
  return { type: "stdio", command: server.command, args, env: {} };
}

/** Select one exact bridge identity. Ambiguous source scripts fail closed;
 * equivalent Claude/Codex registrations collapse to the smallest safe argv. */
function selectFleetBridgeForOpenMaus(
  claude: Record<string, HostMcpServer>,
  codex: Record<string, HostMcpServer>,
): Extract<HostMcpServer, { type: "stdio" }> | null {
  const candidates = [pinnedFleetBridge(claude[FLEET_BRIDGE_NAME]), pinnedFleetBridge(codex[FLEET_BRIDGE_NAME])]
    .filter((server): server is Extract<HostMcpServer, { type: "stdio" }> => Boolean(server));
  if (!candidates.length) return null;
  if (new Set(candidates.map((server) => server.args[0])).size !== 1) return null;
  return candidates.sort((left, right) => left.args.length - right.args.length || left.command.localeCompare(right.command))[0];
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

/** Full-task turns keep the broad host catalog, but the fleet bridge itself
 * is still identity-pinned and value-free. The observer lease receives a
 * separate catalog below and can never reach these additional servers. */
function fullTaskServers(
  claude: Record<string, HostMcpServer>,
  codex: Record<string, HostMcpServer>,
  opencode: Record<string, HostMcpServer>,
  hermes: Record<string, HostMcpServer>,
): Record<string, HostMcpServer> {
  const merged = mergeCatalog(
    mergeCatalog(mergeCatalog(claude, codex, "codex"), opencode, "opencode"),
    hermes,
    "hermes",
  );
  for (const name of Object.keys(merged)) {
    if (FLEET_BRIDGE_SOURCE_DUPLICATE.test(name)) delete merged[name];
  }
  const bridge = pinnedFleetBridge(merged[FLEET_BRIDGE_NAME]);
  if (bridge) merged[FLEET_BRIDGE_NAME] = bridge;
  else delete merged[FLEET_BRIDGE_NAME];
  return {
    ...merged,
    "openmaus-host": { type: "builtin" },
    "openmaus-fleet": { type: "builtin", family: "fleet" },
  };
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

export interface HostMcpCatalogOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  runCodexList?: () => string;
  readOpenCodeConfig?: () => string;
  runHermesList?: () => string;
}

/** Load the host sources once, then derive two non-overlapping authority
 * views: a full-task catalog for admitted in-app bot turns and a single
 * bounded observer bridge for authenticated external leases. */
export function loadHostMcpCatalogs(options: HostMcpCatalogOptions = {}): {
  fullTask: HostMcpCatalog;
  observer: HostMcpCatalog;
} {
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
  const bridge = selectFleetBridgeForOpenMaus(claude, codex);
  const observerServers: Record<string, HostMcpServer> = bridge ? { [FLEET_BRIDGE_NAME]: bridge } : {};
  const fullServers = fullTaskServers(claude, codex, opencode, hermes);
  const fullInventory = Object.entries(fullServers).flatMap(([name, server]) =>
    server.type === "builtin"
      ? server.family === "fleet"
        ? FLEET_CAPABILITY_TOOL_DEFINITIONS.map((tool) => `${name}:${tool.name}`)
        : BUILTIN_CAPABILITY_TOOLS.map((tool) => `${name}:${tool.name}`)
      : [name],
  );
  const sources = {
    claude: claudeState,
    codex: codexState,
    opencode: opencodeState,
    hermes: hermesState,
  };
  return {
    fullTask: {
      servers: fullServers,
      manifest: createCapabilityProfileManifest({ toolInventory: fullInventory }),
      sources,
    },
    observer: {
      servers: observerServers,
      // Tool schemas are intentionally not projected here. The gateway exposes
      // its fixed observer projection only when the agent requests tools/list.
      manifest: createObserverRouterProfileManifest({ serverInventory: Object.keys(observerServers) }),
      sources,
    },
  };
}

/** Compatibility name retained for observer-only callers and tests. */
export function loadHostMcpCatalog(options: HostMcpCatalogOptions = {}): HostMcpCatalog {
  return loadHostMcpCatalogs(options).observer;
}

export function writeHostMcpManifest(dataDir: string, catalog: HostMcpCatalog): string {
  const directory = join(dataDir, "capability-profiles");
  const path = join(directory, `${catalog.manifest.profile}.json`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileAtomic(
    path,
    JSON.stringify({ ...catalog.manifest, sources: catalog.sources }, null, 2),
    { mode: 0o600 },
  );
  return path;
}
