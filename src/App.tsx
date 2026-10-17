import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Menu } from "lucide-react";
import { CLOUD_LINK_SETTINGS, openBot, StoreProvider, useStore } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";
import { useWelcomeViewer, WelcomeGate } from "@/components/onboarding/WelcomeGate";
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
  ActivityPanel, BotSettingsDialog, ComputerPanel, FilesView, InspectorPanel, KeyboardShortcutsModal, LocalVmWorkspace, NewBotDialog,
  preloadScreens, RemoteAgentSettingsPanel, RemoteDesktopPanel, RoutinesPage, SettingsModal, TeamMapPage, TodayPage, TriggersPanel,
} from "@/components/lazy-screens";
import { WorkspaceBackupRecovery } from "@/components/WorkspaceBackupSettings";
import { NotificationRail, NotificationsPanel } from "@/components/NotificationsPanel";
import { useNotificationFeed } from "@/lib/notification-preferences";
import { UpdateBanner } from "@/components/UpdateBanner";
import { AppNotices } from "@/components/AppNotices";
import { CloudAddDialog } from "@/components/CloudAddDialog";
import { finishCloudProHandoff, takeCloudProHandoff } from "@/components/CloudProPopup";
import { CloudHowTo } from "@/components/CloudHowTo";
import { CloudHomeNote } from "@/components/CloudMove";
import { DesktopCapabilitiesProvider, useCaptionChrome, useDesktopCapabilities, WindowDragStrip } from "@/components/DesktopCapabilities";
import { WindowCaptionButtons } from "@/components/WindowCaptionButtons";
import { NoEngines } from "@/components/NoEngines";
import { CloudEngineSignIn } from "@/components/CloudEngineSignIn";
import { CloudIntent } from "@/components/CloudIntent";
import { cloudIntentDue, cloudIntentShown, useCloudIntent } from "@/lib/cloud-intent";
import { CloudSetup } from "@/components/CloudSetup";
import { CloudWelcome } from "@/components/cloud-welcome/CloudWelcome";
import { WelcomeKeeper } from "@/components/cloud-welcome/WelcomeKeeper";
import { cloudFirstRun, cloudWelcomeVisible, useCloudWelcome } from "@/lib/cloud-welcome";
import { engineReady } from "@/components/EngineLibrary";
import { CommandPalette } from "@/components/CommandPalette";
import { setLocale } from "@/lib/i18n";
import { shouldOpenKeyboardShortcuts } from "@/lib/keyboard-shortcuts";
import { effectiveLanguage, useLanguageChoice } from "@/lib/language-preference";
import { botShowsUnread } from "@/lib/bot-unread";
import { phonePairingSettingsAction, takePhonePairingRequest } from "@/lib/phone-pairing";
import { useExternalChatLinks } from "@/hooks/use-external-chat-links";
import { useUsageSnapshot } from "@/hooks/use-usage-snapshot";
import { ChatNotice } from "@/components/ChatErrorBanner";

