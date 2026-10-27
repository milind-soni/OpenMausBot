import { gapIn, type PastedGap, type PastedMcpServer, type PastedSecret } from "@/lib/mcp-paste";

import { resultBudgetDraft, type McpMessage, type McpResultBudgetDraft, type McpResultBudgetListing } from "./McpResultBudgetField";

/** Security: secrets arrive as names only. */
export interface StdioMcpListing extends McpResultBudgetListing {
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  enabled: boolean;
}
export interface RemoteMcpListing extends McpResultBudgetListing {
  name: string;
  type: "http" | "sse";
  url: string;
  headerKeys: string[];
  enabled: boolean;
  auth?: "signed-in" | "needs-sign-in";
  oauth?: McpOAuthClientListing;
}
export interface McpOAuthClientListing {
  clientId: string;
  scopes: string[];
  clientSecretConfigured: boolean;
  redirectUri: string;
}
export type McpServerListing = (StdioMcpListing | RemoteMcpListing) & { managedBy?: string; runsOn?: { environmentId: string; label: string }; apps?: boolean };

export function isRemoteMcpListing(server: McpServerListing): server is RemoteMcpListing {
  return "url" in server;
}

/** One header or environment variable in the form. A `saved` row's value is write-only: blank keeps what is saved. */
export interface SecretRow {
  id: number;
  name: string;
  value: string;
  saved?: boolean;
  gap?: PastedGap;
}

export interface McpDraft extends McpResultBudgetDraft {
  name: string;
  transport: "stdio" | "remote";
  command: string;
  args: string;
  env: SecretRow[];
  type: "http" | "sse";
  url: string;
  urlGap?: PastedGap;
  headers: SecretRow[];
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScopes: string;
  oauthForgetSecret: boolean;
}

let rowIds = 0;
export function secretRow(row: Omit<SecretRow, "id"> = { name: "", value: "" }): SecretRow {
  rowIds += 1;
  return { id: rowIds, ...row };
}

export function emptyDraft(): McpDraft {
  return {
    name: "", transport: "remote", command: "", args: "", env: [secretRow()], type: "http", url: "", headers: [secretRow()],
    oauthClientId: "", oauthClientSecret: "", oauthScopes: "", oauthForgetSecret: false, resultBudget: "",
  };
}

const savedRows = (keys: readonly string[]) => keys.length ? keys.map((name) => secretRow({ name, value: "", saved: true })) : [secretRow()];
const pastedRows = (secrets: readonly PastedSecret[]) => secrets.length ? secrets.map((secret) => secretRow({ ...secret })) : [secretRow()];

export function draftFor(server: McpServerListing): McpDraft {
  if (isRemoteMcpListing(server)) {
    return {
      ...emptyDraft(),
      name: server.name,
      type: server.type,
      url: server.url,
      headers: savedRows(server.headerKeys),
      oauthClientId: server.oauth?.clientId ?? "",
      oauthScopes: server.oauth?.scopes.join(" ") ?? "",
      resultBudget: resultBudgetDraft(server),
    };
  }
  return {
    ...emptyDraft(),
    name: server.name,
    transport: "stdio",
    command: server.command,
    args: server.args.join("\n"),
    env: savedRows(server.envKeys),
    resultBudget: resultBudgetDraft(server),
  };
}

export function draftFromPaste(server: PastedMcpServer): McpDraft {
  if (server.transport === "remote") {
    return {
      ...emptyDraft(),
      name: server.name,
      type: server.type,
      url: server.url,
      ...(server.urlGap ? { urlGap: server.urlGap } : {}),
      headers: pastedRows(server.headers),
      oauthClientId: server.oauthClientId ?? "",
    };
  }
  return { ...emptyDraft(), name: server.name, transport: "stdio", command: server.command, args: server.args.join("\n"), env: pastedRows(server.env) };
}

