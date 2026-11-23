import { loadFullThread } from "@/state/message-history";
import { visibleMessages } from "@/state/snapshot-navigation";
import { formatTranscriptMarkdown, type ExportTranscriptOptions } from "./export-transcript";

interface ConversationTranscriptOptions extends ExportTranscriptOptions {
  threadId: string;
  hasMore?: boolean;
}

/** An export reads the whole selected branch without filling the UI's bounded message cache. */
export function conversationTranscript({ threadId, hasMore, ...options }: ConversationTranscriptOptions): string | Promise<string> {
  if (!hasMore) return formatTranscriptMarkdown(options);
  return loadFullThread(threadId).then((thread) => formatTranscriptMarkdown({ ...options, messages: visibleMessages(thread) }));
}
