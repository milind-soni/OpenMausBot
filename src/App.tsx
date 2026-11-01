import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, Loader2, Menu } from "lucide-react";
import { CLOUD_LINK_SETTINGS, openBot, StoreProvider, useStore } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";
import { useWelcomeViewer, WelcomeGate } from "@/components/onboarding/WelcomeGate";
import { MausBotWelcome } from "@/components/MausBotWelcome";
import { CloudTimeZoneSync } from "@/components/CloudTimeZone";
import { cloudSignInDue, spotlightsQuiet, type WelcomeViewer } from "@/lib/onboarding";
import { FirstConversationTour } from "@/components/onboarding/FirstConversationTour";
import { GuidedTour } from "@/components/onboarding/GuidedTour";
import { LiveCallHost } from "@/components/LiveCallHost";
import { ThreadRefsProvider } from "@/components/ThreadRefs";
import { initAnalytics } from "@/lib/analytics";
import { parseComputerHelp } from "@/lib/computer-control";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { SIDEBAR_AND_PANEL_FIT, SIDEBAR_INLINE, TWO_SIDE_PANELS_FIT, useMediaQuery } from "@/lib/use-media-query";
import { PluginsPanel, preloadConnectedApps } from "@/components/PluginsPanel";
import {
  ActivityPanel, BotSettingsDialog, ComputerPanel, FilesView, InspectorPanel, KeyboardShortcutsModal, LocalVmWorkspace,
  preloadScreens, RemoteAgentSettingsPanel, RemoteDesktopPanel, RoomPanel, SettingsModal, TeamMapPage, TriggersPage,
} from "@/components/lazy-screens";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useRoomPanelShown } from "@/lib/room-panel";
import { WorkspaceBackupRecovery } from "@/components/WorkspaceBackupSettings";
import { NotificationRail, NotificationsPanel } from "@/components/NotificationsPanel";
import { useNotificationFeed } from "@/lib/notification-preferences";
import { UpdateBanner } from "@/components/UpdateBanner";
import { AppNotices } from "@/components/AppNotices";
import { CloudAsleepStrip } from "@/components/CloudAsleepStrip";
import { LiveConnectionStrip } from "@/components/LiveConnectionStrip";
import { CloudSendStrip } from "@/components/CloudSendStrip";
import { HomeLine } from "@/components/HomeLine";
import { useTeamChats } from "@/state/team-chats";
import { needsYouVersion, useTeamPeopleLoader } from "@/state/team-people";
import { inboxVersion, useInboxLoader, useInboxPanel } from "@/state/inbox";
import { InboxPanel } from "@/components/inbox/InboxPanel";
import { CloudAddDialog } from "@/components/CloudAddDialog";
import { PlacesRail } from "@/components/PlacesRail";
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
import { WelcomeKeeper } from "@/components/cloud-welcome/WelcomeKeeper";
import { EmptyChatShell } from "@/components/onboarding/EmptyChatShell";
import { cloudFirstRun, cloudWelcomeVisible, useCloudWelcome } from "@/lib/cloud-welcome";
import { engineReady } from "@/components/EngineLibrary";
import { CommandPalette } from "@/components/CommandPalette";
import { setLocale, t } from "@/lib/i18n";
import { shouldOpenKeyboardShortcuts } from "@/lib/keyboard-shortcuts";
import { effectiveLanguage, useLanguageChoice } from "@/lib/language-preference";
import { botUnreadCount, showBrowserUnread } from "@/lib/bot-unread";
import { phonePairingSettingsAction, takePhonePairingRequest } from "@/lib/phone-pairing"; import { takeConnectRequest } from "@/lib/connect-link";
import { useExternalChatLinks } from "@/hooks/use-external-chat-links";
import { useUsageSnapshot } from "@/hooks/use-usage-snapshot";
import { useReadShownChatOnFocus } from "@/hooks/use-read-shown-chat";
import { usePresence } from "@/hooks/use-presence";
import { ChatNotice } from "@/components/ChatErrorBanner";
import { loadingLine } from "@/lib/app-loading";
import { useAiSwitchKeeper } from "@/lib/ai-switch";
import { useChiefStepOpen } from "@/lib/default-bot";
import { SESSION_ENDED_REASON, useSessionEnded } from "@/lib/session-ended";
import { PairPage } from "./pair/PairPage";
import { WebPanelPage } from "@/components/WebPanelPage";

