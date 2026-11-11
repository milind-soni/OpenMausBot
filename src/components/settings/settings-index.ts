import {
  Archive, Bot, Coins, CreditCard, LockKeyhole, Monitor, Palette, Server, SlidersHorizontal, Smartphone, Sparkles, Users,
  type LucideIcon,
} from "lucide-react";
import type { LocaleKey } from "@/locales";
import type { AppSettingsSection, SettingsPageId } from "@/state/store";

export type { SettingsPageId };
export type SettingsOwner = "place" | "account" | "app";

/** What this page can show, read once per render from the bridge, the server's config and the session. */
export interface SettingsContext {
  /** the desktop app's own window (any place in it), not a browser tab */
  desktop: boolean;
  /** this computer's own page */
  here: boolean;
  /** main says this page is the app's home (home:page): This computer's page, or My Cloud's own page once it is home.
   * The one source for whether This app's rows (Open at login, Logs and diagnostics) and the account live here. */
  home: boolean;
  /** a MausBot Cloud's page, personal or a team's */
  cloud: boolean;
  team: boolean;
  /** this app drives another computer (paired-client mode) */
  client: boolean;
  admin: boolean;
  /** the window has a rail, or the app knows two places or more */
  places: boolean;
  /** Plan & billing can be read here: the desktop's plan bridge, or a personal Cloud's owner in a browser */
  plan: boolean;
  organization: boolean;
  environments: boolean;
  installations: boolean;
  skills: boolean;
  advanced: boolean;
}

export interface SettingsPage {
  id: SettingsPageId;
  owner: SettingsOwner;
  /** the nav label; an identity page's label is its owner's (the place's name, Your account, This app) */
  labelKey: LocaleKey;
  icon?: LucideIcon;
  synonyms: string[];
  when: (ctx: SettingsContext) => boolean;
}

const notClient = (ctx: SettingsContext) => !ctx.client;
/** What only an admin can use: a team's member isn't offered it at all (the installation's AI, desktops, spending, data). */
const adminPage = (ctx: SettingsContext) => !ctx.client && !(ctx.team && !ctx.admin);
/** A page Simple mode leaves out: its everyday rows show elsewhere in Simple (Overview, This app, Plan & billing). */
const advancedOnly = (when: (ctx: SettingsContext) => boolean) => (ctx: SettingsContext) => ctx.advanced && when(ctx);
/** Simple mode's eight entries: the place (Overview, Phone & devices, AI, Vault), Your account (Plan & billing) and
 * This app (Appearance). Advanced adds You and your bots, Desktops & browser, Spending, Data and General. */
