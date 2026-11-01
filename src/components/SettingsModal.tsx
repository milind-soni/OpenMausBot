import { useEffect, useRef, useState } from "react";
import { Archive, ChartNoAxesColumn, Cloud, CloudDownload, Coins, Download, FlaskConical, KeyRound, LockKeyhole, Monitor, Palette, ScrollText, Search, Settings, Sparkles, TabletSmartphone, Terminal, User, Users, X, Building2, Zap, BookOpen } from "lucide-react";
import { useStore, type AppSettingsSection } from "@/state/store";
import { skillsLibraryEnabled } from "@/lib/feature-flags";
import { type LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import { AdminOnly } from "./AdminOnly";
import { KeysPage } from "./keys/KeysPage";
import { KEY_CATALOG, keyMatches, keySection, type KeyEntry } from "./keys/key-catalog";
import { openKeySettings, useKeyFocus } from "./keys/key-focus";
import { AnalyticsRow } from "./AnalyticsRow";
import { UpdatesConsentRow } from "./UpdatesConsent";
import { OpenAtLoginRow } from "./OpenAtLoginRow";
import { DefaultBotSidebarRow } from "./DefaultBotControls";
import { TalkShortcutRow, talkShortcutKeywords } from "./TalkShortcutRow";
import { DiagnosticsRow } from "./DiagnosticsRow";
import { DecisionModelSettings } from "./DecisionModelSettings";
import { EnginesSettings } from "./EnginesSettings";
import { LocalComputerSection } from "./LocalComputerSection";
import { CompanionSection } from "./CompanionSection";
import { ServerPairingCard } from "./ServerPairingCard";
import { PeopleSection } from "./PeopleSection";
import { ActivitySection } from "./ActivitySection";
import { AccessOverview } from "./bot-access/AccessOverview";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { currentPhonePairingTarget, phonePairingSettingsAction } from "@/lib/phone-pairing";
import { CustomDomainSettings } from "./CustomDomainSettings";
import { BuiltInBrowserRow } from "./BrowserSettingsRows";
import { LoginsSettings } from "./LoginsSettings";
import { RemoteComputerSection } from "./RemoteComputerSection";
import { ConnectedWorkspacesSettings } from "./ConnectedWorkspacesSettings";
import { PlaceLookCard } from "./PlaceLookCard";
import { ChromeRailRow } from "./ChromeRailToggle";
import { WindowFrameRow } from "./WindowFrameRow";
import { OrganizationSettings } from "./OrganizationSettings";
import { CloudAccountSettings } from "./CloudAccountSettings";
import { ProSettingsCard } from "./ProIntroduction";
import { CloudUsageSettings } from "./CloudUsageMeter";
import { Card, SettingsGroup, SIMPLE_BUTTONS } from "./SettingsPrimitives";
import { shortcutLabel } from "./ShortcutHint";
import { UsageSection } from "./UsageSection";
import { SkillsSection } from "./SkillsSection";
import { LicenseExpiryBanner } from "./LicenseExpiryBanner";
import { WorkspacesSection, workspacesAvailable } from "./WorkspacesSection";
import { SkinPicker } from "./SkinPicker";
import { ThemeRow } from "./ThemeRow";
import { ChatWidthRow, FontRow, SidebarToolsLayoutRow } from "./AppearanceSelectRows";
import { RoomTurnTimeoutSettings } from "./RoomTurnTimeoutSettings";
import { McpCallTimeoutSettings } from "./McpCallTimeoutSettings";
import { ProfileFields } from "./ProfileSettings";
import { ThreadConcurrencySettings } from "./ThreadConcurrencySettings";
import { AutomaticRecoverySettings } from "./AutomaticRecoverySettings";
import { ThreadCleanupSettings } from "./ThreadCleanupSettings";
import { PinnedPanelsSettings } from "./PinnedPanelsSettings";
import { DefaultBotSettings } from "./NewBotDialog";
import { WorkspaceBackupSettings } from "./WorkspaceBackupSettings";
import { CompanyBackupSettings } from "./CompanyBackupSettings";
import { ImportSettings } from "./ImportSettings";
import { cn } from "@/lib/cn";
import { scrollWithin } from "@/lib/scroll-within";
import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { NotificationRows } from "./NotificationSettingsRows";
import { useAdvancedMode } from "@/lib/interface-mode";
import { Select } from "./Select";
import { SavedStepsRow } from "./SavedStepsRow";
import { BrowserProfilesRow, ColorUserBubblesRow, AdvancedModeRow, ExperimentalFeaturesRow, LanguageRow, NewBotEffortRow, PinnedCirclesRow, ReplayTourRow, RunCardRow, FollowUpRow, SendKeyRow, ShowThreadsRow, ToolCallsRow, UniversalPinsRow, UpdatesRow } from "./AppSettingsRows";
import { SIMPLE_ADVANCED_ONLY, SimpleAiPage, SimpleBillingPage, SimpleComputerPage, SimpleGeneralPage, SimpleLooksPage, SimpleUpdatesPage, type Disclose, type SimpleDisclosureId } from "./SettingsSimplePages";

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
  { id: "general", group: "you", labelKey: "settings.section.general", icon: User, keywords: ["profile", "pinned panels", "web panel", "dashboard", "pin a page", "name", "email", "about me", "about", "suggestions", "suggested", "memory", "analytics", "updates", "product updates", "newsletter", "email updates", "effort", "new bots", "reasoning", "threads", "parallel", "concurrency", "cleanup", "retention", "event log", "event-log", "log size", "automatic recovery", "backup model", "fallback", "routines", "conversation", "schedule", "usage", "limit", "plan", "upgrade", "cloud desktop hours", "storage", "saved steps", "repeat", "replay", "computer tasks", "without ai", "forget", ...talkShortcutKeywords()] },
  { id: "appearance", group: "you", labelKey: "settings.section.appearance", icon: Palette, keywords: ["skin", "theme", "appearance", "chat width", "width", "wide", "full width", "bubble", "bubbles", "tools", "tool calls", "threads", "show threads", "hide threads", "sidebar", "display", "run", "this run", "run card", "commands", "notifications", "sound", "sounds", "mute", "silent", "chime", "pinned", "circles", "universal", "groups", "top", "send", "enter", "return", "shift+enter", "ctrl+enter", "cmd+enter", "⌘+enter", "new line", "keyboard", "ime", "japanese", "message color", "my messages", "toolbar", "tools layout", "footer", "routines", "triggers", "team map", "color", "colour", "cloud color", "server color", "tint", "sidebar color", "sidebar picture", "picture", "image", "banner", "background", "computers", "your computers", "rail", "strip", "frame", "window frame", "title bar"] },
  { id: "companion", group: "you", labelKey: "settings.section.companion", icon: TabletSmartphone, keywords: ["companion", "device", "phone", "desktop", "client", "host", "pair", "pairing", "mobile", "https", "secure", "tailscale", "wifi", "remote", "advanced", "domain", "dns", "self-hosted", "server", "caddy"] },
  { id: "engines", group: "ai", labelKey: "settings.section.engines", icon: Terminal, keywords: ["models", "model providers", "engines", "claude", "codex", "grok", "providers", "cli", "sign in", "subscription"] },
  { id: "connections", group: "ai", labelKey: "settings.section.connections", icon: KeyRound, keywords: ["keys", "api", "api key", "api keys", "connections", "composio", "box", "xai", "mistral", "cerebras", "meta", "muse", "vps", "router", "openrouter", "base url", "openai", "anthropic", "groq", "greenference", "opencode", "deepseek", "provider", "lm studio", "lmstudio", "llm studio", "llmstudio", "bionic"] },
  { id: "decisionModel", group: "ai", labelKey: "settings.section.decisionModel", icon: Zap, keywords: ["decision", "extraction", "jev", "typesafe", "cloudflare", "workers ai", "clef", "clairic", "email", "routing", "auto", "rooms", "who answers"] },
  { id: "skills", group: "ai", labelKey: "settings.section.skills", icon: BookOpen, keywords: ["skills", "library", "assign", "agent skills", "skill md"] },
  { id: "desktopWorkspaces", group: "computers", labelKey: "settings.section.desktopWorkspaces", icon: Building2, keywords: ["workspace", "cloud", "hosted", "vps", "server", "servers", "connect", "pair", "switch", "local"] },
  { id: "computer", group: "computers", labelKey: "settings.section.computer", icon: Monitor, keywords: ["vm", "virtual", "desktop", "browser", "built-in browser", "profiles", "browser profiles"] },
  { id: "logins", group: "computers", labelKey: "settings.section.logins", icon: LockKeyhole, keywords: ["logins", "login", "passwords", "password", "sign in", "2fa", "one-time code", "totp", "fill_login", "1password", "vault"] },
  { id: "cloudAccount", group: "account", labelKey: "settings.section.cloudAccount", icon: Cloud, keywords: ["cloud", "my cloud", "account", "personal", "sign in", "pro", "subscription", "billing", "sync", "send", "this computer", "bots", "logins", "1password"] },
  { id: "organization", group: "account", labelKey: "settings.section.organization", icon: Building2, keywords: ["company", "organization", "organisation", "sign in", "enroll", "managed", "models", "disconnect"] },
  { id: "usage", group: "account", labelKey: "settings.section.usage", icon: Coins, keywords: ["tokens", "cost", "billing", "plan", "quota", "remaining", "weekly", "5-hour", "model", "used"] },
  { id: "backups", group: "account", labelKey: "settings.section.backups", icon: Archive, keywords: ["export", "import", "restore", "full backup", "password", "recovery"] },
  { id: "import", group: "account", labelKey: "settings.section.import", icon: Download, keywords: ["import", "grok", "grok bot", "x.ai", "cursor", "claude code", "codex", "gemini", "skills", "mcp", "tools", "bring"] },
  { id: "people", group: "account", labelKey: "settings.section.people", icon: Users, keywords: ["people", "users", "invite", "sign in", "members", "admins", "access"] },
  { id: "botAccess", group: "account", labelKey: "settings.section.botAccess", icon: Users, keywords: ["access", "share", "sharing", "who can", "view", "chat", "edit", "permissions", "team", "members", "bots"] },
  { id: "activity", group: "account", labelKey: "settings.section.activity", icon: ScrollText, keywords: ["activity", "audit", "log", "history", "who changed", "approvals", "decisions", "admin"] },
  { id: "workspaces", group: "account", labelKey: "settings.section.workspaces", icon: Building2, keywords: ["clients", "tenants", "fleet", "workspaces", "installation", "installations"] },
  { id: "experimental", group: "account", labelKey: "settings.section.experimental", icon: FlaskConical, keywords: ["early", "preview", "learn", "skill", "authoring"] },
];

