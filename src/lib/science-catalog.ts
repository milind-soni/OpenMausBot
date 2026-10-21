import { ALL_VIEW_SCIENCE_IDS, isBenchlingTenantUrl, type CatalogAuth, type CatalogEntry, type CatalogGroup, type CatalogResponse, type CatalogSection, type ScienceTag } from "../../shared/connector-catalog";
import type { LocaleKey } from "@/locales";
import { t } from "./i18n";

export interface ScienceServer {
  name: string;
  url: string;
  enabled: boolean;
  auth?: "signed-in" | "needs-sign-in" | "needs-max";
  catalog?: { id: string; auth: CatalogAuth };
}

const NAME_LIMIT = 32;

const TAG_KEYS: Record<ScienceTag, LocaleKey> = {
  "no-account": "science.tag.noAccount",
  "free-account": "science.tag.freeAccount",
  "paid-account": "science.tag.paidAccount",
  subscription: "science.tag.subscription",
};

const GROUP_KEYS: Record<string, LocaleKey> = {
  papers: "science.group.papers",
  targets: "science.group.targets",
  clinical: "science.group.clinical",
  lab: "science.group.lab",
};

export function scienceServers(listing: unknown[]): ScienceServer[] {
  const servers: ScienceServer[] = [];
  for (const item of listing) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.name !== "string" || typeof raw.url !== "string") continue;
    const server: ScienceServer = { name: raw.name, url: raw.url, enabled: raw.enabled !== false };
    if (raw.auth === "signed-in" || raw.auth === "needs-sign-in" || raw.auth === "needs-max") server.auth = raw.auth;
    const marker = raw.catalog as { id?: unknown; auth?: unknown } | undefined;
    if (marker && typeof marker.id === "string" && (marker.auth === "cloud" || marker.auth === "oauth" || marker.auth === "tenant")) {
      server.catalog = { id: marker.id, auth: marker.auth };
    }
    servers.push(server);
  }
  return servers;
}

export function scienceSection(catalog: CatalogResponse): CatalogSection | null {
  return catalog.sections.find((s) => s.id === "science") ?? null;
}

function normalizedUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return null;
  }
}

export function entryServer(entry: CatalogEntry, servers: ScienceServer[]): ScienceServer | null {
  const marked = servers.find((s) => s.catalog?.id === entry.id);
  if (marked) return marked;
  const unmarked = servers.filter((s) => !s.catalog);
  if (entry.auth === "tenant") return unmarked.find((s) => isBenchlingTenantUrl(s.url)) ?? null;
  const wanted = entry.url ? normalizedUrl(entry.url) : null;
  if (!wanted) return null;
  return unmarked.find((s) => normalizedUrl(s.url) === wanted) ?? null;
}

export function serverConnected(server: ScienceServer | null): boolean {
  return !!server && server.enabled && server.auth !== "needs-sign-in" && server.auth !== "needs-max";
}

export function catalogServerName(id: string, taken: readonly string[]): string {
  const used = new Set(taken);
  const base = id.slice(0, NAME_LIMIT);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const name = `${id.slice(0, NAME_LIMIT - suffix.length)}${suffix}`;
    if (!used.has(name)) return name;
  }
}

export function matchesSearch(entry: CatalogEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || `${entry.name} ${entry.description}`.toLowerCase().includes(q);
}

export function groupedEntries(section: CatalogSection, query: string): Array<{ group: CatalogGroup; entries: CatalogEntry[] }> {
  return section.groups
    .map((group) => ({ group, entries: section.entries.filter((e) => e.group === group.id && matchesSearch(e, query)) }))
    .filter((g) => g.entries.length > 0);
}

export function allViewEntries(section: CatalogSection, query: string): CatalogEntry[] {
  if (query.trim()) return section.entries.filter((e) => matchesSearch(e, query));
  return ALL_VIEW_SCIENCE_IDS.flatMap((id) => section.entries.filter((e) => e.id === id));
}

export function publicEntries(section: CatalogSection): CatalogEntry[] {
  return section.entries.filter((e) => e.tag === "no-account");
}

export function connectedEntries(section: CatalogSection, servers: ScienceServer[]): CatalogEntry[] {
  return section.entries.filter((e) => serverConnected(entryServer(e, servers)));
}

export function groupTitle(group: CatalogGroup): string {
  const key = GROUP_KEYS[group.id];
  return key ? t(key) : group.title;
}

export function tagLabel(tag: ScienceTag): string {
  return t(TAG_KEYS[tag]);
}