export const ADVANCED_PAGES: readonly SettingsPageId[] = ["bots", "desktops", "usage", "data", "general"];

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: "overview", owner: "place", labelKey: "settings.page.overview", synonyms: ["overview", "place", "status", "version", "domain", "address", "sidebar"], when: () => true },
  { id: "phone", owner: "place", labelKey: "settings.section.phoneDevices", icon: Smartphone, when: notClient,
    synonyms: ["phone", "pair", "pairing", "qr", "code", "iphone", "android", "mobile", "tablet", "device", "devices", "wifi", "wi-fi", "anywhere", "relay", "remote", "companion", "tailscale", "connect your phone", "get the phone app", "pair a device", "this server", "remote access"] },
  { id: "ai", owner: "place", labelKey: "settings.group.ai", icon: Sparkles, when: adminPage,
    synonyms: ["ai", "models", "model providers", "providers", "engines", "api keys", "keys", "key", "claude", "codex", "openai", "anthropic", "ollama", "lm studio", "local model"] },
  { id: "bots", owner: "place", labelKey: "settings.page.bots", icon: Bot, when: advancedOnly(notClient),
    synonyms: ["all bots", "bots", "about you", "about me", "profile", "new bots", "defaults", "effort", "limits", "rules"] },
  { id: "desktops", owner: "place", labelKey: "settings.page.desktops", icon: Monitor, when: advancedOnly(adminPage),
    synonyms: ["bot desktops", "computer", "desktop", "desktops", "browser", "built-in browser", "private desktop", "sandbox", "docker", "podman", "container", "vps", "own server", "cloud desktops"] },
  { id: "vault", owner: "place", labelKey: "settings.section.vault", icon: LockKeyhole, when: notClient,
    synonyms: ["vault", "password", "passwords", "login", "logins", "secrets", "1password", "2fa"] },
  { id: "usage", owner: "place", labelKey: "settings.page.spending", icon: Coins, when: advancedOnly(adminPage),
    synonyms: ["spending", "usage", "cost", "costs", "tokens", "money", "runs", "export csv"] },
  { id: "data", owner: "place", labelKey: "settings.page.data", icon: Archive, when: advancedOnly(adminPage),
    synonyms: ["data", "backup", "backups", "export", "import", "restore", "storage", "attachments", "activity", "audit"] },
  { id: "people", owner: "place", labelKey: "settings.section.people", icon: Users,
    when: (ctx) => !ctx.client && ctx.admin && (ctx.team || (!ctx.desktop && !ctx.cloud)),
    synonyms: ["people", "members", "invite", "roles", "bot access", "sharing", "team"] },
  { id: "installations", owner: "place", labelKey: "settings.section.workspaces", icon: Server, when: (ctx) => !ctx.client && ctx.installations,
    synonyms: ["installations", "fleet", "clients", "tenants"] },
  { id: "account", owner: "account", labelKey: "settings.page.account", when: () => true,
    synonyms: ["account", "sign in", "log in", "log out", "sign out", "email", "organization", "mausbot cloud"] },
  { id: "plan", owner: "account", labelKey: "settings.page.plan", icon: CreditCard, when: (ctx) => !ctx.client && ctx.plan,
    synonyms: ["plan", "billing", "subscription", "invoice", "receipt", "payment", "card", "upgrade", "trial", "cancel", "refund", "usage & billing", "mausbot cloud", "weekly", "limits"] },
  { id: "app", owner: "app", labelKey: "settings.page.app", when: () => true,
    synonyms: ["this app", "updates", "update", "version", "help", "about", "servers", "your computers", "environments", "diagnostics", "logs", "tour"] },
  { id: "general", owner: "app", labelKey: "settings.section.general", icon: SlidersHorizontal, when: advancedOnly(() => true),
    synonyms: ["general", "language", "typing", "send", "enter", "notifications", "sounds", "startup", "login", "analytics", "privacy", "talk"] },
  { id: "appearance", owner: "app", labelKey: "settings.section.appearance", icon: Palette, when: () => true,
    synonyms: ["appearance", "theme", "skin", "looks", "dark mode", "light mode", "font", "chat width", "layout", "threads", "pins"] },
];

export const OWNERS: readonly SettingsOwner[] = ["place", "account", "app"];

export const pageById = (id: SettingsPageId): SettingsPage => SETTINGS_PAGES.find((page) => page.id === id)!;

export function visiblePages(ctx: SettingsContext): SettingsPage[] {
  return SETTINGS_PAGES.filter((page) => page.when(ctx));
}

export interface SettingsTarget {
  page: SettingsPageId;
  anchor?: string;
}

