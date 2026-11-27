import { useEffect, useState } from "react";

export interface ActivityFocus {
  botId: string;
  threadId: string;
  turnId?: string;
}

let current: ActivityFocus | null = null;
const listeners = new Set<() => void>();

/** Asks the Activity panel to show this run: the panel opened next, or the one open now. */
export function focusActivityRun(focus: ActivityFocus): void {
  current = focus;
  for (const listener of Array.from(listeners)) listener();
}

/** The run the person last asked this bot's panel to show. Taking it clears the request, so opening the panel some other
 * way later shows no old run. */
export function useActivityFocus(botId: string): ActivityFocus | null {
  const [focus, setFocus] = useState<ActivityFocus | null>(null);
  useEffect(() => {
    const take = () => {
      if (current?.botId !== botId) return;
      setFocus(current);
      current = null;
    };
    listeners.add(take);
    take();
    return () => {
      listeners.delete(take);
    };
  }, [botId]);
  return focus;
}
