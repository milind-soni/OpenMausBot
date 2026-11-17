import { useEffect, useRef } from "react";
import type { Action, AppState } from "@/state/store";

/** Per device: the right-side panel (the bot's screen or the bot info panel) last left open in the chat view. */
export type RememberedSidePanel = "computer" | "inspector";

export const SIDE_PANEL_OPEN_KEY = "omb-side-panel-open";

export function rememberedSidePanel(): RememberedSidePanel | null {
  try {
    const panel = localStorage.getItem(SIDE_PANEL_OPEN_KEY);
    return panel === "computer" || panel === "inspector" ? panel : null;
  } catch {
    return null;
  }
}

export function rememberSidePanel(panel: RememberedSidePanel | null): void {
  try {
    if (panel) localStorage.setItem(SIDE_PANEL_OPEN_KEY, panel);
    else localStorage.removeItem(SIDE_PANEL_OPEN_KEY);
  } catch {
    // Storage can be full or blocked; the panel still stays as it is for this session.
  }
}

export type SidePanelPlace = Pick<AppState, "activeView" | "computerOpen" | "inspectorOpen">;

/**
 * Keeps the bot's screen or bot info panel open across restarts and full-page views (routines, files):
 * whenever the chat view appears it opens the remembered panel, and it remembers what the person
 * leaves open there. Off in the phone layout, where a panel covers the chat.
 */
export function useRememberedSidePanel(
  place: SidePanelPlace,
  dispatch: (action: Action) => void,
  options: { enabled: boolean; inspector: boolean },
): void {
  const { activeView, computerOpen, inspectorOpen } = place;
  const { enabled, inspector } = options;
  const wasShown = useRef(false);
  useEffect(() => {
    const shown = enabled && activeView === "chat";
    const arrived = shown && !wasShown.current;
    wasShown.current = shown;
    if (!shown) return;
    if (arrived && !computerOpen && !inspectorOpen) {
      const panel = rememberedSidePanel();
      if (panel === "computer") dispatch({ type: "toggleComputer", open: true });
      else if (panel === "inspector" && inspector) dispatch({ type: "toggleInspector", open: true });
      return;
    }
    rememberSidePanel(computerOpen ? "computer" : inspectorOpen ? "inspector" : null);
  }, [activeView, computerOpen, inspectorOpen, enabled, inspector, dispatch]);
}
