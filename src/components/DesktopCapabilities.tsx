import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { cacheDesktopCapabilities, initialDesktopCapabilities, loadDesktopCapabilities } from "@/lib/desktop";

type DesktopState = {
  capabilities: DesktopCapabilities;
  ready: boolean;
};

const DesktopContext = createContext<DesktopState>({
  capabilities: initialDesktopCapabilities(),
  ready: !window.ogb,
});

export function DesktopCapabilitiesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DesktopState>(() => ({
    capabilities: initialDesktopCapabilities(),
    ready: !window.ogb,
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
 * Shared chrome styles for the overlay-less frameless Windows window: headers
 * become window drag regions, and the controls at a header's right end drop
 * 16px below the 26px-tall renderer-drawn caption buttons that occupy the
 * window's top-right corner (WindowCaptionButtons.tsx).
 */
export function useCaptionChrome() {
  const { capabilities } = useDesktopCapabilities();
  const windowsCaption = capabilities.windowChrome === "win-caption";
  return {
    windowsCaption,
    // SAFETY: Electron's documented -webkit-app-region CSS property is not in
    // React's CSSProperties type, but the renderer accepts it as an inline style.
    dragStyle: windowsCaption ? ({ WebkitAppRegion: "drag" } as CSSProperties) : undefined,
    noDragStyle: windowsCaption ? ({ WebkitAppRegion: "no-drag" } as CSSProperties) : undefined,
    // A header's right-end control row: drop it 16px below the caption
    // buttons. Margins, not a transform: Blink resolves -webkit-app-region
    // from untransformed layout boxes, so translateY would leave the row's
    // shifted top half inside the header's drag region (dead clicks). The
    // negative bottom margin cancels the height growth, so the rest of the
    // layout does not move.
    controlsShiftStyle: windowsCaption
      ? ({ WebkitAppRegion: "no-drag", marginTop: "16px", marginBottom: "-16px" } as CSSProperties)
      : undefined,
    // Docked right panels: their headers sit flush under the caption corner,
    // so the whole header (not just an icon row) drops 16px via padding.
    // tailwind-merge in cn() lets this override just the pt half of py-*.
    padClass: windowsCaption ? "pt-[28px]" : undefined,
  };
}
