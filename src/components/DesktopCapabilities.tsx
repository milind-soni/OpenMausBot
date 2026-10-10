import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { cacheDesktopCapabilities, initialDesktopCapabilities, loadDesktopCapabilities } from "@/lib/desktop";

type DesktopState = {
  capabilities: DesktopCapabilities;
  ready: boolean;
};

const DesktopContext = createContext<DesktopState>({
  capabilities: initialDesktopCapabilities(),
  ready: typeof window === "undefined" || !window.ogb,
});

export function DesktopCapabilitiesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DesktopState>(() => ({
    capabilities: initialDesktopCapabilities(),
    ready: typeof window === "undefined" || !window.ogb,
  }));

  useEffect(() => {
    let alive = true;
    let eventRevision = 0;
    const unsubscribe = window.ogb?.onCapabilitiesChanged?.((capabilities) => {
      eventRevision += 1;
      if (alive) setState({ capabilities: cacheDesktopCapabilities(capabilities), ready: true });
    });
    const initialRevision = eventRevision;
    void loadDesktopCapabilities().then((capabilities) => {
      if (alive && eventRevision === initialRevision) {
        setState({ capabilities, ready: true });
      }
    });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);

  return <DesktopContext.Provider value={state}>{children}</DesktopContext.Provider>;
}

export function useDesktopCapabilities(): DesktopState {
  return useContext(DesktopContext);
}

/**
 * Shared chrome for windows without a native title bar. On macOS
 * (titleBarStyle hiddenInset, traffic lights over the content) and on
 * frameless Windows (renderer-drawn caption buttons) the top bar of every
 * view is the window's drag handle, as the sidebar head already is. Linux
 * keeps its native title bar, so nothing here applies there.
 *
 * `dragProps` marks a header as a drag region. The data attribute lets
 * styles.css opt every control inside it back out (buttons, inputs, links,
 * menus), so a header only has to mark itself. Double-clicking the empty
 * part of a drag region zooms or minimizes per the macOS setting: Electron
 * does that for hiddenInset windows, no handler needed.
 *
 * The caption corner offsets (controlsShiftStyle, padClass) stay Windows
 * only: the macOS traffic lights sit at the top left, over the sidebar.
 */
export function useCaptionChrome() {
  const { capabilities } = useDesktopCapabilities();
  return captionChrome(capabilities.windowChrome);
}

// SAFETY: Electron's documented -webkit-app-region CSS property is not in
// React's CSSProperties type, but the renderer accepts it as an inline style.
const DRAG_STYLE = { WebkitAppRegion: "drag" } as CSSProperties;
const NO_DRAG_STYLE = { WebkitAppRegion: "no-drag" } as CSSProperties;

export type WindowDragProps = { "data-window-drag"?: ""; style?: CSSProperties };

export function captionChrome(windowChrome: DesktopCapabilities["windowChrome"] | undefined) {
  const windowsCaption = windowChrome === "win-caption";
  const draggable = windowsCaption || windowChrome === "mac-inset";
  const dragProps: WindowDragProps = draggable ? { "data-window-drag": "", style: DRAG_STYLE } : {};
  return {
    windowsCaption,
    draggable,
    dragProps,
    dragStyle: draggable ? DRAG_STYLE : undefined,
    noDragStyle: draggable ? NO_DRAG_STYLE : undefined,
    // A header's right-end control row: drop it 16px below the caption
    // buttons. Margins, not a transform: Blink resolves -webkit-app-region
    // from untransformed layout boxes, so translateY would leave the row's
    // shifted top half inside the header's drag region (dead clicks). The
    // negative bottom margin cancels the height growth, so the rest of the
    // layout does not move. On macOS the row stays where it is and the
    // gaps between its buttons drag (styles.css keeps the buttons clickable).
    controlsShiftStyle: windowsCaption
      ? ({ WebkitAppRegion: "no-drag", marginTop: "16px", marginBottom: "-16px" } as CSSProperties)
      : undefined,
    // Docked right panels: their headers sit flush under the caption corner,
    // so the whole header (not just an icon row) drops 16px via padding.
    // tailwind-merge in cn() lets this override just the pt half of py-*.
    padClass: windowsCaption ? "pt-[28px]" : undefined,
  };
}

/**
 * A view with no header of its own (the empty and loading states) still
 * needs a top bar to move the window by. Put this first inside a `relative`
 * container: it is the window drag handle across the top 52px, the height
 * of the chat header, and paints nothing.
 */
export function WindowDragStrip() {
  const { dragProps } = useCaptionChrome();
  if (!dragProps.style) return null;
  return <div aria-hidden data-window-drag-strip {...dragProps} className="pointer-events-none absolute inset-x-0 top-0 h-[52px]" />;
}
