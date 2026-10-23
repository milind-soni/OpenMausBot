import { Cloud, Archive, BookOpen, Building2, CircleUser, Download, Coins, FlaskConical, KeyRound, LockKeyhole, Monitor, Palette, ScrollText, ShieldCheck, Sparkles, TabletSmartphone, Terminal, User, Users, Zap } from "lucide-react";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { AppSettingsSection } from "@/state/store";

export type SettingsGroup = "you" | "ai" | "computers" | "account";

export const SETTINGS_GROUPS: Array<{ id: SettingsGroup; labelKey: LocaleKey }> = [
  { id: "you", labelKey: "settings.group.you" },
  { id: "ai", labelKey: "settings.group.ai" },
  { id: "computers", labelKey: "settings.group.computers" },
  { id: "account", labelKey: "settings.group.account" },
];

export const SECTIONS: Array<{
  id: AppSettingsSection;
  group: SettingsGroup;
  labelKey: LocaleKey;
  icon: typeof User;
  keywords: string[];
}> = [
  { id: "general", group: "you", labelKey: "settings.section.general", icon: User, keywords: ["profile", "name", "email", "about me", "about", "suggestions", "suggested", "memory", "analytics", "updates", "product updates", "news", "newsletter", "email updates", "effort", "new bots", "reasoning", "threads", "parallel", "concurrency", "cleanup", "retention", "event log", "event-log", "log size", "automatic recovery", "backup model", "fallback", "routines", "conversation", "schedule"] },
  { id: "appearance", group: "you", labelKey: "settings.section.appearance", icon: Palette, keywords: ["skin", "theme", "appearance", "chat width", "width", "wide", "full width", "bubble", "bubbles", "tools", "tool calls", "threads", "show threads", "hide threads", "sidebar", "density", "compact", "comfortable", "avatars", "display", "run", "this run", "run card", "commands", "notifications", "sound", "sounds", "mute", "silent", "chime", "pinned", "circles", "universal", "groups", "top", "send", "enter", "return", "shift+enter", "ctrl+enter", "cmd+enter", "⌘+enter", "new line", "keyboard", "ime", "japanese", "message color", "my messages", "toolbar", "tools layout", "footer", "routines", "triggers", "team map"] },
  { id: "companion", group: "you", labelKey: "settings.section.companion", icon: TabletSmartphone, keywords: ["companion", "device", "phone", "desktop", "client", "host", "pair", "pairing", "mobile", "https", "secure", "tailscale", "wifi", "remote", "advanced", "domain", "dns", "self-hosted", "server", "caddy"] },
  { id: "engines", group: "ai", labelKey: "settings.section.engines", icon: Terminal, keywords: ["models", "model providers", "engines", "claude", "codex", "grok", "providers", "cli", "sign in", "subscription"] },
  { id: "connections", group: "ai", labelKey: "settings.section.connections", icon: KeyRound, keywords: ["keys", "api", "api key", "api keys", "connections", "composio", "box", "xai", "mistral", "cerebras", "meta", "muse", "vps", "router", "openrouter", "base url", "openai", "anthropic", "groq", "opencode", "deepseek", "provider"] },
  { id: "decisionModel", group: "ai", labelKey: "settings.section.decisionModel", icon: Zap, keywords: ["decision", "jev", "typesafe", "routing", "auto", "rooms", "who answers"] },
  { id: "approvalReview", group: "ai", labelKey: "settings.section.approvalReview", icon: ShieldCheck, keywords: ["approval", "review", "reviewer", "rubric", "authorization", "permissions"] },
  { id: "skills", group: "ai", labelKey: "settings.section.skills", icon: BookOpen, keywords: ["skills", "library", "assign", "agent skills", "skill md"] },
  { id: "desktopWorkspaces", group: "computers", labelKey: "settings.section.desktopWorkspaces", icon: Building2, keywords: ["workspace", "cloud", "hosted", "vps", "server", "servers", "connect", "pair", "switch", "local"] },
  { id: "computer", group: "computers", labelKey: "settings.section.computer", icon: Monitor, keywords: ["vm", "virtual", "desktop", "browser", "built-in browser", "profiles", "browser profiles"] },
  { id: "logins", group: "computers", labelKey: "settings.section.logins", icon: LockKeyhole, keywords: ["logins", "login", "passwords", "password", "sign in", "2fa", "one-time code", "totp", "fill_login", "1password", "vault"] },
  { id: "cloudAccount", group: "account", labelKey: "settings.section.cloudAccount", icon: Cloud, keywords: ["cloud", "my cloud", "account", "personal", "sign in", "pro", "subscription", "billing", "sync", "send", "this computer", "bots", "logins", "1password", "lend"] },
  { id: "organization", group: "account", labelKey: "settings.section.organization", icon: Building2, keywords: ["company", "organization", "organisation", "sign in", "enroll", "managed", "models", "disconnect"] },
  { id: "usage", group: "account", labelKey: "settings.section.usage", icon: Coins, keywords: ["tokens", "cost", "billing", "plan", "quota", "remaining", "weekly", "5-hour", "model", "used"] },
  { id: "backups", group: "account", labelKey: "settings.section.backups", icon: Archive, keywords: ["export", "import", "restore", "full backup", "password", "recovery"] },
  { id: "import", group: "account", labelKey: "settings.section.import", icon: Download, keywords: ["import", "grok", "grok bot", "x.ai", "cursor", "claude code", "codex", "gemini", "skills", "mcp", "tools", "bring"] },
  { id: "people", group: "account", labelKey: "settings.section.people", icon: Users, keywords: ["people", "users", "invite", "sign in", "members", "admins", "access"] },
  { id: "activity", group: "account", labelKey: "settings.section.activity", icon: ScrollText, keywords: ["activity", "audit", "log", "history", "who changed", "approvals", "decisions", "admin"] },
  { id: "workspaces", group: "account", labelKey: "settings.section.workspaces", icon: Building2, keywords: ["clients", "tenants", "fleet", "workspaces", "installation", "installations"] },
  { id: "experimental", group: "account", labelKey: "settings.section.experimental", icon: FlaskConical, keywords: ["early", "preview", "learn", "skill", "authoring"] },
];

