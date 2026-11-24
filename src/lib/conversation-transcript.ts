import { loadFullThread } from "@/state/message-history";
import { optimisticMessageId } from "@/state/optimistic-send";
import { visibleMessages } from "@/state/snapshot-navigation";
import { formatTranscriptMarkdown, type ExportTranscriptOptions } from "./export-transcript";
import { t } from "./i18n";

interface ConversationTranscriptOptions extends ExportTranscriptOptions {
  threadId: string;
  hasMore?: boolean;
  activeLeafId?: string | null;
}

/** An export reads the whole selected branch without filling the UI's bounded message cache. */
export function conversationTranscript({ threadId, hasMore, activeLeafId, ...options }: ConversationTranscriptOptions): string | Promise<string> {
  if (!hasMore) return formatTranscriptMarkdown(options);
  return loadFullThread(threadId).then((thread) => {
    // Keep the clicked rows, including streamed text, while filling their earlier history.
    // A server-confirmed send replaces only its actual optimistic identity.
    const confirmed = new Map<string, string>();
    for (const message of thread.messages) {
      if (message.sendId && message.id !== optimisticMessageId(message.sendId)) confirmed.set(message.sendId, message.id);
    }
    const aliases = new Map<string, string>();
    for (const message of options.messages) {
      if (message.sendId && message.id === optimisticMessageId(message.sendId)) {
        const id = confirmed.get(message.sendId);
        if (id) aliases.set(message.id, id);
      }
    }
    const held = new Map(options.messages.filter((message) => !aliases.has(message.id)).map((message) => {
      const parentId = message.parentId ? aliases.get(message.parentId) : undefined;
      return [message.id, parentId ? { ...message, parentId } : message] as const;
    }));
    const persisted = new Set(options.messages.filter((message) => !message.sendId || message.id !== optimisticMessageId(message.sendId)).map((message) => message.id));
    let boundary = thread.messages.findLastIndex((message) => persisted.has(message.id));
    if (boundary < 0) {
      // An optimistic-only branch can still point at a parent already known at the click.
      const parent = options.messages[0]?.parentId;
      if (parent && !aliases.has(parent)) boundary = thread.messages.findIndex((message) => message.id === parent);
    }
    if (boundary < 0) throw new Error(t("chat.export.historyGone"));
    // A later confirmation may replace its optimistic row, but cannot extend the history boundary.
    const confirmedIds = new Set(aliases.values());
    const history = thread.messages.filter((message, index) => index <= boundary || confirmedIds.has(message.id));
    const loaded = new Set(history.map((message) => message.id));
    const messages = [...history.map((message) => held.get(message.id) ?? message),
      ...[...held.values()].filter((message) => !loaded.has(message.id))];
    const leaf = activeLeafId ? aliases.get(activeLeafId) ?? activeLeafId : activeLeafId;
    if (leaf && !messages.some((message) => message.id === leaf)) {
      throw new Error(t("chat.export.branchGone"));
    }
    return formatTranscriptMarkdown({ ...options, messages: visibleMessages({ messages, activeLeafId: leaf }) });
  });
}
