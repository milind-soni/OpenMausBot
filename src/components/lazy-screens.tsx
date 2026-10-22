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
export const RemoteAgentSettingsPanel = lazyScreen("RemoteAgentSettingsPanel", async () => (await import("./RemoteAgentSettingsPanel")).RemoteAgentSettingsPanel);
export const RemoteDesktopPanel = lazyScreen("RemoteDesktopPanel", async () => (await import("./remote-desktop-panel")).RemoteDesktopPanel);
export const TriggersPage = lazyScreen("TriggersPage", async () => (await import("./TriggersPage")).TriggersPage);
export const SettingsModal = lazyScreen("SettingsModal", async () => (await import("./SettingsModal")).SettingsModal);
export const TeamMapPage = lazyScreen("TeamMapPage", async () => (await import("./TeamMapPage")).TeamMapPage);

const SCREENS = [
  ActivityPanel, BotSettingsDialog, ComputerPanel, FilesView, InspectorPanel, KeyboardShortcutsModal, LocalVmWorkspace, NewBotDialog,
  RemoteAgentSettingsPanel, RemoteDesktopPanel, SettingsModal, TeamMapPage, TriggersPage,
];

if (typeof location !== "undefined" && new URLSearchParams(location.search).has("desktop-settings")) {
  void SettingsModal.preload().catch(() => {});
}

export function preloadScreens(): () => void {
  const run = () => {
    for (const screen of SCREENS) void screen.preload().catch(() => {});
  };
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(run, { timeout: 2_000 });
    return () => cancelIdleCallback(handle);
  }
  // Safari has no requestIdleCallback.
  const timer = setTimeout(run, 1_000);
  return () => clearTimeout(timer);
}
