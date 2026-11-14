import { createContext, useMemo, useRef } from "react";
import { liveToolIds, type LiveToolRun, type ToolRunMessage } from "@/lib/tool-liveness";

/** The running tool calls, apart from the chat's other row values: only tool rows read them, so a call starting or
 * finishing re-renders those rows and not every message bubble. */
export const LiveToolsContext = createContext<ReadonlySet<string>>(new Set());

const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((id) => b.has(id));

/** The tool calls still running in this turn. Every new row of a busy turn recomputes them, but the set keeps its
 * identity while the same calls run, so the tool rows reading it render again only when a call starts or ends. */
export function useLiveToolIds(messages: readonly ToolRunMessage[], run: LiveToolRun): ReadonlySet<string> {
  const previous = useRef<ReadonlySet<string> | null>(null);
  const { busy, turnStartedAt } = run;
  return useMemo(() => {
    const next = liveToolIds(messages, { busy, turnStartedAt });
    if (previous.current && sameIds(previous.current, next)) return previous.current;
    return (previous.current = next);
  }, [messages, busy, turnStartedAt]);
}
