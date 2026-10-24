import { useEffect, useRef, useState } from "react";
import { Archive, CircleUser, Cloud, Coins, Download, FlaskConical, KeyRound, LockKeyhole, Monitor, Palette, ScrollText, Search, Sparkles, TabletSmartphone, Terminal, User, Users, X, Building2, Zap, BookOpen } from "lucide-react";
import { api, useStore, type AppSettingsSection, type ConfigStatus } from "@/state/store";
import { builtInBrowserEnabled, showToolCallsEnabled, skillAuthoringEnabled, skillsLibraryEnabled } from "@/lib/feature-flags";
import { localeChoices, type LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import { withTourReset } from "@/lib/guided-tour";
import { completionPatch } from "@/lib/onboarding";
import { AnthropicEveryClaudeBot, ApiKeyRow, OpenCodeProviderKeys, VpsConnection } from "./ApiKeys";
import { AnalyticsRow } from "./AnalyticsRow";
import { UpdatesConsentRow } from "./UpdatesConsent";
import { DefaultBotSidebarRow } from "./DefaultBotControls";
import { DiagnosticsRow } from "./DiagnosticsRow";
import { OtherOpenAiCompatServers } from "./OpenAiCompatServers";
import { DecisionModelSettings } from "./DecisionModelSettings";
import { useUpdaterState } from "@/lib/updater";
import { brand } from "../lib/brand";
import { EnginesSettings } from "./EnginesSettings";
import { LocalComputerSection } from "./LocalComputerSection";
import { CompanionSection } from "./CompanionSection";
import { ServerPairingCard } from "./ServerPairingCard";
import { PeopleSection } from "./PeopleSection";
import { ActivitySection } from "./ActivitySection";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { currentPhonePairingTarget, phonePairingSettingsAction } from "@/lib/phone-pairing";
import { CustomDomainSettings } from "./CustomDomainSettings";
import { BrowserProfilesManager } from "./BrowserProfilesManager";
import { BuiltInBrowserRow, NewBrowserSettings } from "./BrowserSettingsRows";
import { LoginsSettings } from "./LoginsSettings";
import { RemoteComputerSection } from "./RemoteComputerSection";
import { ConnectedWorkspacesSettings } from "./ConnectedWorkspacesSettings";
import { OrganizationSettings } from "./OrganizationSettings";
import { CloudAccountSettings } from "./CloudAccountSettings";
import { ProSettingsCard } from "./ProIntroduction";
import { CloudUsageSettings } from "./CloudUsageMeter";
import { Card, SettingRow, Switch } from "./SettingsPrimitives";
import { LearnedSkillsSettings } from "./ShareLearnedSkillsSettings";
import { effortLabel } from "./ModelPicker";
import { EFFORT_LEVELS, isEffortLevel } from "../../shared/wire";
import { shortcutLabel } from "./ShortcutHint";
import { UsageSection } from "./UsageSection";
import { SkillsSection } from "./SkillsSection";
import { LicenseExpiryBanner } from "./LicenseExpiryBanner";
import { WorkspacesSection, workspacesAvailable } from "./WorkspacesSection";
import { SkinPicker } from "./SkinPicker";
import { ChatWidthRow, FontRow, SidebarToolsLayoutRow } from "./AppearanceSelectRows";
import { setColorUserBubbles, useColorUserBubbles } from "@/lib/user-bubble-preference";
import { RoomTurnTimeoutSettings } from "./RoomTurnTimeoutSettings";
import { McpCallTimeoutSettings } from "./McpCallTimeoutSettings";
import { ProfileFields } from "./ProfileSettings";
import { ThreadConcurrencySettings } from "./ThreadConcurrencySettings";
import { AutomaticRecoverySettings } from "./AutomaticRecoverySettings";
import { ThreadCleanupSettings } from "./ThreadCleanupSettings";
import { DefaultBotSettings } from "./NewBotDialog";
import { WorkspaceBackupSettings } from "./WorkspaceBackupSettings";
import { CompanyBackupSettings } from "./CompanyBackupSettings";
import { ImportSettings } from "./ImportSettings";
import { cn } from "@/lib/cn";
import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { NotificationRows } from "./NotificationSettingsRows";
import { setShowThreads, useShowThreadsChoice } from "@/lib/thread-preferences";
import { setAdvancedMode, useAdvancedMode } from "@/lib/interface-mode";
import { parseSidebarDensity, setPinnedCircles, setSidebarDensity, setUniversalPins, SIDEBAR_DENSITIES, usePinnedCircles, useSidebarDensity, useUniversalPins, type SidebarDensity } from "@/lib/sidebar-preferences";
import { setShowRunCard, useShowRunCard } from "@/lib/run-card-preferences";
import { effectiveLanguage, setLanguageChoice, useLanguageChoice } from "@/lib/language-preference";
import { Select } from "./Select";
import { ComposerShortcutSettings } from "./ComposerShortcutSettings";

// labelKey, not a label: t() reads the active pack when called, so a label resolved at module scope would freeze the
// boot language.
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
  { id: "general", group: "you", labelKey: "settings.section.general", icon: User, keywords: ["profile", "name", "email", "about me", "about", "suggestions", "suggested", "memory", "analytics", "updates", "product updates", "newsletter", "email updates", "effort", "new bots", "reasoning", "threads", "parallel", "concurrency", "cleanup", "retention", "event log", "event-log", "log size", "automatic recovery", "backup model", "fallback", "routines", "conversation", "schedule", "usage", "limit", "plan", "upgrade", "cloud desktop hours", "storage"] },
  { id: "appearance", group: "you", labelKey: "settings.section.appearance", icon: Palette, keywords: ["skin", "theme", "appearance", "chat width", "width", "wide", "full width", "bubble", "bubbles", "tools", "tool calls", "threads", "show threads", "hide threads", "sidebar", "density", "compact", "comfortable", "avatars", "display", "run", "this run", "run card", "commands", "notifications", "sound", "sounds", "mute", "silent", "chime", "pinned", "circles", "universal", "groups", "top", "send", "enter", "return", "shift+enter", "ctrl+enter", "cmd+enter", "⌘+enter", "new line", "keyboard", "ime", "japanese", "message color", "my messages", "toolbar", "tools layout", "footer", "routines", "triggers", "team map"] },
  { id: "companion", group: "you", labelKey: "settings.section.companion", icon: TabletSmartphone, keywords: ["companion", "device", "phone", "desktop", "client", "host", "pair", "pairing", "mobile", "https", "secure", "tailscale", "wifi", "remote", "advanced", "domain", "dns", "self-hosted", "server", "caddy"] },
  { id: "engines", group: "ai", labelKey: "settings.section.engines", icon: Terminal, keywords: ["models", "model providers", "engines", "claude", "codex", "grok", "providers", "cli", "sign in", "subscription"] },
  { id: "connections", group: "ai", labelKey: "settings.section.connections", icon: KeyRound, keywords: ["keys", "api", "api key", "api keys", "connections", "composio", "box", "xai", "mistral", "cerebras", "meta", "muse", "vps", "router", "openrouter", "base url", "openai", "anthropic", "groq", "opencode", "deepseek", "provider"] },
  { id: "decisionModel", group: "ai", labelKey: "settings.section.decisionModel", icon: Zap, keywords: ["decision", "extraction", "jev", "typesafe", "cloudflare", "workers ai", "clef", "clairic", "email", "routing", "auto", "rooms", "who answers"] },
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
  { id: "ai", labelKey: "settings.group.ai", icon: Sparkles, sections: ["engines", "connections"] },
  { id: "computers", labelKey: "settings.group.computers", icon: Monitor, sections: ["companion", "desktopWorkspaces", "computer", "logins"] },
  { id: "cloud", labelKey: "settings.section.cloudAccount", icon: Cloud, sections: ["cloudAccount"] },
  { id: "account", labelKey: "settings.group.account", icon: CircleUser, sections: ["organization", "import", "people", "activity", "usage"] },
];