/** What a row saves: for a value that was a variable, what was pasted put back between the text around it. */
export function rowValue(row: SecretRow): string {
  const typed = row.value.trim();
  if (!row.gap || !typed) return row.value;
  const { before, after } = row.gap;
  if (before.trim() && typed.toLowerCase().startsWith(before.trim().toLowerCase())) return typed;
  return `${before}${typed}${after}`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

/** Security: an error names a row, never its value. */
export function rowsBody(
  rows: readonly SecretRow[],
  kind: "header" | "env",
): { ok: true; values: Record<string, string | true> } | { ok: false; error: McpMessage } {
  const values: Record<string, string | true> = {};
  for (const row of rows) {
    const name = row.name.trim();
    const value = kind === "header" ? rowValue(row).trim() : rowValue(row);
    if (!name && !value) continue;
    if (!name) return { ok: false, error: { key: "mcp.err.rowName" } };
    if (!(kind === "header" ? HEADER_NAME : ENV_NAME).test(name)) {
      return { ok: false, error: { key: kind === "header" ? "mcp.headers.invalidName" : "mcp.env.invalidName", params: { key: name } } };
    }
    if (Object.hasOwn(values, name)) return { ok: false, error: { key: kind === "header" ? "mcp.headers.duplicate" : "mcp.env.duplicate", params: { key: name } } };
    if (value) values[name] = value;
    else if (row.saved) values[name] = true;
    else return { ok: false, error: { key: "mcp.err.missingValue", params: { name } } };
  }
  return { ok: true, values };
}

export function parseMcpArguments(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function parseMcpOAuthClient(
  input: { clientId: string; clientSecret: string; scopes: string; forgetSecret: boolean },
  saved?: { clientSecretConfigured: boolean },
): { clientId: string; clientSecret?: string | true; scopes?: string[] } | undefined {
  const clientId = input.clientId.trim();
  if (!clientId) return undefined;
  const secret = input.clientSecret.trim();
  const scopes = input.scopes.split(/[\s,]+/).filter(Boolean);
  return {
    clientId,
    ...(secret ? { clientSecret: secret } : saved?.clientSecretConfigured && !input.forgetSecret ? { clientSecret: true as const } : {}),
    ...(scopes.length ? { scopes } : {}),
  };
}

export function draftBody(
  draft: McpDraft,
  existing: McpServerListing | undefined,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: McpMessage } {
  const name = draft.name.trim();
  if (draft.transport === "remote") {
    const url = draft.url.trim();
    if (!name || !/^https?:\/\/\S+$/i.test(url)) return { ok: false, error: { key: "mcp.err.nameAndUrl" } };
    if (gapIn(url)) return { ok: false, error: { key: "mcp.paste.urlMissing" } };
    const headers = rowsBody(draft.headers, "header");
    if (!headers.ok) return headers;
    const oauth = parseMcpOAuthClient(
      { clientId: draft.oauthClientId, clientSecret: draft.oauthClientSecret, scopes: draft.oauthScopes, forgetSecret: draft.oauthForgetSecret },
      existing && isRemoteMcpListing(existing) ? existing.oauth : undefined,
    );
    return { ok: true, body: { type: draft.type, url, headers: headers.values, ...(oauth ? { oauth } : {}) } };
  }
  const command = draft.command.trim();
  if (!name || !command) return { ok: false, error: { key: "mcp.err.nameAndCommand" } };
  const env = rowsBody(draft.env, "env");
  if (!env.ok) return env;
  return { ok: true, body: { command, args: parseMcpArguments(draft.args), env: env.values } };
}

/** The one key a URL server is reached with, which a Team Cloud keeps as this person's own when it's only for them. */
export function soleKey(draft: McpDraft): string | null {
  if (draft.transport !== "remote" || draft.oauthClientId.trim()) return null;
  const named = draft.headers.filter((row) => row.name.trim());
  return named.length === 1 ? rowValue(named[0]!).trim() || null : null;
}
