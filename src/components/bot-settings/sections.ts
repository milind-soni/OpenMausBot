import {
  BookOpen,
  Brain,
  CalendarClock,
  Coins,
  Cpu,
  Eye,
  History,
  LayoutDashboard,
  Library,
  type LucideIcon,
  Mic,
  Network,
  ShieldCheck,
  Slack,
  Sparkles,
  User,
} from "lucide-react";

import type { BotSettingsSection } from "@/state/store";
import type { LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import type { BotApps, BotAppsState } from "./useBotApps";

export const BOT_SECTIONS: Array<{
  id: BotSettingsSection;
  label: string;
  labelKey?: LocaleKey;
  icon: LucideIcon;
  keywords: string[];
  /** Headings shown inside the section, matched in the person's language. */
  headingKeys?: LocaleKey[];
}> = [
  { id: "overview", label: "Overview", labelKey: "botSettings.sections.overview", icon: LayoutDashboard, keywords: ["summary", "status", "what it does", "won't", "prompt", "what the model sees"] },
  { id: "identity", label: "Identity", labelKey: "botSettings.sections.identity", icon: User, keywords: ["name", "title", "avatar", "blurb", "instructions"] },
  { id: "slack", label: "Slack", icon: Slack, keywords: ["slack", "slack app", "admin", "message", "direct messages", "mentions"] },
  { id: "soul", label: "Soul", labelKey: "botSettings.sections.soul", icon: Sparkles, keywords: ["standing instructions", "instructions", "persona", "rules", "soul.md"] },
  { id: "skills", label: "Skills", labelKey: "botSettings.sections.skills", icon: BookOpen, keywords: ["skills", "learned", "procedures", "teach"] },
  { id: "memory", label: "Memory", labelKey: "botSettings.sections.memory", icon: Brain, keywords: ["memory", "notes", "remember", "topics"] },
  { id: "library", label: "Library", labelKey: "botPanel.tab.library", icon: Library, keywords: ["library", "made", "pages", "apps", "files", "published"] },
  { id: "routines", label: "Routines", labelKey: "botSettings.sections.routines", icon: CalendarClock, keywords: ["schedule", "routines", "cron", "tasks"] },
  { id: "access", label: "Access", labelKey: "botSettings.sections.access", icon: Network, keywords: ["works on", "computer", "vm", "cloud", "vps", "folder", "workspace", "browser", "connected apps", "composio", "webhooks", "always allow", "grants", "tool selection", "tools", "mcp", "allow", "exclude"], headingKeys: [
    "computer.worksOn", "botAccess.folder.title", "botAccess.apps.title", "botAccess.grants.header", "botAccess.phone.title",
    "research.title", "connectors.tab.mcp", "botAccess.tools.title", "botAccess.browser.title", "botAccess.recordSteps.title",
    "botAccess.webhooks.title", "botAccess.always.title",
  ] },
  { id: "model", label: "Model", labelKey: "botSettings.sections.model", icon: Cpu, keywords: ["engine", "model", "provider", "cli", "effort"] },
  { id: "permissions", label: "Permissions", labelKey: "botSettings.sections.permissions", icon: ShieldCheck, keywords: ["auto mode", "approve", "auto approve", "review", "routine approvals", "coordination", "chief of staff", "section"] },
  { id: "voice", label: "Voice & alerts", labelKey: "botSettings.sections.voice", icon: Mic, keywords: ["voice", "alerts", "notifications", "speak"] },
  { id: "visibility", label: "Who can see it", labelKey: "botSettings.visibility.title", icon: Eye, keywords: ["visibility", "who can see", "private", "people", "admins", "members", "access", "hide"] },
  { id: "history", label: "History", labelKey: "botSettings.sections.history", icon: History, keywords: ["history", "changes", "undo", "rollback", "log"] },
  { id: "usage", label: "Usage", labelKey: "botSettings.sections.usage", icon: Coins, keywords: ["tokens", "cost", "billing"] },
];

export type BotSectionEntry = (typeof BOT_SECTIONS)[number];

export const sectionLabel = (entry: BotSectionEntry) => (entry.labelKey ? t(entry.labelKey) : entry.label);

/** Whether a settings search (already trimmed and lowercased) finds this section. `appNames` are the bot's connected
 * apps, whose switches live in Access, so "github" finds Access when GitHub is connected. */
export function sectionMatches(entry: BotSectionEntry, query: string, appNames: readonly string[] = []): boolean {
  if (!query) return true;
  const headings = (entry.headingKeys ?? []).map((key) => t(key));
  const apps = entry.id === "access" ? appNames : [];
  return [entry.label, sectionLabel(entry), ...entry.keywords, ...headings, ...apps]
    .some((part) => part.toLowerCase().includes(query));
}

/** App names come from the connector inventory, the app catalog and the Email lookup; search keeps looking until all have answered. */
export function appSearchPhase(apps: Pick<BotAppsState, "phase" | "inventorySettled" | "cardsSettled" | "emailSettled">): BotApps["phase"] {
  return apps.inventorySettled && apps.cardsSettled && apps.emailSettled ? apps.phase : "loading";
}

/** The note shown when no section matches. Until the bot's connected apps have loaded, an app name may still match. */
export function searchEmptyText(query: string, appsPhase: BotApps["phase"]): string {
  return appsPhase === "loading" ? t("botSettings.searchLoading") : t("botSettings.searchNone", { query });
}
