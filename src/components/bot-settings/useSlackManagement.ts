import { useEffect, useState } from "react";

import { api } from "@/state/store";

/** Only an available https link; null for anything else. */
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
