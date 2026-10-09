import { z } from "zod";

import type { McpServerSpec, RemoteMcpSpec, StdioMcpSpec } from "./contracts.ts";

/** One server as kept in config.json `mcpServers`. The shape is the block
 * Claude Code, Cursor and Claude Desktop write, so a pasted entry is a
 * stored entry: a command this machine runs, or a URL to connect to. */
export interface StoredStdioMcpServer extends StdioMcpSpec {
  enabled: boolean;
}
/** An app registered in advance with the server's authorization server,
 * for servers that do not let apps register themselves. The secret is a
 * credential like a header value: kept in config.json, never listed. */
export interface McpOAuthClientConfig {
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
}
export interface StoredRemoteMcpServer extends RemoteMcpSpec {
  enabled: boolean;
  oauth?: McpOAuthClientConfig;
}
export type StoredMcpServer = StoredStdioMcpServer | StoredRemoteMcpServer;

/** What the renderer sees: names of secrets, never their values. */
export interface StdioMcpServerListing {
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  enabled: boolean;
}
export interface RemoteMcpServerListing {
  name: string;
  type: "http" | "sse";
  url: string;
  headerKeys: string[];
  enabled: boolean;
  /** present when a pre-registered sign-in app is set */
  oauth?: { clientId: string; scopes: string[]; clientSecretConfigured: boolean };
}
export type McpServerListing = StdioMcpServerListing | RemoteMcpServerListing;

/** The two kinds tell apart by shape, as they do on disk and in every
 * client's config: a remote server has a `url`, a local one a `command`. */
export function isRemoteMcpServer(server: McpServerSpec): server is RemoteMcpSpec {
  return "url" in server;
}

export const MAX_MCP_SERVERS = 20;
const MAX_ARGS = 64;
const MAX_ENV = 64;
const MAX_HEADERS = 32;
const MCP_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An HTTP header field name: RFC 9110 token characters. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

/** Names used to route OpenMausBot's built-in MCP proxies and their ephemeral
 * capabilities. Codex exposes MCP env names through one app-server process;
 * a custom server must never request one of these names or it could redirect
 * a built-in proxy or receive that proxy's bearer. */
export function isHarnessOwnedMcpEnvName(name: string): boolean {
  return name === "ELECTRON_RUN_AS_NODE" || name.startsWith("OMB_") || name.startsWith("OGB_");
}

function environmentNameError(name: string): string | null {
  if (!ENV_NAME.test(name)) return `Environment variable “${name}” is not valid.`;
  if (isHarnessOwnedMcpEnvName(name)) {
    return `Environment variable “${name}” is reserved by OpenMausBot.`;
  }
  return null;
}

function headerError(name: string, value: string): string | null {
  if (!HEADER_NAME.test(name)) return `Header “${name}” is not a valid header name.`;
  if (/[\r\n]/.test(value)) return `Header “${name}” must be a single line.`;
  return null;
}

/** A remote server's address: a full http(s) URL. Credentials belong in a
 * header, where the app keeps them write-only, not in the address the
 * listing shows. */
function urlError(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "Use a full address, like https://example.com/mcp.";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "The address must start with http:// or https://.";
  if (parsed.username || parsed.password) return "Put credentials in a header, not in the address.";
  return null;
}

const RESERVED_MCP_NAMES = new Set([
  "ogb",
  "computer",
  "agents",
  "composio",
  "data",
  "browser",
  "phone",
  "dweb",
  "openmausbot_connectors",
  "openmausbot_phone",
]);

const stdioEntrySchema = z.object({
  command: z.string().trim().min(1).max(1_024),
  args: z.array(z.string().max(4_096)).max(MAX_ARGS).optional(),
  env: z.record(z.string(), z.string().max(16_384)).optional(),
  enabled: z.boolean().optional(),
}).strict();

const stdioMutationSchema = stdioEntrySchema.extend({
  env: z.record(z.string(), z.union([z.string().max(16_384), z.literal(true)])).optional(),
});

/** RFC 6749 §A: a client id is visible ASCII; a scope is one token without
 * spaces, quotes or backslashes. */
const CLIENT_ID = /^[\x20-\x7e]+$/;
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const CLIENT_SECRET_MAX = 4_096;