export type SimpleSettingsPage = {
  id: string;
  labelKey: LocaleKey;
  icon: typeof User;
  sections: AppSettingsSection[];
  keywords?: string[];
};

export const SIMPLE_PAGES: SimpleSettingsPage[] = [
  { id: "general", labelKey: "settings.section.general", icon: Settings, sections: ["general", "appearance", "people", "botAccess", "import", "organization", "activity"],
    keywords: ["account", "theme", "looks", "open at login", "startup", "analytics", "advanced mode"] },
  { id: "ai", labelKey: "settings.group.ai", icon: Sparkles, sections: ["engines", "connections"] },
  { id: "computer", labelKey: "settings.simple.page.computer", icon: Monitor, sections: ["companion", "desktopWorkspaces", "computer", "logins"] },
  { id: "billing", labelKey: "settings.simple.page.billing", icon: ChartNoAxesColumn, sections: ["usage", "cloudAccount"], keywords: ["billing", "included", "allowance", "cloud hours", "voice"] },
  { id: "updates", labelKey: "settings.simple.page.updates", icon: CloudDownload, sections: ["updates"],
    keywords: ["update", "version", "release", "product updates", "newsletter", "email updates", "welcome", "tour", "diagnostics", "logs", "support"] },
];

export const SIMPLE_HIDDEN_SECTIONS: readonly AppSettingsSection[] = ["backups", "experimental", "workspaces", "skills", "decisionModel"];


