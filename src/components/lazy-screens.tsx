import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "@/lib/i18n";

// Screens that open only on request: Settings, Routines, the Team map, the
// Computer panel and the rest below. Imported directly, every launch would
// parse and run all of them before its first paint; each is its own chunk
// instead, fetched once the launch is idle (preloadScreens).
//
// Deliberately not React.lazy + Suspense. lazy() suspends on every first
// render, even when the chunk is already here, and React holds the commit
// after a fallback for up to 300 ms, so each first open would lag. It also
// rethrows a failed import on every render, and nothing above these screens
// catches errors, so one missing chunk would blank the whole app.
//
// A chunk that cannot be fetched (the server restarting, or a browser tab
// whose server was updated since it loaded) usually stays failed for the
// life of the page: Chromium, and so Electron, keeps the failed import in
// its module map and rejects every later import() of it without asking the
// network again. So a failure is logged, and a screen opened after one says
// it could not load and offers a reload instead of silently showing nothing.

export type LazyScreen<P> = ((props: P) => ReactNode) & {
  preload: () => Promise<ComponentType<P>>;
};

// NonNullable: NewBotDialog takes its props as an optional parameter.
export function lazyScreen<Props>(
  name: string,
  load: () => Promise<(props: Props) => ReactNode>,
): LazyScreen<NonNullable<Props>> {
  type P = NonNullable<Props>;
  let ready: ComponentType<P> | undefined;
  let loading: Promise<ComponentType<P>> | undefined;
  // A failed load is forgotten, so the next open asks once more: a browser
  // that does not keep failed imports fetches it again.
  const preload = () => (loading ??= load().then(
    (component) => (ready = component as ComponentType<P>),
    (error: unknown) => {
      loading = undefined;
      console.warn(`[lazy-screens] ${name} could not be loaded; reloading the window fetches it again.`, error);
      throw error;
    },
  ));
  function Screen(props: P) {
    // Fetched already: render it in this same commit, as an ordinary import would.
    const [Loaded, setLoaded] = useState(() => ready);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      if (Loaded) return;
      let live = true;
      // Opened before its chunk arrived: nothing until it does. If it cannot
      // be loaded, say so and leave the rest of the app alone.
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

/** Stands in for a screen whose chunk could not be loaded. Only a fresh page
 * load recovers, and that is the person's click: composer drafts are kept in
 * storage, but nothing reloads on its own. Portaled, because these screens
 * mount in flex rows, inside dialogs and in the main pane. */
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
export const InspectorPanel = lazyScreen("InspectorPanel", async () => (await import("./InspectorPanel")).InspectorPanel);
export const KeyboardShortcutsModal = lazyScreen("KeyboardShortcutsModal", async () => (await import("./KeyboardShortcutsModal")).KeyboardShortcutsModal);
export const LocalVmWorkspace = lazyScreen("LocalVmWorkspace", async () => (await import("./LocalVmWorkspace")).LocalVmWorkspace);
export const NewBotDialog = lazyScreen("NewBotDialog", async () => (await import("./NewBotDialog")).NewBotDialog);
export const RemoteAgentSettingsPanel = lazyScreen("RemoteAgentSettingsPanel", async () => (await import("./RemoteAgentSettingsPanel")).RemoteAgentSettingsPanel);
export const RemoteDesktopPanel = lazyScreen("RemoteDesktopPanel", async () => (await import("./remote-desktop-panel")).RemoteDesktopPanel);
export const RoutinesPage = lazyScreen("RoutinesPage", async () => (await import("./RoutinesPage")).RoutinesPage);
export const SettingsModal = lazyScreen("SettingsModal", async () => (await import("./SettingsModal")).SettingsModal);
export const TeamMapPage = lazyScreen("TeamMapPage", async () => (await import("./TeamMapPage")).TeamMapPage);
export const TriggersPanel = lazyScreen("TriggersPanel", async () => (await import("./TriggersPanel")).TriggersPanel);

const SCREENS = [
  ActivityPanel, BotSettingsDialog, ComputerPanel, InspectorPanel, KeyboardShortcutsModal, LocalVmWorkspace, NewBotDialog,
  RemoteAgentSettingsPanel, RemoteDesktopPanel, RoutinesPage, SettingsModal, TeamMapPage, TriggersPanel,
];

// A window opened onto Settings (?desktop-settings=…: the desktop app's
// Workspaces, Organization and Cloud windows, phone pairing) shows it at
// mount, before the launch is idle: fetch it now, beside the session check.
// A failure is logged by preload and shown when Settings mounts.
if (typeof location !== "undefined" && new URLSearchParams(location.search).has("desktop-settings")) {
  void SettingsModal.preload().catch(() => {});
}

/** Fetches every screen above once the launch has painted and gone idle, so
 * a later click renders it at once. Returns a cancel for the effect cleanup.
 * Failures are logged by preload and shown when that screen is opened. */
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
