import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowDownToLine,
  ArrowLeftRight,
  Check,
  CreditCard,
  Cloud,
  FolderOpen,
  Info,
  HelpCircle,
  Keyboard,
  Laptop,
  LifeBuoy,
  Loader2,
  LogOut,
  MessageSquare,
  Sparkles,
  RefreshCw,
  Settings as SettingsIcon,
  Smartphone,
  UserRound,
  UsersRound,
  Zap,
} from "lucide-react";

import { accountMenuItems, AccountsSheet, useAccounts } from "./AccountMenu";
import { accountLine, useAccountSummary } from "./settings/account-summary";
import { usePhonePlaceState, type PhonePlaceState } from "./settings/phone-status";
import { useSettingsPlace } from "./settings/settings-place";
import { AccountMoveStatus, useAccountMove, type AccountMoveKind } from "./AccountMove";
import { InitialsAvatar } from "./Avatar";
import { AboutDialog } from "./AboutDialog";
import { CloudTile } from "./cloud-buy/parts";
import { usageBridge } from "./CloudUsageMeter";
import { useCloudPlanSnapshot } from "./CloudTrialNotice";
import type { WorkspacePlace } from "./DesktopWorkspaceSwitcher";
import { railShown, usePlaces } from "@/lib/places";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useAutomationsNeedYou } from "./SidebarFooterNav";
import { useCloudFilesReady } from "@/lib/cloud-files";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";
import { api, useStore, type Action, type AppSettingsSection } from "@/state/store";
import { serverCheckPhase, serverUpdateRow, type ServerUpdateCheck, type ServerUpdatePhase } from "@/lib/server-update";
import type { CloudAccountBridge, CloudAccountState } from "../../electron/cloud-account.mjs";
import { updaterMessage, useUpdaterState, type UpdaterState } from "@/lib/updater";
import { productName } from "../lib/brand";
import { cloudColor } from "@/lib/cloud-look";
import { cn } from "@/lib/cn";
import { meterPercent, resetLine } from "@/lib/usage-meter";
import type { CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import { activeLocale, t } from "@/lib/i18n";
import { FEEDBACK_URL, HELP_CENTER_URL, RELEASES_URL, appVersion, openExternalLink } from "@/lib/app-links";
import { pageIsThisComputer } from "@/lib/companion-bridge";
import { cloudPlanLabel } from "@/lib/cloud-plan";
import { shortcutLabel } from "./ShortcutHint";
import { useOtherServerName } from "@/lib/other-server";
import { isOwnerOrAdmin, profileForSession, readSessionState, type SessionState } from "@/lib/session";
import {
  cloudPhoneDestination,
  phonePairingSettingsAction,
  type CloudPhoneDestination,
  type PhoneDestination,
} from "@/lib/phone-pairing";

export function profileInitials(profile?: { name?: string; email?: string }): string {
  const name = profile?.name?.trim();
  if (name) {
    const words = name.split(/\s+/);
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  }
  const email = profile?.email?.trim();
  return email ? email[0]!.toUpperCase() : "?";
}

export function profileLabel(profile?: { name?: string; email?: string }): string {
  return profile?.name?.trim() || profile?.email?.trim() || t("sidebar.profile.you");
}

export type UpdatePhase =
  | UpdaterState["status"]
  | "up-to-date"
  // only a self-hosted server's check reports a release it cannot install itself
  | "available"
  // or that it already runs a newer version than this page
  | "reload";

export function updatePhase(state: UpdaterState | null, upToDate: boolean): UpdatePhase {
  const status = state?.status ?? "idle";
  if (status !== "idle") return status;
  return upToDate ? "up-to-date" : "idle";
}

export function updateLabel(phase: UpdatePhase, state: UpdaterState | null): string {
  switch (phase) {
    case "downloading":
      return state?.percent == null
        ? t("sidebar.update.startingDownload")
        : t("sidebar.update.downloading", { percent: Math.round(state.percent) });
    case "preparing":
      return t("sidebar.update.preparing");
    case "downloaded":
      return (
        state?.installMode === "handoff"
          ? t("sidebar.update.readyInstall", { app: productName(), version: state?.version ?? "" })
          : t("sidebar.update.ready", { app: productName(), version: state?.version ?? "" })
      ).replace("  ", " ");
    case "installing":
      return (
        updaterMessage(state) ||
        (state?.installMode === "handoff"
          ? t("sidebar.update.openingTerminal")
          : t("sidebar.update.installing"))
      );
    case "checking":
      return t("sidebar.update.checking");
    case "handed-off":
      return t("sidebar.update.handedOff");
    case "error":
      return updaterMessage(state)?.trim() || t("sidebar.update.failed");
    case "up-to-date":
      return t("sidebar.update.upToDate");
    default:
      return t("sidebar.update.check");
  }
}

export function updateBusy(phase: UpdatePhase, pending = false): boolean {
  return pending || phase === "checking" || phase === "downloading" || phase === "preparing" || phase === "installing";
}

function UpdateIcon({ phase, pending, size = 18 }: { phase: UpdatePhase; pending: boolean; size?: number }) {
  if (updateBusy(phase, pending)) return <Loader2 size={size} className="animate-spin" />;
  if (phase === "up-to-date") return <Check size={size} />;
  if (phase === "downloaded") return <ArrowDownToLine size={size} />;
  return <RefreshCw size={size} />;
}

export function updateHasButton(phase: UpdatePhase): boolean {
  return phase === "downloading" || phase === "preparing" || phase === "downloaded" || phase === "installing";
}

export function updateNoteworthy(phase: UpdatePhase, pending = false): boolean {
  return pending || (phase !== "idle" && phase !== "up-to-date" && phase !== "checking");
}

interface UpdateEntry {
  item: SidebarMenuItem;
  phase: UpdatePhase;
  pending: boolean;
  label: string;
  source?: "desktop" | "server";
  installMode?: string;
}

/** The update a Simple account menu raises to its top row: one waiting to be installed, or one that failed. */
export function simpleUpdateTop(entry: Pick<UpdateEntry, "phase" | "source" | "installMode"> | null): { label: string; action: string } | null {
  const ready = () => t("sidebar.update.readyShort");
  if (entry?.source === "desktop") {
    if (entry.phase === "downloaded") return { label: ready(), action: t(entry.installMode === "handoff" ? "sidebar.update.installAction" : "sidebar.update.restartAction") };
    if (entry.phase === "error") return { label: t("sidebar.update.failedShort"), action: t("sidebar.update.retryAction") };
  }
  if (entry?.source === "server") {
    if (entry.phase === "available") return { label: ready(), action: t("sidebar.update.installAction") };
    if (entry.phase === "reload") return { label: ready(), action: t("sidebar.update.restartAction") };
  }
  return null;
}

export function useUpdateItem(): UpdateEntry | null {
  const state = useUpdaterState();
  const updater = window.ogb?.updater;
  const [pending, setPending] = useState(false);
  const [checkedAt, setCheckedAt] = useState(0);
  const status = state?.status ?? "idle";

  useEffect(() => setPending(false), [status]);

  const upToDate = Boolean(checkedAt) && (!state || state.status === "idle") && Date.now() - checkedAt < 3000;
  useEffect(() => {
    if (!upToDate) return;
    const timer = setTimeout(() => setCheckedAt(0), 3000);
    return () => clearTimeout(timer);
  }, [upToDate]);

  if (!updater || !state) return null;

  const phase = updatePhase(state, upToDate);
  const label = updateLabel(phase, state);
  return {
    phase,
    pending,
    label,
    source: "desktop",
    installMode: state.installMode,
    item: {
      key: "update",
      label,
      icon: <UpdateIcon phase={phase} pending={pending} />,
      disabled: updateBusy(phase, pending) || state?.retryable === false,
      keepOpen: true,
      attention: phase === "downloaded" || phase === "error",
      attentionTone: phase === "error" ? "danger" : "accent",
      onSelect: () => {
        if (phase === "downloaded") {
          setPending(true);
          return void updater.install();
        }
        setCheckedAt(Date.now());
        void updater.check();
      },
    },
  };
}

/** Without the packaged app's updater the server cannot replace itself, so the row says whether a newer release exists and how to install it. */
export function useServerUpdateItem(enabled: boolean): UpdateEntry | null {
  const [phase, setPhase] = useState<ServerUpdatePhase>("idle");
  const [check, setCheck] = useState<ServerUpdateCheck | null>(null);
  const otherServer = useOtherServerName(enabled);

  useEffect(() => {
    if (phase !== "up-to-date") return;
    const timer = setTimeout(() => setPhase("idle"), 3000);
    return () => clearTimeout(timer);
  }, [phase]);

  if (!enabled) return null;
  const row = serverUpdateRow(phase, check, appVersion(), otherServer);
  return {
    phase,
    pending: false,
    label: row.label,
    source: "server",
    item: {
      key: "update",
      label: row.label,
      subtitle: row.subtitle,
      icon: <UpdateIcon phase={phase} pending={false} />,
      disabled: phase === "checking",
      keepOpen: true,
      attention: phase === "available" || phase === "reload" || phase === "error",
      attentionTone: phase === "error" ? "danger" : "accent",
      onSelect: () => {
        if (phase === "available" && check?.releaseUrl) return void openExternalLink(check.releaseUrl);
        if (phase === "reload") return window.location.reload();
        setPhase("checking");
        void api<ServerUpdateCheck>("/api/updates/check", { timeoutMs: 20_000 })
          .then((next) => {
            setCheck(next);
            setPhase(serverCheckPhase(next));
          })
          .catch(() => setPhase("error"));
      },
    },
  };
}

export function useCloudPhoneDestination(enabled: boolean): { cloud: CloudPhoneDestination; bridge?: CloudAccountBridge } {
  const bridge = enabled && !window.ogb?.remoteClient?.active ? window.ogb?.cloudAccount : undefined;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState((next) => { updated = true; if (active) setAccount(next); });
    void bridge.state().then((next) => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  return bridge ? { cloud: cloudPhoneDestination(account), bridge } : { cloud: null };
}

export function selectPhoneDestination(destination: PhoneDestination, { bridge, dispatch }: { bridge?: Pick<CloudAccountBridge, "connectHomeForPhone">; dispatch: (action: Action) => void }): void {
  if (destination.id !== "cloud" || !bridge) {
    dispatch(phonePairingSettingsAction());
    return;
  }
  void bridge.connectHomeForPhone().catch(() => dispatch({ type: "toggleAppSettings", open: true, section: "cloudAccount" }));
}

/** The menu row's line under Phone & devices: where a phone goes and how it is doing there, in a few words. */
export function phoneDevicesSubtitle(state: PhonePlaceState, place: string): string {
  switch (state.kind) {
    case "paired": return t("sidebar.menu.phoneDevices.paired", { count: state.count, place });
    case "attention": return t("sidebar.menu.phoneDevices.attention", { place });
    case "managed": return t("policy.managedBy", { organization: state.organization });
    case "chat-only": return t("remote.serverPairing.scope.client");
    case "portal": return t("sidebar.menu.phoneDevices.portal");
    default: return t("sidebar.menu.phoneDevices.notSetUp", { place });
  }
}

export function phoneDevicesItem(state: PhonePlaceState, place: string, onSelect: () => void): SidebarMenuItem {
  const dot = state.kind === "paired" && state.connected ? "bg-success" : state.kind === "attention" ? "bg-warning" : null;
  return {
    key: "phone-devices",
    label: t("settings.section.phoneDevices"),
    subtitle: phoneDevicesSubtitle(state, place),
    icon: <Smartphone size={16} />,
    trailing: dot ? <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", dot)} /> : undefined,
    onSelect,
  };
}

export function toolMenuItems({ activeView, automationsNeedYou, onAutomations, onTeamMap, onFiles, archived }: {
  activeView: string;
  automationsNeedYou: boolean;
  onAutomations: () => void;
  onTeamMap: () => void;
  /** set once My Cloud's files are ready to open */
  onFiles?: () => void;
  archived?: ArchivedBots;
}): SidebarMenuItem[] {
  return [
    { key: "automations", label: t("sidebar.nav.automations"), icon: <Zap size={16} />, active: activeView === "routines", attention: automationsNeedYou, onSelect: onAutomations },
    { key: "team-map", label: t("sidebar.nav.teamMap"), icon: <UsersRound size={16} />, active: activeView === "team-map", onSelect: onTeamMap },
    ...(onFiles ? [{ key: "files", label: t("sidebar.nav.files"), icon: <FolderOpen size={16} />, active: activeView === "files", onSelect: onFiles }] : []),
    ...(archived?.count ? [{ key: "archived", label: t("sidebar.archived.title"), icon: <Archive size={16} />, value: String(archived.count), onSelect: archived.open }] : []),
  ];
}

/** The account button's name: the person, then whatever its dot is raised for, then the move to My Cloud while it goes.
 * A failing move and automations that need the person share one segment. */
export function accountLabel(name: string, { automationsNeedYou, update, move = null }: { automationsNeedYou: boolean; update: string | null; move?: AccountMoveKind | null }): string {
  const needsYou = move === "failed"
    ? t(automationsNeedYou ? "sidebar.account.moveAndAutomationsNeedYou" : "sidebar.account.moveNeedsYou")
    : automationsNeedYou ? t("sidebar.account.automationsNeedYou") : "";
  return [name, needsYou, move === "sending" ? t("sidebar.account.moving") : "", update ?? ""].filter(Boolean).join(" · ");
}

export type AccountDot = "danger" | "accent";
const DOT_COLOR: Record<AccountDot, string> = { danger: "bg-danger", accent: "bg-accent" };

/** The avatar's dot: red while automations, a failed update or the failing move to My Cloud need the person, the accent
 * for an update; none for the move on its way or done (what it brought waits in the menu). */
export function accountDot({ automationsNeedYou, update, move }: { automationsNeedYou: boolean; update: "failed" | "news" | null; move: AccountMoveKind | null }): AccountDot | null {
  if (automationsNeedYou || update === "failed" || move === "failed") return "danger";
  return update ? "accent" : null;
}

/** `besideRail`: the window's rail of places stands beside the page and switches places, so Switch to… isn't offered twice. */
export function placeMenuItems(place: Pick<WorkspacePlace, "bridge" | "current" | "cloudHome" | "onLine" | "openMenu" | "switchable">, { owner, name, onCloudSettings, besideRail = false }: {
  owner: string | null;
  /** A team's name on a team's Cloud. */
  name?: string;
  onCloudSettings: () => void;
  besideRail?: boolean;
}): SidebarMenuItem[] {
  const here = <Check size={15} aria-hidden="true" className="shrink-0 text-ink-secondary" />;
  if (!place.switchable) {
    if (!place.cloudHome && !place.current?.home) return [];
    const subtitle = [place.onLine, owner ? t("sidebar.cloudOwner", { email: owner }) : ""].filter(Boolean).join(" · ");
    return [{ key: "place", label: name || t("cloudSetup.myCloud"), ...(subtitle ? { subtitle } : {}), icon: <Cloud size={16} />, trailing: here, onSelect: onCloudSettings }];
  }
  const current = place.current;
  const icon = cloudColor(current?.color) ? <CloudTile color={current?.color} size={16} />
    : current?.local === false || (place.cloudHome && !current) ? <Cloud size={16} /> : <Laptop size={16} />;
  return [
    ...(current ? [{ key: "place", label: current.name, ...(place.cloudHome && place.onLine ? { subtitle: place.onLine } : {}), icon, trailing: here, onSelect: place.openMenu }] : []),
    ...(besideRail ? [] : [{ key: "switch-place", label: t("sidebar.menu.switchTo"), icon: <ArrowLeftRight size={16} />, onSelect: place.openMenu }]),
  ];
}

type PlanWindowUse = { available: boolean; usedPercent: number | null; resetsAt: string | null };
export type PlanUsageWindows = { providers: Array<{ ok: boolean; plan: string | null; weekly: PlanWindowUse; fiveHour: PlanWindowUse; extra?: Array<{ label: string; usedPercent: number }> }> };

export interface UsageSummary {
  value: string;
  weekly?: boolean;
  resets?: string;
}

export function resetsIn(at: number | null, now: number): string | undefined {
  if (at === null || !Number.isFinite(at) || at <= now) return undefined;
  const hours = (at - now) / 3_600_000;
  const format = new Intl.RelativeTimeFormat(activeLocale(), { numeric: "auto" });
  return t("sidebar.menu.resets", { when: hours < 24 ? format.format(Math.max(1, Math.round(hours)), "hour") : format.format(Math.round(hours / 24), "day") });
}

export function planUsageSummary(report: PlanUsageWindows | null, now = Date.now()): UsageSummary | null {
  const signedIn = report?.providers.filter((provider) => provider.ok) ?? [];
  for (const window of ["weekly", "fiveHour"] as const) {
    const known = signedIn.map((provider) => provider[window]).filter((entry) => entry.available && entry.usedPercent !== null);
    if (known.length === 0) continue;
    const tightest = known.reduce((most, entry) => (entry.usedPercent! > most.usedPercent! ? entry : most));
    const resets = resetsIn(tightest.resetsAt ? Date.parse(tightest.resetsAt) : null, now);
    return { value: t("sidebar.menu.usageUsed", { percent: Math.round(tightest.usedPercent!) }), weekly: window === "weekly", ...(resets ? { resets } : {}) };
  }
  const budgets = signedIn.flatMap((provider) => provider.extra?.filter((extra) => extra.label === "Monthly spend") ?? []);
  return budgets.length ? { value: t("sidebar.menu.usageUsed", { percent: Math.round(Math.max(...budgets.map((budget) => budget.usedPercent))) }) } : null;
}

export function cloudUsageSummary(plan: CloudPlanSnapshot | null): UsageSummary | null {
  if (plan?.status !== "paid") return null;
  const usage = plan.usage;
  if (usage?.meters.length) return { value: t("sidebar.menu.usageUsed", { percent: Math.max(...usage.meters.map(meterPercent)) }), resets: resetLine(usage) };
  return null;
}

/** A key hint at a menu row's end: plain 12/16 tertiary text, the same for every row. */
function keyHint(label: string | null | undefined): React.ReactNode {
  return label ? <span aria-hidden="true" className="shrink-0 text-[12px] leading-4 text-ink-tertiary">{label}</span> : undefined;
}

/** ⌘, opens Settings from the app's own menu; a browser has no such key. */
function settingsKeyHint(): React.ReactNode {
  const platform = typeof window === "undefined" ? undefined : window.ogb?.platform;
  if (!platform) return undefined;
  return keyHint(platform === "darwin" ? "⌘," : "Ctrl+,");
}

export interface AccountHeader {
  name: string;
  line: string;
  avatar: React.ReactNode;
  onOpen: () => void;
}

/** One menu for Simple, Advanced and phone width: your account, Phone & devices and Settings, Simple's own places to go,
 * then Plan & billing and Help, with any other accounts and Sign out last. A ready update is raised to the top. */
export function profileMenuItems({
  phone,
  update,
  updateTop = null,
  move = [],
  header,
  plan = null,
  switchPlace = null,
  accounts = [],
  simple,
  onSettings,
  onShortcuts,
  onAbout,
  onHelp,
  onFeedback,
  onWhatsNew,
  signOut = null,
}: {
  phone: SidebarMenuItem | null;
  update: SidebarMenuItem | null;
  updateTop?: { label: string; action: string } | null;
  /** the move to My Cloud's own rows, first of all (AccountMove) */
  move?: SidebarMenuItem[];
  header: AccountHeader;
  plan?: SidebarMenuItem | null;
  /** only when the rail is hidden and there is another place to go to */
  switchPlace?: SidebarMenuItem | null;
  /** who is signed in on this device, and Sign out: the last rows */
  accounts?: SidebarMenuItem[];
  simple?: { tools: SidebarMenuItem[] };
  onSettings: () => void;
  onShortcuts: () => void;
  onAbout: () => void;
  onHelp: () => void;
  onFeedback: () => void;
  onWhatsNew?: () => void;
  /** the last row while someone is signed in, where signing out can work from this page */
  signOut?: (() => void) | null;
}): SidebarMenuItem[] {
  const raised: SidebarMenuItem | null = update && updateTop ? {
    ...update,
    label: updateTop.label,
    subtitle: undefined,
    attention: false,
    trailing: <span className="ui-button ui-button-sm ui-button-primary pointer-events-none flex h-6 shrink-0 items-center rounded-full px-2.5 text-[12px] font-medium">{updateTop.action}</span>,
  } : null;
  const help: SidebarMenuItem[] = [
    { key: "help", label: t("sidebar.menu.help"), icon: <HelpCircle size={16} />, onSelect: onHelp },
    ...(onWhatsNew ? [{ key: "whats-new", label: t("sidebar.menu.whatsNew"), icon: <Sparkles size={16} />, onSelect: onWhatsNew }] : []),
    { key: "shortcuts", label: t("sidebar.menu.shortcuts"), icon: <Keyboard size={16} />, trailing: keyHint(shortcutLabel("shortcuts-cheat-sheet")), onSelect: onShortcuts },
    { key: "feedback", label: t("sidebar.menu.feedback"), icon: <MessageSquare size={16} />, onSelect: onFeedback },
    ...(update && !raised ? [{ ...update, separatorBefore: true }] : []),
    { key: "about", label: t("sidebar.menu.aboutApp", { app: productName() }), icon: <Info size={16} />, separatorBefore: !(update && !raised), onSelect: onAbout },
  ];
  const account: SidebarMenuItem = { key: "account", label: header.name, subtitle: header.line, icon: header.avatar, large: true, chevron: true, onSelect: header.onOpen };
  const settings: SidebarMenuItem = { key: "settings", label: t("sidebar.menu.settings"), icon: <SettingsIcon size={16} />, trailing: settingsKeyHint(), onSelect: onSettings };
  const support: SidebarMenuItem = { key: "support", label: t("sidebar.menu.helpShort"), icon: <LifeBuoy size={16} />, submenu: help, onSelect: () => {} };
  const present = (...items: Array<SidebarMenuItem | null | false>) => items.filter((item): item is SidebarMenuItem => Boolean(item));
  const out: SidebarMenuItem[] = [...accounts.filter((item) => item.key !== "accounts-sign-out"),
    ...(signOut ? [{ key: "sign-out", label: t("accounts.signOut"), icon: <LogOut size={16} />, onSelect: signOut }] : accounts.filter((item) => item.key === "accounts-sign-out"))];
  const groups = simple
    ? [move, present(raised), [account], present(phone, settings), simple.tools, present(plan, switchPlace, support), out]
    : [move, present(raised), [account], present(phone, settings), present(plan, switchPlace, support), out];
  return groups.filter((group) => group.length > 0)
    .flatMap((group, at) => group.map((item, index) => (at > 0 && index === 0 ? { ...item, separatorBefore: true } : item)));
}

export interface ArchivedBots {
  count: number;
  open: () => void;
}

export interface SimpleAccount {
  place: WorkspacePlace;
  owner: string | null;
  automationsNeedYou: boolean;
  archived?: ArchivedBots;
}

export function useSimpleAccount(place: WorkspacePlace, owner: string | null, archived?: ArchivedBots): SimpleAccount {
  return { place, owner, automationsNeedYou: useAutomationsNeedYou(), archived };
}

/** `circle` is the phone's round avatar button at the top of the bot list. */
export function SidebarProfileMenu({ iconOnly = false, rail = false, circle = false, simple: account }: {
  iconOnly?: boolean; rail?: boolean; circle?: boolean; simple?: SimpleAccount;
} = {}) {
  const { state, dispatch } = useStore();
  const simple = account !== undefined;
  const [menuOpen, setMenuOpen] = useState(false);
  const advancedMode = useAdvancedMode();
  const automationsNeedYou = useAutomationsNeedYou();
  const planSnapshot = useCloudPlanSnapshot(usageBridge(state.config?.cloudHome === true) ?? (window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudPlan));
  const cloudUsage = cloudUsageSummary(planSnapshot);
  const phoneState = usePhonePlaceState(menuOpen);
  const place = useSettingsPlace();
  const summary = useAccountSummary();
  const desktopUpdate = useUpdateItem();
  const serverUpdate = useServerUpdateItem(!window.ogb?.updater);
  const here = pageIsThisComputer();
  const openComputer = window.ogb?.rail?.openComputer;
  // A Cloud's page in the desktop window can't update the app: the row says where that happens, and goes there.
  const elsewhereUpdate: UpdateEntry | null = !desktopUpdate && !here && Boolean(window.ogb) && state.config?.cloudHome === true && openComputer ? {
    phase: "idle", pending: false, label: t("sidebar.menu.checkFromHere", { place: t("rail.thisComputer") }),
    item: { key: "update", label: t("sidebar.menu.checkFromHere", { place: t("rail.thisComputer") }), icon: <RefreshCw size={16} />, onSelect: () => void openComputer("app").catch(() => {}) },
  } : null;
  const update = desktopUpdate ?? elsewhereUpdate ?? serverUpdate;
  const [aboutOpen, setAboutOpen] = useState(false);
  const [session, setSession] = useState<SessionState | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let active = true;
    void readSessionState().then((state) => {
      if (active) setSession(state);
    });
    return () => { active = false; };
  }, []);

  const profile = profileForSession(state.config?.profile, session);
  const name = profileLabel(profile);
  const remote = window.ogb?.remoteClient?.active === true;
  const besideRail = railShown(usePlaces());
  const filesReady = useCloudFilesReady();
  const desktop = Boolean(window.ogb);
  const planHere = !remote && (desktop ? Boolean(window.ogb?.cloudAccount || (window.ogb?.cloudPlan && state.config?.cloudHome === true))
    : state.config?.cloudHome === true && !state.config?.team && isOwnerOrAdmin(session));
  const openSettings = (section: AppSettingsSection) => dispatch({ type: "toggleAppSettings", open: true, section });
  const move = useAccountMove(state.config?.cloudHome === true, { onOpen: () => openSettings("plan"), onPairPhone: () => dispatch(phonePairingSettingsAction()) });
  const accounts = useAccounts();
  const openSource = desktop && !window.ogb?.cloudAccount && !window.ogb?.cloudPlan;
  const planLine = !desktop ? undefined : cloudUsage ? t("sidebar.menu.plan.used", { plan: summary.plan ?? cloudPlanLabel(planSnapshot?.tier), percent: cloudUsage.value.replace(/\D+/g, "") })
    : summary.signedIn === false || summary.plan === t("settings.account.free") ? t("sidebar.menu.plan.free") : summary.plan ?? undefined;

  const items = profileMenuItems({
    phone: remote ? null : phoneDevicesItem(phoneState, place.name, () => openSettings("phone")),
    update: update?.item ?? null,
    updateTop: simpleUpdateTop(update),
    move: move.items,
    header: {
      name,
      line: accountLine({ ...summary, email: summary.email ?? (summary.plan ? profile?.email ?? null : null) }, { browser: !desktop, place: place.name, openSource }),
      avatar: <InitialsAvatar initials={profileInitials(profile)} avatarUrl={profile?.avatarUrl} size={32} fontSize={13} className="bg-ink/[0.08]" />,
      onOpen: () => openSettings("account"),
    },
    plan: planHere ? { key: "plan", label: t("settings.page.plan"), ...(planLine ? { subtitle: planLine } : {}), icon: <CreditCard size={16} />, onSelect: () => openSettings("plan") } : null,
    switchPlace: !besideRail && desktop && !remote && window.ogb?.workspaces && account?.place.switchable
      ? { key: "switch-place", label: t("sidebar.menu.switchPlace"), icon: <ArrowLeftRight size={16} />, chevron: true, onSelect: account.place.openMenu } : null,
    accounts: accountMenuItems(accounts),
    // Simple's own places to go, at every width: the phone's round avatar has them too.
    ...(account || (circle && !advancedMode) ? { simple: {
      tools: toolMenuItems({
        activeView: state.activeView,
        automationsNeedYou: account?.automationsNeedYou ?? automationsNeedYou,
        onAutomations: () => dispatch({ type: "showRoutines", view: "list" }),
        onTeamMap: () => dispatch({ type: "showTeamMap" }),
        onFiles: filesReady ? () => dispatch({ type: "showFiles" }) : undefined,
        archived: account?.archived,
      }),
    } } : {}),
    onSettings: () => openSettings("overview"),
    onShortcuts: () => {
      triggerRef.current?.closest("button")?.focus();
      dispatch({ type: "toggleShortcuts", open: true });
    },
    onAbout: () => setAboutOpen(true),
    onHelp: () => void openExternalLink(HELP_CENTER_URL),
    onFeedback: () => void openExternalLink(FEEDBACK_URL),
    onWhatsNew: () => void openExternalLink(RELEASES_URL),
    signOut: accounts.view?.active ? null
      : !desktop && session?.kind === "session" ? () => { void api("/api/auth/logout", { method: "POST" }).finally(() => location.reload()); }
      : desktop && !remote && window.ogb?.cloudAccount && summary.signedIn ? () => { void window.ogb?.cloudAccount?.signOut().catch(() => {}); }
      : null,
  });
  const noteworthy = update && updateNoteworthy(update.phase, update.pending) && !updateHasButton(update.phase);
  const needsYou = account?.automationsNeedYou === true;
  const initials = profileInitials(profile);
  const nameless = simple && initials === "?" ? <UserRound size={18} strokeWidth={1.75} aria-hidden /> : undefined;
  const label = accountLabel(name, { automationsNeedYou: needsYou, update: simple && noteworthy && update ? update.label : null, move: move.kind });
  const dot = accountDot({ automationsNeedYou: needsYou, update: noteworthy ? (update.phase === "error" ? "failed" : "news") : null, move: move.kind });
  // Advanced's full row has its own update badge: its avatar's dot is the move's alone.
  const moveDot = accountDot({ automationsNeedYou: false, update: null, move: move.kind });

  return (
    <>
      <SidebarPopoverMenu
        width={272}
        items={items}
        ariaLabel={name}
        onOpenChange={setMenuOpen}
        triggerClassName={iconOnly || simple ? cn("shrink-0", circle || simple ? "rounded-full" : "rounded-xl") : "w-full"}
        triggerTitle={iconOnly || simple ? label : undefined}
        triggerLabel={label}
        triggerTour={account?.place.switchable ? "server-switcher" : undefined}
        renderTrigger={({ open }) => simple ? (
          <span
            ref={triggerRef}
            data-sidebar-account=""
            className={cn("relative flex size-9 items-center justify-center rounded-full ring-2 transition-shadow", open ? "ring-ink/15" : "ring-transparent hover:ring-ink/10")}
          >
            <InitialsAvatar initials={initials} avatarUrl={profile?.avatarUrl} size={36} fallback={nameless} fontSize={14} className="ring-1 ring-inset ring-ink/[0.04]" />
            {dot && <span aria-hidden data-account-dot={dot} className={cn("absolute -right-0.5 -top-0.5 size-2.5 rounded-full ring-2 ring-panel", DOT_COLOR[dot])} />}
          </span>
        ) : iconOnly ? (
          <span
            ref={triggerRef}
            className={cn(
              "relative flex items-center justify-center rounded-xl transition-colors",
              rail ? "size-10" : "size-[46px]",
              circle && "size-10 rounded-full border border-hairline bg-card",
              open ? "bg-raised" : "hover:bg-raised/50",
            )}
          >
            <InitialsAvatar initials={initials} avatarUrl={profile?.avatarUrl} size={rail ? 30 : circle ? 26 : 28} />
            {dot && <span aria-hidden data-account-dot={dot} className={cn("absolute end-1 top-1 size-2.5 rounded-full ring-2 ring-app", DOT_COLOR[dot])} />}
          </span>
        ) : (
          <span
            ref={triggerRef}
            className={cn(
              "flex min-h-[46px] w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors",
              open ? "bg-raised" : "hover:bg-raised/50",
            )}
          >
            <span className="relative flex shrink-0">
              <InitialsAvatar initials={profileInitials(profile)} avatarUrl={profile?.avatarUrl} size={28} className="bg-ink/[0.08]" />
              {moveDot && <span aria-hidden data-account-dot={moveDot} className={cn("absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-app", DOT_COLOR[moveDot])} />}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[14px] font-medium leading-5 text-ink">{name}</span>
              <AccountMoveStatus kind={move.kind} place={move.place} />
            </span>
            {noteworthy && (
              <span
                title={update.label}
                aria-label={update.label}
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full",
                  update.phase === "error" ? "bg-danger/15 text-danger" : "bg-accent/15 text-accent",
                )}
              >
                <UpdateIcon phase={update.phase} pending={update.pending} size={14} />
              </span>
            )}
          </span>
        )}
      />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      {accounts.sheet && <AccountsSheet adding={accounts.sheet.email} note={accounts.sheet.note} onClose={accounts.closeSheet} />}
    </>
  );
}