export const SIMPLE_HIDDEN_SECTIONS: readonly AppSettingsSection[] = ["backups", "experimental", "workspaces", "skills", "decisionModel"];

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

function simplePageMatches(page: SimpleSettingsPage, query: string): boolean {
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

export function UpdatesRow() {
  const s = useUpdaterState();
  const updater = window.ogb?.updater;
  if (!s || !updater) return null;
  const label =
    s.status === "checking"
      ? t("settings.updates.checking")
      : s.status === "downloading"
        ? s.percent == null
          ? t("settings.updates.startingDownload")
          : t("settings.updates.downloading", { percent: Math.round(s.percent) })
        : s.status === "preparing"
          ? t("settings.updates.preparing")
          : s.status === "downloaded"
            ? s.installMode === "handoff"
              ? t("settings.updates.readyInstall", { app: brand().name, version: s.version ?? "" })
              : t("settings.updates.ready", { app: brand().name, version: s.version ?? "" })
            : s.status === "installing"
              ? s.message ||
                (s.installMode === "handoff"
                  ? t("settings.updates.openingTerminal")
                  : t("settings.updates.restarting"))
              : s.status === "handed-off"
                ? t("settings.updates.handedOff")
                : s.status === "error"
                  ? t("settings.updates.failed", { message: s.message ?? t("settings.updates.unknownError") })
                  : t("settings.updates.latest");
  return (
    <SettingRow title={t("settings.updates.title")} subtitle={label}>
      <button
        onClick={() => {
          if (s.status === "downloaded") return void updater.install();
          void updater.check();
        }}
        disabled={
          s.status === "checking" || s.status === "downloading" || s.status === "preparing" ||
          s.status === "installing" || s.retryable === false
        }
        className="ui-button"
      >
        {s.retryable === false
          ? t("settings.updates.quitReopen")
          : s.status === "downloaded"
            ? s.installMode === "handoff"
              ? t("settings.updates.install")
              : t("settings.updates.restart")
            : s.status === "preparing"
              ? t("settings.updates.preparingShort")
              : s.status === "installing"
                ? s.installMode === "handoff"
                  ? t("settings.updates.opening")
                  : t("settings.updates.restartingShort")
                : t("settings.updates.check")}
      </button>
    </SettingRow>
  );
}

function NewBotEffortRow() {
  const { state, dispatch } = useStore();
  const current = state.config?.newBots?.effort ?? "";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async (value: string) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ newBots: { effort: isEffortLevel(value) ? value : null } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.newBotEffort.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      title={t("settings.newBotEffort.title")}
      subtitle={t("settings.newBotEffort.subtitle")}
      message={error ? <p role="alert" className="text-danger">{error}</p> : null}
    >
      <Select size="sm" className="w-full max-w-[240px]"
        value={current}
        disabled={saving}
        aria-label={t("settings.newBotEffort.aria")}
        onChange={(event) => void save(event.target.value)}
      >
        <option value="">{t("settings.newBotEffort.default")}</option>
        {EFFORT_LEVELS.map((level) => (
          <option key={level} value={level}>
            {effortLabel(level)}
          </option>
        ))}
      </Select>
    </SettingRow>
  );
}

