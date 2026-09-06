import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Menu } from "lucide-react";
import { StoreProvider, useStore } from "@/state/store";
import { Onboarding } from "@/components/Onboarding";
import { emailGateDone, initAnalytics } from "@/lib/analytics";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { BotSettingsDialog } from "@/components/BotSettingsDialog";
import { RemoteAgentSettingsPanel } from "@/components/RemoteAgentSettingsPanel";
import { PluginsPanel, preloadConnectedApps } from "@/components/PluginsPanel";
import { ComputerPanel } from "@/components/ComputerPanel";
import { RemoteDesktopPanel } from "@/components/remote-desktop-panel";
import { InspectorPanel } from "@/components/InspectorPanel";
import { SettingsModal } from "@/components/SettingsModal";
import { UpdateBanner } from "@/components/UpdateBanner";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { RoutinesPage } from "@/components/RoutinesPage";
import { NoEngines } from "@/components/NoEngines";
import { CommandPalette } from "@/components/CommandPalette";
import { LocalVmWorkspace } from "@/components/LocalVmWorkspace";
import { BrowserWorkspace } from "@/components/BrowserWorkspace";
import { SkillRecorderPage } from "@/components/SkillRecorderPage";
import { TeamMapPage } from "@/components/TeamMapPage";
import { heldComputerControlBotIds } from "@/lib/computer-control";
import { skillRecorderEnabled } from "@/lib/feature-flags";
import { setLocale } from "@/lib/i18n";

