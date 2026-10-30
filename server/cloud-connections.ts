// This computer's connections, as they move once to the person's own Cloud: MCP servers with their secrets and
// sign-ins, the AI keys bots run on, the connected-apps account and HighLevel. GET /api/cloud-connections names each,
// never a secret; the secrets reach the desktop's main process only over its private port (login-handoff.ts), which
// sends them only to the person's own Cloud. A sign-in that refreshes itself (an MCP server's own account, HighLevel's)
// moves: once My Cloud has it, this computer forgets its copy, so the two never spend one refresh token.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import { canonicalJson } from "../shared/package-format.ts";
import { fingerprint } from "./cloud-send-verify.ts";
import type { ComposioIdentity } from "./composio-share.ts";
import type { AppConfig } from "./config.ts";
import type { HighLevelConnection } from "./highlevel/store.ts";
import type { McpOAuthRecord } from "./mcp-oauth-store.ts";
import type { McpAuthState } from "./mcp-oauth.ts";
import { isRemoteMcpServer, parseStoredMcpServer, type StoredMcpServer } from "./mcp-registry.ts";

export type ConnectionKind = "mcp" | "key" | "composio" | "highlevel";

/** One connection, by name only. */
export interface ConnectionListing {
  /** "mcp:<name>", "key:<provider>", "composio" or "highlevel". */
  id: string;
  kind: ConnectionKind;
  label: string;
  /** An MCP server: the host it reaches, or the program it starts. */
  detail?: string;
  /** An MCP server whose program, files or address are this computer's: it moves marked as running here. */
  runsHere?: true;
  /** A command-line MCP server: the program it starts, which My Cloud needs too. */
  launcher?: string;
  /** A key: the engines (instance ids) it runs. */
  for?: string[];
  /** A sign-in that refreshes itself (an MCP server's own account, HighLevel's): it moves, and this computer then
   * forgets it. */
  signIn?: true;
  /** Connected apps: OpenMausBot's service or the person's own Composio project, the account in a digest equal on two
   * servers exactly when they reach the same apps, and the service's installation a code is minted for. */
  mode?: ComposioIdentity["mode"];
  account?: string;
  installationId?: string;
}

/** What the person's own Cloud has a key for, when the key is theirs; keys for what a Cloud includes (voice, Boat, X
 * research, the decider) are not listed, since the person's own key would replace what it includes. An Anthropic key
 * goes for "Claude (API key)" alone: there it never takes over Claude bots that sign in with a Claude account. */
interface Provider { id: string; label: string; for: string[]; config(cfg: AppConfig): Partial<AppConfig> | null }

const keyed = (name: "openai" | "openrouter" | "mistral" | "cerebras") => (cfg: AppConfig): Partial<AppConfig> | null => {
  const key = cfg[name]?.key;
  return key ? { [name]: { key } } : null;
};
const keyedUrl = (name: "xai" | "groq" | "meta") => (cfg: AppConfig): Partial<AppConfig> | null => {
  const entry = cfg[name];
  return entry?.key ? { [name]: { key: entry.key, ...(entry.url ? { url: entry.url } : {}) } } : null;
};

export const KEY_PROVIDERS: readonly Provider[] = [
  { id: "openai", label: "OpenAI", for: ["openai"], config: keyed("openai") },
  { id: "openrouter", label: "OpenRouter", for: ["openrouter"], config: keyed("openrouter") },
  { id: "anthropic", label: "Anthropic", for: ["claudeApi"], config: (cfg) => cfg.anthropic?.key
    ? { anthropic: { key: cfg.anthropic.key, ...(cfg.anthropic.url ? { url: cfg.anthropic.url } : {}), everyClaudeBot: false } } : null },
  { id: "xai", label: "xAI", for: ["xaiApi"], config: keyedUrl("xai") },
  { id: "mistral", label: "Mistral", for: ["mistral"], config: keyed("mistral") },
  { id: "cerebras", label: "Cerebras", for: ["cerebras"], config: keyed("cerebras") },
  { id: "groq", label: "Groq", for: ["groq"], config: keyedUrl("groq") },
  { id: "meta", label: "Meta", for: ["meta"], config: keyedUrl("meta") },
  { id: "openaiCompat", label: "OpenAI-compatible", for: ["openaiCompat"], config: (cfg) => cfg.openaiCompat?.key
    ? { openaiCompat: Object.fromEntries(Object.entries(cfg.openaiCompat).filter(([, value]) => typeof value === "string" && value)) } : null },
  { id: "opencodeGo", label: "OpenCode", for: ["opencodeGo"], config: (cfg) => cfg.opencodeGo?.apiKey || Object.keys(cfg.opencodeGo?.providerKeys ?? {}).length
    ? { opencodeGo: { ...(cfg.opencodeGo!.apiKey ? { apiKey: cfg.opencodeGo!.apiKey } : {}), ...(cfg.opencodeGo!.providerKeys ? { providerKeys: cfg.opencodeGo!.providerKeys } : {}) } } : null },
];