function ReplayAppTourButton() {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div>
      <button
        disabled={saving}
        onClick={() => {
          setSaving(true);
          setFailed(false);
          void api("/api/config", {
            method: "PUT",
            body: JSON.stringify({ onboarding: {
              ...(!state.config?.onboarding?.completedAt ? completionPatch().onboarding : {}),
              hintsSeen: withTourReset(state.config?.onboarding),
            } }),
            signal: AbortSignal.timeout(10_000),
          })
            .then((config) => {
              dispatch({ type: "configStatus", config });
              dispatch({ type: "toggleTour", open: true });
            })
            .catch(() => setFailed(true))
            .finally(() => setSaving(false));
        }}
        className="ui-button"
      >
        {t("settings.welcome.appTour")}
      </button>
      {failed && <p role="alert" className="mt-2 text-[13px] text-danger">{t("onboarding.tour.error")}</p>}
    </div>
  );
}

function ReplayTourRow() {
  const { dispatch } = useStore();
  return (
    <SettingRow title={t("settings.welcome.title")} subtitle={t("settings.welcome.subtitle")}>
      <div className="flex flex-wrap justify-end gap-2">
        <ReplayAppTourButton />
        <button
          onClick={() => dispatch({ type: "toggleWelcome", open: true })}
          className="ui-button"
        >
          {t("settings.welcome.replay")}
        </button>
      </div>
    </SettingRow>
  );
}