/** Every older page name, as notices, links and the native menu still send them, and where it now lives. */
export const LEGACY_SETTINGS: Record<Exclude<AppSettingsSection, SettingsPageId>, (ctx: SettingsContext) => SettingsTarget> = {
  desktopWorkspaces: () => ({ page: "app", anchor: "your-computers" }),
  organization: () => ({ page: "account", anchor: "organization" }),
  cloudAccount: (ctx) => (ctx.plan ? { page: "plan", anchor: "plan" } : { page: "account" }),
  experimental: () => ({ page: "bots", anchor: "early" }),
  connections: () => ({ page: "ai", anchor: "ai-keys" }),
  decisionModel: () => ({ page: "ai", anchor: "routing" }),
  imageGeneration: () => ({ page: "ai", anchor: "images" }),
  engines: () => ({ page: "ai", anchor: "providers" }),
  companion: () => ({ page: "phone" }),
  remote: (ctx) => (ctx.client ? { page: "app", anchor: "your-computers" } : { page: "phone" }),
  computer: () => ({ page: "desktops" }),
  logins: () => ({ page: "vault" }),
  botAccess: () => ({ page: "people", anchor: "bot-access" }),
  activity: () => ({ page: "data", anchor: "activity" }),
  backups: () => ({ page: "data", anchor: "backups" }),
  workspaces: () => ({ page: "installations" }),
  skills: () => ({ page: "bots", anchor: "skills" }),
  import: () => ({ page: "data", anchor: "bring-in" }),
  updates: (ctx) => (ctx.desktop ? { page: "app", anchor: "updates" } : { page: "overview" }),
};

const isPage = (id: AppSettingsSection): id is SettingsPageId => SETTINGS_PAGES.some((page) => page.id === id);

/** True when a row or section is one Advanced mode adds (on a page Simple shows, or on an Advanced-only page). */
export function needsAdvanced(target: SettingsTarget, ctx: SettingsContext): boolean {
  if (ctx.advanced || !pageById(target.page).when({ ...ctx, advanced: true })) return false;
  if (!pageById(target.page).when(ctx)) return true;
  return Boolean(target.anchor && SETTINGS_INDEX.some((entry) => entry.page === target.page && entry.anchor === target.anchor && entry.advanced));
}

/** Where a request for Settings lands here: its page (or Overview when that page can't exist on this place) and the
 * section to scroll to. A page or row only Advanced mode shows comes back with `advanced`: opening it turns Advanced on. */
export function resolveSettingsTarget(requested: AppSettingsSection, ctx: SettingsContext): SettingsTarget & { missing?: SettingsPageId; advanced?: true } {
  const target = isPage(requested) ? { page: requested } : LEGACY_SETTINGS[requested](ctx);
  if (needsAdvanced(target, ctx)) return { ...target, advanced: true };
  if (pageById(target.page).when(ctx)) return target;
  return { page: "overview", missing: target.page };
}

/** A context with every page showing (Advanced mode), for tests and previews to narrow down. */
export const fullContext = (over: Partial<SettingsContext> = {}): SettingsContext => ({
  desktop: true, here: true, home: true, cloud: false, team: false, client: false, admin: true, places: false, plan: true,
  organization: false, environments: true, installations: false, skills: false, advanced: true, ...over,
});

/** One row, section or page search can open. `label` beats `labelKey` where the name is not a string of the app's. */
export interface SettingsIndexEntry {
  id: string;
  page: SettingsPageId;
  anchor?: string;
  labelKey: LocaleKey;
  /** the section the row sits in, for its location line */
  sectionKey?: LocaleKey;
  synonyms?: string[];
  /** words for which this entry ranks first */
  topFor?: string[];
  advanced?: boolean;
  when?: (ctx: SettingsContext) => boolean;
  /** opens something outside Settings instead of a row */
  jump?: "apps" | "automations" | "shortcuts" | "bot";
  /** where Simple mode shows this row, when that is another page than Advanced's (General's language on This app) */
  simple?: { page: SettingsPageId; anchor?: string };
}

const desk = (ctx: SettingsContext) => ctx.desktop && !ctx.client;
const hereOnly = (ctx: SettingsContext) => ctx.here;
const browserAdmin = (ctx: SettingsContext) => !ctx.desktop && ctx.admin;

