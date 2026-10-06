// Apps the person authorizes one at a time. Gmail and Slack use that
// provider's remote MCP server. Outlook mail is a Microsoft Graph grant on
// this computer: there is no public Outlook-only remote MCP, and Work IQ
// covers all of Microsoft 365. The token stays on this computer. Composio
// is not on the path, and authorizing one app does not authorize another.
import { mcpOAuthRedirectUri } from "./mcp-oauth-redirect.ts";

export interface DirectApp {
  id: "outlook" | "gmail" | "slack";
  /** Stored name. Fixed, so the grant cannot be relabeled onto another host. */
  name: string;
  title: string;
  /** Remote MCP URL, or the Graph address Outlook uses to derive its redirect. */
  url: string;
  /** Scopes sent on the consent screen. Empty means the provider's own list. */
  scopes: readonly string[];
  docsUrl: string;
  /** The provider's server creates drafts and does not send. */
  draftsOnly: boolean;
  /** graph: this computer calls Microsoft Graph. mcp: a remote MCP server. */
  transport: "graph" | "mcp";
}

/** Stable identity for the Outlook redirect port. Not an MCP server. */
export const OUTLOOK_IDENTITY_URL = "https://graph.microsoft.com/v1.0/me/messages";

/** Mail only. Calendar, files, and Teams are intentionally absent. */
export const OUTLOOK_SCOPES = [
  "offline_access",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
] as const;

export const OUTLOOK_SIGN_IN_PATH = "/api/outlook/sign-in";
export const OUTLOOK_MCP_PATH = "/api/outlook/mcp";

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `common` when omitted. A directory id, or one of Microsoft's three aliases. */
export function outlookTenant(value: string | undefined): string | null {
  const tenant = (value ?? "").trim() || "common";
  if (tenant === "common" || tenant === "organizations" || tenant === "consumers") return tenant;
  if (TENANT_ID.test(tenant)) return tenant.toLowerCase();
  return null;
}

export const DIRECT_APPS: readonly DirectApp[] = [
  {
    id: "outlook",
    name: "outlook",
    title: "Outlook",
    url: OUTLOOK_IDENTITY_URL,
    scopes: OUTLOOK_SCOPES,
    docsUrl: "https://learn.microsoft.com/en-us/graph/auth-register-app-v2",
    draftsOnly: false,
    transport: "graph",
  },
  {
    id: "gmail",
    name: "gmail",
    title: "Gmail",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
    docsUrl: "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server",
    draftsOnly: true,
    transport: "mcp",
  },
  {
    id: "slack",
    name: "slack",
    title: "Slack",
    url: "https://mcp.slack.com/mcp",
    scopes: [],
    docsUrl: "https://docs.slack.dev/ai/slack-mcp-server/",
    draftsOnly: false,
    transport: "mcp",
  },
];

export function directAppByName(name: string): DirectApp | undefined {
  return DIRECT_APPS.find((app) => app.name === name);
}

export function directAppRedirectUri(app: DirectApp): string {
  return mcpOAuthRedirectUri(app.url);
}

export interface DirectAppServer {
  name: string;
  url?: string;
  enabled: boolean;
  auth?: "signed-in" | "needs-sign-in";
}

export type DirectAppCard =
  | { kind: "create" }
  | { kind: "ready"; enabled: boolean; auth?: "signed-in" | "needs-sign-in" }
  | { kind: "name-taken" };

/** How the card should treat an existing server list. A same-name server
 * that points somewhere else is not this app's grant. */
export function directAppCardState(app: DirectApp, servers: readonly DirectAppServer[]): DirectAppCard {
  const existing = servers.find((server) => server.name === app.name);
  if (!existing) return { kind: "create" };
  if (existing.url !== app.url) return { kind: "name-taken" };
  return { kind: "ready", enabled: existing.enabled, auth: existing.auth };
}

/** The POST /api/mcp/servers body for a remote MCP app. A new server is
 * stored switched off until sign-in succeeds. Outlook does not use this. */
export function directAppCreateBody(
  app: DirectApp,
  input: { clientId: string; clientSecret: string },
): { ok: true; body: Record<string, unknown> } | { ok: false; error: "client-id" | "client-secret" | "not-mcp" } {
  if (app.transport !== "mcp") return { ok: false, error: "not-mcp" };
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret.trim();
  if (!clientId) return { ok: false, error: "client-id" };
  if (!clientSecret) return { ok: false, error: "client-secret" };
  return {
    ok: true,
    body: {
      name: app.name,
      type: "http",
      url: app.url,
      headers: {},
      oauth: {
        clientId,
        clientSecret,
        ...(app.scopes.length ? { scopes: [...app.scopes] } : {}),
      },
    },
  };
}
