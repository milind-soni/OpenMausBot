import { useEffect, useState } from "react";
import type { InboxRow } from "../../../shared/inbox";
import type { Message } from "@/state/store";
import { api } from "@/state/api";

const CONTEXT_PAGE = 8;

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
