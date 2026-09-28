// Whether this bot's Slack app can be managed from here, and where. The app
// holds no Slack logic: on a hosted organisation workspace the server answers
// with a link into the organisation's Admin; everywhere else it answers
// { available: false } and the Slack section stays out of the rail.
import { useEffect, useState } from "react";

import { api } from "@/state/store";

/** The link to render, or null for anything but an available https link. */
export function slackManagementUrl(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const { available, managementUrl } = response as { available?: unknown; managementUrl?: unknown };
  if (available !== true || typeof managementUrl !== "string") return null;
  try {
    return new URL(managementUrl).protocol === "https:" ? managementUrl : null;
  } catch {
    return null;
  }
}

/** Null while loading, on a local install, and when the read fails: in all
 * three there is nothing to offer, so the section simply is not there. */
export function useSlackManagementUrl(botId: string): string | null {
  const [loaded, setLoaded] = useState<{ botId: string; url: string | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api(`/api/bots/${encodeURIComponent(botId)}/slack-management`, { signal: controller.signal, timeoutMs: 10_000 })
      .then((response: unknown) => {
        if (!controller.signal.aborted) setLoaded({ botId, url: slackManagementUrl(response) });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ botId, url: null });
      });
    return () => controller.abort();
  }, [botId]);
  // A late answer for another bot must never surface as this bot's link.
  return loaded?.botId === botId ? loaded.url : null;
}