export const SIMPLE_FOLDED: Partial<Record<AppSettingsSection, SimpleDisclosureId>> = {
  connections: "ai-keys",
  remote: "computer-elsewhere",
  desktopWorkspaces: "computer-elsewhere",
};

export function simpleSettingsPages(available: ReadonlySet<AppSettingsSection>, open: AppSettingsSection): SimpleSettingsPage[] {
  const pages = SIMPLE_PAGES
    .map((page) => ({ ...page, sections: page.sections.filter((id) => available.has(id)) }))
    .filter((page) => page.sections.length > 0);
  const hidden = SIMPLE_HIDDEN_SECTIONS.includes(open) && available.has(open) ? SECTIONS.find((entry) => entry.id === open) : undefined;
  if (hidden) pages.push({ id: hidden.id, labelKey: hidden.labelKey, icon: hidden.icon, sections: [hidden.id] });
  return pages;
}

export function revealSettingsBlock(
  scroller: Parameters<typeof scrollWithin>[0] & { querySelector: (selector: string) => Parameters<typeof scrollWithin>[1] | null },
  section: AppSettingsSection,
  indexInPage: number,
): void {
  if (indexInPage <= 0) { scroller.scrollTop = 0; return; }
  const block = scroller.querySelector(`[data-settings-block="${section}"]`);
  if (block) scrollWithin(scroller, block);
}

