import { useEffect, useState } from "react";

import { api } from "@/state/api";

export type FramingBlock = "blocked" | "login";

/** Why the site can't be shown in a frame here, as its own answer says: its headers refuse this app (the browser fires
 * `load` on a frame it refused, so nothing in the page can tell), or it asks for a login. Unknown (still asking,
 * offline, not allowed to ask) reads as nothing in the way. */
export function useFramingBlock(url: string | null, attempt = 0): FramingBlock | null {
  const [seen, setSeen] = useState<{ url: string; block: FramingBlock } | null>(null);
  useEffect(() => {
    if (!url) return;
    const check = new AbortController();
    api<{ framing?: string }>(`/api/published-apps/framing?url=${encodeURIComponent(url)}&origin=${encodeURIComponent(window.location.origin)}`, { background: true, signal: check.signal })
      .then(({ framing }) => { if (!check.signal.aborted) setSeen(framing === "blocked" || framing === "login" ? { url, block: framing } : null); }, () => undefined);
    return () => check.abort();
  }, [url, attempt]);
  return url !== null && seen?.url === url ? seen.block : null;
}
