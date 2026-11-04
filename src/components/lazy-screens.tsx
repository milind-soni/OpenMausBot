import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "@/lib/i18n";

// Not React.lazy: it suspends on every first render even with the chunk loaded (React holds a commit after a fallback
// up to 300 ms) and rethrows a failed import on every render. Chromium keeps a failed import() in its module map and
// rejects every later import of it without refetching.

export type LazyScreen<P> = ((props: P) => ReactNode) & {
  preload: () => Promise<ComponentType<P>>;
};

export function lazyScreen<Props>(
  name: string,
  load: () => Promise<(props: Props) => ReactNode>,
): LazyScreen<NonNullable<Props>> {
  type P = NonNullable<Props>;
  let ready: ComponentType<P> | undefined;
  let loading: Promise<ComponentType<P>> | undefined;
  const preload = () => (loading ??= load().then(
    (component) => (ready = component as ComponentType<P>),
    (error: unknown) => {
      loading = undefined;
      console.warn(`[lazy-screens] ${name} could not be loaded; reloading the window fetches it again.`, error);
      throw error;
    },
  ));
  function Screen(props: P) {
    const [Loaded, setLoaded] = useState(() => ready);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      if (Loaded) return;
      let live = true;
      void preload().then(
        (component) => { if (live) setLoaded(() => component); },
        () => { if (live) setFailed(true); },
      );
      return () => {
        live = false;
      };
    }, [Loaded]);
    if (Loaded) return <Loaded {...props} />;
    return failed ? <ScreenUnavailable /> : null;
  }
  return Object.assign(Screen, { preload });
}

function ScreenUnavailable() {
  return createPortal(
    <div
      role="alert"
      data-screen-unavailable
      className="fixed bottom-4 left-1/2 z-[100] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border border-danger/30 bg-card px-3.5 py-2.5 text-[13px] text-danger shadow-xl"
    >
      <span>{t("screenLoad.failed")}</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised"
      >
        {t("screenLoad.reload")}
      </button>
    </div>,
    document.body,
  );
}

export const ActivityPanel = lazyScreen("ActivityPanel", async () => (await import("./ActivityPanel")).ActivityPanel);
export const BotSettingsDialog = lazyScreen("BotSettingsDialog", async () => (await import("./BotSettingsDialog")).BotSettingsDialog);
export const ComputerPanel = lazyScreen("ComputerPanel", async () => (await import("./ComputerPanel")).ComputerPanel);
export const FilesView = lazyScreen("FilesView", async () => (await import("./FilesView")).FilesView);
export const InspectorPanel = lazyScreen("InspectorPanel", async () => (await import("./InspectorPanel")).InspectorPanel);
export const KeyboardShortcutsModal = lazyScreen("KeyboardShortcutsModal", async () => (await import("./KeyboardShortcutsModal")).KeyboardShortcutsModal);
export const LocalVmWorkspace = lazyScreen("LocalVmWorkspace", async () => (await import("./LocalVmWorkspace")).LocalVmWorkspace);
export const NewBotDialog = lazyScreen("NewBotDialog", async () => (await import("./NewBotDialog")).NewBotDialog);
export const PluginsPanel = lazyScreen("PluginsPanel", async () => (await import("./PluginsPanel")).PluginsPanel);
export const RemoteAgentSettingsPanel = lazyScreen("RemoteAgentSettingsPanel", async () => (await import("./RemoteAgentSettingsPanel")).RemoteAgentSettingsPanel);
export const RoomPanel = lazyScreen("RoomPanel", async () => (await import("./room-panel/RoomPanel")).RoomPanel);
export const RemoteDesktopPanel = lazyScreen("RemoteDesktopPanel", async () => (await import("./remote-desktop-panel")).RemoteDesktopPanel);
export const TriggersPage = lazyScreen("TriggersPage", async () => (await import("./TriggersPage")).TriggersPage);
export const SettingsModal = lazyScreen("SettingsModal", async () => (await import("./SettingsModal")).SettingsModal);
export const TeamMapPage = lazyScreen("TeamMapPage", async () => (await import("./TeamMapPage")).TeamMapPage);

// Rarely opened, so never fetched ahead. The team library is what brings the YAML parser in.
export const CloudAddDialog = lazyScreen("CloudAddDialog", async () => (await import("./CloudAddDialog")).CloudAddDialog);
export const PhoneAppDialog = lazyScreen("PhoneAppDialog", async () => (await import("./PhoneAppDialog")).PhoneAppDialog);
export const ShareTeamDialog = lazyScreen("ShareTeamDialog", async () => (await import("./ShareTeamDialog")).ShareTeamDialog);
export const GrokMoveDialog = lazyScreen("GrokMoveDialog", async () => (await import("./GrokMoveDialog")).GrokMoveDialog);
export const TeamLibraryPanel = lazyScreen("TeamLibraryPanel", async () => (await import("./TeamLibraryPanel")).TeamLibraryPanel);

// Most opened first: a Cloud page fetches these in this order.
const SCREENS = [
  SettingsModal, BotSettingsDialog, PluginsPanel, ComputerPanel, TriggersPage, ActivityPanel, FilesView, InspectorPanel, KeyboardShortcutsModal,
  LocalVmWorkspace, NewBotDialog, RemoteAgentSettingsPanel, RemoteDesktopPanel, RoomPanel, TeamMapPage,
];

if (typeof location !== "undefined" && new URLSearchParams(location.search).has("desktop-settings")) {
  void SettingsModal.preload().catch(() => {});
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const REMOTE_PRELOAD_AFTER_MS = 5_000;

// On this machine a first open costs 8-28 ms, and fetching every screen during launch held the first paint back by a
// quarter, so a local page fetches each when it opens. Over a network a first open takes up to a second, so a Cloud page
// still fetches them, once launch is over and one per idle moment.
export function preloadScreens(hostname = location.hostname): () => void {
  if (LOCAL_HOSTS.has(hostname)) return () => {};
  let stopped = false;
  let cancelWait = () => {};
  const whenIdle = (run: () => void) => {
    if (typeof requestIdleCallback === "function") {
      const handle = requestIdleCallback(run, { timeout: 2_000 });
      cancelWait = () => cancelIdleCallback(handle);
    } else {
      // Safari has no requestIdleCallback.
      const timer = setTimeout(run, 1_000);
      cancelWait = () => clearTimeout(timer);
    }
  };
  const fetchFrom = (index: number) => {
    const screen = SCREENS[index];
    if (!screen) return;
    whenIdle(() => {
      void screen.preload().catch(() => {}).then(() => {
        if (!stopped) fetchFrom(index + 1);
      });
    });
  };
  const start = setTimeout(() => fetchFrom(0), REMOTE_PRELOAD_AFTER_MS);
  cancelWait = () => clearTimeout(start);
  return () => {
    stopped = true;
    cancelWait();
  };
}
