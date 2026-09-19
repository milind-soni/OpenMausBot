import { useEffect, useRef, useState } from "react";
import type { Bot } from "@/state/store";
import { readComputerPanelView, writeComputerPanelView, type ComputerPanelView } from "@/lib/computer-panel-view";

/** Which inner tab the panel shows: restored per bot, following the live
 * conversation once it moves, and falling back when a tab's surface goes
 * away. Also tracks whether this bot's desktop viewer window is open. */
export function useComputerPanelView({
  bot,
  browserEnabled,
  androidConnected,
  viewerConnectionKey,
}: {
  bot: Bot;
  browserEnabled: boolean;
  androidConnected: boolean;
  viewerConnectionKey: string;
}) {
  const [panelView, setPanelView] = useState<ComputerPanelView>(() => readComputerPanelView(bot.id));
  const [viewerOpen, setViewerOpen] = useState(false);

  const selectPanelView = (view: ComputerPanelView) => {
    setPanelView(view);
    writeComputerPanelView(bot.id, view);
  };

  const previousPanelTarget = useRef<string | null>(null);
  const previousBotId = useRef<string | null>(null);
  useEffect(() => {
    // Restore a manually chosen tab on reopen. After a real thread/place
    // change, follow that target once; busy/tool events never steal the tab.
    const previous = previousPanelTarget.current;
    const priorBotId = previousBotId.current;
    const botChanged = priorBotId !== null && priorBotId !== bot.id;
    previousPanelTarget.current = viewerConnectionKey;
    previousBotId.current = bot.id;
    if (previous === viewerConnectionKey && !(bot.computer === "browser" && browserEnabled)) return;
    setPanelView(bot.computer === "browser" && browserEnabled ? "browser"
      : previous === null || botChanged ? readComputerPanelView(bot.id) : "computer");
  }, [viewerConnectionKey, bot.id, bot.computer, browserEnabled]);

  // Pause the screenshot poll while this bot's viewer is open; seed from the
  // live viewer so a remount/switch mid-session doesn't wrongly resume it.
  useEffect(() => {
    let alive = true;
    const dv = window.ogb?.desktopViewer;
    if (dv?.currentState) {
      void dv
        .currentState()
        .then((s) => {
          if (alive) setViewerOpen(s.open && s.contextId === bot.id);
        })
        .catch(() => {});
    }
    const off = dv?.onState((viewer) => {
      if (viewer.contextId === bot.id) setViewerOpen(viewer.open);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [bot.id]);

  useEffect(() => {
    if ((!androidConnected && panelView === "android") || (!browserEnabled && panelView === "browser")) {
      setPanelView("computer");
      writeComputerPanelView(bot.id, "computer");
    }
  }, [androidConnected, bot.id, browserEnabled, panelView]);

  return { panelView, selectPanelView, viewerOpen };
}
