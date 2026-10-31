import { CreditCard, type LucideIcon } from "lucide-react";

import whopLogo from "@/assets/whop/logo.png";
import type { LocaleKey } from "@/locales";

export interface HostedMcpApp {
  /** The card's id (`data-app-tile`) and the name the server is added under (then `-2`, `-3`…): a valid server name. */
  readonly id: string;
  /** The service's own name, never translated. */
  readonly label: string;
  /** Its official hosted MCP endpoint, which signs in with browser OAuth instead of a pasted key. A server is this app only at exactly this address, over streamable HTTP. */
  readonly url: string;
  /** Its licensed logo, or a neutral lucide glyph when the service publishes none we may ship. */
  readonly icon: { readonly image: string } | { readonly glyph: LucideIcon };
  readonly description: LocaleKey;
  /** What signing in grants, and who owns the service's own approvals. Shown on the card and on the server's row. */
  readonly notice: LocaleKey;
  /** Search words besides the label and the description. */
  readonly keywords: string;
}

/** The hosted MCP apps with a one-click card in Plugins. Adding one is adding a row: its card, Connect, Disconnect and
 * Bot access, its row in the MCP list, search, the Connected filter and the count all derive from this table. */
export const HOSTED_MCP_APPS = [
  {
    id: "whop",
    label: "Whop",
    url: "https://mcp.whop.com/mcp",
    icon: { image: whopLogo },
    description: "whop.description",
    notice: "whop.notice",
    keywords: "whop checkout memberships",
  },
  {
    id: "agentcard",
    label: "Agentcard",
    url: "https://mcp.agentcard.sh/mcp",
    // Agentcard's packages are "SEE LICENSE IN LICENSE" and it publishes no logo licence, so a neutral glyph stands in.
    icon: { glyph: CreditCard },
    description: "agentcard.description",
    notice: "agentcard.notice",
    keywords: "agentcard agent card opencommerce shopping payments buy virtual debit card",
  },
] as const satisfies readonly HostedMcpApp[];

/** A row of the table, with its own literal id. */
export type HostedApp = (typeof HOSTED_MCP_APPS)[number];
export type HostedMcpAppId = HostedApp["id"];

export type HostedConnections = Readonly<Record<HostedMcpAppId, boolean>>;

interface ServerAddress { type?: string; url?: string }

/** The hosted app this server is, by exact address: type "http", https, the app's origin, its path with or without a
 * trailing slash, no query, hash or userinfo. A look-alike host or a URL carrying a key is never branded. */
export function hostedMcpApp(server: ServerAddress): HostedApp | undefined {
  if (server.type !== "http" || !server.url) return undefined;
  let address: URL;
  try { address = new URL(server.url); } catch { return undefined; }
  if (address.search || address.hash || address.username || address.password) return undefined;
  return HOSTED_MCP_APPS.find((app) => {
    const own = new URL(app.url);
    return address.origin === own.origin && (address.pathname === own.pathname || address.pathname === `${own.pathname}/`);
  });
}

/** `whop`, then `whop-2`, `whop-3`…: never an existing server's name. */
export function hostedServerName(app: HostedMcpApp, servers: ReadonlyArray<{ name: string }>): string {
  const names = new Set(servers.map((server) => server.name));
  let name: string = app.id;
  for (let suffix = 2; names.has(name); suffix++) name = `${app.id}-${suffix}`;
  return name;
}

/** The one rule for "connected", shared by the cards, the Connected filter and the count: the server is on and signed in. */
export function hostedConnections(
  servers: ReadonlyArray<ServerAddress & { enabled: boolean; auth?: "signed-in" | "needs-sign-in" }>,
): HostedConnections {
  return Object.fromEntries(HOSTED_MCP_APPS.map((app) => [
    app.id,
    servers.some((server) => hostedMcpApp(server) === app && server.enabled && server.auth === "signed-in"),
  ])) as HostedConnections;
}
