import { createCitationTextSelector, findCitationText, type CitationAttachment } from "./citations";

type TextChunk = { node: Text; start: number; end: number };
const EXCLUDED_SELECTOR = "button, input, textarea, select, [role=button], [contenteditable], [hidden], [aria-hidden=true], script, style, template, noscript, svg";
const BLOCK_SELECTOR = "address, article, aside, blockquote, dd, div, dl, dt, figcaption, figure, footer, h1, h2, h3, h4, h5, h6, header, hr, li, main, nav, ol, p, pre, section, table, td, th, tr, ul";

function readCitationText(root: HTMLElement) {
  const parts: string[] = [];
  const chunks: TextChunk[] = [];
  let length = 0;
  let separator = false;
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      if (!text.length) return;
      if (separator && length > 0) { parts.push("\n"); length += 1; }
      separator = false;
      chunks.push({ node: text, start: length, end: length + text.length });
      parts.push(text.data);
      length += text.length;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (element.matches(EXCLUDED_SELECTOR)) return;
    const block = element.matches(BLOCK_SELECTOR);
    if (block || element.tagName === "BR") separator = true;
    for (const child of element.childNodes) visit(child);
    if (block) separator = true;
  };
  visit(root);
  return { text: parts.join(""), chunks };
}

function excludedAncestor(node: Node): Element | null {
  return (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest(EXCLUDED_SELECTOR) ?? null;
}

function selectedTextBoundary(range: Range, node: Node, last: boolean): Text | null {
  if (!range.intersectsNode(node)) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node as Text;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : text.length;
    return start < end ? text : null;
  }
  for (let child = last ? node.lastChild : node.firstChild; child; child = last ? child.previousSibling : child.nextSibling) {
    const boundary = selectedTextBoundary(range, child, last);
    if (boundary) return boundary;
  }
  return null;
}

export function captureCitationSelection(viewport: HTMLElement, selection: Selection | null) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const first = selectedTextBoundary(range, range.commonAncestorContainer, false);
  const last = selectedTextBoundary(range, range.commonAncestorContainer, true);
  if (!first || !last) return null;
  const source = first.parentElement?.closest<HTMLElement>("[data-citation-source]");
  if (!source || !viewport.contains(source)) return null;
  range.setStart(first, first === range.startContainer ? range.startOffset : 0);
  range.setEnd(last, last === range.endContainer ? range.endOffset : last.length);
  if (range.collapsed || !source.contains(range.endContainer) || excludedAncestor(range.startContainer) || excludedAncestor(range.endContainer)) return null;
  const stream = readCitationText(source);
  let rawStart: number | null = null;
  let rawEnd = 0;
  for (const chunk of stream.chunks) {
    if (!range.intersectsNode(chunk.node)) continue;
    const start = range.startContainer === chunk.node ? range.startOffset : 0;
    const end = range.endContainer === chunk.node ? range.endOffset : chunk.node.length;
    if (start === end) continue;
    rawStart ??= chunk.start + start;
    rawEnd = chunk.start + end;
  }
  if (rawStart === null) return null;
  const selector = createCitationTextSelector(stream.text, rawStart, rawEnd);
  return selector ? { source, selector, range } : null;
}

function rawTextOffset(text: string, normalizedOffset: number): number {
  let offset = 0;
  for (const match of text.matchAll(/\s+|\S+/g)) {
    const whitespace = /\s/.test(match[0][0]!);
    const length = whitespace ? 1 : match[0].length;
    if (normalizedOffset <= offset + length) return match.index + (whitespace && normalizedOffset > offset ? match[0].length : normalizedOffset - offset);
    offset += length;
  }
  return text.length;
}

export function resolveCitationRange(root: HTMLElement, citation: CitationAttachment): Range | null {
  const stream = readCitationText(root);
  const match = findCitationText(stream.text, { text: citation.quote, ...citation.source });
  if (!match) return null;
  const start = rawTextOffset(stream.text, match.start);
  const end = rawTextOffset(stream.text, match.end);
  const first = stream.chunks.find((chunk) => chunk.end > start);
  const last = stream.chunks.findLast((chunk) => chunk.start < end);
  if (!first || !last) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(first.node, Math.max(0, start - first.start));
  range.setEnd(last.node, Math.min(last.node.length, end - last.start));
  return range;
}

export function findCitationSource(document: Document, citation: CitationAttachment): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>("[data-citation-source]")].find((element) =>
    element.dataset.citationSource === citation.source.messageId &&
    element.dataset.citationOwnerType === citation.source.ownerType,
  ) ?? null;
}

let highlightCleanup: number | undefined;

function sameRange(a: Range, b: Range): boolean {
  return a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset;
}

export async function highlightCitationSource(citation: CitationAttachment): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const source = findCitationSource(document, citation);
    const range = source ? resolveCitationRange(source, citation) : null;
    if (source && range) {
      source.scrollIntoView({ block: "center", behavior: "smooth" });
      const highlights = (CSS as unknown as { highlights?: { set(name: string, value: unknown): void; delete(name: string): void } }).highlights;
      const HighlightConstructor = (globalThis as unknown as { Highlight?: new (range: Range) => unknown }).Highlight;
      window.clearTimeout(highlightCleanup);
      if (highlights && HighlightConstructor) {
        highlights.set("omb-citation-source", new HighlightConstructor(range));
        highlightCleanup = window.setTimeout(() => highlights.delete("omb-citation-source"), 2_500);
      } else {
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        highlightCleanup = window.setTimeout(() => {
          if (selection?.rangeCount === 1 && sameRange(selection.getRangeAt(0), range)) selection.removeAllRanges();
        }, 2_500);
      }
      return true;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  return false;
}

export function citationTabShortcut() {
  let used = false;
  return {
    reset() { used = false; },
    handle(event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">, action: HTMLButtonElement | null): boolean {
      if (used || event.key !== "Tab" || event.shiftKey || !action || action.disabled) return false;
      event.preventDefault();
      action.focus({ preventScroll: true });
      used = true;
      return true;
    },
  };
}

type ShortcutEvent = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "isComposing">;

/** ⌘L on a Mac, Ctrl+L elsewhere: add the selected message text to the
 * prompt. Free in the app's own catalog (src/lib/keyboard-shortcuts.ts) and
 * only taken while a message selection is showing the pill. `code` keeps it
 * on the L key in non-Latin layouts. */
export function isAddToPromptShortcut(event: ShortcutEvent, isMac: boolean): boolean {
  if (event.isComposing || event.shiftKey || event.altKey) return false;
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return modifier && (event.key.toLowerCase() === "l" || event.code === "KeyL");
}

/** The chord as the pill shows it and announces it (aria-keyshortcuts). */
export function addToPromptChord(isMac: boolean): { text: string; aria: string } {
  return isMac ? { text: "\u2318L", aria: "Meta+L" } : { text: "Ctrl+L", aria: "Control+L" };
}

/** Whether a key in the composer takes the newest quote chip back out:
 * Escape, or Backspace with the caret at the very start of the input, right
 * after the chips. */
export function removesQuoteChip(
  event: Pick<KeyboardEvent, "key" | "isComposing">,
  selection: { start: number | null; end: number | null },
): boolean {
  if (event.isComposing) return false;
  if (event.key === "Escape") return true;
  return event.key === "Backspace" && selection.start === 0 && selection.end === 0;
}
