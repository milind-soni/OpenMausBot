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

import type { BotSettingsSection } from "@/state/store";

export const BOT_SECTIONS: Array<{
  id: BotSettingsSection;
  label: string;
  icon: LucideIcon;
  keywords: string[];
}> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard, keywords: ["summary", "status", "what it does", "won't", "prompt", "what the model sees"] },
  { id: "identity", label: "Identity", icon: User, keywords: ["name", "title", "avatar", "blurb", "instructions"] },
  { id: "soul", label: "Soul", icon: Sparkles, keywords: ["standing instructions", "instructions", "persona", "rules", "soul.md"] },
  { id: "skills", label: "Skills", icon: BookOpen, keywords: ["skills", "learned", "procedures", "teach"] },
  { id: "memory", label: "Memory", icon: Brain, keywords: ["memory", "notes", "remember", "topics"] },
  { id: "routines", label: "Routines", icon: CalendarClock, keywords: ["schedule", "routines", "cron", "tasks"] },
  { id: "access", label: "Access", icon: Network, keywords: ["works on", "computer", "vm", "cloud", "vps", "folder", "workspace", "browser", "connected apps", "composio", "webhooks", "always allow", "grants"] },
  { id: "model", label: "Model", icon: Cpu, keywords: ["engine", "model", "provider", "cli", "effort"] },
  { id: "permissions", label: "Permissions", icon: ShieldCheck, keywords: ["auto mode", "approve", "auto approve", "review", "routine approvals", "peers", "contact", "coordination", "chief of staff", "section"] },
  { id: "voice", label: "Voice & alerts", icon: Mic, keywords: ["voice", "alerts", "notifications", "speak"] },
  { id: "history", label: "History", icon: History, keywords: ["history", "changes", "undo", "rollback", "log"] },
  { id: "usage", label: "Usage", icon: Coins, keywords: ["tokens", "cost", "billing"] },
];
