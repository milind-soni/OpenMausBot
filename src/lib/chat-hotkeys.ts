/** Window-level keys a chat transcript listens for.
 *
 * Extracted from ChatView because Spaces mounts one ChatView per bot: with the
 * listeners inline, twenty cards meant twenty handlers answering a single Cmd-F.
 * An inactive chat now registers nothing at all, and the rule is testable
 * without a DOM.
 */

export interface KeyTarget {
  addEventListener(type: "keydown", handler: (event: KeyboardEvent) => void): void;
  removeEventListener(type: "keydown", handler: (event: KeyboardEvent) => void): void;
}

export interface ChatHotkeyOptions {
  /** Only the focused chat answers the keyboard. */
  active: boolean;
  onFind: () => void;
  /** An upward key is a scroll gesture: it breaks follow-the-bottom. */
  onScrollAway: () => void;
}

function isTyping(target: unknown): boolean {
  const tagName = (target as { tagName?: string } | null)?.tagName;
  return tagName === "TEXTAREA" || tagName === "INPUT";
}

/** Returns the cleanup. Installing while inactive is a no-op, cleanup included. */
export function installChatHotkeys(target: KeyTarget, options: ChatHotkeyOptions): () => void {
  if (!options.active) return () => {};

  const onKey = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      options.onFind();
      return;
    }
    // ArrowUp only counts outside inputs — in the composer it edits, not scrolls.
    if (event.key === "PageUp" || ((event.key === "Home" || event.key === "ArrowUp") && !isTyping(event.target))) {
      options.onScrollAway();
    }
  };

  target.addEventListener("keydown", onKey);
  return () => target.removeEventListener("keydown", onKey);
}
