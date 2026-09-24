// Composio — two clients in one file:
//  1) the Connect meta-MCP (connect.composio.dev) for connection state +
//     auth links, ported from agentcal src/composio.js
//  2) the v3 toolkits catalog (backend.composio.dev) for the plugin
//     marketplace — names, descriptions, logos. Works when the key is a
//     project API key; when it isn't, the caller falls back to the curated
//     catalog below (logos then resolve via favicon fallback client-side).
import type { AppConfig } from "./config.ts";

const CONNECT_URL = "https://connect.composio.dev/mcp";
const BACKEND_URL = "https://backend.composio.dev/api/v3";

function parseMcpResponse(text: string) {
  // Streamable-HTTP servers answer JSON or SSE (`data: {...}` lines).
  const line = text.startsWith("{")
    ? text
    : text.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
  if (!line) throw new Error("empty MCP response");
  const msg = JSON.parse(line);
  if (msg.error) throw new Error(msg.error.message || "MCP error");
  const content = msg.result?.content?.find((c: any) => c.type === "text")?.text;
  if (!content) return msg.result ?? null;
  try {
    return JSON.parse(content);
  } catch {
    return { text: content };
  }
}

export async function composioTool(cfg: AppConfig, name: string, args: unknown) {
  if (!cfg.composio?.key) {
    throw new Error('no Composio key configured — add {"composio":{"key":"ck_…"}} to ~/.gbs/config.json');
  }
  const res = await fetch(cfg.composio.url || CONNECT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-consumer-api-key": cfg.composio.key,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Composio MCP: HTTP ${res.status}`);
  return parseMcpResponse(await res.text());
}

export interface ActiveConnection {
  slug: string;
  label: string;
  status: string;
  accounts: Array<{
    id?: string;
    email?: string;
    name?: string;
    status?: string;
  }>;
}

let activeConnectionsCache: { at: number; connections: ActiveConnection[] } | null = null;
let activeConnectionsInFlight: Promise<ActiveConnection[]> | null = null;

export function invalidateActiveConnectionsCache() {
  activeConnectionsCache = null;
}

/**
 * Active Composio connections (cached 45s). Returns [] if unconfigured or error occurs.
 */
export async function listActiveConnections(
  cfg: AppConfig,
  forceRefresh = false
): Promise<ActiveConnection[]> {
  if (!cfg.composio?.key) return [];

  if (!forceRefresh && activeConnectionsCache && Date.now() - activeConnectionsCache.at < 45_000) {
    return activeConnectionsCache.connections;
  }
  // concurrent turns share one lookup instead of each hitting Composio
  if (!forceRefresh && activeConnectionsInFlight) return activeConnectionsInFlight;
  activeConnectionsInFlight = fetchActiveConnections(cfg).finally(() => {
    activeConnectionsInFlight = null;
  });
  return activeConnectionsInFlight;
}

async function fetchActiveConnections(cfg: AppConfig): Promise<ActiveConnection[]> {
  try {
    const { cards } = await listToolkits(cfg);
    const slugs = cards.map((c) => c.slug);
    const labelMap = new Map(cards.map((c) => [c.slug, c.label]));

    const out = await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", {
      toolkits: slugs.map((name) => ({ name, action: "list" })),
    });

    const results = out?.data?.results ?? {};
    const connections: ActiveConnection[] = [];

    for (const [slug, data] of Object.entries<any>(results)) {
      if (!data) continue;
      const accounts = Array.isArray(data.accounts) ? data.accounts : [];
      const isActive =
        accounts.some((a: any) => /active/i.test(a.status ?? "")) ||
        /^active$/i.test(data.status ?? "");

      if (isActive) {
        connections.push({
          slug,
          label: labelMap.get(slug) || slug.charAt(0).toUpperCase() + slug.slice(1),
          status: "active",
          accounts: accounts.map((a: any) => ({
            id: a.id ?? a.account_id ?? a.nanoid ?? undefined,
            email: a.email ?? a.user_email ?? a.username ?? undefined,
            name: a.name ?? a.account_name ?? undefined,
            status: a.status ?? "active",
          })),
        });
      }
    }

    activeConnectionsCache = { at: Date.now(), connections };
    return connections;
  } catch (err) {
    console.error("[composio] listActiveConnections failed:", err);
    // cache the failure too, so an outage costs one lookup per 45s, not one per turn
    const connections = activeConnectionsCache?.connections ?? [];
    activeConnectionsCache = { at: Date.now(), connections };
    return connections;
  }
}

