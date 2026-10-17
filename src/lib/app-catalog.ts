import { t } from "./i18n";
import type { LocaleKey } from "@/locales";

export interface CatalogCard {
  slug: string;
  categories?: string[];
}

export const INLINE_CATEGORY_COUNT = 5;
export const CATEGORY_SECTION_COUNT = 3;
export const CATEGORY_SECTION_SIZE = 4;

export function rankCategories(cards: readonly CatalogCard[], inline = INLINE_CATEGORY_COUNT): { inline: string[]; more: string[] } {
  const counts = new Map<string, number>();
  for (const card of cards) for (const category of new Set(card.categories ?? [])) counts.set(category, (counts.get(category) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
  return { inline: ranked.slice(0, inline), more: ranked.slice(inline) };
}

export function inCategory(card: CatalogCard, category: string | null): boolean {
  return category === null || (card.categories ?? []).includes(category);
}

export type CatalogSection<Card> =
  | { kind: "connected"; cards: Card[] }
  | { kind: "category"; category: string; cards: Card[]; more: boolean }
  | { kind: "all"; cards: Card[] };

export function catalogSections<Card extends CatalogCard>(
  cards: readonly Card[],
  isConnected: (slug: string) => boolean,
  categories: readonly string[],
): CatalogSection<Card>[] {
  const sections: CatalogSection<Card>[] = [];
  const connected = cards.filter((card) => isConnected(card.slug));
  if (connected.length) sections.push({ kind: "connected", cards: connected });
  for (const category of categories.slice(0, CATEGORY_SECTION_COUNT)) {
    const open = cards.filter((card) => !isConnected(card.slug) && inCategory(card, category));
    if (open.length) sections.push({ kind: "category", category, cards: open.slice(0, CATEGORY_SECTION_SIZE), more: open.length > CATEGORY_SECTION_SIZE });
  }
  sections.push({ kind: "all", cards: cards.filter((card) => !isConnected(card.slug)) });
  return sections;
}

// Catalog categories and blurbs come in English; the known ones show in the app's language.
const APP_CATEGORY_COPY: Record<string, string> = {
  productivity: "productivity",
  "developer tools": "developerTools",
  communication: "communication",
  files: "files",
  "sales and crm": "salesCrm",
  design: "design",
  marketing: "marketing",
  analytics: "analytics",
};

const CONNECTOR_COPY: Record<string, string> = {
  "google calendar": "googleCalendar",
  "google sheets": "googleSheets",
  "google docs": "googleDocs",
  notion: "notion",
  github: "github",
  linear: "linear",
  sentry: "sentry",
  jira: "jira",
  slack: "slack",
  gmail: "gmail",
  discord: "discord",
  "google drive": "googleDrive",
  posthog: "posthog",
  "x (twitter)": "xTwitter",
  reddit: "reddit",
  zapier: "zapier",
  hubspot: "hubspot",
  salesforce: "salesforce",
  asana: "asana",
  trello: "trello",
  dropbox: "dropbox",
  airtable: "airtable",
  figma: "figma",
  stripe: "stripe",
};

export function appCategoryLabel(name: string): string {
  const id = APP_CATEGORY_COPY[name.trim().toLowerCase()];
  return id ? t(`apps.category.${id}` as LocaleKey) : name;
}

export function connectorDescription(card: { label: string; blurb: string }): string {
  const id = CONNECTOR_COPY[card.label.trim().toLowerCase()];
  return id ? t(`apps.catalog.${id}.blurb` as LocaleKey) : card.blurb;
}
