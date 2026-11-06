import type { Message, Store } from "../store.ts";
import { toolResultPrefix } from "../tool-results.ts";

const MESSAGE_PAGE_MAX = 200;
/** How much of a tool step's output a conversation page carries: the rest is fetched when the step is opened, so
 * switching to a conversation full of tool steps stays light. */
export const TOOL_OUTPUT_PREVIEW = 1_000;

/** undefined = absent, null = present but unusable (the caller answers 400). */
export function pageSize(raw: string | null): number | null | undefined {
  if (raw === null) return undefined;
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 0) return null;
  return Math.min(size, MESSAGE_PAGE_MAX);
}

export function slimMessage(message: Message): Message | Record<string, unknown> {
  if (message.kind !== "screen" || !message.png) return message;
  const { png: _png, ...rest } = message;
  return { ...rest, hasImage: true };
}

/** A message as a conversation page carries it: slimmed, and a plain tool step's long output cut to a preview marked
 * `clipped`. Input stays whole (labels parse it), and so do rows whose tool output is the reply itself (a teammate's
 * result, a relayed message, a handoff). */
export function pageMessage(message: Message): Message | Record<string, unknown> {
  const slim = slimMessage(message);
  const tool = message.tool;
  if (!tool || message.kind !== "activity" || message.relay || message.roomRequest || message.comm || message.threadRef) return slim;
  const output = tool.output;
  if (output === undefined || output.length <= TOOL_OUTPUT_PREVIEW) return slim;
  return { ...slim, tool: { ...tool, output: toolResultPrefix(output, TOOL_OUTPUT_PREVIEW), clipped: true } };
}

/** What one snapshot of every conversation may carry in messages. The companion proxy buffers a JSON answer up to
 * 32 MiB and refuses a larger one, so a host with many long conversations must stay under that with room for the rest
 * of the snapshot, or a paired client can't load its bot list at all. */
export const SNAPSHOT_MESSAGE_BYTES = 24 * 1024 * 1024;

/** Fits a snapshot's conversation pages into `budget` bytes of messages. Each conversation gets an even share, what a
 * short one leaves goes to the longer ones, and a cut drops the oldest messages and sets hasMore, so scrolling up
 * still reads them. The newest message always stays: the next page is asked for from the oldest one held. */
export function fitSnapshotPages<T extends { messages: unknown[]; hasMore?: boolean }>(owners: T[], budget = SNAPSHOT_MESSAGE_BYTES): T[] {
  const sized = owners.map((owner, index) => {
    const sizes = owner.messages.map((message) => Buffer.byteLength(JSON.stringify(message)));
    return { index, sizes, bytes: sizes.reduce((sum, size) => sum + size, 0) };
  });
  if (sized.reduce((sum, owner) => sum + owner.bytes, 0) <= budget) return owners;
  const fitted = [...owners];
  let left = budget;
  sized.sort((a, b) => a.bytes - b.bytes).forEach(({ index, sizes, bytes }, order) => {
    const share = left / (sized.length - order);
    let kept = sizes.length;
    let used = bytes;
    while (kept > 1 && used > share) used -= sizes[sizes.length - kept--]!;
    left = Math.max(0, left - used);
    if (kept < sizes.length) fitted[index] = { ...owners[index]!, messages: owners[index]!.messages.slice(-kept), hasMore: true };
  });
  return fitted;
}

/** A conversation's messages one page at a time (newest first when `before` is absent), and the page around one message. */
export function messagePages(store: Pick<Store, "messagesFor" | "messagesTail" | "activeLeaf">) {
  function messagePage(threadId: string, limit: number | undefined, before?: string | null) {
    if (limit === undefined) {
      return { messages: store.messagesFor(threadId), activeLeafId: store.activeLeaf(threadId) };
    }
    if (!before) {
      const tail = store.messagesTail(threadId, limit);
      return { messages: tail.messages.map(pageMessage), hasMore: tail.hasMore, activeLeafId: tail.activeLeafId };
    }
    const all = store.messagesFor(threadId);
    const end = all.findIndex((msg) => msg.id === before);
    const stop = end === -1 ? all.length : end;
    const start = Math.max(0, stop - limit);
    return {
      messages: all.slice(start, stop).map(pageMessage),
      hasMore: start > 0,
      activeLeafId: store.activeLeaf(threadId),
    };
  }

  function messageWindow(threadId: string, messageId: string, limit: number) {
    const all = store.messagesFor(threadId);
    const index = all.findIndex((message) => message.id === messageId);
    if (index < 0) return null;
    const before = Math.floor((limit - 1) / 2);
    const start = Math.max(0, Math.min(index - before, all.length - limit));
    const stop = Math.min(all.length, start + limit);
    return { messages: all.slice(start, stop).map(pageMessage), hasMore: start > 0 };
  }

  return { messagePage, messageWindow };
}