function Shell({ viewer }: { viewer: WelcomeViewer | null }) {
  const { state, dispatch } = useStore();
  useTeamChats(state.config);
  useTeamPeopleLoader(state.config, needsYouVersion(state.bots, state.groups, state.notifications));
  const inbox = inboxVersion(state.bots);
  useInboxLoader(inbox);
  const inboxShown = useInboxPanel().open && inbox !== null;
  // A Switch AI pick lands once its stopped turn's chat is idle, wherever the person is by then.
  useAiSwitchKeeper({ bots: state.bots, dispatch });
  const showThreads = useShowThreads();
  const { capabilities } = useDesktopCapabilities();
  const captionChrome = useCaptionChrome();
  const unreadCount =
    state.bots.filter((bot) => !bot.hidden).reduce((sum, bot) => sum + botUnreadCount(bot), 0) +
    state.groups.filter((group) => group.unread).length;
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const twoSidePanelsFit = useMediaQuery(TWO_SIDE_PANELS_FIT, true);
  const sidebarAndPanelFit = useMediaQuery(SIDEBAR_AND_PANEL_FIT, true);
  const sidebarInline = useMediaQuery(SIDEBAR_INLINE, false);
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
  useEffect(() => { // A bot's link to a connection that needs the person on My Cloud opens the page that connects it.
    const request = takeConnectRequest(window.location.href);
    if (!request) return;
    window.history.replaceState(null, "", request.rest);
    dispatch("section" in request ? { type: "toggleAppSettings", open: true, section: request.section } : { type: "togglePlugins", open: true, surface: request.surface });
  }, [dispatch]);
  useExternalChatLinks(state, dispatch);
  usePresence(state, dispatch);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const language = effectiveLanguage(useLanguageChoice(), state.config?.language);
  const [, setLocaleEpoch] = useState(0);
  useEffect(() => {
    setLocale(language || globalThis.navigator?.language);
    setLocaleEpoch((epoch) => epoch + 1);
  }, [language]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [localVmWorkspaceBotId, setLocalVmWorkspaceBotId] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const previousViewRef = useRef(state.activeView);
  const calendarOriginRef = useRef<"chat" | "team-map" | "web-panel">("chat");
  const loading = loadingLine({ connected: state.connected, hydrated: state.hydrated === true, developer: import.meta.env.DEV });
  const group = state.groups.find((g) => g.id === state.selectedId);
  const chiefStep = useChiefStepOpen();
  const bot = group || chiefStep ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);
  const notificationFeed = useNotificationFeed() && !remoteClient;
  const advanced = useAdvancedMode();
  const roomPanelOpen = useRoomPanelShown({ group, state, simple: !advanced && !remoteClient });
  const sidePanelOpen = (Boolean(bot) && (state.settingsOpen || state.computerOpen || state.inspectorOpen || state.activityOpen)) || roomPanelOpen || (notificationFeed && state.notificationsOpen) || inboxShown;
  const collapseSidebar = sidePanelOpen && !sidebarAndPanelFit;
  const calendarFocus = state.activeView === "routines" && state.routinesFocus.view === "calendar";

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
      const bots = state.bots.filter((b) => !b.hidden);
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "newBot" });
      } else if (/^[1-9]$/.test(e.key)) {
        const target = bots[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          openBot(dispatch, target, showThreads);
        }
      } else if (e.shiftKey && (e.key === "[" || e.key === "]")) {
        const idx = bots.findIndex((b) => b.id === state.selectedId);
        const next = bots[(idx + (e.key === "]" ? 1 : -1) + bots.length) % bots.length];
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
    setDrawerOpen(false);
  }, [state.selectedId, bot?.threadId, group?.threadId, state.activeView, state.pluginsOpen, state.settingsOpen]);

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
    state.appSettingsOpen ||
    state.pluginsOpen;

  useEffect(() => {
    return window.ogb?.onOpenAppSettings?.(section => dispatch((section === "cloud-add" || section === "cloud-add-howto") && window.ogb?.cloudAccount && !remoteClient
      ? { type: "openCloudAdd", source: section === "cloud-add" ? "app_menu" : "app_howto" }
      : section === "cloud" && window.ogb?.cloudAccount && !remoteClient
        ? CLOUD_LINK_SETTINGS
        : section === "cloud-settings" && (window.ogb?.cloudAccount || window.ogb?.cloudPlan) && !remoteClient
          ? { type: "toggleAppSettings", open: true, section: "cloudAccount" }
          : { type: "toggleAppSettings", open: true, ...(section === "organization" && window.ogb?.organization && !remoteClient ? { section } : {}) }));
  }, [dispatch]);

  useEffect(() => {
    return window.ogb?.desktopViewer?.onState((viewer) => {
      if (viewer.open || !viewer.contextId) return;
      const botId = viewer.contextId;
      void fetch(`/api/bots/${botId}/computer/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "release" }),
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
    <UpdateBanner sidebarIndicator={framed || (!calendarFocus && (sidebarInline || drawerOpen))} />
    <CloudAsleepStrip />
    <LiveConnectionStrip connected={state.connected} hydrated={state.hydrated === true} />
    <CloudSendStrip cloudHome={state.config?.cloudHome === true} />
    <HomeLine />
    <AppNotices quiet={paletteOpen || drawerOpen || Boolean(localVmWorkspaceBotId)} viewer={viewer} />
  </>;
  return (
    <div className={cn("flex h-full flex-col", framed && "bg-frame")}>
      <WindowFrameBar />
      {!framed && strips}
      <div className="relative flex min-h-0 flex-1">
      {!calendarFocus && <button
        type="button"
        ref={menuButtonRef}
        aria-label="Open bot list"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
        className="absolute left-3 top-3 z-30 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink max-md:flex max-md:size-9 max-md:items-center max-md:justify-center max-md:rounded-full max-md:border max-md:border-hairline max-md:bg-card max-md:p-0 max-md:text-ink md:hidden"
      >
        <Menu size={18} className="max-md:hidden" />
        <ChevronLeft size={20} aria-hidden="true" className="hidden max-md:block" />
      </button>}
      {drawerOpen && !calendarFocus && (
        <div
          aria-hidden
          onMouseDown={(e) => e.target === e.currentTarget && setDrawerOpen(false)}
          className="absolute inset-0 z-30 bg-black/50 md:hidden"
        />
      )}
      {!calendarFocus && <PlacesRail />}
      {!calendarFocus && <Sidebar
        collapseToIcons={collapseSidebar}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          menuButtonRef.current?.focus();
        }}
      />}
      {/* A framed window shows the chat or page in a rounded card, on the frame beside the sidebar: its top corners and
          its bottom-left corner are round, and it runs to the window's right and bottom edges. */}
      <div data-window-card={framed ? "" : undefined}
        className={framed ? "relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-t-[12px] rounded-bl-[12px] bg-app ring-1 ring-ink/[0.06]" : "contents"}>
      {framed && strips}
      <div className={framed ? "relative flex min-h-0 flex-1" : "contents"}>
      {state.activeView === "team-map" ? (
        <TeamMapPage />
      ) : state.activeView === "files" ? (
        <FilesView />
      ) : state.activeView === "web-panel" ? (
        <WebPanelPage />
      ) : state.activeView === "routines" ? (
        <TriggersPage onBack={closeCalendar} onOpenRoom={openCalendarRoom} />
      ) : !remoteClient && localVmWorkspaceBotId ? (
        <LocalVmWorkspace
          primaryBotId={localVmWorkspaceBotId}
          overlayOpen={nativeViewOverlayOpen}
          onClose={() => setLocalVmWorkspaceBotId(null)}
          onOpenComputer={openComputerFromWorkspace}
        />
      ) : firstRun === "welcome" ? (
        <CloudWelcome />
      ) : firstRun === "intent" ? (
        <CloudIntent />
      ) : firstRun === "sign-in" ? (
        <CloudEngineSignIn />
      ) : noEngines ? (
        <NoEngines />
      ) : chiefStep ? (
        <EmptyChatShell />
      ) : group ? (
        <GroupView key={group.id} group={group} />
      ) : bot ? (
        <ChatView bot={bot} />
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
      {state.settingsOpen && bot && (
        remoteClient
          ? <RemoteAgentSettingsPanel bot={bot} overlay={state.computerOpen && !twoSidePanelsFit} />
          : <BotSettingsDialog key={`settings:${bot.id}`} bot={bot} overlay={(state.inspectorOpen || state.computerOpen || (notificationFeed && state.notificationsOpen)) && !twoSidePanelsFit} />
      )}
      {state.computerOpen && bot && (
        remoteClient ? (
          <RemoteDesktopPanel key={`computer:${bot.id}`} bot={bot} />
        ) : (
          <ComputerPanel
            key={`computer:${bot.id}`}
            bot={bot}
            onOpenVmWorkspace={openLocalVmWorkspace}
          />
        )
      )}
      {roomPanelOpen && group && (
        <RoomPanel key={`room:${group.id}`} group={group} overlay={notificationFeed && state.notificationsOpen && !twoSidePanelsFit} />
      )}
      {!remoteClient && state.inspectorOpen && bot && <InspectorPanel key={bot.threadId} bot={bot} />}
      {!remoteClient && state.activityOpen && bot && <ActivityPanel key={`activity:${bot.id}`} bot={bot} />}
      {inboxShown && <InboxPanel />}
      {notificationFeed && !calendarFocus && state.notificationsOpen && <NotificationsPanel />}
      {notificationFeed && !calendarFocus && <NotificationRail />}
      </div>
      </div>
      {state.appSettingsOpen && <SettingsModal />}
      <CloudAddDialog />
      <CloudHowTo />
      <CloudSetup viewer={viewer} welcomeShown={welcomeOnScreen} />
      <WelcomeKeeper viewer={viewer} />
      {state.pluginsOpen && <PluginsPanel />}
      {state.shortcutsOpen && (
        <KeyboardShortcutsModal
          open={state.shortcutsOpen}
          onClose={() => dispatch({ type: "toggleShortcuts", open: false })}
        />
      )}
      {/* After the modals: same z-50 tier, so DOM order keeps the palette on top. */}
      <CommandPalette onOpenChange={setPaletteOpen} />
      {/* Blink resolves -webkit-app-region in DOM order, so this no-drag twin after the headers cuts the drawer button back out. */}
      {!calendarFocus && <span
        aria-hidden
        data-drawer-button-no-drag
        style={captionChrome.noDragStyle}
        className="pointer-events-none absolute left-3 top-3 size-[30px] md:hidden"
      />}
      </div>
      {/* Last child on purpose: Blink resolves -webkit-app-region in DOM order, so no-drag buttons must follow every drag region. */}
      <WindowCaptionButtons
        visible={capabilities.windowChrome === "win-caption" && Boolean(window.ogb?.windowControls)}
      />
    </div>
  );
}

function Application() {
  useEffect(() => {
    initAnalytics();
  }, []);
  const viewer = useWelcomeViewer();
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        <ThreadRefsProvider>
          <Shell viewer={viewer} />
        </ThreadRefsProvider>
        <WelcomeGate viewer={viewer} />
        <MausBotWelcome viewer={viewer} />
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
  if (ended) return <PairPage initialCode={null} reason={SESSION_ENDED_REASON} />;
  return <WorkspaceBackupRecovery><Application /></WorkspaceBackupRecovery>;
}
