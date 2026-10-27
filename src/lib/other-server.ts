import { useEffect, useState } from "react";

/**
 * Whether the desktop app's window shows a server other than this computer's own, such as one added in the Server menu.
 * The preload decides it from the page's own origin against this app's server, the same rule that decides which bridge a
 * page gets, so it holds before anything loads. False in a browser, on this computer's page and in older desktop builds.
 */
export function desktopShowsOtherServer(): boolean {
  return typeof window !== "undefined" && window.ogb?.app?.ownPage === false;
}

/** That server's name as it was saved in the Server menu, or its address until the app answers; null when there is none. */
export function useOtherServerName(enabled = true): string | null {
  const other = enabled && desktopShowsOtherServer();
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (!other) return;
    let alive = true;
    void window.ogb?.workspaces?.state()
      .then((state) => { if (alive && !state.local && state.name?.trim()) setName(state.name.trim()); })
      .catch(() => {});
    return () => { alive = false; };
  }, [other]);
  return other ? (name ?? window.location.host) : null;
}