const LOCAL_NAME = /(?:^|\.)(?:localhost|local|lan|home|internal|ts\.net)$/iu;

function privateAddress(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = host.toLowerCase();
  return v6 === "::1" || v6 === "::" || /^f[cd][0-9a-f]{2}:/u.test(v6) || /^fe[89ab][0-9a-f]:/u.test(v6);
}

/** An address only this computer or its own network reaches: My Cloud would call nothing there. */
export function addressHere(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.replace(/^\[|\]$/gu, ""); } catch { return true; }
  return (!host.includes(".") && !host.includes(":")) || LOCAL_NAME.test(host) || privateAddress(host);
}

/** A path on this computer: home-relative, relative, a file: address, or an absolute path that exists here. */
function pathHere(value: string): boolean {
  const pieces = [value, ...value.split("=").slice(1)].flatMap((piece) => [piece, piece.split(":")[0] ?? ""]);
  return pieces.some((piece) => piece === "~" || piece.startsWith("~/") || piece.startsWith("./") || piece.startsWith("../")
    || piece.startsWith("file:") || (isAbsolute(piece) && piece.length > 1 && existsSync(piece)));
}

export function launcherOf(command: string): string {
  return basename(command.replaceAll("\\", "/")).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/u, "");
}

/** A server that needs this computer: it starts a program by path, reads a file or folder here, or calls an address
 * only this computer reaches. */
export function runsHere(server: StoredMcpServer): boolean {
  if (isRemoteMcpServer(server)) return addressHere(server.url);
  const command = server.command.trim();
  if (/[\\/]/u.test(command) || command.startsWith("~") || command.startsWith(".")) return true;
  return [...server.args, ...Object.values(server.env)].some(pathHere);
}

/** A key whose model address only this computer or its own network reaches (a model server at home): My Cloud would
 * call nothing there, so it stays on this computer. */
export function modelStaysHere(fragment: Partial<AppConfig>): boolean {
  return Object.values(fragment).some((entry) => entry !== null && typeof entry === "object" && typeof (entry as { url?: unknown }).url === "string"
    && Boolean((entry as { url: string }).url.trim()) && addressHere((entry as { url: string }).url));
}

/** Each key provider this computer has a key for that moves, with its config fragment. */
function movingKeys(cfg: AppConfig): Array<{ provider: Provider; fragment: Partial<AppConfig> }> {
  return KEY_PROVIDERS.flatMap((provider) => {
    const fragment = provider.config(cfg);
    return fragment && !modelStaysHere(fragment) ? [{ provider, fragment }] : [];
  });
}

export interface ConnectionSources {
  config: AppConfig;
  mcpAuth(name: string, url: string): McpAuthState;
  composio: ComposioIdentity | null;
  highlevel(): HighLevelConnection | null;
}