function simplePageMatches(page: SimpleSettingsPage, query: string): boolean {
  if (!query) return true;
  if ([t(page.labelKey), ...page.keywords ?? []].some((part) => part.toLowerCase().includes(query))) return true;
  return page.sections.some((id) => {
    const entry = SECTIONS.find((candidate) => candidate.id === id);
    return entry ? sectionMatches(entry, query) : false;
  });
}

export function sectionMatches(section: (typeof SECTIONS)[number], query: string): boolean {
  if (!query) return true;
  if (section.id === "connections" && KEY_CATALOG.some((entry) => keyMatches(entry, query))) return true;
  return [t(section.labelKey), ...section.keywords].some((part) => part.toLowerCase().includes(query));
}

export function keySearchResults(query: string): KeyEntry[] {
  return query ? KEY_CATALOG.filter((entry) => keyMatches(entry, query)).slice(0, 8) : [];
}

export const openKeyResult = (entry: KeyEntry) => entry.uses ? openKeySettings(entry.uses, entry.id) : openKeySettings(entry.id);

export function SettingsModal() {
  const { state, dispatch } = useStore();
  const advanced = useAdvancedMode();
  const remoteActive = window.ogb?.remoteClient?.active === true;
  const requested = state.appSettingsSection;
  const section: AppSettingsSection =
    (remoteActive && !["appearance", "desktopWorkspaces"].includes(requested)) || requested === "remote"
      ? "companion"
      : advanced && requested === "updates" ? "general" : requested;
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchFirst = useRef(advanced);
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
    .filter((entry) => entry.id !== "activity" || (!window.ogb && ownerOrAdmin === true))
    .filter((entry) => entry.id !== "botAccess" || (Boolean(state.config?.team) && ownerOrAdmin === true));
  const availableSections = baseSections.filter((entry) => entry.id !== "skills" || skillsLibraryEnabled(state.config));
  const visibleSections = availableSections.filter((entry) => sectionMatches(entry, q));

  const simpleAvailable = new Set<AppSettingsSection>([...availableSections.map((entry) => entry.id), ...(remoteActive ? [] : ["updates" as const])]);
  const simplePages = advanced ? [] : simpleSettingsPages(simpleAvailable, section);
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

  const [folds, setFolds] = useState<Partial<Record<SimpleDisclosureId, boolean>>>({});
  const keyFocus = useKeyFocus();
  useEffect(() => { if (keyFocus) setFolds((current) => current["ai-keys"] ? current : { ...current, "ai-keys": true }); }, [keyFocus]);
  const disclose: Disclose = (id) => {
    const open = q !== "" || (folds[id] ?? SIMPLE_FOLDED[requested] === id);
    return { id, open, onToggle: () => setFolds((current) => ({ ...current, [id]: !open })) };
  };
  const [looks, setLooks] = useState(false);
  const [reveal, setReveal] = useState<string | null>(null);
  const advancedMatches = advanced || !q ? [] : SIMPLE_ADVANCED_ONLY.filter((key) => t(key).toLowerCase().includes(q));
  const keyResults = remoteActive || !availableSections.some((entry) => entry.id === "connections") ? [] : keySearchResults(q);
  const keyResultButtons = (className: string) => keyResults.map((entry) => (
    <button key={entry.id} type="button" data-settings-key-result={entry.id} className={className}
      onClick={() => { setQuery(""); setLooks(false); dispatch(openKeyResult(entry)); }}>
      <span>{t(entry.labelKey)} <span className="text-ink-secondary">· {t(keySection(entry).titleKey)}</span></span>
    </button>
  ));

  const sectionIndex = currentPage?.sections.indexOf(section) ?? 0;
  const revealBlock = !advanced && requested === "remote" ? "remote" : section;
  useEffect(() => {
    if (scrollRef.current) revealSettingsBlock(scrollRef.current, revealBlock as AppSettingsSection, advanced ? 0 : revealBlock === section ? sectionIndex : 1);
  }, [advanced, revealBlock, section, sectionIndex]);
  useEffect(() => {
    if (!reveal) return;
    const block = scrollRef.current?.querySelector(`[data-settings-block="${reveal}"]`);
    if (scrollRef.current && block) scrollWithin(scrollRef.current, block);
    setReveal(null);
  }, [reveal]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const search = dialog?.querySelector<HTMLInputElement>("[data-settings-search]");
    if (searchFirst.current && search?.checkVisibility()) search.focus();
    else dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (!searchFirst.current && dialog && document.activeElement === dialog && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey
        && search?.checkVisibility()) {
        event.preventDefault();
        search.focus();
        setQuery((current) => current + event.key);
        return;
      }
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

  const phoneFocus = state.appSettingsPhonePairing;
  const computerPairs = currentPhonePairingTarget(state.config?.cloudHome === true) === "computer";
  const remoteAccess = {
    client: <RemoteComputerSection hideWhenUnavailable={!advanced} />,
    domain: remoteActive ? null : <CustomDomainSettings />,
    // Security: the server decides who may pair (an owner or admin session), not this gate.
    pairing: <ServerPairingCard cloudHome={state.config?.cloudHome === true} focusRequest={computerPairs ? 0 : phoneFocus} team={state.config?.team?.name} simple={!advanced} />,
    companion: remoteActive ? null : <CompanionSection profileEmail={state.config?.profile?.email} focusRequest={computerPairs ? phoneFocus : 0} />,
  };

  const renderSection = (id: AppSettingsSection) => {
    switch (id) {
      case "desktopWorkspaces":
        return <ConnectedWorkspacesSettings />;
      case "organization":
        return window.ogb?.organization && !remoteActive ? <OrganizationSettings /> : null;
      case "cloudAccount":
        return (window.ogb?.cloudAccount || (window.ogb?.cloudPlan && state.config?.cloudHome === true)) && !remoteActive
          ? <CloudAccountSettings linkRequest={state.appSettingsCloudLink} cloudHome={state.config?.cloudHome === true} teamHome={state.config?.team}
            onConnectPhone={() => dispatch(phonePairingSettingsAction())} onAddCloud={advanced ? () => dispatch({ type: "openCloudAdd", source: "app_settings" }) : undefined}
            onSignIn={() => dispatch({ type: "openCloudAdd", source: "app_settings", signIn: true })} />
          : null;
      case "general":
        return (
          <>
            <AdvancedModeRow />
            <DefaultBotSidebarRow />
            <TalkShortcutRow />

            <ProSettingsCard />
            <CloudUsageSettings />
            <Card title={t("settings.profile.title")} subtitle={t("settings.profile.sharedSubtitle")}>
              <ProfileFields />
            </Card>

            <LanguageRow />
            <OpenAtLoginRow />
            <NewBotEffortRow />
            <SavedStepsRow />
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
            <PinnedPanelsSettings />

            {!remoteActive && <ReplayTourRow />}
            <UpdatesRow />
            <DiagnosticsRow />
          </>
        );
      case "appearance":
        return (
          <>
            <ThemeRow />
            <Card title={t("settings.skin.title")} subtitle={t("settings.skin.subtitle")}>
              <SkinPicker />
            </Card>
            <PlaceLookCard />
            {remoteActive && <AdvancedModeRow />}
            {remoteActive && <LanguageRow />}
            <FontRow />
            <ChatWidthRow />
            <ColorUserBubblesRow />
            <SendKeyRow />
            <FollowUpRow />
            <SidebarToolsLayoutRow />
            <ChromeRailRow />
            <WindowFrameRow />
            <ShowThreadsRow />
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
        return <AdminOnly><KeysPage /></AdminOnly>;
      case "decisionModel": return <AdminOnly><DecisionModelSettings /></AdminOnly>;
      case "engines": return <AdminOnly><EnginesSettings /></AdminOnly>;
      case "backups": return <AdminOnly><WorkspaceBackupSettings /><CompanyBackupSettings /></AdminOnly>;
      case "import": return <AdminOnly><ImportSettings /></AdminOnly>;
      case "companion":
        return <>{remoteAccess.client}{remoteAccess.domain}{remoteAccess.pairing}{remoteAccess.companion}</>;
      case "computer":
        return <><BuiltInBrowserRow /><BrowserProfilesRow /><AdminOnly><LocalComputerSection /></AdminOnly></>;
      case "logins":
        return <LoginsSettings />;
      case "usage":
        return <AdminOnly note="settings.adminOnly.usage"><UsageSection /></AdminOnly>;
      case "skills":
        return skillsLibraryEnabled(state.config) ? <SkillsSection /> : null;
      case "people":
        return <PeopleSection />;
      case "activity":
        return <ActivitySection />;
      case "botAccess":
        return <AccessOverview />;
      case "workspaces":
        return <WorkspacesSection />;
      default:
        return null;
    }
  };

  const renderSimplePage = (page: SimpleSettingsPage) => {
    const has = (id: AppSettingsSection) => page.sections.includes(id);
    switch (page.id) {
      case "general": return looks
        ? <SimpleLooksPage onBack={() => { setLooks(false); setReveal("appearance"); }} />
        : <SimpleGeneralPage has={has} peopleOpen={section === "people"} onLooks={() => setLooks(true)} />;
      case "ai": return <SimpleAiPage has={has} disclose={disclose} connections={renderSection("connections")} />;
      case "computer": return <SimpleComputerPage has={has} remoteAccess={remoteAccess} servers={renderSection("desktopWorkspaces")} disclose={disclose} />;
      case "billing": return <SimpleBillingPage has={has} disclose={disclose} cloudAccount={renderSection("cloudAccount")} />;
      case "updates": return <SimpleUpdatesPage remoteActive={remoteActive} />;
      default:
        return page.sections.map((id) => <section key={id} data-settings-block={id} className="flex scroll-mt-4 flex-col gap-4">{renderSection(id)}</section>);
    }
  };

  const close = () => dispatch({ type: "toggleAppSettings", open: false });
  const searchField = (className: string, inputClassName: string) => (
    <div className={className}>
      <Search size={15} aria-hidden="true" className="shrink-0 text-ink-secondary" />
      <input
        data-settings-search
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          if (query) setQuery("");
          else close();
        }}
        placeholder={t("settings.search")}
        aria-label={t("settings.searchAria")}
        className={inputClassName}
      />
    </div>
  );

  if (!advanced) {
    const looksOpen = looks && currentPage?.id === "general";
    const goTo = (id: AppSettingsSection) => { setLooks(false); openSection(id); };
    return (
      <div
        className="glass-popup-frame"
        data-settings-sheet
        data-settings-look="simple"
        style={glassPopupFrameStyle()}
        onMouseDown={(e) => e.target === e.currentTarget && close()}
      >
        <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0" />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="app-settings-title"
          tabIndex={-1}
          style={{ outline: "none" }}
          className="glass-surface glass-popup animate-pop-in relative flex overflow-hidden rounded-2xl text-ink"
        >
          <span id="app-settings-title" className="sr-only">{t("settings.title")}</span>
          <nav aria-label={t("settings.title")} className="glass-rail hidden min-h-0 w-[198px] shrink-0 flex-col gap-0.5 overflow-y-auto px-3 py-4 sm:flex">
            {searchField(
              "mb-2 flex h-8 shrink-0 items-center gap-2 rounded-lg bg-ink/[0.05] px-[9px] text-[13px] focus-within:ring-2 focus-within:ring-focus/60",
              "w-full min-w-0 bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none",
            )}
            {visiblePages.length === 0 && advancedMatches.length === 0 && keyResults.length === 0 && (
              <div className="px-[9px] py-3 text-[13px] leading-[18px] text-ink-secondary">{t("settings.noMatch", { query: query.trim() })}</div>
            )}
            {visiblePages.map((page) => {
              const Icon = page.icon;
              const current = page === currentPage;
              return (
                <button
                  key={page.id}
                  type="button"
                  data-settings-page={page.id}
                  onClick={() => goTo(page.sections[0]!)}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "flex h-8 shrink-0 cursor-pointer items-center gap-[9px] rounded-lg px-[9px] text-left text-[13px] text-ink transition-colors motion-reduce:transition-none",
                    current ? "bg-ink/[0.08]" : "hover:bg-ink/[0.06]",
                  )}
                >
                  <Icon size={15} aria-hidden="true" className="shrink-0" />
                  <span className="truncate">{t(page.labelKey)}</span>
                </button>
              );
            })}
            {advancedMatches.map((key) => (
              <button
                key={key}
                type="button"
                data-settings-advanced-only={key}
                onClick={() => { setQuery(""); goTo("general"); setReveal("advanced-mode"); }}
                className="flex min-h-8 shrink-0 cursor-pointer items-center rounded-lg px-[9px] py-1.5 text-left text-[13px] leading-[18px] text-ink transition-colors hover:bg-ink/[0.06] motion-reduce:transition-none"
              >
                <span>{t(key)} <span className="text-ink-secondary">· {t("settings.simple.advanced")}</span></span>
              </button>
            ))}
            {keyResultButtons("flex min-h-8 shrink-0 cursor-pointer items-center rounded-lg px-[9px] py-1.5 text-left text-[13px] leading-[18px] text-ink transition-colors hover:bg-ink/[0.06] motion-reduce:transition-none")}
          </nav>

          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex shrink-0 items-center gap-3 py-3 pl-4 pr-14 sm:pb-1.5 sm:pl-12 sm:pt-8">
              <Select className="min-w-0 sm:hidden"
                aria-label={t("settings.title")}
                value={currentPage?.id ?? ""}
                onChange={(event) => {
                  setQuery("");
                  const page = simplePages.find((candidate) => candidate.id === event.target.value);
                  if (page) goTo(page.sections[0]!);
                }}
              >
                {simplePages.map((page) => (
                  <option key={page.id} value={page.id}>{t(page.labelKey)}</option>
                ))}
              </Select>
              <h2 className="hidden truncate text-[17px] font-medium leading-6 tracking-[-0.008em] text-ink sm:block">
                {looksOpen ? t("settings.simple.page.looks") : currentPage ? t(currentPage.labelKey) : null}
              </h2>
            </header>
            <button
              type="button"
              onClick={close}
              aria-label={t("settings.close")}
              title={`${t("settings.close")} (${shortcutLabel("close-panel")})`}
              className="absolute right-3 top-3 flex size-8 cursor-pointer items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink motion-reduce:transition-none"
            >
              <X size={16} aria-hidden="true" />
            </button>

            <div
              ref={scrollRef}
              data-settings-scroll
              className={cn(
                "flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-4 pb-8 pt-4 sm:px-8 sm:pb-7 sm:pt-[22px]",
                SIMPLE_BUTTONS,
                "[&_.uppercase]:normal-case [&_.uppercase]:tracking-normal",
              )}
            >
              <LicenseExpiryBanner config={state.config} />
              {currentPage ? renderSimplePage(currentPage) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="glass-popup-frame"
      data-settings-sheet
      data-settings-look="advanced"
      style={glassPopupFrameStyle()}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      {/* A sibling, not the parent: a backdrop-filter on an ancestor would stop the pop-up's own glass from seeing the app behind it. */}
      <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        tabIndex={-1}
        className="glass-surface glass-popup animate-pop-in relative flex overflow-hidden rounded-2xl outline-none"
      >
        <span id="app-settings-title" className="sr-only">{t("settings.title")}</span>
        <nav className="glass-rail hidden min-h-0 w-[200px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline/30 p-3 sm:flex">
          <div className="shrink-0 px-2 py-3 text-[15px] font-semibold text-ink">
            {t("settings.title")}
          </div>
          {searchField(
            "mb-2 mt-1 flex h-8 shrink-0 items-center gap-2 rounded-lg bg-ink/[0.05] px-[9px] text-[13px] focus-within:ring-2 focus-within:ring-focus/60",
            "w-full min-w-0 bg-transparent text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none",
          )}
          {visibleSections.length === 0 && (
            <div className="px-2.5 py-4 text-[13px] leading-relaxed text-ink-secondary">
              {t("settings.noMatch", { query: query.trim() })}
            </div>
          )}
          {SETTINGS_GROUPS.map((group) => {
            const entries = visibleSections.filter((entry) => entry.group === group.id);
            if (entries.length === 0) return null;
            return (
              <div key={group.id} role="group" aria-labelledby={`settings-group-${group.id}`} data-settings-group={group.id} className="flex flex-col gap-0.5 pb-2">
                <div id={`settings-group-${group.id}`} className="px-[9px] pb-1 pt-2 text-[12px] font-medium leading-4 text-ink-tertiary">
                  {t(group.labelKey)}
                </div>
                {entries.map(({ id, labelKey, icon: Icon }) => (
                  <button
                    key={id}
                    data-settings-section={id}
                    onClick={() => openSection(id)}
                    aria-current={section === id ? "page" : undefined}
                    className={cn(
                      "flex h-8 shrink-0 cursor-pointer items-center gap-[9px] rounded-lg px-[9px] text-left text-[13px] text-ink transition-colors motion-reduce:transition-none",
                      section === id ? "bg-ink/[0.08]" : "hover:bg-ink/[0.06]",
                    )}
                  >
                    <Icon size={15} className="shrink-0" />
                    {t(labelKey)}
                  </button>
                ))}
              </div>
            );
          })}
          {keyResultButtons("cursor-pointer flex min-h-9 items-center rounded-lg px-2.5 py-2 text-left text-[13px] text-ink transition-colors hover:bg-control/50 motion-reduce:transition-none")}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline/30 px-3 py-3 sm:pl-9">
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
            <span className="hidden text-[15px] font-semibold text-ink sm:block">
              {sectionLabelKey ? t(sectionLabelKey) : null}
            </span>
            <button
              onClick={close}
              aria-label={t("settings.close")}
              title={`${t("settings.close")} (${shortcutLabel("close-panel")})`}
              className="ui-icon-button cursor-pointer shrink-0 max-md:size-9 max-md:rounded-full max-md:border max-md:border-hairline max-md:bg-card"
            >
              <X size={18} />
            </button>
          </div>

          <div ref={scrollRef} className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 py-4 sm:px-5 sm:pb-5">
            <LicenseExpiryBanner config={state.config} />
            {renderSection(section)}
          </div>
        </div>
      </div>
    </div>
  );
}
