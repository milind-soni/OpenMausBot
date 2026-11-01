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
 * Electron zooms or minimizes on a double-click in a hiddenInset window's drag region, so no handler is needed.
 * styles.css opts the controls inside a drag region back out.
 */
export function useCaptionChrome() {
  const { capabilities } = useDesktopCapabilities();
  return captionChrome(capabilities.windowChrome);
}

// SAFETY: Electron's -webkit-app-region is not in React's CSSProperties type; the renderer accepts it as an inline
// style.
const DRAG_STYLE = { WebkitAppRegion: "drag" } as CSSProperties;
const NO_DRAG_STYLE = { WebkitAppRegion: "no-drag" } as CSSProperties;

export type WindowDragProps = { "data-window-drag"?: ""; style?: CSSProperties };

/** A window with no title bar of its own, which the page can frame: the person may turn that frame off. */
export function windowFrameable(capabilities: Pick<DesktopCapabilities, "windowChrome"> | undefined): boolean {
  return capabilities?.windowChrome === "mac-inset" || capabilities?.windowChrome === "win-caption";
}

/** A window that draws its own frame: the top bar holding the traffic lights or the Windows caption buttons
 * (WindowFrameBar) and the rail of places in the frame's colour, and the app, its sidebar and the chat or page, in a
 * rounded card beside them. Nothing under the bar makes room for the window's buttons. Off once the person turned the frame off. */
export function windowFramed(capabilities: Pick<DesktopCapabilities, "windowChrome" | "windowFrame"> | undefined): boolean {
  return windowFrameable(capabilities) && capabilities?.windowFrame !== false;
}

/** A window with no title bar of its own: the page's headers drag it, framed or not. */
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
  };
}

export function WindowDragStrip() {
  const { dragProps } = useCaptionChrome();
  if (!dragProps.style) return null;
  return <div aria-hidden data-window-drag-strip {...dragProps} className="pointer-events-none absolute inset-x-0 top-0 h-[52px]" />;
}