const PROMPT_LOOKUP_BUDGET_MS = 3_000;

/**
 * Formats active connected apps block for system prompt injection.
 * Degrades gracefully (returns "") if unconfigured, no active connections, or on error.
 */
export async function formatConnectedAppsPrompt(cfg: AppConfig): Promise<string> {
  if (!cfg.composio?.key) return "";
  try {
    // Runs before every turn: never hold the agent up for more than a moment.
    // A slow lookup keeps going in the background and fills the cache.
    const activeConns = await Promise.race([
      listActiveConnections(cfg),
      new Promise<ActiveConnection[]>((resolve) => setTimeout(resolve, PROMPT_LOOKUP_BUDGET_MS, []).unref?.()),
    ]);
    if (activeConns.length === 0) return "";
    const listStr = activeConns
      .map((c) => {
        const acctsStr = c.accounts.map((a) => a.email || a.name || a.id).filter(Boolean).join(", ");
        return `- ${c.label} (${c.slug}): Active${acctsStr ? ` [Account: ${acctsStr}]` : ""}`;
      })
      .join("\n");
    return `\n\n[Connected Studio Apps (Composio)]\nThe user currently has active connections for the following external apps:\n${listStr}\nYou have direct access to tools for these connected apps. You can use them whenever helpful without needing to ask the user if they are connected.`;
  } catch {
    return "";
  }
}

/** Connection status per service slug: { slack: { connected, status } }. */
export async function connectionStatus(cfg: AppConfig, slugs: string[]) {
  const out = await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", {
    toolkits: slugs.map((name) => ({ name, action: "list" })),
  });
  const results = out?.data?.results ?? {};
  const status: Record<string, { connected: boolean; status: string }> = {};
  for (const slug of slugs) {
    const r = results[slug];
    const active =
      (r?.accounts ?? []).some((a: any) => /active/i.test(a.status ?? "")) || /^active$/i.test(r?.status ?? "");
    status[slug] = { connected: active, status: r?.status ?? "unknown" };
  }
  return status;
}

/** Disconnect a service: remove every connected account for the slug. */
export async function removeService(cfg: AppConfig, slug: string) {
  invalidateActiveConnectionsCache();
  const out = await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", {
    toolkits: [{ name: slug, action: "list" }],
  });
  const accounts = out?.data?.results?.[slug]?.accounts ?? [];
  const ids = accounts.map((a: any) => a.id ?? a.account_id ?? a.nanoid).filter(Boolean);
  for (const id of ids) {
    await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", {
      toolkits: [{ name: slug, action: "remove", account_id: id }],
    });
  }
  return { removed: ids.length };
}

/** Mint a browser auth link for one service. Returns { url } or throws. */
export async function authorizeService(cfg: AppConfig, slug: string) {
  invalidateActiveConnectionsCache();
  const out = await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", {
    toolkits: [{ name: slug, action: "add" }],
  });
  // be liberal: any https URL mentioning composio/auth wins, else the first
  const raw = JSON.stringify(out);
  const urls = raw.match(/https:\/\/[^"\\\s]+/g) ?? [];
  const url = urls.find((u) => /composio|connect|auth/i.test(u)) ?? urls[0];
  if (!url) throw new Error(`Composio returned no auth link for ${slug}`);
  return { url };
}

// ── marketplace catalog ────────────────────────────────────────────────
export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  /** used for the client-side favicon fallback when logo is null/broken */
  domain: string | null;
}

