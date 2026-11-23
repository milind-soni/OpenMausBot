import { useCallback, useEffect, useRef, useState } from "react";

import { fetchUpkeepStatus, type UpkeepStatus } from "@/lib/memory";
import type { Bot } from "@/state/store";

export function useMemoryUpkeepStatus(bot: Pick<Bot, "id" | "modelSelection">, active: boolean) {
  const { id } = bot;
  const instanceId = active ? bot.modelSelection.instanceId : undefined;
  const [status, setStatus] = useState<UpkeepStatus | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    request.current?.abort();
    const current = new AbortController();
    request.current = current;
    setReadError(null);
    try {
      const next = await fetchUpkeepStatus(id, current.signal);
      if (!current.signal.aborted) setStatus(next);
    } catch (cause) {
      if (!current.signal.aborted) setReadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [id]);

  useEffect(() => {
    if (!active) return;
    setStatus(null);
    void reload();
    return () => request.current?.abort();
  }, [active, instanceId, reload]);

  return { status, readError, reload };
}
