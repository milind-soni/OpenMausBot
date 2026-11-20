import { useHorizontalDrag } from "@/hooks/use-horizontal-drag";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { useMenuMotion } from "@/components/MenuMotion";
import { ModalPresence } from "@/components/ModalPresence";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, Loader2, Menu } from "lucide-react";
import { CLOUD_LINK_SETTINGS, openBot, StoreProvider, useStore } from "@/state/store";
import { nextShortcutBot, shortcutBots, shownBotIds } from "@/lib/sidebar-shortcut-order";
import { useShowThreads } from "@/lib/thread-preferences";
import { useWelcomeViewer, WelcomeGate } from "@/components/onboarding/WelcomeGate";
import { MausBotWelcome } from "@/components/MausBotWelcome";
import { NewBotNameHost } from "@/components/NewBotName";
import { MemberApps } from "@/components/MemberApps";
import { CloudTimeZoneSync } from "@/components/CloudTimeZone";
import { cloudSignInDue, spotlightsQuiet, type WelcomeViewer } from "@/lib/onboarding";
import { FirstConversationTour } from "@/components/onboarding/FirstConversationTour";
import { GuidedTour } from "@/components/onboarding/GuidedTour";
import { LiveCallHost } from "@/components/LiveCallHost";
import { ThreadRefsProvider } from "@/components/ThreadRefs";
import { initAnalytics } from "@/lib/analytics";
import { useAppLoadSignal } from "@/lib/app-load";
import { cloudAccountBridge, openCloudOnWeb } from "@/lib/cloud-add-web";
import { parseComputerHelp } from "@/lib/computer-control";
import { viewerClosedRelease } from "@/components/computer-takeover";
import { Sidebar } from "@/components/Sidebar";
import { ChatV2 } from "@/components/chat-v2/ChatV2";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { ForkPanel } from "@/components/ForkPanel";
import { SIDEBAR_AND_PANEL_FIT, SIDEBAR_INLINE, TWO_SIDE_PANELS_FIT, useMediaQuery } from "@/lib/use-media-query";
import { preloadConnectedApps } from "@/lib/connected-apps";
import {
  ActivityPanel, AnnouncementsPage, BotSettingsDialog, CloudAddDialog, ComputerPanel, FilesView, InspectorPanel, KeyboardShortcutsModal, LocalVmWorkspace,
  PluginsPanel, preloadScreens, PublishedAppsPage, RemoteAgentSettingsPanel, RemoteDesktopPanel, SettingsModal, TeamFilesPage, TeamMapPage, TriggersPage,
} from "@/components/lazy-screens";
import { WorkspaceBackupRecovery } from "@/components/WorkspaceBackupSettings";
import { NotificationRail, NotificationsPanel } from "@/components/NotificationsPanel";
import { useNotificationFeed } from "@/lib/notification-preferences";
import { UpdateBanner } from "@/components/UpdateBanner";
import { AppNotices } from "@/components/AppNotices";
import { CliLoginCard } from "@/components/CliLoginCard";
import { AppGrantNotice } from "@/components/AppGrantPrompt";
import { BotLimitPopup } from "@/components/BotLimitPopup";
import { CloudAsleepStrip } from "@/components/CloudAsleepStrip";
import { LiveConnectionStrip } from "@/components/LiveConnectionStrip";
import { CloudSendStrip } from "@/components/CloudSendStrip";
import { HomeLine } from "@/components/HomeLine";
import { useTeamChats } from "@/state/team-chats";
import { needsYouVersion, useTeamPeopleLoader } from "@/state/team-people";
import { useTeamPresence } from "@/state/team-presence";
import { inboxVersion, useInboxLoader, useInboxPanel, useInboxReady } from "@/state/inbox";
import { InboxPanel } from "@/components/inbox/InboxPanel";
import { PlacesRail } from "@/components/PlacesRail";
import { NewLocalFromMenu } from "@/components/PlaceAddSheet";
import { CloudHowTo } from "@/components/CloudHowTo";
import { DesktopCapabilitiesProvider, useCaptionChrome, useDesktopCapabilities, WindowDragStrip, windowFramed } from "@/components/DesktopCapabilities";
import { WindowCaptionButtons } from "@/components/WindowCaptionButtons";
import { WindowFrameBar } from "@/components/WindowFrameBar";
import { cn } from "@/lib/cn";
import { NoEngines } from "@/components/NoEngines";
import { CloudEngineSignIn } from "@/components/CloudEngineSignIn";
import { CloudIntent } from "@/components/CloudIntent";
import { cloudIntentDue, cloudIntentShown, useCloudIntent } from "@/lib/cloud-intent";
import { CloudSetup } from "@/components/CloudSetup";
import { CloudWelcome } from "@/components/cloud-welcome/CloudWelcome";
import { TeamWelcome } from "@/components/TeamWelcome";
import { ConversationShareDialogs } from "@/components/conversation-share/ConversationShareDialogs";
import { invitedToTeam, teamWelcomeDue, useTeamWelcomeRecord } from "@/lib/team-welcome";
import { WelcomeKeeper } from "@/components/cloud-welcome/WelcomeKeeper";
import { EmptyChatShell } from "@/components/onboarding/EmptyChatShell";
import { cloudFirstRun, cloudWelcomeVisible, useCloudWelcome } from "@/lib/cloud-welcome";
import { engineReady } from "@/components/EngineLibrary";
import { CommandPalette } from "@/components/CommandPalette";
import { t } from "@/lib/i18n";
import { botCycleStep, shouldOpenKeyboardShortcuts } from "@/lib/keyboard-shortcuts";
import { effectiveLanguage, useLanguageChoice, usePageLanguage } from "@/lib/language-preference";
import { botUnreadCount, showBrowserUnread } from "@/lib/bot-unread";
import { phonePairingSettingsAction, takePhonePairingRequest } from "@/lib/phone-pairing"; import { useConnectLink } from "@/lib/use-connect-link";
import { isSettingsPage } from "@/components/settings/settings-index";
import { useBotListDrawer } from "@/hooks/use-bot-list-drawer";
import { useRememberedSidePanel } from "@/hooks/use-remembered-side-panel";
import { useDesktopNotificationOpens, useExternalChatLinks } from "@/hooks/use-external-chat-links"; import { useNewBotFromOtherPlace } from "@/lib/places-together";
import { useUsageSnapshot } from "@/hooks/use-usage-snapshot";
import { useReadShownChatOnFocus } from "@/hooks/use-read-shown-chat";
import { usePresence } from "@/hooks/use-presence";
import { ChatNotice } from "@/components/ChatErrorBanner";
import { loadingLine } from "@/lib/app-loading";
import { useAiSwitchKeeper } from "@/lib/ai-switch";
import { useChiefStepOpen } from "@/lib/default-bot";
import { useSessionEnded } from "@/lib/session-ended";
import { PairPage } from "./pair/PairPage";
import { WebPanelPage } from "@/components/WebPanelPage";
import { AppPreviewPanel } from "@/components/published-apps/AppPreviewPanel";
import { refreshPublishedApps } from "@/lib/own-published-apps";