export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = [
  { id: "pair", page: "phone", anchor: "pair", labelKey: "phone.pair.button", sectionKey: "phone.pair.section", topFor: ["phone", "pair", "pairing", "qr", "iphone", "android", "this server", "pair a device", "connect your phone"],
    synonyms: ["code", "mobile", "tablet", "companion", "get the phone app"] },
  { id: "paired", page: "phone", anchor: "paired", labelKey: "devices.paired", synonyms: ["devices", "remove", "revoke", "pair again"] },
  { id: "wifi", page: "phone", anchor: "reach", labelKey: "devices.route.wifi", sectionKey: "phone.reach.title", when: hereOnly, synonyms: ["wifi", "wi-fi", "lan", "local network"] },
  { id: "relay", page: "phone", anchor: "reach", labelKey: "devices.route.relay", sectionKey: "phone.reach.title", when: hereOnly, synonyms: ["anywhere", "relay", "away"] },
  { id: "keep-awake", page: "phone", anchor: "reach", labelKey: "remote.keepAwake", sectionKey: "phone.reach.title", when: hereOnly, synonyms: ["sleep", "awake", "overnight", "scheduled"] },
  { id: "wake-automations", page: "phone", labelKey: "settings.search.wakeAutomations", jump: "automations", when: hereOnly, topFor: ["sleep", "overnight", "scheduled"], synonyms: ["awake"] },
  { id: "tailscale", page: "phone", anchor: "reach", labelKey: "devices.moreWays", sectionKey: "phone.reach.title", when: hereOnly, advanced: true, synonyms: ["tailscale", "https", "tailnet"] },
  { id: "domain", page: "overview", anchor: "address", labelKey: "settings.overview.address", when: (ctx) => !ctx.here && !ctx.client, synonyms: ["domain", "dns", "https", "custom domain"] },
  { id: "sidebar-color", page: "overview", anchor: "sidebar", labelKey: "placeLook.sidebarColor", sectionKey: "settings.overview.sidebar", synonyms: ["color", "colour", "tint", "cloud color"] },
  { id: "sidebar-picture", page: "overview", anchor: "sidebar", labelKey: "placeLook.sidebarPicture", sectionKey: "settings.overview.sidebar", topFor: ["wallpaper", "background", "sidebar image"], synonyms: ["picture", "banner", "image"] },
  { id: "show-helper", page: "overview", anchor: "sidebar", labelKey: "settings.search.showHelper", sectionKey: "settings.overview.sidebar", synonyms: ["helper", "starter", "default bot"] },
  { id: "providers", page: "ai", anchor: "providers", labelKey: "settings.ai.providers", topFor: ["ollama", "lm studio", "local model", "model providers"], synonyms: ["models", "engines", "claude", "codex", "sign in", "subscription", "cli"] },
  { id: "keys", page: "ai", anchor: "ai-keys", labelKey: "settings.ai.otherServices", topFor: ["api keys", "api key"], synonyms: ["keys", "key", "openai", "anthropic", "xai", "openrouter", "router", "base url", "mistral", "groq", "cerebras", "deepseek", "opencode", "composio", "elevenlabs"] },
  { id: "backup-model", page: "ai", anchor: "backup-model", labelKey: "settings.recovery.title", sectionKey: "settings.ai.backupModel", advanced: true, synonyms: ["backup model", "fallback", "recovery"] },
  { id: "routing", page: "ai", anchor: "routing", labelKey: "settings.ai.routing", advanced: true, synonyms: ["decision and extraction", "decision", "extraction", "routing", "who answers", "jev", "typesafe", "cloudflare", "workers ai"] },
  { id: "images", page: "ai", anchor: "images", labelKey: "settings.ai.images", advanced: true, synonyms: ["image generation", "images", "generate", "picture"] },
  { id: "about-you", page: "bots", anchor: "about-you", labelKey: "settings.bots.aboutYou", topFor: ["name", "my name", "photo", "avatar", "picture", "profile", "profile picture", "about me"], synonyms: ["rules", "rules for every bot"] },
  { id: "away-emails", page: "bots", anchor: "about-you", labelKey: "settings.profile.awayEmails", sectionKey: "settings.bots.aboutYou", synonyms: ["away", "emails", "email me"] },
  { id: "new-bots", page: "bots", anchor: "new-bots", labelKey: "settings.bots.newBots", synonyms: ["defaults", "effort", "reasoning", "preset", "share as preset"] },
  { id: "limits", page: "bots", anchor: "limits", labelKey: "settings.simple.more.limits", advanced: true, synonyms: ["group turns", "timeout", "tool time limit", "parallel threads", "concurrency", "keep warm"] },
  { id: "parallel", page: "bots", anchor: "parallel", labelKey: "settings.threads.title", sectionKey: "settings.simple.more.limits", advanced: true, synonyms: ["parallel", "threads", "concurrency"] },
  { id: "group-turns", page: "bots", anchor: "group-turns", labelKey: "settings.roomTurns.title", sectionKey: "settings.simple.more.limits", advanced: true, synonyms: ["group", "turns"] },
  { id: "skills", page: "bots", anchor: "skills", labelKey: "settings.section.skills", when: (ctx) => ctx.skills, synonyms: ["skills", "library"] },
  { id: "early", page: "bots", anchor: "early", labelKey: "settings.bots.early", advanced: true, synonyms: ["experimental", "early", "preview", "write their own skills"] },
  { id: "all-bots", page: "bots", labelKey: "settings.page.bots", topFor: ["all bots"] },
  { id: "browser", page: "desktops", anchor: "browser", labelKey: "settings.experimental.browser", synonyms: ["browser", "profiles", "browser profiles", "open sites", "new browser"] },
  { id: "desktop-kinds", page: "desktops", anchor: "desktops", labelKey: "settings.desktops.title", topFor: ["private desktop", "sandbox", "docker", "podman", "container", "vps", "own server"], synonyms: ["cloud desktops", "desktop", "vm"] },
  { id: "saved-steps", page: "desktops", anchor: "automation", labelKey: "settings.savedSteps.title", advanced: true, synonyms: ["repeat", "saved steps", "without ai"] },
  { id: "vault", page: "vault", labelKey: "settings.section.vault", topFor: ["password", "passwords", "login", "logins"], synonyms: ["secrets", "1password", "2fa", "totp"] },
  { id: "spending", page: "usage", labelKey: "settings.page.spending", topFor: ["spending", "cost", "costs", "tokens", "money"], synonyms: ["usage"] },
  { id: "backups", page: "data", anchor: "backups", labelKey: "settings.section.backups", simple: { page: "overview", anchor: "your-data" }, synonyms: ["export", "restore", "full backup"] },
  { id: "bring-in", page: "data", anchor: "bring-in", labelKey: "settings.data.bringIn", synonyms: ["import", "move from", "bring"] },
  { id: "move", page: "data", anchor: "move", labelKey: "settings.data.move", when: hereOnly, topFor: ["keep here", "move back", "bring back", "move to cloud"] },
  { id: "storage", page: "data", anchor: "storage", labelKey: "settings.data.storage", synonyms: ["attachments", "clear attachments", "event log", "cleanup", "retention"] },
  { id: "activity", page: "data", anchor: "activity", labelKey: "settings.section.activity", when: browserAdmin, topFor: ["activity", "audit", "audit log"], synonyms: ["history", "who did what"] },
  { id: "members", page: "people", anchor: "members", labelKey: "settings.people.members", synonyms: ["invite", "roles", "admins"] },
  { id: "bot-access", page: "people", anchor: "bot-access", labelKey: "settings.section.botAccess", synonyms: ["who can", "share", "permissions"] },
  { id: "account", page: "account", labelKey: "settings.page.account", topFor: ["sign in", "log in", "log out", "sign out", "email"], synonyms: ["account", "mausbot cloud"] },
  { id: "organization", page: "account", anchor: "organization", labelKey: "settings.section.organization", when: (ctx) => ctx.organization, synonyms: ["company", "organisation", "managed"] },
  { id: "emails", page: "account", anchor: "emails", labelKey: "settings.account.emails", when: desk, synonyms: ["newsletter", "product updates", "email updates"] },
  { id: "plan", page: "plan", anchor: "plan", labelKey: "settings.page.plan", topFor: ["billing", "subscription", "invoice", "receipt", "payment", "card", "upgrade", "plan", "trial", "cancel", "cancel plan", "cancel subscription", "cancel trial", "unsubscribe", "refund"], synonyms: ["usage & billing", "manage subscription"] },
  { id: "this-week", page: "plan", anchor: "this-week", labelKey: "settings.plan.thisWeek", sectionKey: "settings.page.plan", synonyms: ["usage", "weekly", "limits", "cloud desktop hours", "voice replies"] },
  { id: "updates", page: "app", anchor: "updates", labelKey: "settings.updates.title", when: desk, synonyms: ["update", "version", "check for updates", "release"] },
  { id: "your-computers", page: "app", anchor: "your-computers", labelKey: "settings.app.computers", when: desk, synonyms: ["servers", "connect to a server", "environments", "switch"] },
  { id: "help", page: "app", anchor: "help", labelKey: "sidebar.menu.helpShort", synonyms: ["help center", "feedback", "diagnostics", "logs", "tour", "welcome tour"] },
  { id: "language", page: "general", anchor: "typing", labelKey: "settings.language.title", simple: { page: "app", anchor: "typing" }, synonyms: ["language", "translate"] },
  { id: "send-key", page: "general", anchor: "typing", labelKey: "settings.sendKey.title", synonyms: ["enter", "return", "shift+enter", "new line", "keyboard"] },
  { id: "talk", page: "general", anchor: "typing", labelKey: "settings.search.talk", when: desk, topFor: ["voice", "microphone", "mic", "dictation", "talk"] },
  { id: "notifications", page: "general", anchor: "notifications", labelKey: "notifications.title", simple: { page: "app", anchor: "typing" }, topFor: ["notifications", "notify", "alerts", "sounds"], synonyms: ["mute", "silent", "chime", "feed"] },
  { id: "startup", page: "general", anchor: "startup", labelKey: "settings.general.startup", when: desk, synonyms: ["open at login", "startup", "launch"] },
  { id: "analytics", page: "general", anchor: "privacy", labelKey: "settings.general.privacy", synonyms: ["analytics", "usage analytics", "privacy", "telemetry"] },
  { id: "light-dark", page: "appearance", anchor: "look", labelKey: "settings.theme.lightOrDark", topFor: ["dark mode", "night mode", "light mode"], synonyms: ["dark", "light", "system"] },
  { id: "theme", page: "appearance", anchor: "look", labelKey: "settings.theme.title", synonyms: ["skin", "looks", "themes"] },
  { id: "bubbles", page: "appearance", anchor: "look", labelKey: "settings.userBubbles.simpleTitle", synonyms: ["message color", "my messages", "bubbles"] },
  { id: "tool-calls", page: "appearance", anchor: "chat", labelKey: "settings.appearance.chat", synonyms: ["tool calls", "this run", "chat width", "font", "typeface"] },
  { id: "layout", page: "appearance", anchor: "appearance", labelKey: "settings.appearance.layout", advanced: true, synonyms: ["show your computers", "rail", "window frame", "title bar", "threads", "tools layout", "pinned", "circles", "universal pins", "pinned panels"] },
  { id: "apps", page: "overview", labelKey: "settings.search.apps", jump: "apps", synonyms: ["apps", "gmail", "slack", "calendar", "notion", "connect app", "integrations"] },
  { id: "bot-settings", page: "overview", labelKey: "settings.search.bot", jump: "bot", synonyms: ["approvals", "safety", "routines", "memory", "bot's notifications"] },
  { id: "shortcuts", page: "app", labelKey: "sidebar.menu.shortcuts", jump: "shortcuts", synonyms: ["keyboard shortcuts", "hotkeys", "cheat sheet"] },
];