function Shell({ viewer }: { viewer: WelcomeViewer | null }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const { capabilities } = useDesktopCapabilities();
  const captionChrome = useCaptionChrome();
  const unreadCount =
    state.bots.filter((bot) => !bot.hidden && botShowsUnread(bot)).length +
    state.groups.filter((group) => group.unread).length;
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const twoSidePanelsFit = useMediaQuery(TWO_SIDE_PANELS_FIT, true);
  const sidebarAndPanelFit = useMediaQuery(SIDEBAR_AND_PANEL_FIT, true);
  const sidebarInline = useMediaQuery(SIDEBAR_INLINE, false);
  const [handedOver, setHandedOver] = useState(false);
  useEffect(() => {
    if (!window.ogb?.environments) return;
    const open = (computerId?: string | null, panel?: "copy") => {
      if (computerId) {
        const target = new URL(window.location.href);
        target.searchParams.set(panel === "copy" ? "copy-to" : "share-computer", computerId);
        window.history.replaceState(null, "", `${target.pathname}${target.search}${target.hash}`);
      }
      dispatch({ type: "toggleAppSettings", open: true, section: "desktopWorkspaces" });
    };
    const url = new URL(window.location.href);
    const requestedSettings = url.searchParams.get("desktop-settings");
    const cloud = ["cloud", "cloud-settings", "cloud-add", "cloud-add-howto"].includes(requestedSettings ?? "");
    if (requestedSettings === "workspaces" || (requestedSettings === "organization" && window.ogb.organization && !remoteClient) ||
      (cloud && window.ogb.cloudAccount && !remoteClient)) {
      const handoff = takeCloudProHandoff(url);
      url.searchParams.delete("desktop-settings");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      if (handoff && window.ogb.cloudAccount) { setHandedOver(true); finishCloudProHandoff(handoff, window.ogb.cloudAccount, dispatch); }
      else if (requestedSettings === "organization") dispatch({ type: "toggleAppSettings", open: true, section: "organization" });
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
  useExternalChatLinks(state, dispatch);
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
  const calendarOriginRef = useRef<"chat" | "team-map">("chat");
  const group = state.groups.find((g) => g.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);
  const notificationFeed = useNotificationFeed() && !remoteClient;
  const sidePanelOpen = (Boolean(bot) && (state.settingsOpen || state.computerOpen || state.inspectorOpen || state.activityOpen)) || (notificationFeed && state.notificationsOpen);
  const collapseSidebar = sidePanelOpen && !sidebarAndPanelFit;
  const calendarFocus = state.activeView === "routines";

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
        dispatch({ type: "toggleNewBot", open: true });
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

  useEffect(() => {
    window.ogb?.setUnreadCount?.(unreadCount);
  }, [unreadCount]);

  useEffect(() => {
    if (!state.connected) return;
    void preloadConnectedApps().catch(() => {});
  }, [state.connected]);
  useUsageSnapshot();

  useEffect(() => preloadScreens(), []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [state.selectedId, bot?.threadId, group?.threadId, state.activeView, state.pluginsOpen, state.settingsOpen]);

  useEffect(() => {
    if (state.activeView === "routines" && previousViewRef.current !== "routines") {
      calendarOriginRef.current = previousViewRef.current === "team-map" ? "team-map" : "chat";
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
    dispatch({ type: "select", id: state.selectedId });
  }, [dispatch, state.selectedId]);
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
    state.pluginsOpen ||
    state.triggersOpen;

  useEffect(() => {
    return window.ogb?.onOpenAppSettings?.(section => dispatch((section === "cloud-add" || section === "cloud-add-howto") && window.ogb?.cloudAccount && !remoteClient
      ? { type: "openCloudAdd", source: section === "cloud-add" ? "app_menu" : "app_howto" }
      : section === "cloud" && window.ogb?.cloudAccount && !remoteClient
        ? CLOUD_LINK_SETTINGS
        : section === "cloud-settings" && window.ogb?.cloudAccount && !remoteClient
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

  return (
    <div className="flex h-full flex-col">
      <UpdateBanner sidebarIndicator={!calendarFocus && (sidebarInline || drawerOpen)} />
      <AppNotices quiet={paletteOpen || drawerOpen || Boolean(localVmWorkspaceBotId) || handedOver} viewer={viewer} />
      <div className="relative flex min-h-0 flex-1">
      {!calendarFocus && <button
        type="button"
        ref={menuButtonRef}
        aria-label="Open bot list"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
        className="absolute left-3 top-3 z-30 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink md:hidden"
      >
        <Menu size={18} />
      </button>}
      {drawerOpen && !calendarFocus && (
        <div
          aria-hidden
          onMouseDown={(e) => e.target === e.currentTarget && setDrawerOpen(false)}
          className="absolute inset-0 z-30 bg-black/50 md:hidden"
        />
      )}
      {!calendarFocus && <Sidebar
        collapseToIcons={collapseSidebar}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          menuButtonRef.current?.focus();
        }}
      />}
      {state.activeView === "team-map" ? (
        <TeamMapPage />
      ) : state.activeView === "files" ? (
        <FilesView />
      ) : state.activeView === "today" ? <TodayPage /> : state.activeView === "routines" ? (
        <RoutinesPage onBack={closeCalendar} onOpenRoom={openCalendarRoom} />
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
      ) : group ? (
        <GroupView key={group.id} group={group} />
      ) : bot ? (
        <ChatView bot={bot} />
      ) : (
        <main className="relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
          <WindowDragStrip />
          <div className="w-full max-w-md"><ChatNotice notice={state.notice} /></div>
          <Loader2 size={20} className="animate-spin" />
          <div className="text-[14px]">
            {state.connected ? "No bots yet" : "Connecting to the bot server…"}
          </div>
          {!state.connected && (
            <div className="text-[12px]">
              Start it with <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
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
      {!remoteClient && state.inspectorOpen && bot && <InspectorPanel key={bot.threadId} bot={bot} />}
      {!remoteClient && state.activityOpen && bot && <ActivityPanel key={`activity:${bot.id}`} bot={bot} />}
      {notificationFeed && !calendarFocus && state.notificationsOpen && <NotificationsPanel />}
      {notificationFeed && !calendarFocus && <NotificationRail />}
      {state.appSettingsOpen && <SettingsModal />}
      <CloudAddDialog />
      <CloudHowTo />
      <CloudSetup viewer={viewer} welcomeShown={welcomeOnScreen} />
      <WelcomeKeeper viewer={viewer} />
      {state.pluginsOpen && <PluginsPanel />}
      {state.triggersOpen && <TriggersPanel />}
      {state.newBotOpen && <NewBotDialog />}
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
      <CloudHomeNote />
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
        <GuidedTour />
        <LiveCallHost />
        <FirstConversationTour quiet={spotlightsQuiet(viewer)} />
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}

export default function App() {
  return <WorkspaceBackupRecovery><Application /></WorkspaceBackupRecovery>;
}