const oauthClientSchema = z.object({
  clientId: z.string().trim().min(1, "Enter the client ID of the app registered with this server's sign-in provider.").max(512)
    .regex(CLIENT_ID, "A client ID is printable text on one line."),
  clientSecret: z.string().min(1).max(CLIENT_SECRET_MAX).regex(CLIENT_ID, "A client secret is printable text on one line.").optional(),
  scopes: z.array(z.string().max(256).regex(SCOPE, "Scopes are single words, like offline_access or api://my-app/mcp.read.")).max(32).optional(),
}).strict();

const remoteEntrySchema = z.object({
  /** Streamable HTTP unless the entry says the older SSE transport. */
  type: z.enum(["http", "sse"]).optional(),
  url: z.string().trim().min(1).max(2_048),
  headers: z.record(z.string(), z.string().max(16_384)).optional(),
  oauth: oauthClientSchema.optional(),
  enabled: z.boolean().optional(),
}).strict();

const remoteMutationSchema = remoteEntrySchema.extend({
  headers: z.record(z.string(), z.union([z.string().max(16_384), z.literal(true)])).optional(),
  oauth: oauthClientSchema.extend({
    clientSecret: z.union([z.string().min(1).max(CLIENT_SECRET_MAX).regex(CLIENT_ID, "A client secret is printable text on one line."), z.literal(true)]).optional(),
  }).optional(),
});

/** The sign-in app for a mutation: a `true` secret keeps the saved one, but
 * only for the same client ID — a secret never moves to another app. */
function resolveOAuthClient(
  incoming: z.infer<typeof remoteMutationSchema>["oauth"],
  saved: McpOAuthClientConfig | undefined,
): { ok: true; value: McpOAuthClientConfig | undefined } | { ok: false; error: string } {
  if (!incoming) return { ok: true, value: undefined };
  let clientSecret: string | undefined;
  if (incoming.clientSecret === true) {
    if (!saved?.clientSecret || saved.clientId !== incoming.clientId) {
      return { ok: false, error: "No client secret is saved for this client ID. Enter it again, or leave it out for an app without one." };
    }
    clientSecret = saved.clientSecret;
  } else {
    clientSecret = incoming.clientSecret;
  }
  const scopes = [...new Set(incoming.scopes ?? [])];
  return {
    ok: true,
    value: { clientId: incoming.clientId, ...(clientSecret ? { clientSecret } : {}), ...(scopes.length ? { scopes } : {}) },
  };
}

/** Which shape an entry means to be. `url` decides, as it does for every
 * client that reads these blocks; a `type` of http/sse without a url is
 * still a remote entry, so its error talks about the address. */
function looksRemote(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  return "url" in record || record.type === "http" || record.type === "sse";
}

export function mcpServerNameError(name: string): string | null {
  if (!MCP_NAME.test(name)) {
    return "Use 1–32 lowercase letters, numbers, underscores, or hyphens, starting with a letter.";
  }
  if (RESERVED_MCP_NAMES.has(name)) return "That name is reserved by OpenMausBot.";
  return null;
}

type Parsed = { ok: true; server: StoredMcpServer } | { ok: false; error: string };

/** Resolve a `true` placeholder ("keep the saved value") against what is
 * stored, or refuse it: a placeholder for a value that was never saved
 * would silently store the literal `true`. */
function resolveSecrets(
  incoming: Record<string, string | true>,
  saved: Record<string, string> | undefined,
): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === true) {
      const kept = saved?.[key];
      if (kept === undefined) return { ok: false, error: `No saved value exists for ${key}.` };
      values[key] = kept;
    } else {
      values[key] = value;
    }
  }
  return { ok: true, values };
}

function parseStdio(raw: unknown, mutation: boolean, existing?: StoredMcpServer): Parsed {
  const parsed = (mutation ? stdioMutationSchema : stdioEntrySchema).safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid MCP server." };
  }
  const incoming = parsed.data.env ?? {};
  const invalidEnv = Object.keys(incoming).map(environmentNameError).find((error) => error !== null);
  if (invalidEnv) return { ok: false, error: invalidEnv };
  if (Object.keys(incoming).length > MAX_ENV) {
    return { ok: false, error: `Use at most ${MAX_ENV} environment variables.` };
  }
  const env = resolveSecrets(incoming, existing && !isRemoteMcpServer(existing) ? existing.env : undefined);
  if (!env.ok) return env;
  return {
    ok: true,
    server: {
      command: parsed.data.command,
      args: parsed.data.args ?? [],
      env: env.values,
      enabled: enabledFor(parsed.data.enabled, mutation, existing),
    },
  };
}