function Shell() {
  const { state, dispatch } = useStore();
  const unreadCount =
    state.bots.filter((bot) => !bot.hidden && bot.unread).length +
    state.groups.filter((group) => group.unread).length;
  const remoteClient = window.ogb?.remoteClient?.active === true;
  // Mobile-only drawer state. Above md, none of these properties are emitted
  // at all — Sidebar scopes every mobile class with max-md: rather than
  // cancelling them with md:, which would still emit a translate value and
  // turn the aside into a containing block for its fixed descendants (see
  // Sidebar.tsx's className comment).
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Apply the configured UI language the moment config arrives or changes;
  // "" follows the system. The epoch bump re-renders extracted strings —
  // t() reads a module variable, so React needs this nudge.
  const language = state.config?.language ?? "";
  const [, setLocaleEpoch] = useState(0);
  useEffect(() => {
    setLocale(language || globalThis.navigator?.language);
    setLocaleEpoch((epoch) => epoch + 1);
  }, [language]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [localVmWorkspaceBotId, setLocalVmWorkspaceBotId] = useState<string | null>(null);
  // the Browser tab, expanded into the main column (the small preview in
  // the panel hands off to this and back)
  const [browserWorkspaceBotId, setBrowserWorkspaceBotId] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const previousViewRef = useRef(state.activeView);
  const calendarOriginRef = useRef<"chat" | "team-map" | "skill-recorder">("chat");
  const group = state.groups.find((g) => g.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);
  const calendarFocus = state.activeView === "routines";

  // Nothing on this machine can run a bot. A missing cloud login does not
  // count — that CLI can still host a local model. Wait for the first
  // /api/instances response before deciding: an empty list means "not asked
  // yet", and flashing the setup screen at every launch would be worse.
  const noEngines =
    state.connected &&
    state.instances.length > 0 &&
    !state.instances.some((i) => i.snapshot.state === "available");

  // App-wide shortcuts: ⌘N new bot · ⌘1–9 jump to bot · ⌘⇧[ / ⌘⇧] prev/next.
  // Kept deliberately small; every panel already closes on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
          dispatch({ type: "select", id: target.id });
        }
      } else if (e.shiftKey && (e.key === "[" || e.key === "]")) {
        const idx = bots.findIndex((b) => b.id === state.selectedId);
        const next = bots[(idx + (e.key === "]" ? 1 : -1) + bots.length) % bots.length];
        if (next) {
          e.preventDefault();
          dispatch({ type: "select", id: next.id });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.bots, state.selectedId, dispatch]);

  useEffect(() => {
    window.ogb?.setUnreadCount?.(unreadCount);
  }, [unreadCount]);

  // Re-assert every authoritative positive hold in the process that owns the
  // native browser. This covers initial hydration, SSE updates from another
  // computer surface, and renderer reloads. Deliberately never mirror false:
  // only a trusted two-phase release may open Electron's direct browser gate.
  useEffect(() => {
    const setter = window.ogb?.browser?.setHumanControl;
    if (!setter) return;
    for (const botId of heldComputerControlBotIds(state.computerControl)) {
      void setter(botId, true).catch(() => {});
    }
  }, [state.computerControl]);

  // Warm connected-account state as soon as the local server is available.
  // The modal then opens with the correct Connect/Add account buttons and
  // quietly revalidates instead of rediscovering every account from scratch.
  useEffect(() => {
    if (!state.connected) return;
    void preloadConnectedApps().catch(() => {});
  }, [state.connected]);

  // Picking a conversation closes the drawer: on a phone the chat is what you
  // asked for, and leaving the list up would hide it. Watching activeView too
  // catches re-selecting the bot that is already current from another view —
  // the reducer switches the view without changing selectedId. pluginsOpen
  // and settingsOpen cover the same idea from a different trigger: close the
  // drawer whenever an action opens something over the chat.
  useEffect(() => {
    setDrawerOpen(false);
  }, [state.selectedId, state.activeView, state.pluginsOpen, state.settingsOpen]);

  useEffect(() => {
    if (state.activeView === "routines" && previousViewRef.current !== "routines") {
      calendarOriginRef.current = previousViewRef.current;
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
  const openBrowserWorkspace = useCallback((botId: string) => {
    dispatch({ type: "toggleComputer", open: false });
    setBrowserWorkspaceBotId(botId);
  }, [dispatch]);
  const closeBrowserWorkspace = useCallback(() => {
    setBrowserWorkspaceBotId(null);
    dispatch({ type: "toggleComputer", open: true });
  }, [dispatch]);
  useEffect(() => {
    if (browserWorkspaceBotId && (state.activeView !== "chat" || state.selectedId !== browserWorkspaceBotId)) {
      setBrowserWorkspaceBotId(null);
    }
  }, [browserWorkspaceBotId, state.activeView, state.selectedId]);

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
    if (calendarOriginRef.current === "skill-recorder" && skillRecorderEnabled(state.config)) {
      dispatch({ type: "showSkillRecorder" });
      return;
    }
    dispatch({ type: "select", id: state.selectedId });
  }, [dispatch, state.config, state.selectedId]);
  const openCalendarRoom = useCallback((id: string) => {
    dispatch({ type: "select", id });
  }, [dispatch]);

  const nativeViewOverlayOpen =
    drawerOpen ||
    paletteOpen ||
    state.settingsOpen ||
    state.computerOpen ||
    state.inspectorOpen ||
    state.appSettingsOpen ||
    state.pluginsOpen;

  // The viewer outlives ComputerPanel and can target any bot, so release control
  // here (always mounted) when a bot's viewer closes. release() is idempotent.
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
          if (snap) dispatch({ type: "computerControl", botId, held: snap.held === true, helpReason: snap.helpReason ?? null });
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
      {/* fixed-position popup, bottom-left — outside the layout flow */}
      <UpdateBanner />
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
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          menuButtonRef.current?.focus();
        }}
      />}
      {state.activeView === "team-map" ? (
        <TeamMapPage />
      ) : state.activeView === "routines" ? (
        <RoutinesPage onBack={closeCalendar} onOpenRoom={openCalendarRoom} />
      ) : !remoteClient && state.activeView === "skill-recorder" ? (
        <SkillRecorderPage />
      ) : !remoteClient && browserWorkspaceBotId && bot && bot.id === browserWorkspaceBotId ? (
        <BrowserWorkspace bot={bot} onClose={closeBrowserWorkspace} />
      ) : !remoteClient && localVmWorkspaceBotId ? (
        <LocalVmWorkspace
          primaryBotId={localVmWorkspaceBotId}
          overlayOpen={nativeViewOverlayOpen}
          onClose={() => setLocalVmWorkspaceBotId(null)}
          onOpenComputer={openComputerFromWorkspace}
        />
      ) : noEngines ? (
        <NoEngines />
      ) : group ? (
        <GroupView key={group.id} group={group} />
      ) : bot ? (
        <ChatView bot={bot} />
      ) : (
        <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
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
      {state.settingsOpen && bot && (
        remoteClient
          ? <RemoteAgentSettingsPanel bot={bot} />
          : <BotSettingsDialog key={bot.id} bot={bot} />
      )}
      {state.computerOpen && bot && (
        remoteClient ? (
          <RemoteDesktopPanel key={bot.id} bot={bot} />
        ) : (
          <ComputerPanel
            key={bot.id}
            bot={bot}
            onOpenVmWorkspace={openLocalVmWorkspace}
            onExpandBrowser={openBrowserWorkspace}
          />
        )
      )}
      {!remoteClient && state.inspectorOpen && bot && <InspectorPanel bot={bot} />}
      {state.appSettingsOpen && <SettingsModal />}
      {state.pluginsOpen && <PluginsPanel />}
      {/* mounted after the modals: same z-50 tier, so DOM order keeps the
          palette on top when one of them is open underneath */}
      <CommandPalette onOpenChange={setPaletteOpen} />
      </div>
    </div>
  );
}

export default function App() {
  const [gated, setGated] = useState(() => window.ogb?.remoteClient?.active !== true && !emailGateDone());
  useEffect(() => {
    initAnalytics();
  }, []);
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        <Shell />
        {gated && <Onboarding onDone={() => setGated(false)} />}
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}