export interface SearchHit {
  entry: SettingsIndexEntry;
  /** the row exists only on another place on the rail */
  elsewhere: boolean;
  score: number;
  /** only Advanced mode shows it: choosing it turns Advanced on */
  advanced?: boolean;
}

const PAGE_TOP: Partial<Record<SettingsPageId, readonly string[]>> = {
  phone: ["phone", "phones", "pair", "pairing", "qr", "phone pairing", "mobile"],
};

const LOCAL_ONLY_WORDS = ["wifi", "wi-fi", "lan", "local network", "tailscale"];

const norm = (text: string) => text.toLocaleLowerCase().replace(/\s+/g, " ").trim();

function score(query: string, label: string, words: readonly string[], topFor: readonly string[]): number {
  if (topFor.includes(query)) return 100;
  const title = norm(label);
  if (title === query) return 90;
  if (title.startsWith(query)) return 80;
  if (title.split(/[\s,·&/]+/).some((word) => word.startsWith(query))) return 70;
  if (query.split(" ").every((part) => title.includes(part))) return 60;
  if (words.some((word) => word === query)) return 50;
  if (words.some((word) => word.startsWith(query) || (query.length > 3 && word.includes(query)))) return 40;
  return 0;
}

/** Search over pages and rows. Rows that can't exist on this place but can on another place on the rail come back
 * marked `elsewhere`; with one place there are none. */
