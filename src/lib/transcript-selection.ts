const ROW = "[data-mid]";

/** The first and last transcript rows a text selection spans, as indexes into the conversation. */
export interface SelectedRows {
  first: number;
  last: number;
}

interface TextPoint {
  rowId: string;
  offset: number;
}

/** A selection taken off rows about to be let go: each end as its row and a text offset into it, and the text it held. */
export interface SetAsideSelection {
  anchor: TextPoint;
  focus: TextPoint;
  text: string;
}

function rowOf(node: Node | null, list: Element): HTMLElement | null {
  const element = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
  const row = element?.closest<HTMLElement>(ROW);
  return row && list.contains(row) ? row : null;
}

/** The selection, when it is not collapsed and one of its ends lies in `list`. */
function selectionIn(list: Element): { selection: Selection; range: Range } | null {
  const selection = list.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!list.contains(range.startContainer) && !list.contains(range.endContainer)) return null;
  return { selection, range };
}

const isBackward = (selection: Selection, range: Range) =>
  selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset;

/**
 * The rows a selection with an end in `list` spans. An end outside any row (between rows, below them, or outside the
 * transcript) is first moved onto the edge of the nearest selected row: rows drawn next to such an end would otherwise
 * join the selection.
 */
export function selectedRows(list: Element, indexOf: (rowId: string) => number): SelectedRows | null {
  const held = selectionIn(list);
  if (!held) return null;
  const { selection, range } = held;
  let start = rowOf(range.startContainer, list), end = rowOf(range.endContainer, list);
  if (!start || !end) {
    const spanned = Array.from(list.querySelectorAll<HTMLElement>(ROW)).filter((row) => range.intersectsNode(row));
    if (!spanned.length) return null;
    const from = start ? { node: range.startContainer, offset: range.startOffset } : { node: spanned[0]!, offset: 0 };
    const last = spanned.at(-1)!;
    const to = end ? { node: range.endContainer, offset: range.endOffset } : { node: last, offset: last.childNodes.length };
    const [anchor, focus] = isBackward(selection, range) ? [to, from] : [from, to];
    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    start ??= spanned[0]!;
    end ??= last;
  }
  const first = rowIndex(start, list, indexOf), last = rowIndex(end, list, indexOf);
  if (first < 0 || last < 0) return null;
  return { first: Math.min(first, last), last: Math.max(first, last) };
}

/** A row inside a row (a step in a run) counts as its own row when the conversation has it, else as the row around it. */
function rowIndex(row: HTMLElement | null, list: Element, indexOf: (rowId: string) => number): number {
  for (; row; row = rowOf(row.parentElement, list)) {
    const index = indexOf(row.dataset.mid!);
    if (index >= 0) return index;
  }
  return -1;
}

function textOffset(row: HTMLElement, node: Node, offset: number): number {
  const range = row.ownerDocument.createRange();
  range.setStart(row, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** Takes a selection with an end in `list` off the page, so letting its rows go can neither collapse it onto the list nor
 * grow it over rows drawn later. */
export function setSelectionAside(list: Element): SetAsideSelection | null {
  const held = selectionIn(list);
  if (!held) return null;
  const { selection } = held;
  const anchorRow = rowOf(selection.anchorNode, list), focusRow = rowOf(selection.focusNode, list);
  const aside = anchorRow && focusRow ? {
    anchor: { rowId: anchorRow.dataset.mid!, offset: textOffset(anchorRow, selection.anchorNode!, selection.anchorOffset) },
    focus: { rowId: focusRow.dataset.mid!, offset: textOffset(focusRow, selection.focusNode!, selection.focusOffset) },
    text: selection.toString(),
  } : null;
  selection.removeAllRanges();
  return aside;
}

function pointAt(row: HTMLElement, offset: number): { node: Node; offset: number } {
  const walker = row.ownerDocument.createTreeWalker(row, 4);
  let passed = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = (node as Text).data.length;
    if (passed + length >= offset) return { node, offset: offset - passed };
    passed += length;
  }
  return { node: row, offset: row.childNodes.length };
}

/** A selection's text without the line breaks its rows' hover-only parts add or take away. */
const words = (text: string) => text.replace(/\s+/g, "");

/**
 * Puts a set-aside selection back once both of its rows are drawn again. "waiting" while one is not; "dropped" when the
 * rows no longer hold the same text, so a selection is never put back over other words.
 */
export function restoreSelection(list: Element, aside: SetAsideSelection): "waiting" | "restored" | "dropped" {
  const rows = Array.from(list.querySelectorAll<HTMLElement>(ROW));
  const anchorRow = rows.find((row) => row.dataset.mid === aside.anchor.rowId);
  const focusRow = rows.find((row) => row.dataset.mid === aside.focus.rowId);
  if (!anchorRow || !focusRow) return "waiting";
  const selection = list.ownerDocument.getSelection();
  if (!selection) return "dropped";
  const anchor = pointAt(anchorRow, aside.anchor.offset), focus = pointAt(focusRow, aside.focus.offset);
  selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  if (words(selection.toString()) === words(aside.text)) return "restored";
  selection.removeAllRanges();
  return "dropped";
}
