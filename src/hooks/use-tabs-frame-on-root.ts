import { useLayoutEffect } from "react";

/**
 * Names the chat header's tab band on the root element, for the rules that join the sidebar to it. Matching the header
 * from the root instead (`:root:has(...)`) makes the browser restyle the whole page each time a streaming reply adds a node.
 */
export function useTabsFrameOnRoot(look: "simple" | "advanced" | undefined): void {
  useLayoutEffect(() => {
    if (!look) return;
    const root = document.documentElement;
    root.dataset.chatTabsFrame = look;
    return () => {
      if (root.dataset.chatTabsFrame === look) delete root.dataset.chatTabsFrame;
    };
  }, [look]);
}