function parseRemote(raw: unknown, mutation: boolean, existing?: StoredMcpServer): Parsed {
  const parsed = (mutation ? remoteMutationSchema : remoteEntrySchema).safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid MCP server." };
  }
  const badUrl = urlError(parsed.data.url);
  if (badUrl) return { ok: false, error: badUrl };
  const incoming = parsed.data.headers ?? {};
  if (Object.keys(incoming).length > MAX_HEADERS) {
    return { ok: false, error: `Use at most ${MAX_HEADERS} headers.` };
  }
  const headers = resolveSecrets(incoming, existing && isRemoteMcpServer(existing) ? existing.headers : undefined);
  if (!headers.ok) return headers;
  const invalidHeader = Object.entries(headers.values).map(([name, value]) => headerError(name, value)).find((error) => error !== null);
  if (invalidHeader) return { ok: false, error: invalidHeader };
  const oauth = resolveOAuthClient(parsed.data.oauth, existing && isRemoteMcpServer(existing) ? existing.oauth : undefined);
  if (!oauth.ok) return oauth;
  return {
    ok: true,
    server: {
      type: parsed.data.type ?? "http",
      url: parsed.data.url,
      headers: headers.values,
      ...(oauth.value ? { oauth: oauth.value } : {}),
      enabled: enabledFor(parsed.data.enabled, mutation, existing),
    },
  };
}

/** File-authored entries are on unless they say otherwise. A newly added
 * server from the app is inert until explicitly enabled; an edit keeps the
 * current switch unless the mutation moves it. */
function enabledFor(value: boolean | undefined, mutation: boolean, existing?: StoredMcpServer): boolean {
  if (!mutation) return value !== false;
  return existing ? (value ?? existing.enabled) : false;
}

export function parseStoredMcpServer(name: string, raw: unknown): Parsed {
  const nameError = mcpServerNameError(name);
  if (nameError) return { ok: false, error: nameError };
  return looksRemote(raw) ? parseRemote(raw, false) : parseStdio(raw, false);
}

/** Parse a renderer mutation. `true` is a write-only placeholder meaning
 * “keep this already stored value”; it is never accepted for a new key. */
export function parseMcpServerMutation(
  name: string,
  raw: unknown,
  existing?: StoredMcpServer,
): Parsed {
  const nameError = mcpServerNameError(name);
  if (nameError) return { ok: false, error: nameError };
  return looksRemote(raw) ? parseRemote(raw, true, existing) : parseStdio(raw, true, existing);
}

/** The fields POST /api/mcp/servers keeps (`mcpServerBody` in server/index.ts),
 * minus `enabled`. A bot is not allowed to send that switch at all. */
const BOT_MCP_SERVER_KEYS = ["command", "args", "env", "type", "url", "headers", "oauth"] as const;

function pickMcpServerFields(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of BOT_MCP_SERVER_KEYS) if (record[key] !== undefined) out[key] = record[key];
  return out;
}

export type DisabledMcpServerAdd =
  | { ok: true; name: string; server: StoredMcpServer; next: Record<string, unknown> }
  | { ok: false; status: number; error: string };

const BOT_CANNOT_SWITCH = "A bot cannot change the on/off switch. The server is saved off, and only the user can turn it on in MCP server settings.";

/** File one new MCP server as a disabled row. Does not probe, does not
 * launch, and does not touch a server that is already stored. The caller
 * still applies organisation policy before writing the returned map. */