// Curated fallback — the services agentcal's connectors page ships plus the
// long marketplace tail. Logos resolve client-side:
// logo → favicon(domain) → monogram.
const CURATED: ToolkitCard[] = [
  { slug: "slack", label: "Slack", blurb: "Post updates and read channels", domain: "slack.com", logo: null },
  { slug: "github", label: "GitHub", blurb: "Issues, pull requests, and code", domain: "github.com", logo: null },
  { slug: "gmail", label: "Gmail", blurb: "Read and send email", domain: "gmail.com", logo: null },
  { slug: "googlecalendar", label: "Google Calendar", blurb: "Read and create events", domain: "calendar.google.com", logo: null },
  { slug: "googlesheets", label: "Google Sheets", blurb: "Read and update spreadsheets", domain: "sheets.google.com", logo: null },
  { slug: "googledocs", label: "Google Docs", blurb: "Read and write documents", domain: "docs.google.com", logo: null },
  { slug: "googledrive", label: "Google Drive", blurb: "Browse and manage files", domain: "drive.google.com", logo: null },
  { slug: "notion", label: "Notion", blurb: "Pages and databases", domain: "notion.so", logo: null },
  { slug: "linear", label: "Linear", blurb: "Issues and project tracking", domain: "linear.app", logo: null },
  { slug: "sentry", label: "Sentry", blurb: "Errors and alerts", domain: "sentry.io", logo: null },
  { slug: "posthog", label: "PostHog", blurb: "Analytics, feature flags, experiments", domain: "posthog.com", logo: null },
  { slug: "discord", label: "Discord", blurb: "Messages and channels", domain: "discord.com", logo: null },
  { slug: "x", label: "X (Twitter)", blurb: "Post and read on X", domain: "x.com", logo: null },
  { slug: "reddit", label: "Reddit", blurb: "Browse and post", domain: "reddit.com", logo: null },
  { slug: "zapier", label: "Zapier", blurb: "Connect 9,000+ apps", domain: "zapier.com", logo: null },
  { slug: "hubspot", label: "HubSpot", blurb: "CRM search & updates", domain: "hubspot.com", logo: null },
  { slug: "salesforce", label: "Salesforce", blurb: "CRM records and reports", domain: "salesforce.com", logo: null },
  { slug: "jira", label: "Jira", blurb: "Issues and sprints", domain: "atlassian.com", logo: null },
  { slug: "asana", label: "Asana", blurb: "Tasks and projects", domain: "asana.com", logo: null },
  { slug: "trello", label: "Trello", blurb: "Boards and cards", domain: "trello.com", logo: null },
  { slug: "dropbox", label: "Dropbox", blurb: "Files and folders", domain: "dropbox.com", logo: null },
  { slug: "airtable", label: "Airtable", blurb: "Bases and records", domain: "airtable.com", logo: null },
  { slug: "figma", label: "Figma", blurb: "Files and comments", domain: "figma.com", logo: null },
  { slug: "stripe", label: "Stripe", blurb: "Payments and customers", domain: "stripe.com", logo: null },
];

let toolkitCache: { at: number; cards: ToolkitCard[] } | null = null;

/**
 * Marketplace catalog. Tries the v3 toolkits API (official names,
 * descriptions, logos — cached 10 min); falls back to the curated list.
 */
export async function listToolkits(cfg: AppConfig): Promise<{ cards: ToolkitCard[]; source: "api" | "curated" }> {
  if (toolkitCache && Date.now() - toolkitCache.at < 10 * 60_000) {
    return { cards: toolkitCache.cards, source: "api" };
  }
  const backendKey = cfg.composio?.apiKey ?? cfg.composio?.key;
  if (backendKey) {
    try {
      const res = await fetch(`${BACKEND_URL}/toolkits?limit=500&sort_by=usage`, {
        headers: { "x-api-key": backendKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const json: any = await res.json();
        const items = json.items ?? json.data ?? [];
        if (Array.isArray(items) && items.length) {
          const cards: ToolkitCard[] = items.map((t: any) => ({
            slug: (t.slug ?? t.key ?? t.name ?? "").toLowerCase(),
            label: t.name ?? t.slug ?? "",
            blurb: (t.meta?.description ?? t.description ?? "").slice(0, 90),
            logo: t.meta?.logo ?? t.logo ?? null,
            domain: null,
          }));
          toolkitCache = { at: Date.now(), cards };
          return { cards, source: "api" };
        }
      }
    } catch {
      /* fall through to curated */
    }
  }
  return { cards: CURATED, source: "curated" };
}

export const CURATED_SLUGS = CURATED.map((c) => c.slug);
