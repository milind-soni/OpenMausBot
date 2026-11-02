// Rendered Markdown kept per message text: a message drawn again (a conversation switched back to, rows scrolled back
// into the window, a bubble that re-renders) reuses the React elements it already produced instead of parsing again.
// An entry is only reused while everything the plugins read still matches (`variant`: mention names, thread links,
// math); the cache holds an estimate of the memory its element trees take and lets the least recently drawn go first.
import type { ReactElement } from "react";

/** The estimated memory all cached element trees may hold. */
export const MARKDOWN_CACHE_BYTES = 10 * 1024 * 1024;
/** A longer text is parsed each time it is drawn rather than pinning its element tree. */
export const MARKDOWN_CACHE_MAX_CHARS = 200_000;
/** What one source character holds as an HTML syntax tree plus React elements: 57 bytes of V8 heap measured over 2,000
 * replies of prose, lists, code and tables, so 10 MB is about 170,000 characters of Markdown. */
export const MARKDOWN_BYTES_PER_CHAR = 60;

interface Entry {
  variant: string;
  element: ReactElement;
  bytes: number;
}

export interface MarkdownRenderCache {
  /** The cached element for `text` drawn as `variant`, or `render()`'s, which is kept for next time. */
  render(text: string, variant: string, render: () => ReactElement): ReactElement;
  readonly size: number;
  readonly bytes: number;
  clear(): void;
}

export function createMarkdownRenderCache(limit = MARKDOWN_CACHE_BYTES, maxChars = MARKDOWN_CACHE_MAX_CHARS): MarkdownRenderCache {
  const entries = new Map<string, Entry>();
  let held = 0;
  const drop = (text: string, entry: Entry) => {
    entries.delete(text);
    held -= entry.bytes;
  };
  return {
    render(text, variant, render) {
      const cached = entries.get(text);
      if (cached && cached.variant === variant) {
        // Most recently drawn moves to the back of the eviction order.
        entries.delete(text);
        entries.set(text, cached);
        return cached.element;
      }
      if (cached) drop(text, cached);
      const element = render();
      const bytes = text.length * MARKDOWN_BYTES_PER_CHAR;
      if (text.length > maxChars || bytes > limit) return element;
      entries.set(text, { variant, element, bytes });
      held += bytes;
      for (const [oldest, entry] of entries) {
        if (held <= limit) break;
        drop(oldest, entry);
      }
      return element;
    },
    get size() { return entries.size; },
    get bytes() { return held; },
    clear() {
      entries.clear();
      held = 0;
    },
  };
}