export type SimpleSettingsPage = {
  id: string;
  labelKey: LocaleKey;
  icon: typeof User;
  sections: AppSettingsSection[];
};

export const SIMPLE_PAGES: SimpleSettingsPage[] = [
  { id: "general", labelKey: "settings.section.general", icon: User, sections: ["general"] },
  { id: "appearance", labelKey: "settings.section.appearance", icon: Palette, sections: ["appearance"] },
  { id: "ai", labelKey: "settings.group.ai", icon: Sparkles, sections: ["engines", "connections", "decisionModel", "approvalReview"] },
  { id: "computers", labelKey: "settings.group.computers", icon: Monitor, sections: ["companion", "desktopWorkspaces", "computer", "logins"] },
  { id: "cloud", labelKey: "settings.section.cloudAccount", icon: Cloud, sections: ["cloudAccount"] },
  { id: "account", labelKey: "settings.group.account", icon: CircleUser, sections: ["organization", "import", "people", "activity", "usage"] },
];

export const SIMPLE_HIDDEN_SECTIONS: readonly AppSettingsSection[] = ["backups", "experimental", "workspaces", "skills"];

export function simpleSettingsPages(
  available: ReadonlyArray<(typeof SECTIONS)[number]>,
  open: AppSettingsSection,
): SimpleSettingsPage[] {
  const allowed = new Set(available.map((entry) => entry.id));
  const pages = SIMPLE_PAGES
    .map((page) => ({ ...page, sections: page.sections.filter((id) => allowed.has(id)) }))
    .filter((page) => page.sections.length > 0);
  const hidden = SIMPLE_HIDDEN_SECTIONS.includes(open) ? available.find((entry) => entry.id === open) : undefined;
  if (hidden) pages.push({ id: hidden.id, labelKey: hidden.labelKey, icon: hidden.icon, sections: [hidden.id] });
  return pages;
}

export function revealSettingsBlock(
  scroller: { scrollTop: number; querySelector: (selector: string) => { scrollIntoView?: (options: ScrollIntoViewOptions) => void } | null },
  section: AppSettingsSection,
  indexInPage: number,
): void {
  if (indexInPage <= 0) { scroller.scrollTop = 0; return; }
  scroller.querySelector(`[data-settings-block="${section}"]`)?.scrollIntoView?.({ block: "start" });
}

export function simplePageMatches(page: SimpleSettingsPage, query: string): boolean {
  if (!query) return true;
  if (t(page.labelKey).toLowerCase().includes(query)) return true;
  return page.sections.some((id) => {
    const entry = SECTIONS.find((candidate) => candidate.id === id);
    return entry ? sectionMatches(entry, query) : false;
  });
}

export function sectionMatches(section: (typeof SECTIONS)[number], query: string): boolean {
  if (!query) return true;
  return [t(section.labelKey), ...section.keywords].some((part) => part.toLowerCase().includes(query));
}
