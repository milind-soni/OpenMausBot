import { useEffect, useState } from "react";

import { api } from "@/state/api";

/** Whether the site refuses to be framed by this app, as its own headers say: the browser fires `load` on a frame it
 * refused, so nothing in the page can tell. Unknown (still asking, offline, not allowed to ask) reads as not refused. */
export function useFramingRefused(url: string | null, attempt = 0): boolean {
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    const check = new AbortController();
    api<{ framing?: string }>(`/api/published-apps/framing?url=${encodeURIComponent(url)}&origin=${encodeURIComponent(window.location.origin)}`, { background: true, signal: check.signal })
      .then(({ framing }) => { if (!check.signal.aborted) setRefused(framing === "blocked" ? url : null); }, () => undefined);
    return () => check.abort();
  }, [url, attempt]);
  return url !== null && refused === url;
}
