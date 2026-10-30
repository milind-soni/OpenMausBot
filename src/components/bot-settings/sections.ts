import {
  BookOpen,
  Brain,
  CalendarClock,
  Coins,
  Cpu,
  Eye,
  History,
  LayoutDashboard,
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

export const BOT_SECTIONS: Array<{
  id: BotSettingsSection;
  label: string;
  labelKey?: LocaleKey;
  icon: LucideIcon;
  keywords: string[];
}> = [
  { id: "overview", label: "Overview", labelKey: "botSettings.sections.overview", icon: LayoutDashboard, keywords: ["summary", "status", "what it does", "won't", "prompt", "what the model sees"] },
  { id: "identity", label: "Identity", labelKey: "botSettings.sections.identity", icon: User, keywords: ["name", "title", "avatar", "blurb", "instructions"] },
  { id: "slack", label: "Slack", icon: Slack, keywords: ["slack", "slack app", "admin", "message", "direct messages", "mentions"] },
  { id: "soul", label: "Soul", labelKey: "botSettings.sections.soul", icon: Sparkles, keywords: ["standing instructions", "instructions", "persona", "rules", "soul.md"] },
  { id: "skills", label: "Skills", labelKey: "botSettings.sections.skills", icon: BookOpen, keywords: ["skills", "learned", "procedures", "teach"] },
  { id: "memory", label: "Memory", labelKey: "botSettings.sections.memory", icon: Brain, keywords: ["memory", "notes", "remember", "topics"] },
  { id: "routines", label: "Routines", labelKey: "botSettings.sections.routines", icon: CalendarClock, keywords: ["schedule", "routines", "cron", "tasks"] },
  { id: "access", label: "Access", labelKey: "botSettings.sections.access", icon: Network, keywords: ["works on", "computer", "vm", "cloud", "vps", "folder", "workspace", "browser", "connected apps", "composio", "webhooks", "always allow", "grants", "tool selection", "tools", "mcp", "allow", "exclude"] },
  { id: "model", label: "Model", labelKey: "botSettings.sections.model", icon: Cpu, keywords: ["engine", "model", "provider", "cli", "effort"] },
  { id: "permissions", label: "Permissions", labelKey: "botSettings.sections.permissions", icon: ShieldCheck, keywords: ["auto mode", "approve", "auto approve", "review", "routine approvals", "peers", "contact", "coordination", "chief of staff", "section"] },
  { id: "voice", label: "Voice & alerts", labelKey: "botSettings.sections.voice", icon: Mic, keywords: ["voice", "alerts", "notifications", "speak"] },
  { id: "visibility", label: "Who can see it", labelKey: "botSettings.visibility.title", icon: Eye, keywords: ["visibility", "who can see", "private", "people", "admins", "members", "access", "hide"] },
  { id: "history", label: "History", labelKey: "botSettings.sections.history", icon: History, keywords: ["history", "changes", "undo", "rollback", "log"] },
  { id: "usage", label: "Usage", labelKey: "botSettings.sections.usage", icon: Coins, keywords: ["tokens", "cost", "billing"] },
];
