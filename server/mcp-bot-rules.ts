import { redactSecretsInText } from "../shared/redact.ts";
import type { McpAuthState } from "./mcp-oauth.ts";
import { isRemoteMcpServer, type StoredMcpServer } from "./mcp-registry.ts";

export type McpOwner = "shared" | "own" | "theirs" | "person" | "elsewhere";

/** A bot may never send these: they are the person's switches. */
export const BOT_STRIPPED_KEYS: readonly string[] = ["bot", "runsOn", "apps", "enabled"];

const SECRET_REF = /secret-ref:[0-9a-f]{32}/;

export function mcpOwner(name: string, server: StoredMcpServer, botId: string, personal: readonly string[]): McpOwner {
  if (personal.includes(name)) return "person";
  if (!isRemoteMcpServer(server) && server.bot) return server.bot === botId ? "own" : "theirs";
  if (server.runsOn) return "elsewhere";
  return "shared";
}

/** `server` supplies the computer's name for the "elsewhere" refusal. */
export function botMayChange(owner: McpOwner, server?: StoredMcpServer): { ok: true } | { ok: false; error: string } {
  switch (owner) {
    case "theirs": return { ok: false, error: "That server belongs to another bot." };
    case "person": return { ok: false, error: "This connection is each person's own. Change it in Settings." };
    case "elsewhere": return { ok: false, error: `This server runs on ${server?.runsOn?.label ?? "another computer"}, so it can't be changed here.` };
    default: return { ok: true };
  }
}

function isSecretRef(value: unknown): boolean {
  return typeof value === "string" && SECRET_REF.test(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sameList(a: readonly string[], b: unknown): boolean {
  return Array.isArray(b) && a.length === b.length && a.every((item, i) => item === b[i]);
}

/** Saved secrets keep (`true`) unless `drop`; a value the patch supplies replaces the saved one either way. */
function mergeSecrets(
  saved: Record<string, string>,
  patched: Record<string, unknown>,
  drop: boolean,
  label: "env" | "header",
  dropped: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(saved)) {
    const sent = patched[key];
    if (sent !== undefined && sent !== true) continue;
    if (drop && !isSecretRef(sent)) dropped.push(`${label} ${key}`);
    else out[key] = true;
  }
  for (const [key, value] of Object.entries(patched)) if (value !== true) out[key] = value;
  return out;
}

export function mergeBotUpdate(existing: StoredMcpServer, patch: Record<string, unknown>): { body: Record<string, unknown>; dropped: string[] } {
  const dropped: string[] = [];
  if (isRemoteMcpServer(existing)) {
    const url = typeof patch.url === "string" ? patch.url : existing.url;
    const moved = url !== existing.url;
    const headers = mergeSecrets(existing.headers ?? {}, record(patch.headers), moved, "header", dropped);
    const body: Record<string, unknown> = {
      type: patch.type ?? existing.type,
      url,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(patch.resultBudget !== undefined ? { resultBudget: patch.resultBudget } : existing.resultBudget !== undefined ? { resultBudget: existing.resultBudget } : {}),
    };
    const saved = existing.oauth;
    const sent = patch.oauth === undefined ? undefined : record(patch.oauth);
    const clientId = typeof sent?.clientId === "string" ? sent.clientId : saved?.clientId;
    if (clientId) {
      const scopes = sent?.scopes ?? saved?.scopes;
      let clientSecret: unknown = sent?.clientSecret;
      if (clientSecret === undefined || clientSecret === true) {
        const keep = saved?.clientSecret !== undefined && saved.clientId === clientId;
        clientSecret = keep && !moved ? true : undefined;
        if (keep && moved) dropped.push("oauth client secret");
      }
      body.oauth = { clientId, ...(scopes ? { scopes } : {}), ...(clientSecret !== undefined ? { clientSecret } : {}) };
    }
    // A remote server's sign-in tokens belong to its address, so a new address starts signed out.
    if (moved) dropped.push("sign-in");
    return { body, dropped };
  }

  const patchedEnv = record(patch.env);
  const moved = (typeof patch.command === "string" && patch.command !== existing.command)
    || (patch.args !== undefined && !sameList(existing.args, patch.args))
    || Object.entries(patchedEnv).some(([key, value]) => typeof value === "string" && !isSecretRef(value) && value !== existing.env[key]);
  const env = mergeSecrets(existing.env, patchedEnv, moved, "env", dropped);
  const body: Record<string, unknown> = {
    command: patch.command ?? existing.command,
    args: patch.args ?? existing.args,
    ...(Object.keys(env).length ? { env } : {}),
    ...(patch.resultBudget !== undefined ? { resultBudget: patch.resultBudget } : existing.resultBudget !== undefined ? { resultBudget: existing.resultBudget } : {}),
  };
  return { body, dropped };
}

function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.split(/[?#]/)[0] ?? "";
  }
}

export function botListing(
  name: string,
  server: StoredMcpServer,
  extra: { owner: McpOwner; authState: McpAuthState; forThisBot: boolean; managedBy?: string },
): Record<string, unknown> {
  const common = {
    name,
    enabled: server.enabled,
    owner: extra.owner,
    signIn: extra.authState,
    forThisBot: extra.forThisBot,
    ...(extra.managedBy ? { managedBy: extra.managedBy } : {}),
  };
  if (isRemoteMcpServer(server)) {
    return { ...common, transport: server.type ?? "http", url: withoutQuery(server.url), headerKeys: Object.keys(server.headers ?? {}) };
  }
  return {
    ...common,
    transport: "stdio",
    command: redactSecretsInText(server.command),
    args: server.args.map(redactSecretsInText),
    envKeys: Object.keys(server.env),
  };
}