export function listConnections(sources: ConnectionSources): ConnectionListing[] {
  const { config: cfg } = sources;
  const items: ConnectionListing[] = [];
  for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
    const parsed = parseStoredMcpServer(name, raw);
    if (!parsed.ok) continue;
    const server = parsed.server;
    const remote = isRemoteMcpServer(server);
    let detail: string;
    try { detail = remote ? new URL(server.url).host : [server.command, server.args.find((arg) => !arg.startsWith("-")) ?? ""].join(" ").trim().slice(0, 120); } catch { detail = name; }
    items.push({ id: `mcp:${name}`, kind: "mcp", label: name, detail,
      ...(runsHere(server) ? { runsHere: true as const } : {}),
      ...(remote ? {} : { launcher: launcherOf(server.command) }),
      ...(remote && sources.mcpAuth(name, server.url) === "signed-in" ? { signIn: true as const } : {}) });
  }
  for (const { provider } of movingKeys(cfg)) items.push({ id: `key:${provider.id}`, kind: "key", label: provider.label, for: [...provider.for] });
  const account = sources.composio;
  if (account) {
    items.push({ id: "composio", kind: "composio", label: "Connected apps", mode: account.mode, account: account.account,
      ...(account.installationId ? { installationId: account.installationId } : {}) });
  }
  const highlevel = sources.highlevel();
  if (highlevel) items.push({ id: "highlevel", kind: "highlevel", label: "HighLevel", ...(highlevel.kind === "oauth" ? { signIn: true as const } : {}) });
  return items;
}

/** What one connection's handoff carries, for My Cloud's own routes. */
export type ConnectionHandoff =
  | { mcp: { name: string; server: StoredMcpServer; signIn?: McpOAuthRecord } }
  | { config: Partial<AppConfig> }
  | { composio: { apiKey: string; userId: string } }
  | { highlevel: HighLevelConnection };

export interface HandoffSources {
  config: AppConfig;
  /** The sign-in kept for a server reached by URL, with its tokens. */
  mcpSignIn(name: string, url: string): McpOAuthRecord | undefined;
  highlevel(): HighLevelConnection | null;
}

/** A sign-in's tokens in a digest: the same tokens give the same digest, so a sign-in that refreshed meanwhile is seen. */
export function signInDigest(tokens: unknown): string {
  return createHash("sha256").update(canonicalJson(tokens ?? null)).digest("hex");
}

const MCP_ID = /^mcp:([a-z][a-z0-9_-]{0,31})$/u;

function remoteServer(cfg: AppConfig, name: string): Extract<StoredMcpServer, { url: string }> | null {
  const raw = cfg.mcpServers?.[name];
  const parsed = raw === undefined ? null : parseStoredMcpServer(name, raw);
  return parsed?.ok && isRemoteMcpServer(parsed.server) ? parsed.server : null;
}

/** One connection's secrets, and the digest of a sign-in that moves. A server that runs here keeps its sign-in here:
 * whoever reaches that address does so from this computer. */
export function answerConnection(id: string, sources: HandoffSources):
  { ok: true; connection: ConnectionHandoff; digest?: string } | { ok: false; error: string } {
  const cfg = sources.config;
  const mcp = MCP_ID.exec(id);
  if (mcp) {
    const name = mcp[1]!;
    const parsed = cfg.mcpServers?.[name] === undefined ? null : parseStoredMcpServer(name, cfg.mcpServers[name]);
    if (!parsed?.ok) return { ok: false, error: "This MCP server is no longer on this computer." };
    const server = parsed.server;
    const record = isRemoteMcpServer(server) && !runsHere(server) ? sources.mcpSignIn(name, server.url) : undefined;
    const signIn = record?.state === "signed-in" && record.tokens ? record : undefined;
    return { ok: true, connection: { mcp: { name, server, ...(signIn ? { signIn } : {}) } }, ...(signIn ? { digest: signInDigest(signIn.tokens) } : {}) };
  }
  const key = /^key:(\w{1,40})$/u.exec(id);
  if (key) {
    const fragment = KEY_PROVIDERS.find((provider) => provider.id === key[1])?.config(cfg);
    if (fragment && modelStaysHere(fragment)) return { ok: false, error: "This key's model is on this computer's own network, so it stays here." };
    return fragment ? { ok: true, connection: { config: fragment } } : { ok: false, error: "This key is no longer saved on this computer." };
  }
  if (id === "composio") {
    const apiKey = cfg.composio?.apiKey?.trim(), userId = cfg.composio?.userId;
    return apiKey && userId ? { ok: true, connection: { composio: { apiKey, userId } } } : { ok: false, error: "Connected apps here use OpenMausBot's service." };
  }
  if (id === "highlevel") {
    const connection = sources.highlevel();
    if (!connection) return { ok: false, error: "HighLevel is not connected on this computer." };
    return { ok: true, connection: { highlevel: connection }, ...(connection.kind === "oauth" ? { digest: highlevelDigest(connection) } : {}) };
  }
  return { ok: false, error: "This connection is not on this computer." };
}

