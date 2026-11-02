import { useLayoutEffect, useState, type RefObject } from "react";

/** Simple: anything that grows the pill past its one 44px row (a second line, a reply strip) rounds its corners in. */
export function useTallPill(shellRef: RefObject<HTMLDivElement | null>, on: boolean): boolean {
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!on || !shell || typeof ResizeObserver === "undefined") return;
    const measure = () => setTall(shell.getBoundingClientRect().height > 44.5);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [shellRef, on]);
  return tall;
}

/**
 * Advanced: a message past one line takes the composer's full width above the buttons instead of wrapping in the gap
 * between them. `wrapAt` is the length at which the one-row field wrapped; the field goes back beside the buttons
 * only below it, so wider text on its own line cannot flip back and forth.
 */
export function useStackedField(inputRef: RefObject<HTMLTextAreaElement | null>, on: boolean, text: string): boolean {
  const [wrapAt, setWrapAt] = useState<number | null>(null);
  const stacked = on && (text.includes("\n") || (wrapAt !== null && text.length >= wrapAt));
  // Width changes (a resized window, a panel opening) can wrap the one-row field too, so watch its size, not just the text.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!on || stacked || !input || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // An empty field's height is its placeholder's, which may wrap; that is not a message. The next message measures afresh.
      if (!input.value) return setWrapAt(null);
      const style = getComputedStyle(input);
      const line = parseFloat(style.lineHeight) || 24;
      const content = input.scrollHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
      if (content > line * 1.5) setWrapAt(input.value.length);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(input);
    return () => observer.disconnect();
  }, [inputRef, on, stacked, text]);
  return stacked;
}