import { usePhoneViewport } from "@/hooks/use-phone-viewport";

function Shell({ viewer }: { viewer: WelcomeViewer | null }) {
  const { state, dispatch } = useStore();
  const { chatV2, phoneLayout } = state;
  usePhoneViewport(Boolean(phoneLayout));
  const setChatV2 = (v2: boolean) => dispatch({ type: "chatView", v2 });
  useTeamChats(state.config);
  const needsYou = needsYouVersion(state.bots, state.groups, state.notifications);
  useTeamPeopleLoader(state.config, needsYou);
  useInboxLoader(`${inboxVersion(state.bots) ?? ""}|${needsYou}`);
  useEffect(() => { refreshPublishedApps(); }, []);
  const inboxReady = useInboxReady();
  const shortcutsMotion = useMenuMotion(state.shortcutsOpen);
  const settingsMotion = useMenuMotion(state.appSettingsOpen);
  const appsMotion = useMenuMotion(state.pluginsOpen);
  const botSettingsMotion = useMenuMotion(state.settingsOpen);
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const inspectorMotion = useMenuMotion(!remoteClient && !state.forkPanel && state.inspectorOpen);
  const activityMotion = useMenuMotion(!remoteClient && state.activityOpen);
  const computerMotion = useMenuMotion(state.computerOpen);
  const inboxShown = useInboxPanel().open && inboxReady;
  // A Switch AI pick lands once its stopped turn's chat is idle, wherever the person is by then.
  useAiSwitchKeeper({ bots: state.bots, dispatch });
  const showThreads = useShowThreads();
  const { capabilities } = useDesktopCapabilities();
  const captionChrome = useCaptionChrome();
  const unreadCount =
    state.bots.filter((bot) => !bot.hidden).reduce((sum, bot) => sum + botUnreadCount(bot), 0) +
    state.groups.filter((group) => group.unread).length;
  const twoSidePanelsFit = useMediaQuery(TWO_SIDE_PANELS_FIT, true);
  const sidebarAndPanelFit = useMediaQuery(SIDEBAR_AND_PANEL_FIT, true);
  const sidebarInline = useMediaQuery(SIDEBAR_INLINE, false);
  useEffect(() => {
    if (!sidebarInline && state.forkPanel) dispatch({ type: "closeForkPanel" });
  }, [sidebarInline, state.forkPanel, dispatch]);
  useRememberedSidePanel(state, dispatch, { enabled: sidebarInline, inspector: !remoteClient });
  useEffect(() => {
    if (!window.ogb?.environments) return;
    const open = (computerId?: string | null) => {
      if (computerId) {
        const target = new URL(window.location.href);
        target.searchParams.set("share-computer", computerId);
        window.history.replaceState(null, "", `${target.pathname}${target.search}${target.hash}`);
      }
      dispatch({ type: "toggleAppSettings", open: true, section: "desktopWorkspaces" });
    };
    const url = new URL(window.location.href);
    const requestedSettings = url.searchParams.get("desktop-settings");
    const cloud = ["cloud", "cloud-settings", "cloud-add", "cloud-add-howto"].includes(requestedSettings ?? "");
    if (requestedSettings === "workspaces" || (requestedSettings === "organization" && window.ogb.organization && !remoteClient) ||
      (cloud && window.ogb.cloudAccount && !remoteClient)) {
      url.searchParams.delete("desktop-settings");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      if (requestedSettings === "organization") dispatch({ type: "toggleAppSettings", open: true, section: "organization" });
      else if (requestedSettings === "cloud") dispatch(CLOUD_LINK_SETTINGS);
      else if (requestedSettings === "cloud-settings") dispatch({ type: "toggleAppSettings", open: true, section: "cloudAccount" });
      else if (requestedSettings === "cloud-add" || requestedSettings === "cloud-add-howto") dispatch({ type: "openCloudAdd", source: requestedSettings === "cloud-add" ? "app_menu" : "app_howto" });
      else open();
    }
    return window.ogb.environments.onOpenSettings?.(open);
  }, [dispatch]);
  useEffect(() => {
    const rest = takePhonePairingRequest(window.location.href);
    if (rest === null) return;
    window.history.replaceState(null, "", rest);
    dispatch(phonePairingSettingsAction());
  }, [dispatch]);
  useConnectLink(dispatch, Boolean(state.config?.team));
  useExternalChatLinks(state, dispatch); useDesktopNotificationOpens(state, dispatch); useNewBotFromOtherPlace(state.hydrated === true, useCallback(() => dispatch({ type: "newBot" }), [dispatch]));
  usePresence(state, dispatch); useTeamPresence(state);
  usePageLanguage(effectiveLanguage(useLanguageChoice(), state.config?.language), true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Stays mounted once opened: a Cloud bought in it can arrive after the sheet is closed.
  const cloudAddOpened = useRef(false);
  cloudAddOpened.current ||= Boolean(state.cloudAdd && cloudAccountBridge());
  // A layout effect runs inside the tap that asked, so a browser lets it open a tab.
  useLayoutEffect(() => {
    if (!state.cloudAdd || cloudAccountBridge()) return;
    openCloudOnWeb(state.cloudAdd, { cloudHome: state.config?.cloudHome === true, teamCloudPage: state.config?.team?.cloudPage });
    dispatch({ type: "closeCloudAdd" });
  }, [state.cloudAdd]);
  const [localVmWorkspaceBotId, setLocalVmWorkspaceBotId] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const previousViewRef = useRef(state.activeView);
  const calendarOriginRef = useRef<"chat" | "team-map" | "web-panel">("chat");
  const loading = loadingLine({ connected: state.connected, hydrated: state.hydrated === true, developer: import.meta.env.DEV });
  const group = state.groups.find((g) => g.id === state.selectedId);
  const chiefStep = useChiefStepOpen();
  const bot = group || chiefStep ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);
  const chatPane = useRef<HTMLDivElement>(null);
  const chatOwnerId = group?.id ?? bot?.id;
  const chatThreadId = group?.threadId ?? bot?.threadId;
  useLayoutEffect(() => {
    const pane = chatPane.current;
    if (!pane?.animate || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ||
        document.documentElement.dataset.reducedMotion === "true") return;
    const animation = pane.animate([{ opacity: 0.45 }, { opacity: 1 }], {
      duration: 180, easing: "ease-out",
    });
    return () => animation.cancel();
  }, [chatOwnerId, chatThreadId, chatV2, state.activeView]);

  const { open: drawerOpen, show: openDrawer, hide: hideDrawer, noteAction: noteDrawerAction } = useBotListDrawer({ selectedId: state.selectedId, botThread: bot?.threadId, groupThread: group?.threadId,
    view: state.activeView, pluginsOpen: state.pluginsOpen, settingsOpen: state.settingsOpen });
  const closeDrawer = useCallback(() => {
    hideDrawer();
    requestAnimationFrame(() => menuButtonRef.current?.focus({ preventScroll: true }));
  }, [hideDrawer]);
  const drawerDirection = useRef(1);
  const drawerGesture = useHorizontalDrag(event => {
    if (!phoneLayout || !(event.target instanceof Element)) return false;
    if (!event.currentTarget.querySelector("[data-bot-list-chat]")) return false;
    const surface = event.target.closest(drawerOpen ? "[data-sidebar]" : "[data-bot-list-chat]");
    if (!surface) return false;
    drawerDirection.current = getComputedStyle(surface).direction === "rtl" ? -1 : 1;
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return false;
    if (event.pointerType === "mouse" && event.target.closest('[draggable="true"]')) return false;
    if (drawerOpen) return true;
    const bounds = surface.getBoundingClientRect();
    const leading = drawerDirection.current === 1 ? event.clientX - bounds.left : bounds.right - event.clientX;
    return leading <= 24;
  }, (stage, dx) => {
    if (dx === null) {
      stage.style.removeProperty("--drawer-offset");
      stage.removeAttribute("data-drawer-dragging");
      return;
    }
    const width = window.innerWidth;
    const distance = (drawerOpen ? width : 0) + dx * drawerDirection.current;
    const offset = Math.min(width, Math.max(0, distance)) * drawerDirection.current;
    stage.style.setProperty("--drawer-offset", `${offset}px`);
    stage.setAttribute("data-drawer-dragging", "");
  }, dx => {
    const distance = dx * drawerDirection.current;
    if (drawerOpen && distance <= -56) closeDrawer();
    if (!drawerOpen && distance >= 56) openDrawer();
  });
  const notificationFeed = useNotificationFeed() && !remoteClient;

  const notificationsMotion = useMenuMotion(notificationFeed && state.notificationsOpen);
  const sidePanelOpen = (Boolean(bot) && (state.settingsOpen || state.computerOpen || state.inspectorOpen || state.activityOpen)) || Boolean(state.forkPanel) || (notificationFeed && state.notificationsOpen) || inboxShown;
  const collapseSidebar = sidePanelOpen && !sidebarAndPanelFit;

  const noEngines =
    state.connected &&
    state.instances.length > 0 &&
    !state.instances.some((i) => i.snapshot.state === "available");
  const cloudSignIn = cloudSignInDue(viewer, state, engineReady);
  const cloudIntent = useCloudIntent();
  const cloudAsk = cloudIntentShown(cloudIntentDue({
    viewer, connected: state.connected, enginesKnown: state.instances.length > 0,
    onboarding: state.config?.onboarding, reopened: false,
  }), cloudIntent);
  const cloudJobWaiting = Boolean(viewer?.cloudHome && viewer.canSave && cloudIntent.pending);
  const welcome = useCloudWelcome();
  const welcomeOnScreen = cloudWelcomeVisible({ viewer, connected: state.connected, enginesKnown: state.instances.length > 0, onboarding: state.config?.onboarding }, welcome)
    && state.activeView === "chat" && !(!remoteClient && localVmWorkspaceBotId);
  const firstRun = cloudFirstRun({ welcome: welcomeOnScreen, intent: cloudAsk, signIn: cloudSignIn || cloudJobWaiting });
  const team = state.config?.team ?? null;
  const invited = invitedToTeam(viewer);
  const teamWelcomeRecord = useTeamWelcomeRecord(team && invited ? team.id : null);
  const teamWelcomeOn = teamWelcomeDue({ team, invited, record: teamWelcomeRecord }) && state.activeView === "chat";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || state.shortcutsOpen) return;
      if (shouldOpenKeyboardShortcuts(e)) {
        e.preventDefault();
        dispatch({ type: "toggleShortcuts", open: true });
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const bots = shortcutBots(state.bots.filter((b) => !b.hidden), shownBotIds(document.querySelector("[data-sidebar-root]")));
      const step = e.shiftKey ? botCycleStep(e) : null;
      if (e.key.toLowerCase() === "n" && !e.altKey) {
        e.preventDefault();
        if (e.shiftKey) {
          const selected = state.bots.find((bot) => bot.id === state.selectedId && !bot.hidden);
          if (!e.repeat && selected && selected.yourAccess !== "view") dispatch({ type: "newTask", botId: selected.id });
        } else {
          dispatch({ type: "newBot" });
        }
      } else if (/^[1-9]$/.test(e.key)) {
        const target = bots[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          openBot(dispatch, target, showThreads);
        }
      } else if (step !== null) {
        const next = nextShortcutBot(bots, state.selectedId, step);
        if (next) {
          e.preventDefault();
          openBot(dispatch, next, showThreads);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.bots, state.selectedId, state.shortcutsOpen, showThreads, dispatch]);

  useReadShownChatOnFocus();
  useEffect(() => {
    if (window.ogb?.setUnreadCount) window.ogb.setUnreadCount(unreadCount);
    else showBrowserUnread(unreadCount);
  }, [unreadCount]);

  useEffect(() => {
    if (!state.connected) return;
    void preloadConnectedApps(false, true).catch(() => {}); // a background read: a reconnect is nobody using a Cloud home
  }, [state.connected]);
  useUsageSnapshot();

  useEffect(() => preloadScreens(), []);

  useEffect(() => {
    if (state.activeView === "routines" && previousViewRef.current !== "routines") {
      calendarOriginRef.current = previousViewRef.current === "team-map" || previousViewRef.current === "web-panel" ? previousViewRef.current : "chat";
    }
    previousViewRef.current = state.activeView;
  }, [state.activeView]);

  useEffect(() => {
    if (
      localVmWorkspaceBotId &&
      (state.activeView !== "chat" || state.selectedId !== localVmWorkspaceBotId)
    ) {
      setLocalVmWorkspaceBotId(null);
    }
  }, [localVmWorkspaceBotId, state.activeView, state.selectedId]);

  const openLocalVmWorkspace = (botId: string) => {
    dispatch({ type: "toggleComputer", open: false });
    setLocalVmWorkspaceBotId(botId);
  };

  const openComputerFromWorkspace = (botId: string) => {
    setLocalVmWorkspaceBotId(null);
    dispatch({ type: "select", id: botId });
    dispatch({ type: "toggleComputer", open: true });
  };

  const closeCalendar = useCallback(() => {
    if (calendarOriginRef.current === "team-map") {
      dispatch({ type: "showTeamMap" });
      return;
    }
    if (calendarOriginRef.current === "web-panel" && state.webPanelId) {
      dispatch({ type: "showWebPanel", id: state.webPanelId });
      return;
    }
    dispatch({ type: "select", id: state.selectedId });
  }, [dispatch, state.selectedId, state.webPanelId]);
  const openCalendarRoom = useCallback((id: string) => {
    dispatch({ type: "select", id });
  }, [dispatch]);

  const nativeViewOverlayOpen =
    drawerOpen ||
    paletteOpen ||
    state.settingsOpen ||
    state.computerOpen ||
    state.inspectorOpen ||
    state.activityOpen ||
    settingsMotion.shown ||
    appsMotion.shown ||
    shortcutsMotion.shown;

  useEffect(() => {
    return window.ogb?.onOpenAppSettings?.(section => dispatch(section === "phone" ? phonePairingSettingsAction() : (section === "cloud-add" || section === "cloud-add-howto") && window.ogb?.cloudAccount && !remoteClient
      ? { type: "openCloudAdd", source: section === "cloud-add" ? "app_menu" : "app_howto" }
      : section === "cloud" && window.ogb?.cloudAccount && !remoteClient
        ? CLOUD_LINK_SETTINGS
        : section === "cloud-settings" && (window.ogb?.cloudAccount || window.ogb?.cloudPlan) && !remoteClient
          ? { type: "toggleAppSettings", open: true, section: "cloudAccount" }
          : { type: "toggleAppSettings", open: true, ...((section === "organization" && window.ogb?.organization && !remoteClient) || isSettingsPage(section) ? { section } : {}) }));
  }, [dispatch]);

  useEffect(() => {
    return window.ogb?.desktopViewer?.onState((viewer) => {
      if (viewer.open || !viewer.contextId) return;
      const botId = viewer.contextId, release = viewerClosedRelease(botId);
      if (release) void fetch(`/api/bots/${botId}/computer/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(release),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((snap) => {
          if (snap) dispatch({ type: "computerControl", botId, held: snap.held === true, helpReason: snap.helpReason ?? null, help: parseComputerHelp(snap.help) });
        })
        .catch(() => {});
      void fetch(`/api/bots/${botId}/computer/viewer-close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => {});
    });
  }, [dispatch]);

  const framed = windowFramed(capabilities);
  const strips = <>
    <UpdateBanner sidebarIndicator={framed || sidebarInline || drawerOpen} />
    <CloudAsleepStrip />
    <LiveConnectionStrip connected={state.connected} hydrated={state.hydrated === true} />
    <CloudSendStrip cloudHome={state.config?.cloudHome === true} />
    <HomeLine />
    <AppNotices quiet={paletteOpen || drawerOpen || Boolean(localVmWorkspaceBotId)} viewer={viewer} />
    <CliLoginCard />
  </>;
  return (
    <div data-look="app" className={cn("flex h-full min-w-0 flex-col max-md:overflow-x-clip", framed && "bg-frame")} onClickCapture={drawerOpen ? noteDrawerAction : undefined} onKeyDownCapture={drawerOpen ? noteDrawerAction : undefined}>
      <WindowFrameBar notifications={notificationFeed} />
      <BotLimitPopup />
      <ConversationShareDialogs />
      {!framed && strips}
      <div data-bot-list-stage={drawerOpen ? "open" : "closed"}
        className="relative flex min-h-0 min-w-0 flex-1"
        {...drawerGesture}>
      <button
        type="button"
        ref={menuButtonRef}
        data-bot-list-trigger=""
        inert={phoneLayout && drawerOpen}
        aria-label={t("app.openBotList")}
        aria-expanded={drawerOpen}
        onClick={openDrawer}
        className="absolute start-2 top-2.5 z-30 rounded-md p-1.5 text-ink-secondary interaction:bg-raised/50 hover:text-ink max-md:flex max-md:size-11 max-md:items-center max-md:justify-center max-md:rounded-full max-md:border max-md:border-edge max-md:bg-composer max-md:p-0 max-md:text-ink md:hidden"
      >
        <Menu size={18} className="max-md:hidden" />
        <ChevronLeft size={20} aria-hidden="true" className="hidden max-md:block rtl:-scale-x-100" />
      </button>

        <div
          aria-hidden
          data-sidebar-drawer-scrim=""
          onMouseDown={hideDrawer}
          className={cn("absolute inset-0 z-30 bg-black/50 transition-opacity duration-200 motion-reduce:transition-none md:hidden", !drawerOpen && "pointer-events-none opacity-0")}
        />
      <PlacesRail />
      <NewLocalFromMenu />
      {/* A framed window shows the app, its sidebar and the chat or page, in a rounded card under the top bar and beside
          the window's rail: its top corners and its bottom-left corner are round, and it runs to the window's right and
          bottom edges. */}
      <div data-window-card={framed ? "" : undefined}
        className={framed ? "relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-t-[12px] rounded-bl-[12px] bg-app" : "contents"}>
      {framed && strips}
      <div className={framed ? "relative flex min-h-0 flex-1" : "contents"}>
      <Sidebar
        collapseToIcons={collapseSidebar}
        open={drawerOpen}
        onClose={closeDrawer}
      />
      {state.activeView === "team-map" ? (
        <TeamMapPage />
      ) : state.activeView === "files" ? (
        <FilesView />
      ) : state.activeView === "web-panel" ? (
        <WebPanelPage />
      ) : state.activeView === "published-apps" ? (
        <PublishedAppsPage />
      ) : state.activeView === "announcements" ? (
        <AnnouncementsPage />
      ) : state.activeView === "team-files" && state.config?.team ? (
        <TeamFilesPage />
      ) : state.activeView === "routines" ? (
        <TriggersPage onBack={closeCalendar} onOpenRoom={openCalendarRoom} />
      ) : !remoteClient && localVmWorkspaceBotId ? (
        <LocalVmWorkspace
          primaryBotId={localVmWorkspaceBotId}
          overlayOpen={nativeViewOverlayOpen}
          onClose={() => setLocalVmWorkspaceBotId(null)}
          onOpenComputer={openComputerFromWorkspace}
        />
      ) : teamWelcomeOn && team ? (
        <TeamWelcome team={team} invitedBy={teamWelcomeRecord?.invitedBy ?? null} />
      ) : firstRun === "welcome" ? (
        <CloudWelcome />
      ) : firstRun === "intent" ? (
        <CloudIntent />
      ) : firstRun === "sign-in" ? (
        <CloudEngineSignIn />
      ) : chiefStep ? (
        <EmptyChatShell />
      ) : group || bot ? (
        <div data-bot-list-chat="" inert={phoneLayout && drawerOpen}
          className="flex h-full min-w-0 flex-1 max-md:max-w-full max-md:overflow-x-clip">
          <div ref={chatPane} className="flex h-full min-w-0 flex-1">
          {group ? <GroupView key={group.id} group={group} /> : bot && (
            chatV2 ? <ChatV2 key={bot.threadId} profile={bot} phoneLayout={phoneLayout} onClose={() => setChatV2(false)} />
              : <ChatView bot={bot} onOpenV2={() => setChatV2(true)} />
          )}
          </div>
        </div>
      ) : noEngines ? (
        <NoEngines />
      ) : (
        <main data-app-loading={loading.text} className="relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
          <WindowDragStrip />
          <div className="w-full max-w-md"><ChatNotice notice={state.notice} /></div>
          {loading.busy && <Loader2 size={20} className="animate-spin" />}
          <div className="text-[14px]">{t(loading.text)}</div>
          {loading.command && (
            <div className="text-[12px]">
            {t("app.loading.startServer")} <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
            </div>
          )}
        </main>
      )}
      {/* Sibling panels need distinct keys: two keyed `bot.id` collide in React's keyed reconciliation. */}
      {bot && botSettingsMotion.shown && (
        remoteClient
          ? <RemoteAgentSettingsPanel closing={botSettingsMotion.closing} bot={bot} overlay={state.computerOpen && !twoSidePanelsFit} />
          : <BotSettingsDialog key={`settings:${bot.id}`} bot={bot} closing={botSettingsMotion.closing} overlay={(state.inspectorOpen || state.computerOpen || (notificationFeed && state.notificationsOpen)) && !twoSidePanelsFit} />
      )}
      {bot && (
        remoteClient ? (
          computerMotion.shown && <RemoteDesktopPanel key={`computer:${bot.id}`} bot={bot} closing={computerMotion.closing} />
        ) : (
          computerMotion.shown && <ComputerPanel
            key={`computer:${bot.id}`}
            bot={bot}
            closing={computerMotion.closing}
            onOpenVmWorkspace={openLocalVmWorkspace}
          />
        )
      )}
      <AppPreviewPanel />
      {sidebarInline && <ForkPanel />}
      {inspectorMotion.shown && bot && <InspectorPanel closing={inspectorMotion.closing} key={bot.threadId} bot={bot} />}
      {activityMotion.shown && bot && <ActivityPanel closing={activityMotion.closing} key={`activity:${bot.id}`} bot={bot} />}
      <InboxPanel open={inboxShown} />
      {notificationsMotion.shown && <NotificationsPanel closing={notificationsMotion.closing} />}
      {notificationFeed && !framed && <NotificationRail />}
      </div>
      </div>
      {settingsMotion.shown && <SettingsModal open={state.appSettingsOpen} pendingFallback={state.appSettingsOpen && (
        <SettingsDialog title={t("settings.title")} onClose={() => dispatch({ type: "toggleAppSettings", open: false })}>
          <progress className="h-1 w-full accent-accent" aria-label={t("settings.title")} />
        </SettingsDialog>
      )} />}
      {cloudAddOpened.current && <CloudAddDialog />}
      <CloudHowTo />
      <CloudSetup viewer={viewer} welcomeShown={welcomeOnScreen} />
      <WelcomeKeeper viewer={viewer} />
      <ModalPresence open={state.pluginsOpen}>{team && viewer?.canSave === false ? <MemberApps /> : <PluginsPanel />}</ModalPresence>
      <AppGrantNotice />
      {shortcutsMotion.shown && (
        <KeyboardShortcutsModal
          open={state.shortcutsOpen}
          onClose={() => dispatch({ type: "toggleShortcuts", open: false })}
        />
      )}
      <CommandPalette onOpenChange={setPaletteOpen} />
      {/* Blink resolves -webkit-app-region in DOM order, so this no-drag twin after the headers cuts the drawer button back out. */}
      <span
        aria-hidden
        data-drawer-button-no-drag
        style={captionChrome.noDragStyle}
        className="pointer-events-none absolute left-3 top-3 size-[30px] md:hidden"
      />
      </div>
      {/* Last child on purpose: Blink resolves -webkit-app-region in DOM order, so no-drag buttons must follow every drag region. */}
      <WindowCaptionButtons
        visible={capabilities.windowChrome === "win-caption" && Boolean(window.ogb?.windowControls)}
      />
    </div>
  );
}

function AppLoadSignal() {
  useAppLoadSignal();
  return null;
}

function Application() {
  useEffect(() => {
    initAnalytics();
  }, []);
  const viewer = useWelcomeViewer();
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        <AppLoadSignal />
        <ThreadRefsProvider>
          <Shell viewer={viewer} />
        </ThreadRefsProvider>
        <WelcomeGate viewer={viewer} />
        <MausBotWelcome viewer={viewer} />
        <NewBotNameHost />
        <CloudTimeZoneSync viewer={viewer} />
        <GuidedTour />
        <LiveCallHost />
        <FirstConversationTour quiet={spotlightsQuiet(viewer)} />
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}

export default function App() {
  const ended = useSessionEnded();
  if (ended) return <PairPage initialCode={null} reason={t("pair.sessionEnded")} />;
  return <WorkspaceBackupRecovery><Application /></WorkspaceBackupRecovery>;
}