export function addDisabledMcpServer(current: Record<string, unknown>, body: unknown): DisabledMcpServerAdd {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Expected an MCP server object with a name." };
  }
  const record = body as Record<string, unknown>;
  if (Object.hasOwn(record, "enabled")) return { ok: false, status: 400, error: BOT_CANNOT_SWITCH };
  const name = typeof record.name === "string" ? record.name : "";
  if (name && Object.hasOwn(current, name)) {
    return { ok: false, status: 409, error: "An MCP server with that name already exists." };
  }
  if (Object.keys(current).length >= MAX_MCP_SERVERS) {
    return { ok: false, status: 400, error: `You can add at most ${MAX_MCP_SERVERS} MCP servers.` };
  }
  const parsed = parseMcpServerMutation(name, pickMcpServerFields(record));
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  if (parsed.server.enabled !== false) return { ok: false, status: 400, error: BOT_CANNOT_SWITCH };
  return { ok: true, name, server: parsed.server, next: { ...current, [name]: parsed.server } };
}

export function listMcpServers(raw: Record<string, unknown> | undefined): McpServerListing[] {
  return Object.entries(raw ?? {}).flatMap(([name, value]): McpServerListing[] => {
    const parsed = parseStoredMcpServer(name, value);
    if (!parsed.ok) return [];
    const { server } = parsed;
    if (isRemoteMcpServer(server)) {
      return [{
        name,
        type: server.type,
        url: server.url,
        headerKeys: Object.keys(server.headers).sort(),
        enabled: server.enabled,
        ...(server.oauth ? {
          oauth: { clientId: server.oauth.clientId, scopes: server.oauth.scopes ?? [], clientSecretConfigured: Boolean(server.oauth.clientSecret) },
        } : {}),
      }];
    }
    return [{
      name,
      command: server.command,
      args: server.args,
      envKeys: Object.keys(server.env).sort(),
      enabled: server.enabled,
    }];
  });
}

/** Only the keys a stored entry may carry, and only when the pasted block
 * set them: a strict schema must not see `command: undefined` on a remote
 * entry or `url: undefined` on a local one. */
function pickEntry(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (record[key] !== undefined) out[key] = record[key];
  return out;
}

/**
 * Turn a pasted config block into servers this registry can store. Accepts
 * the {"mcpServers": {...}} shape Claude Code, Cursor and Claude Desktop
 * write, a bare {name: entry} map, or a single {name, command|url, ...} entry.
 * Names are slugged into the registry's format; every entry goes through the
 * same rules as the form and lands disabled until explicitly enabled.
 */
export function parseMcpServersImport(
  text: string,
): { ok: true; servers: Record<string, StoredMcpServer> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "That is not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: 'Expected an object like {"mcpServers": {"name": {"command": "npx", "args": [...]}}}.' };
  }
  const root = parsed as Record<string, unknown>;
  let entries: Record<string, unknown>;
  if (root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)) {
    entries = root.mcpServers as Record<string, unknown>;
  } else if (typeof root.command === "string" || typeof root.url === "string") {
    const name = typeof root.name === "string" ? root.name : "";
    if (!name) return { ok: false, error: 'A single server needs a "name".' };
    const { name: _omit, ...rest } = root;
    entries = { [name]: rest };
  } else {
    entries = root;
  }
  const names = Object.keys(entries);
  if (names.length === 0) return { ok: false, error: "No servers found in that JSON." };
  if (names.length > MAX_MCP_SERVERS) {
    return { ok: false, error: `Import at most ${MAX_MCP_SERVERS} servers at once.` };
  }
  const servers: Record<string, StoredMcpServer> = {};
  for (const rawName of names) {
    const entry = entries[rawName];
    const name = slugMcpName(rawName);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `"${rawName}" is not a server entry.` };
    }
    const record = entry as Record<string, unknown>;
    if (Object.hasOwn(servers, name)) return { ok: false, error: `"${rawName}" appears twice.` };
    // The command is an executable path, not a shell line; spaces are valid
    // in paths on every supported platform. The probe reports missing files.
    // A remote entry keeps its transport and headers; `enabled` from the
    // paste is deliberately dropped so nothing runs before it was tested.
    const result = parseMcpServerMutation(name, looksRemote(record)
      ? pickEntry(record, ["type", "url", "headers"])
      : pickEntry(record, ["command", "args", "env"]));
    if (!result.ok) return { ok: false, error: `"${rawName}": ${result.error}` };
    servers[name] = result.server;
  }
  return { ok: true, servers };
}

function slugMcpName(raw: string): string {
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return /^[a-z]/.test(slug) ? slug : slug ? `mcp-${slug}`.slice(0, 32) : "";
}