function LanguageRow() {
  const { state } = useStore();
  const current = effectiveLanguage(useLanguageChoice(), state.config?.language);

  return (
    <SettingRow
      title={t("settings.language.title")}
      subtitle={t("settings.language.subtitle")}
    >
      <Select size="sm" className="w-full max-w-[240px]"
        value={current}
        aria-label={t("settings.language.aria")}
        onChange={(event) => setLanguageChoice(event.target.value)}
      >
        <option value="">{t("settings.language.system")}</option>
        {localeChoices.map(({ code, label }) => (
          <option key={code} value={code}>
            {label}
          </option>
        ))}
      </Select>
    </SettingRow>
  );
}

function ColorUserBubblesRow() {
  const enabled = useColorUserBubbles();
  return (
    <SettingRow title={t("settings.userBubbles.title")} subtitle={t("settings.userBubbles.subtitle")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.userBubbles.aria")}
        onClick={() => setColorUserBubbles(!enabled)}
      />
    </SettingRow>
  );
}

function AdvancedModeRow() {
  const enabled = useAdvancedMode();
  return (
    <SettingRow className="rounded-2xl border border-accent-border/40 bg-raised-hover/40 py-4" title={t("settings.advancedMode.title")} subtitle={t("settings.advancedMode.subtitle")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.advancedMode.title")}
        onClick={() => setAdvancedMode(!enabled)}
      />
    </SettingRow>
  );
}

function ShowThreadsRow() {
  const enabled = useShowThreadsChoice();
  return (
    <SettingRow title={t("settings.threadDisplay.title")} subtitle={t("settings.threadDisplay.subtitle")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.threadDisplay.show")}
        onClick={() => setShowThreads(!enabled)}
      />
    </SettingRow>
  );
}

function PinnedCirclesRow() {
  const enabled = usePinnedCircles();
  return (
    <SettingRow title={t("settings.pinnedCircles.title")} subtitle={t("settings.pinnedCircles.subtitle")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.pinnedCircles.title")}
        onClick={() => setPinnedCircles(!enabled)}
      />
    </SettingRow>
  );
}

const SIDEBAR_DENSITY_LABEL_KEYS: Record<SidebarDensity, LocaleKey> = {
  comfortable: "sidebar.density.comfortable",
  compact: "sidebar.density.compact",
  icons: "sidebar.density.iconsOnly",
};

function SidebarDensityRow() {
  const density = useSidebarDensity();
  return (
    <SettingRow title={t("sidebar.density.title")} subtitle={t("settings.sidebarDensity.subtitle")}>
      <Select size="sm" className="w-full max-w-[240px]"
        value={density}
        aria-label={t("sidebar.density.chooseAria")}
        onChange={(event) => setSidebarDensity(parseSidebarDensity(event.target.value))}
      >
        {SIDEBAR_DENSITIES.map((option) => (
          <option key={option} value={option}>{t(SIDEBAR_DENSITY_LABEL_KEYS[option])}</option>
        ))}
      </Select>
    </SettingRow>
  );
}

function RunCardRow() {
  const enabled = useShowRunCard();
  return (
    <SettingRow title={t("settings.runCard.title")} subtitle={t("settings.runCard.subtitle")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.runCard.show")}
        onClick={() => setShowRunCard(!enabled)}
      />
    </SettingRow>
  );
}

function UniversalPinsRow() {
  const enabled = useUniversalPins();
  return (
    <SettingRow title={t("settings.universalPins.title")} subtitle={t("settings.universalPins.subtitle")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.universalPins.title")}
        onClick={() => setUniversalPins(!enabled)}
      />
    </SettingRow>
  );
}

function ToolCallsRow() {
  const { state, dispatch } = useStore();
  const enabled = showToolCallsEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { showToolCalls: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.toolCalls.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      title={t("settings.toolCalls.title")}
      subtitle={<>{t("settings.toolCalls.subtitle")} {t("settings.toolCalls.detail")}</>}
      message={error ? <p role="alert" className="text-danger">{error}</p> : null}
    >
      <Switch
        checked={enabled}
        aria-label={t("settings.toolCalls.aria")}
        disabled={saving}
        onClick={() => void toggle()}
        className="disabled:cursor-wait disabled:opacity-50"
      />
    </SettingRow>
  );
}

function ExperimentalFeaturesRow() {
  const { state, dispatch } = useStore();
  const skillAuthoring = skillAuthoringEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { skillAuthoring: next } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.experimental.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={t("settings.experimental.title")} subtitle={t("settings.experimental.subtitle")}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">{t("settings.experimental.skillAuthoring")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {t("settings.experimental.skillAuthoringDetail")}
          </div>
        </div>
        <Switch
          checked={skillAuthoring}
          aria-label={t("settings.experimental.skillAuthoringAria")}
          disabled={saving}
          onClick={() => void toggle(!skillAuthoring)}
          className="disabled:cursor-wait disabled:opacity-50"
        />
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
      <LearnedSkillsSettings />
      <NewBrowserSettings />
    </Card>
  );
}

function BrowserProfilesRow() {
  const { state } = useStore();
  const profiles = state.config?.browserProfiles ?? [];
  if (!builtInBrowserEnabled(state.config) && profiles.length === 0) return null;
  return (
    <Card title={t("settings.profiles.title")} subtitle={t("settings.profiles.sharedSubtitle")}>
      <BrowserProfilesManager />
    </Card>
  );
}

export function SettingsModal() {
  const { state, dispatch } = useStore();
  const advanced = useAdvancedMode();
  const remoteActive = window.ogb?.remoteClient?.active === true;
  const section: AppSettingsSection =
    (remoteActive && !["appearance", "desktopWorkspaces"].includes(state.appSettingsSection)) || state.appSettingsSection === "remote"
      ? "companion"
      : state.appSettingsSection;
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  useEffect(() => window.ogb?.environments?.onOpenSettings?.(() => setQuery("")), []);
  useEffect(() => window.ogb?.onOpenAppSettings?.(() => setQuery("")), []);
  const q = query.trim().toLowerCase();
  const ownerOrAdmin = useOwnerOrAdmin();
  const baseSections = SECTIONS.filter((entry) => !remoteActive || entry.id === "companion" || entry.id === "appearance" || entry.id === "desktopWorkspaces")
    .filter((entry) => entry.id !== "desktopWorkspaces" || Boolean(window.ogb?.environments))
    .filter((entry) => entry.id !== "organization" || Boolean(window.ogb?.organization)).filter((entry) => entry.id !== "import" || Boolean(window.ogb))
    .filter((entry) => entry.id !== "cloudAccount" || Boolean(window.ogb?.cloudAccount || (window.ogb?.cloudPlan && state.config?.cloudHome === true)))
    .filter((entry) => entry.id !== "workspaces" || workspacesAvailable(state.config))
    .filter((entry) => entry.id !== "people" || (!window.ogb && state.config?.cloudHome !== true))
    .filter((entry) => entry.id !== "activity" || (!window.ogb && ownerOrAdmin === true));
  const availableSections = baseSections.filter((entry) => entry.id !== "skills" || skillsLibraryEnabled(state.config));
  const visibleSections = availableSections.filter((entry) => sectionMatches(entry, q));

  const simplePages = advanced ? [] : simpleSettingsPages(availableSections, section);
  const visiblePages = simplePages.filter((page) => simplePageMatches(page, q));
  const currentPage = simplePages.find((page) => page.sections.includes(section));

  const sectionLabelKey = advanced
    ? SECTIONS.find((entry) => entry.id === section)?.labelKey
    : currentPage?.labelKey;
  const nextVisibleSection = advanced
    ? visibleSections.some((entry) => entry.id === section) ? undefined : visibleSections[0]?.id
    : currentPage && visiblePages.includes(currentPage)
      ? undefined
      : visiblePages[0] && (visiblePages[0].sections.find((id) => visibleSections.some((entry) => entry.id === id)) ?? visiblePages[0].sections[0]);

  useEffect(() => {
    if (nextVisibleSection) dispatch({ type: "toggleAppSettings", open: true, section: nextVisibleSection });
  }, [dispatch, nextVisibleSection]);

  const sectionIndex = currentPage?.sections.indexOf(section) ?? 0;
  useEffect(() => {
    if (scrollRef.current) revealSettingsBlock(scrollRef.current, section, advanced ? 0 : sectionIndex);
  }, [advanced, section, sectionIndex]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const search = dialog?.querySelector<HTMLInputElement>("[data-settings-search]");
    if (search?.checkVisibility()) search.focus();
    else dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      // A child editor owns Escape and its focus trap, including while saving.
      if (event.defaultPrevented || (dialog && [...dialog.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
        .some(child => child.getClientRects().length))) return;
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "toggleAppSettings", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.checkVisibility());
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [dispatch]);

  const openSection = (id: AppSettingsSection) => dispatch({ type: "toggleAppSettings", open: true, section: id });

  const renderSection = (id: AppSettingsSection) => {
    switch (id) {
      case "desktopWorkspaces":
        return <ConnectedWorkspacesSettings />;
      case "organization":
        return window.ogb?.organization && !remoteActive ? <OrganizationSettings /> : null;
      case "cloudAccount":
        return (window.ogb?.cloudAccount || (window.ogb?.cloudPlan && state.config?.cloudHome === true)) && !remoteActive
          ? <CloudAccountSettings linkRequest={state.appSettingsCloudLink} cloudHome={state.config?.cloudHome === true} teamHome={state.config?.team}
            onConnectPhone={() => dispatch(phonePairingSettingsAction())} onAddCloud={() => dispatch({ type: "openCloudAdd", source: "app_settings" })} onSignIn={() => dispatch({ type: "openCloudAdd", source: "app_settings", signIn: true })} />
          : null;
      case "general":
        return (
          <>
            <AdvancedModeRow />
            <DefaultBotSidebarRow />

            <ProSettingsCard />
            <CloudUsageSettings />
            <Card title={t("settings.profile.title")} subtitle={t("settings.profile.sharedSubtitle")}>
              <ProfileFields />
            </Card>

            <LanguageRow />
            <NewBotEffortRow />
            <AnalyticsRow />
            <UpdatesConsentRow />
            <DefaultBotSettings />

            <Card title={t("settings.roomTurns.title")} subtitle={t("settings.roomTurns.subtitle")}>
              <RoomTurnTimeoutSettings />
            </Card>

            <Card title={t("settings.mcpCalls.title")} subtitle={t("settings.mcpCalls.subtitle")}>
              <McpCallTimeoutSettings />
            </Card>
            <ThreadConcurrencySettings />

            <AutomaticRecoverySettings />
            <ThreadCleanupSettings />

            {!remoteActive && <ReplayTourRow />}
            <UpdatesRow />
            <DiagnosticsRow />
          </>
        );
      case "appearance":
        return (
          <>
            <Card title={t("settings.skin.title")} subtitle={t("settings.skin.subtitle")}>
              <SkinPicker />
            </Card>
            {remoteActive && <AdvancedModeRow />}
            {remoteActive && <LanguageRow />}
            <FontRow />
            <ChatWidthRow />
            <ColorUserBubblesRow />
            <ComposerShortcutSettings />
            <SidebarDensityRow />
            {advanced && <SidebarToolsLayoutRow />}
            {advanced && <ShowThreadsRow />}
            <PinnedCirclesRow />
            <UniversalPinsRow />
            <NotificationRows />
            {!remoteActive && <ToolCallsRow />}
            <RunCardRow />
          </>
        );
      case "experimental":
        return <ExperimentalFeaturesRow />;
      case "connections":
        return (
          <Card
            title={t("settings.connections.title")}
            subtitle={t("settings.connections.subtitle")}
          >
            <div className="flex flex-col gap-4">
              {state.config?.composio.mode === "managed" ? (
                <div className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[13px] text-success">
                  {t("settings.connections.ready")}
                </div>
              ) : null}
              <div className="text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">{t("keys.providers.title")}</div>
              <p className="-mt-3 text-[12px] leading-relaxed text-ink-secondary">{t("keys.providers.subtitle")}</p>
              <ApiKeyRow section="openai" testProvider="openai" />
              <ApiKeyRow section="anthropic" testProvider="anthropic" />
              <AnthropicEveryClaudeBot />
              <ApiKeyRow section="xai" testProvider="xai" />
              <ApiKeyRow section="openrouter" testProvider="openrouter" />
              <ApiKeyRow section="mistral" testProvider="mistral" />
              <ApiKeyRow section="cerebras" testProvider="cerebras" />
              <ApiKeyRow section="groq" testProvider="groq" />
              <ApiKeyRow section="meta" testProvider="meta" />
              <ApiKeyRow section="deepseek" />
              <OtherOpenAiCompatServers />
              <div className="pt-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">{t("keys.integrations.title")}</div>
              <ApiKeyRow section="treg" testProvider="treg" /><ApiKeyRow section="box" />
              <VpsConnection />
              <ApiKeyRow section="opencodeGo" />
              {state.config?.cloudHome !== true && (
                <p className="-mt-2 text-[11.5px] leading-relaxed text-ink-secondary">
                  {t("keys.opencode.providersHint").split("{command}").flatMap((part, index) =>
                    index === 0 ? [part] : [<code key={index} className="font-mono">opencode auth login</code>, part])}
                </p>
              )}
              <OpenCodeProviderKeys />
              <details className="rounded-lg border border-hairline/40 bg-inset px-3 py-2">
                <summary className="cursor-pointer text-[13px] text-ink-secondary">{t("settings.connections.selfHost")}</summary>
                <div className="mt-3">
                  <ApiKeyRow section="composio" />
                </div>
              </details>
            </div>
          </Card>
        );
      case "decisionModel": return <DecisionModelSettings />;
      case "engines": return <EnginesSettings />;
      case "backups": return <><WorkspaceBackupSettings /><CompanyBackupSettings /></>;
      case "import": return <ImportSettings />;
      case "companion": {
        const phoneFocus = state.appSettingsPhonePairing;
        const computerPairs = currentPhonePairingTarget(state.config?.cloudHome === true) === "computer";
        return (
          <>
            <RemoteComputerSection />
            {!remoteActive && <CustomDomainSettings />}
            {/* Security: the server decides who may pair (an owner or admin session), not this gate. */}
            <ServerPairingCard cloudHome={state.config?.cloudHome === true} focusRequest={computerPairs ? 0 : phoneFocus} team={state.config?.team?.name} />
            {!remoteActive && <CompanionSection profileEmail={state.config?.profile?.email} focusRequest={computerPairs ? phoneFocus : 0} />}
          </>
        );
      }
      case "computer":
        return advanced
          ? <><BuiltInBrowserRow /><BrowserProfilesRow /><LocalComputerSection /></>
          : <LocalComputerSection />;
      case "logins":
        return <LoginsSettings />;
      case "usage":
        return <UsageSection />;
      case "skills":
        return skillsLibraryEnabled(state.config) ? <SkillsSection /> : null;
      case "people":
        return <PeopleSection />;
      case "activity":
        return <ActivitySection />;
      case "workspaces":
        return <WorkspacesSection />;
      default:
        return null;
    }
  };

  const blockHeading = (labelKey: LocaleKey) => (
    <h3 className="px-4 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-secondary">{t(labelKey)}</h3>
  );

  return (
    <div
      className="glass-popup-frame"
      style={glassPopupFrameStyle()}
      onMouseDown={(e) => e.target === e.currentTarget && dispatch({ type: "toggleAppSettings", open: false })}
    >
      {/* A sibling, not the parent: a backdrop-filter on an ancestor would stop the pop-up's own glass from seeing the app behind it. */}
      <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        tabIndex={-1}
        className="glass-surface glass-popup animate-pop-in relative flex overflow-hidden rounded-[24px] outline-none"
      >
        <span id="app-settings-title" className="sr-only">{t("settings.title")}</span>
        <nav className="glass-rail hidden min-h-0 w-[200px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline/30 p-3 sm:flex">
          <div className="shrink-0 px-2 py-3 text-[15px] font-semibold text-ink">
            {t("settings.title")}
          </div>
          <div className="mb-2 mt-1 flex min-h-8 shrink-0 items-center gap-2 rounded-lg border border-transparent bg-control/70 px-2.5 py-2 focus-within:border-focus">
            <Search size={14} className="shrink-0 text-ink-secondary" />
            <input
              data-settings-search
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                if (query) setQuery("");
                else dispatch({ type: "toggleAppSettings", open: false });
              }}
              placeholder={t("settings.search")}
              aria-label={t("settings.searchAria")}
              className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
          {(advanced ? visibleSections.length === 0 : visiblePages.length === 0) && (
            <div className="px-2.5 py-4 text-[12.5px] leading-relaxed text-ink-secondary">
              {t("settings.noMatch", { query: query.trim() })}
            </div>
          )}
          {advanced ? SETTINGS_GROUPS.map((group) => {
            const entries = visibleSections.filter((entry) => entry.group === group.id);
            if (entries.length === 0) return null;
            return (
              <div key={group.id} role="group" aria-labelledby={`settings-group-${group.id}`} data-settings-group={group.id} className="flex flex-col gap-0.5 pb-2">
                <div id={`settings-group-${group.id}`} className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">
                  {t(group.labelKey)}
                </div>
                {entries.map(({ id, labelKey, icon: Icon }) => (
                  <button
                    key={id}
                    data-settings-section={id}
                    onClick={() => openSection(id)}
                    aria-current={section === id ? "page" : undefined}
                    className={cn(
                      "cursor-pointer flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors motion-reduce:transition-none",
                      section === id ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/50 hover:text-ink",
                    )}
                  >
                    <Icon size={15} className="shrink-0" />
                    {t(labelKey)}
                  </button>
                ))}
              </div>
            );
          }) : (
            <div className="flex flex-col gap-0.5 pb-2">
              {visiblePages.map((page) => {
                const Icon = page.icon;
                const current = page === currentPage;
                return (
                  <button
                    key={page.id}
                    data-settings-page={page.id}
                    onClick={() => openSection(page.sections[0]!)}
                    aria-current={current ? "page" : undefined}
                    className={cn(
                      "cursor-pointer flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors motion-reduce:transition-none",
                      current ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/50 hover:text-ink",
                    )}
                  >
                    <Icon size={15} className="shrink-0" />
                    {t(page.labelKey)}
                  </button>
                );
              })}
            </div>
          )}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline/30 px-3 py-3 sm:pl-9">
            {advanced ? (
              <Select className="min-w-0 sm:hidden"
                aria-label={t("settings.title")}
                value={section}
                onChange={(event) => {
                  setQuery("");
                  openSection(event.target.value as AppSettingsSection);
                }}
              >
                {SETTINGS_GROUPS.map((group) => {
                  const entries = availableSections.filter((entry) => entry.group === group.id);
                  return entries.length === 0 ? null : (
                    <optgroup key={group.id} label={t(group.labelKey)}>
                      {entries.map(({ id, labelKey }) => (
                        <option key={id} value={id}>{t(labelKey)}</option>
                      ))}
                    </optgroup>
                  );
                })}
              </Select>
            ) : (
              <Select className="min-w-0 sm:hidden"
                aria-label={t("settings.title")}
                value={currentPage?.id ?? ""}
                onChange={(event) => {
                  setQuery("");
                  const page = simplePages.find((candidate) => candidate.id === event.target.value);
                  if (page) openSection(page.sections[0]!);
                }}
              >
                {simplePages.map((page) => (
                  <option key={page.id} value={page.id}>{t(page.labelKey)}</option>
                ))}
              </Select>
            )}
            <span className="hidden text-[15px] font-semibold text-ink sm:block">
              {sectionLabelKey ? t(sectionLabelKey) : null}
            </span>
            <button
              onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
              aria-label={t("settings.close")}
              title={`${t("settings.close")} (${shortcutLabel("close-panel")})`}
              className="ui-icon-button cursor-pointer shrink-0"
            >
              <X size={18} />
            </button>
          </div>

          <div ref={scrollRef} className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 py-4 sm:px-5 sm:pb-5">
            <LicenseExpiryBanner config={state.config} />
            {advanced ? (
              renderSection(section)
            ) : currentPage ? (
              currentPage.sections.map((id) => {
                const stacked = currentPage.sections.length > 1;
                const labelKey = SECTIONS.find((entry) => entry.id === id)?.labelKey;
                return (
                  <section key={id} data-settings-block={id} className="flex scroll-mt-2 flex-col gap-4">
                    {stacked && labelKey ? blockHeading(labelKey) : null}
                    {renderSection(id)}
                    {id === "computer" && (
                      <div data-settings-block="browser" className="flex flex-col gap-4 pt-2">
                        {blockHeading("settings.experimental.browser")}
                        <BuiltInBrowserRow />
                        <BrowserProfilesRow />
                      </div>
                    )}
                  </section>
                );
              })
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
