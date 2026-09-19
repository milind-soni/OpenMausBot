// Marketplace catalog: toolkit cards from the v3 API with the curated
// list as fallback.
import type { AppConfig } from "../config.ts";
import {
  backendFingerprint,
  brokerAccess,
  canonicalToolkitSlug,
  MAX_CONNECTED_ACCOUNT_PAGES,
  projectApiKey,
  toolkitBase,
} from "./state.ts";
import { brokerRequest } from "./broker.ts";

// ── marketplace catalog ────────────────────────────────────────────────
export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  /** Toolkits such as public search need no user authorization. */
  noAuth?: boolean;
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
  { slug: "twitter", label: "X (Twitter)", blurb: "Post and read on X", domain: "x.com", logo: null },
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

let toolkitCache: { at: number; cards: ToolkitCard[]; identity: string } | null = null;

/**
 * Marketplace catalog. Tries the v3 toolkits API (official names,
 * descriptions, logos — cached 10 min); falls back to the curated list.
 */
export async function listToolkits(cfg: AppConfig): Promise<{ cards: ToolkitCard[]; source: "api" | "curated" }> {
  const backendKey = projectApiKey(cfg);
  const broker = backendKey ? null : brokerAccess();
  const identity = backendKey
    ? backendFingerprint("project-catalog", toolkitBase(), backendKey)
    : broker
      ? backendFingerprint("managed-catalog", broker.url, broker.token)
      : null;
  if (identity && toolkitCache?.identity === identity && Date.now() - toolkitCache.at < 10 * 60_000) {
    return { cards: toolkitCache.cards, source: "api" };
  }
  if (backendKey || broker) {
    try {
      // The marketplace runs to well over a thousand toolkits and the endpoint
      // is cursor-paginated, so one page stops partway through the alphabet.
      // Follow next_cursor, and keep the pages already collected if a later
      // one fails — a partial catalog still beats the curated two dozen.
      const items: any[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let lastReportedPage: number | undefined;
      for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
        const params = new URLSearchParams({ limit: "500", sort_by: "usage" });
        if (cursor) params.set("cursor", cursor);
        const res = backendKey
          ? await fetch(`${toolkitBase()}/toolkits?${params}`, {
              headers: { "x-api-key": backendKey },
              signal: AbortSignal.timeout(15_000),
            })
          : await brokerRequest(cursor ? `/v1/catalog?cursor=${encodeURIComponent(cursor)}` : "/v1/catalog", {
              signal: AbortSignal.timeout(15_000),
            });
        if (!res.ok) break;
        const json: any = await res.json();
        const pageItems = json.items ?? json.data ?? [];
        if (!Array.isArray(pageItems)) break;
        items.push(...pageItems);
        // Composio reports current_page and total_pages beside next_cursor.
        // A broker that drops the cursor (or an upstream regression) can replay
        // a page while minting fresh cursors, so trust page movement: once it
        // stops advancing, the catalog is stuck and paging stops cleanly.
        const reportedPage = Number(json.current_page);
        if (Number.isFinite(reportedPage)) {
          if (lastReportedPage !== undefined && reportedPage <= lastReportedPage) break;
          lastReportedPage = reportedPage;
        }
        const reportedTotalPages = Number(json.total_pages);
        if (
          lastReportedPage !== undefined &&
          Number.isFinite(reportedTotalPages) &&
          reportedTotalPages > 0 &&
          lastReportedPage >= reportedTotalPages
        ) {
          break;
        }
        const next = typeof json.next_cursor === "string" ? json.next_cursor.trim() : "";
        if (!next || seenCursors.has(next)) break;
        seenCursors.add(next);
        cursor = next;
      }
      if (items.length) {
        const cards: ToolkitCard[] = items.map((t: any) => ({
          slug: canonicalToolkitSlug(String(t.slug ?? t.key ?? t.name ?? "")),
          label: t.name ?? t.slug ?? "",
          blurb: (t.meta?.description ?? t.description ?? "").slice(0, 90),
          logo: t.meta?.logo ?? t.logo ?? null,
          noAuth: t.no_auth === true,
          domain: null,
        }));
        const uniqueCards = cards.filter(
          (card, index) => card.slug && cards.findIndex((candidate) => candidate.slug === card.slug) === index,
        );
        toolkitCache = { at: Date.now(), cards: uniqueCards, identity: identity! };
        return { cards: uniqueCards, source: "api" };
      }
    } catch {
      /* fall through to curated */
    }
  }
  return { cards: CURATED, source: "curated" };
}

export async function toolkitCard(cfg: AppConfig, slug: string): Promise<ToolkitCard> {
  const normalized = canonicalToolkitSlug(slug);
  const { cards } = await listToolkits(cfg);
  return cards.find((card) => card.slug.toLowerCase() === normalized)
    ?? CURATED.find((card) => card.slug === normalized)
    ?? {
      slug: normalized,
      label: normalized.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      blurb: "Connect this app so your bot can continue",
      logo: null,
      domain: null,
    };
}

export const CURATED_SLUGS = CURATED.map((c) => c.slug);