export function searchSettings(rawQuery: string, ctx: SettingsContext, label: (entry: SettingsIndexEntry) => string,
  pageLabel: (page: SettingsPage) => string): SearchHit[] {
  const query = norm(rawQuery);
  if (!query) return [];
  const hits: SearchHit[] = [];
  // Search finds everything Advanced mode would show; what Simple leaves out comes back marked `advanced`.
  const every = { ...ctx, advanced: true };
  const simpleHides = (page: SettingsPageId) => !pageById(page).when(ctx);
  for (const page of visiblePages(every)) {
    // A place with no Same Wi-Fi of its own doesn't offer its phone page for "wifi": This computer's row does.
    if (page.id === "phone" && !ctx.here && LOCAL_ONLY_WORDS.includes(query)) continue;
    // A page named by the word itself ("phone", "pair") comes before its own rows.
    const top = PAGE_TOP[page.id] ?? [];
    const value = top.includes(query) ? 101 : score(query, pageLabel(page), page.synonyms, []) - 1;
    if (value > 0) hits.push({ entry: { id: `page:${page.id}`, page: page.id, labelKey: page.labelKey }, elsewhere: false, score: value, advanced: simpleHides(page.id) || undefined });
  }
  for (const listed of SETTINGS_INDEX) {
    // Simple shows some of an Advanced page's rows on a page of its own: search lands there instead.
    const entry = !ctx.advanced && listed.simple ? { ...listed, ...listed.simple } : listed;
    const value = score(query, label(entry), entry.synonyms ?? [], entry.topFor ?? []);
    if (!value) continue;
    const pageHere = pageById(entry.page).when(every);
    const here = pageHere && (entry.when?.(every) ?? true);
    const advanced = !ctx.advanced && (Boolean(entry.advanced) || simpleHides(entry.page));
    if (here) hits.push({ entry, elsewhere: false, score: value, advanced: advanced || undefined });
    else if (ctx.places && ctx.desktop && entry.when === hereOnly && !ctx.here) hits.push({ entry, elsewhere: true, score: value });
  }
  const seen = new Set<string>();
  return hits
    .sort((a, b) => Number(a.elsewhere) - Number(b.elsewhere) || b.score - a.score)
    .filter((hit) => {
      const key = `${hit.elsewhere}:${hit.entry.page}:${hit.entry.anchor ?? ""}:${hit.entry.labelKey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
