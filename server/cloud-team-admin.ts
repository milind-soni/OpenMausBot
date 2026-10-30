// A Team Cloud's shared connections and AI, as its team's admins see them on the Admin's Team admin pages.
// Security invariant: names, states and the identities the providers report only; never a key, token, header or
// environment value, nor any part of an MCP URL but its host.
import type { ConnectorServiceState } from "./composio.ts";
import type { ProviderSnapshot } from "./contracts.ts";

export const CLOUD_TEAM_ADMIN_PATH = "/api/cloud/team/admin";

/** The wire shape of `GET /api/cloud/team/admin` (signed by the Admin). */
export interface TeamAdminSummary {
  v: 1;
  /** Connected apps (Composio). `available: false`: connected apps are off or unreadable here; `services` is then empty. */
  apps: { available: boolean; services: { slug: string; status: string; accounts: { id: string; alias: string | null; status: string }[] }[] };
  mcp: { name: string; transport: "http" | "sse" | "stdio"; host: string | null; enabled: boolean; signedIn: boolean | null; secrets: string[] }[];
  /** The team's own service keys, set or not: treg (X research) and voice (ElevenLabs). `included`: the Cloud's own voice
   * serves the team while no key of its own is set. */
  keys: { id: "treg" | "voice"; configured: boolean; included?: true }[];
  ai: {
    keys: { id: "anthropic" | "openai" | "openrouter"; configured: boolean }[];
    engines: { id: string; name: string; authenticated: boolean; account: { email: string | null; organization: string | null; method: "login" | "api-key" | null } | null }[];
  };
  /** The apps (slugs) and MCP servers each person connects for themselves; everything else is the team's. */
  scopes?: { apps: string[]; mcp: string[] };
  /** Who has connected each of those: addresses only, never a key or token. */
  people?: { apps: Record<string, string[]>; mcp: Record<string, string[]> };
}

type ListedMcp = { name: string; enabled?: boolean; url?: string; type?: string; command?: string; headerKeys?: string[]; envKeys?: string[]; auth?: string };

export function teamAdminSummary(input: {
  apps: Record<string, ConnectorServiceState> | null;
  mcp: readonly ListedMcp[];
  status: Record<string, unknown>;
  voice: { key: boolean; included: boolean };
  engines: readonly { instanceId: string; name: string; snapshot: ProviderSnapshot | undefined | null }[];
}): TeamAdminSummary {
  const configured = (id: string) => Boolean((input.status[id] as { configured?: unknown } | undefined)?.configured);
  const host = (url: string | undefined) => {
    try { return url ? new URL(url).host : null; } catch { return null; }
  };
  return {
    v: 1,
    apps: {
      available: input.apps !== null,
      services: Object.entries(input.apps ?? {}).filter(([, state]) => state.connected || state.pending || state.accounts.length > 0).map(([slug, state]) => ({
        slug, status: state.status, accounts: state.accounts.map((account) => ({ id: account.id, alias: account.alias?.trim() || null, status: account.status })),
      })),
    },
    mcp: input.mcp.map((server) => ({
      name: server.name,
      transport: server.url ? (server.type === "sse" ? "sse" : "http") : "stdio",
      host: host(server.url),
      enabled: server.enabled !== false,
      signedIn: server.auth === undefined ? null : server.auth === "signed-in",
      secrets: [...(server.headerKeys ?? []), ...(server.envKeys ?? [])],
    })),
    keys: [{ id: "treg", configured: configured("treg") }, { id: "voice", configured: input.voice.key, ...(input.voice.included ? { included: true as const } : {}) }],
    ai: {
      keys: (["anthropic", "openai", "openrouter"] as const).map((id) => ({ id, configured: configured(id) })),
      engines: input.engines.filter((engine) => engine.snapshot?.state === "available").map((engine) => {
        const account = engine.snapshot?.authenticated ? engine.snapshot.account : undefined;
        return {
          id: engine.instanceId, name: engine.name, authenticated: engine.snapshot?.authenticated === true,
          account: account ? { email: account.email ?? null, organization: account.organization ?? null, method: account.method ?? null } : null,
        };
      }),
    },
  };
}
