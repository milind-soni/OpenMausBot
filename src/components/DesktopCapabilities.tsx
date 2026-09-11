import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { cacheDesktopCapabilities, initialDesktopCapabilities, loadDesktopCapabilities } from "@/lib/desktop";

type DesktopState = {
  capabilities: DesktopCapabilities;
  ready: boolean;
};

function hasDesktopBridge(): boolean {
  return typeof window !== "undefined" && Boolean(window.ogb);
}

const DesktopContext = createContext<DesktopState>({
  capabilities: initialDesktopCapabilities(),
  ready: !hasDesktopBridge(),
});

export function DesktopCapabilitiesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DesktopState>(() => ({
    capabilities: initialDesktopCapabilities(),
    ready: !hasDesktopBridge(),
  }));

  useEffect(() => {
    let alive = true;
    let eventRevision = 0;
    const unsubscribe =
      typeof window !== "undefined"
        ? window.ogb?.onCapabilitiesChanged?.((capabilities) => {
            eventRevision += 1;
            if (alive) setState({ capabilities: cacheDesktopCapabilities(capabilities), ready: true });
          })
        : undefined;
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
