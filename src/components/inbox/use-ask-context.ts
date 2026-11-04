// What the bot said just before a line of the inbox, read from the conversation it came from, so the line reads in context:
// its words since the person last wrote there. Nothing when that conversation can't be read; the line still reads alone.
import { useEffect, useState } from "react";
import type { InboxRow } from "../../../shared/inbox";
import type { Message } from "@/state/store";
import { api } from "@/state/api";

/** How far back the reading view looks for the bot's words before the line. */
const CONTEXT_PAGE = 8;

/** The bot's own words before the line, since the person last wrote: what a question or a report builds on. */
export function contextBefore(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const one = messages[index]!;
    if (one.role === "user") break;
    if (one.role === "bot" && one.kind === "text" && one.text?.trim()) out.unshift(one);
  }
  return out;
}

export function useAskContext(row: Pick<InboxRow, "id" | "origin">): Message[] {
  const threadId = row.origin?.threadId;
  const messageId = row.origin?.messageId;
  const [context, setContext] = useState<{ key: string; messages: Message[] } | null>(null);
  const key = threadId && messageId ? `${threadId}:${messageId}` : "";
  useEffect(() => {
    if (!key) return;
    let live = true;
    void api<{ messages?: Message[] }>(`/api/threads/${threadId}/messages?limit=${CONTEXT_PAGE}&before=${encodeURIComponent(messageId!)}`, { background: true })
      .then((page) => { if (live) setContext({ key, messages: contextBefore(page?.messages ?? []) }); })
      .catch(() => { if (live) setContext({ key, messages: [] }); });
    return () => { live = false; };
  }, [key, threadId, messageId]);
  return context?.key === key ? context.messages : [];
}