export const highlevelDigest = (connection: HighLevelConnection) =>
  signInDigest({ accessToken: connection.accessToken, refreshToken: connection.refreshToken ?? null, expiresAt: connection.expiresAt ?? null });

export interface ReleaseSources extends HandoffSources {
  /** Forgets a server's sign-in here, without signing it out: My Cloud uses it now. */
  forgetSignIn(name: string): void;
  forgetHighLevel(): void;
}

/** This computer lets go of a sign-in that moved to My Cloud, unless it refreshed since it was read (`changed`): then
 * the newer one goes first. */
export function releaseConnection(id: string, digest: string, sources: ReleaseSources):
  { ok: true; release: { released: true } | { changed: true } } | { ok: false; error: string } {
  const mcp = MCP_ID.exec(id);
  if (mcp) {
    const server = remoteServer(sources.config, mcp[1]!);
    const record = server ? sources.mcpSignIn(mcp[1]!, server.url) : undefined;
    if (!server || !record?.tokens) return { ok: true, release: { released: true } };
    if (signInDigest(record.tokens) !== digest) return { ok: true, release: { changed: true } };
    sources.forgetSignIn(mcp[1]!);
    return { ok: true, release: { released: true } };
  }
  if (id === "highlevel") {
    const connection = sources.highlevel();
    if (connection?.kind !== "oauth") return { ok: true, release: { released: true } };
    if (highlevelDigest(connection) !== digest) return { ok: true, release: { changed: true } };
    sources.forgetHighLevel();
    return { ok: true, release: { released: true } };
  }
  return { ok: false, error: "Only a sign-in that moved is let go of." };
}

/** Each connection's own secrets in a fingerprint under `nonce` (cloud-send-verify.ts), by the id it moves under. A
 * sign-in that refreshes itself is left out: it moves once and this computer lets go of it, so the two sides never
 * hold it at once. */
export function connectionFingerprints(nonce: string, sources: Pick<HandoffSources, "config" | "highlevel">): Record<string, string> {
  const cfg = sources.config;
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
    const parsed = parseStoredMcpServer(name, raw);
    if (!parsed.ok) continue;
    const server = parsed.server;
    out[`mcp:${name}`] = fingerprint(nonce, isRemoteMcpServer(server) ? { headers: server.headers ?? {}, clientSecret: server.oauth?.clientSecret ?? null } : { env: server.env });
  }
  for (const { provider, fragment } of movingKeys(cfg)) out[`key:${provider.id}`] = fingerprint(nonce, fragment);
  const apiKey = cfg.composio?.apiKey?.trim(), userId = cfg.composio?.userId;
  if (apiKey && userId) out.composio = fingerprint(nonce, { apiKey, userId });
  const highlevel = sources.highlevel();
  if (highlevel?.kind === "token") out.highlevel = fingerprint(nonce, { token: highlevel.accessToken, locationId: highlevel.locationId });
  return out;
}

/** Programs a command-line MCP server may start that this server has on its PATH. */
const LAUNCHERS = ["npx", "npm", "node", "pnpm", "bunx", "bun", "deno", "uvx", "uv", "pipx", "python3", "python", "docker", "go", "java", "ruby", "php", "dotnet", "sh", "bash"];

export function launchersOnPath(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = (env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  return LAUNCHERS.filter((name) => dirs.some((dir) => suffixes.some((suffix) => existsSync(join(dir, `${name}${suffix}`)))));
}
