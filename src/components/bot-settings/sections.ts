// The bot settings dialog's section rail — one entry per BotSettingsSection,
// in the fixed order the rail renders them. Search filters against label
// plus keywords, the same convention as the app SettingsModal's SECTIONS.
import {
  BookOpen,
  Brain,
  CalendarClock,
  Coins,
  Cpu,
  History,
  LayoutDashboard,
  type LucideIcon,
  Mic,
  Network,
  ShieldCheck,
  Sparkles,
  User,
} from "lucide-react";

import type { LocaleKey } from "@/locales";
import type { BotSettingsSection } from "@/state/store";

/** A rendered label would freeze the language this module was imported in,
 * and search compares against it — so the rail carries the key and the dialog
 * resolves it while it renders. Keywords stay English: they are what someone
 * types, and the English term is what the docs and the CLI use. */
export const BOT_SECTIONS: Array<{
  id: BotSettingsSection;
  labelKey: LocaleKey;
  icon: LucideIcon;
  keywords: string[];
}> = [
  { id: "overview", labelKey: "botSettings.section.overview", icon: LayoutDashboard, keywords: ["summary", "status", "what it does", "won't", "prompt", "what the model sees"] },
  { id: "identity", labelKey: "botSettings.section.identity", icon: User, keywords: ["name", "title", "avatar", "blurb", "instructions"] },
  { id: "soul", labelKey: "botSettings.section.soul", icon: Sparkles, keywords: ["standing instructions", "instructions", "persona", "rules", "soul.md"] },
  { id: "skills", labelKey: "botSettings.section.skills", icon: BookOpen, keywords: ["skills", "learned", "procedures", "teach"] },
  { id: "memory", labelKey: "botSettings.section.memory", icon: Brain, keywords: ["memory", "notes", "remember", "topics"] },
  { id: "routines", labelKey: "botSettings.section.routines", icon: CalendarClock, keywords: ["schedule", "routines", "cron", "tasks"] },
  { id: "access", labelKey: "botSettings.section.access", icon: Network, keywords: ["works on", "computer", "vm", "cloud", "vps", "folder", "workspace", "browser", "connected apps", "composio", "webhooks", "always allow", "grants"] },
  { id: "model", labelKey: "botSettings.section.model", icon: Cpu, keywords: ["engine", "model", "provider", "cli", "effort"] },
  { id: "permissions", labelKey: "botSettings.section.permissions", icon: ShieldCheck, keywords: ["auto mode", "approve", "auto approve", "review", "routine approvals", "peers", "contact", "coordination", "chief of staff", "section"] },
  { id: "voice", labelKey: "botSettings.section.voice", icon: Mic, keywords: ["voice", "alerts", "notifications", "speak"] },
  { id: "history", labelKey: "botSettings.section.history", icon: History, keywords: ["history", "changes", "undo", "rollback", "log"] },
  { id: "usage", labelKey: "botSettings.section.usage", icon: Coins, keywords: ["tokens", "cost", "billing"] },
];
