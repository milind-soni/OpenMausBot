import { inChatHistory } from "../../shared/chat-history.ts";
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

/** A conversation's messages one page at a time (newest first when `before` is absent), and the page around one message. */
export function messagePages(store: Pick<Store, "activePath" | "activePathIndex" | "messagesFor" | "messagesTail" | "messagesBefore" | "activeLeaf">) {
  function chatPage(threadId: string, limit: number | undefined, before?: string, around?: string) {
    const { messages: path, positions, leafId: activeLeafId } = store.activePathIndex(threadId);
    const anchor = before ?? around;
    const index = anchor === undefined ? path.length : positions.get(anchor);
    if (index === undefined) return null;
    if (!around) {
      const messages: Array<ReturnType<typeof pageMessage>> = [];
      for (let i = index - 1; i >= 0; i--) {
        const message = path[i]!;
        if (!inChatHistory(message)) continue;
        if (messages.length === limit) return { messages: messages.reverse(), hasMore: true, activeLeafId };
        messages.push(pageMessage(message));
      }
      return { messages: messages.reverse(), hasMore: false, activeLeafId };
    }
    const visible = path.filter(m => inChatHistory(m) || m.id === around);
    const size = limit ?? visible.length;
    const start = Math.max(0, Math.min(visible.length - size, visible.findIndex(m => m.id === around) - Math.floor(size / 2)));
    return { messages: visible.slice(start, start + size).map(pageMessage), hasMore: start > 0, activeLeafId };
  }
  function messagePage(threadId: string, limit: number | undefined, chat = false, preview = false) {
    if (preview && limit === 0) {
      const tail = store.messagesTail(threadId, 8);
      const byId = new Map(tail.messages.map(m => [m.id, m]));
      let at = tail.activeLeafId;
      while (at) {
        const m = byId.get(at);
        if (!m) break;
        if (m.kind === "text" && m.text?.trim()) return { messages: [], activeLeafId: tail.activeLeafId, previewText: m.text.slice(0, 240) };
        at = m.parentId ?? null;
      }
      const last = at ? store.activePath(threadId).findLast(m => m.kind === "text" && m.text?.trim()) : undefined;
      return { messages: [], activeLeafId: tail.activeLeafId, previewText: last?.text?.slice(0, 240) };
    }
    if (chat) return chatPage(threadId, limit)!;
    if (limit === undefined) {
      return { messages: store.messagesFor(threadId), activeLeafId: store.activeLeaf(threadId) };
    }
    const tail = store.messagesTail(threadId, limit);
    return { ...tail, messages: tail.messages.map(pageMessage) };
  }

  function messagePageBefore(threadId: string, before: string, limit: number, chat = false) {
    if (chat) return chatPage(threadId, limit, before);
    const page = store.messagesBefore(threadId, before, limit);
    return page ? { ...page, messages: page.messages.map(pageMessage) } : null;
  }

  function messageWindow(threadId: string, messageId: string, limit: number, chat = false) {
    if (chat) return chatPage(threadId, limit, undefined, messageId);
    const all = store.messagesFor(threadId);
    const index = all.findIndex((message) => message.id === messageId);
    if (index < 0) return null;
    const before = Math.floor((limit - 1) / 2);
    const start = Math.max(0, Math.min(index - before, all.length - limit));
    const stop = Math.min(all.length, start + limit);
    return { messages: all.slice(start, stop).map(pageMessage), hasMore: start > 0 };
  }

  return { messagePage, messagePageBefore, messageWindow };
}
