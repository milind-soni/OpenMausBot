import { redactSecretsInText } from "../shared/redact.ts";
import type { McpAuthState } from "./mcp-oauth.ts";
import { isRemoteMcpServer, type StoredMcpServer } from "./mcp-registry.ts";

export type McpOwner = "shared" | "own" | "theirs" | "person" | "elsewhere";

/** A bot may never send these: they are the person's switches. */
export const BOT_STRIPPED_KEYS: readonly string[] = ["bot", "runsOn", "apps", "enabled"];

const WHOLE_REF = /^secret-ref:[0-9a-f]{32}$/;
const SECRET_FLAG_ARG = /^--(?:token|password|passwd|api-key|apikey|secret|access-key|auth-token)$/i;

export function mcpOwner(name: string, server: StoredMcpServer, botId: string, personal: readonly string[]): McpOwner {
  if (personal.includes(name)) return "person";
  if (!isRemoteMcpServer(server) && server.bot && server.bot !== botId) return "theirs";
  if (server.runsOn) return "elsewhere";
  if (!isRemoteMcpServer(server) && server.bot) return "own";
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

/** Exactly one ref, bare or as {secretRef}: a string that merely embeds one is a literal, since redeeming it can build any text. */
export function isSecretRef(value: unknown): boolean {
  if (typeof value === "string") return WHOLE_REF.test(value.trim());
  const ref = record(value).secretRef;
  return typeof ref === "string" && WHOLE_REF.test(ref.trim());
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sameList(a: readonly string[], b: unknown): boolean {
  return Array.isArray(b) && a.length === b.length && a.every((item, i) => item === b[i]);
}

/** A saved secret keeps (`true`) unless `drop`. Any value the patch supplies replaces the saved one, so it is never dropped. */
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
    if (drop) dropped.push(`${label} ${key}`);
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
    || Object.values(patchedEnv).some((value) => value !== true && !isSecretRef(value));
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

function redactArg(arg: string, previous: string | undefined): string {
  if (previous !== undefined && SECRET_FLAG_ARG.test(previous) && !arg.startsWith("-")) return "***";
  return redactSecretsInText(arg);
}

const redactedArgs = (args: readonly string[]) => args.map((arg, i) => redactArg(arg, args[i - 1]));

/** Where a server reaches, as a person reads it: its address without the query, or its command line with secrets hidden. */
export function botServerTarget(server: StoredMcpServer): string {
  if (isRemoteMcpServer(server)) return withoutQuery(server.url);
  return [redactSecretsInText(server.command), ...redactedArgs(server.args)].join(" ");
}

/** What an update changes, as `field: old → new` lines, and the secrets it sends anew by key. `next` is the merged server;
 * env and header values show only where `sent` (the bot's own fields) gives them as literals, so no saved secret shows. */
export function botChangeLines(existing: StoredMcpServer, next: StoredMcpServer, sent: Record<string, unknown>): { lines: string[]; keys: string[] } {
  const lines: string[] = [];
  const change = (field: string, before: string, after: string, shown: readonly [string, string] = [before, after]) => {
    if (before !== after) lines.push(`${field}: ${shown[0] || "–"} → ${shown[1] || "–"}`);
  };
  if (isRemoteMcpServer(existing) && isRemoteMcpServer(next)) {
    const address = (url: string) => withoutQuery(url) + (/[?#]/.test(url) ? "?…" : "");
    change("url", existing.url, next.url, [address(existing.url), address(next.url)]);
    change("type", existing.type, next.type);
    change("oauth.clientId", existing.oauth?.clientId ?? "", next.oauth?.clientId ?? "");
    change("oauth.scopes", (existing.oauth?.scopes ?? []).join(" "), (next.oauth?.scopes ?? []).join(" "));
  } else if (!isRemoteMcpServer(existing) && !isRemoteMcpServer(next)) {
    change("command", existing.command, next.command, [redactSecretsInText(existing.command), redactSecretsInText(next.command)]);
    change("args", JSON.stringify(existing.args), JSON.stringify(next.args), [redactedArgs(existing.args).join(" "), redactedArgs(next.args).join(" ")]);
  }
  change("resultBudget", String(existing.resultBudget ?? ""), String(next.resultBudget ?? ""));
  const keys: string[] = [];
  for (const [label, values] of [["env", sent.env], ["headers", sent.headers]] as const) {
    for (const [key, value] of Object.entries(record(values))) {
      if (isSecretRef(value)) keys.push(key);
      else if (typeof value === "string") lines.push(`${label}.${key} → ${redactSecretsInText(value)}`);
    }
  }
  if (isSecretRef(record(sent.oauth).clientSecret)) keys.push("oauth.clientSecret");
  return { lines, keys };
}

export function botListing(
  name: string,
  server: StoredMcpServer,
  extra: { owner: McpOwner; authState: McpAuthState; forThisBot: boolean; managedBy?: string },
): Record<string, unknown> {
  const common = {
    name,
    enabled: server.enabled,
    owner: extra.managedBy ? "managed" : extra.owner,
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
    args: redactedArgs(server.args),
    envKeys: Object.keys(server.env),
  };
}
