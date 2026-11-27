// The community templates catalog (/api/team-library/catalog). Its names and
// summaries come in English; the built-in teams show in the app's language.
import { t } from "./i18n";
import type { LocaleKey } from "@/locales";
import type { TemplateAvatar } from "../../shared/share-card";

export interface TeamCatalogEntry {
  slug: string;
  name: string;
  summary: string;
  category: string;
  outcome?: string;
  setupMinutes?: number;
  featured?: boolean;
  package?: string;
  manifest: string;
  readme: string;
  /** A template folder (`teams/<slug>`), added through Import so a one-bot template joins no department. */
  folder?: string;
  kind?: "bot" | "department";
  /** Each bot's face; a picture arrives as a data: URL. */
  avatars?: TemplateAvatar[];
  members: number;
  skills: string[];
  requires: { apps: string[] };
  /** Who published it. */
  author?: string;
}

export interface TeamCatalog {
  repositoryUrl: string;
  teams: TeamCatalogEntry[];
}

const CATALOG_COPY: Record<string, string> = {
  "seo growth team": "seoGrowth",
  "engineering team": "engineering",
  "100x marketing team": "marketing100x",
  "reddit lead miner": "redditLeadMiner",
  "competitor watch": "competitorWatch",
  "inbox follow-up": "inboxFollowup",
};

export function catalogCopy(entry: TeamCatalogEntry): TeamCatalogEntry {
  const id = CATALOG_COPY[entry.name.trim().toLowerCase()];
  return id ? { ...entry, name: t(`templates.catalog.${id}.name` as LocaleKey), summary: t(`templates.catalog.${id}.summary` as LocaleKey), outcome: entry.outcome ? t(`templates.catalog.${id}.outcome` as LocaleKey) : undefined } : entry;
}

/** Search matches a team by its localized name and summary as well as its English ones, its category, skills and apps. */
export function catalogMatches(entry: TeamCatalogEntry, search: string): boolean {
  const copy = catalogCopy(entry);
  return `${copy.name} ${copy.summary} ${entry.name} ${entry.summary} ${entry.category} ${entry.skills.join(" ")} ${entry.requires.apps.join(" ")}`
    .toLowerCase()
    .includes(search);
}

const FACE_COLORS = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"];

/** The card's faces: the catalog's, or one mascot in a colour from the slug for a catalog that lists none. */
export function catalogFaces(entry: TeamCatalogEntry): TemplateAvatar[] {
  if (entry.avatars?.length) return entry.avatars;
  let hash = 0;
  for (const char of entry.slug) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return [{ key: entry.slug, name: entry.name, color: FACE_COLORS[hash % FACE_COLORS.length]! }];
}

/** The GitHub folder link Import reads a template folder from. */
export const catalogFolderLink = (repositoryUrl: string, entry: TeamCatalogEntry): string | null =>
  entry.folder ? `${repositoryUrl}/tree/main/${entry.folder}` : null;
