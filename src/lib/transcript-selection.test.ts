// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import { restoreSelection, selectedRows, setSelectionAside, type SetAsideSelection } from "./transcript-selection";
import { SELECTION_HOLD_MAX, TRANSCRIPT_WINDOW_MAX, holdRows, tailWindowStart, windowEarlier, windowLater, type TranscriptWindowBounds } from "./transcript-window";

const TOTAL = 3_000;
const ids = Array.from({ length: TOTAL }, (_, index) => `m${index}`);
const indexOf = (rowId: string) => ids.indexOf(rowId);
let list: HTMLElement;

/** Draws the window's rows as React's keyed list does: rows still drawn keep their nodes, the others come and go. */
function draw({ start, end }: TranscriptWindowBounds) {
  const wanted = ids.slice(start, end ?? TOTAL);
  const kept = new Map(Array.from(list.querySelectorAll<HTMLElement>("[data-mid]")).map((row) => [row.dataset.mid!, row]));
  for (const [rowId, row] of kept) if (!wanted.includes(rowId)) row.remove();
  const after = list.querySelector("button");
  for (const rowId of wanted) {
    let row = kept.get(rowId);
    if (!row) {
      row = document.createElement("div");
      row.dataset.mid = rowId;
      row.innerHTML = `<p>Reply <b>${rowId}</b> says</p><p>more of ${rowId}</p>`;
    }
    list.insertBefore(row, after);
  }
}

const row = (rowId: string) => list.querySelector<HTMLElement>(`[data-mid="${rowId}"]`)!;
const selected = () => String(document.getSelection());

/** One window step as the viewport takes it: widened over the selected rows, or the selection set aside past the cap. */
function step(window: TranscriptWindowBounds, move: typeof windowEarlier, aside: { held: SetAsideSelection | null }) {
  const next = move(window, TOTAL);
  const held = selectedRows(list, indexOf);
  const kept = held && holdRows(next, TOTAL, held);
  if (held && !kept) aside.held = setSelectionAside(list);
  const drawn = kept ?? next;
  draw(drawn);
  if (aside.held && restoreSelection(list, aside.held) !== "waiting") aside.held = null;
  return drawn;
}

beforeEach(() => {
  document.body.innerHTML = `<header>Chat with a bot</header><div role="log"><button>Show later</button></div>`;
  list = document.querySelector<HTMLElement>('[role="log"]')!;
});

describe("a text selection in a windowed transcript", () => {
  it("keeps its rows drawn while the reader scrolls a few steps away, and copies the same text on return", () => {
    let window: TranscriptWindowBounds = { start: tailWindowStart(TOTAL), end: null };
    draw(window);
    document.getSelection()!.setBaseAndExtent(row("m2950").querySelector("b")!.firstChild!, 1, row("m2952").querySelector("p")!.firstChild!, 3);
    const text = selected();
    const anchor = document.getSelection()!.anchorNode;
    expect(text).toContain("more of m2950");
    const aside = { held: null as SetAsideSelection | null };
    for (let steps = 0; steps < 10; steps++) {
      window = step(window, windowEarlier, aside);
      expect(list.contains(anchor), "a row holding an end of the selection is never let go").toBe(true);
      expect(window.end ?? TOTAL).toBeGreaterThan(2_952);
      expect((window.end ?? TOTAL) - window.start).toBeLessThanOrEqual(SELECTION_HOLD_MAX);
      expect(selected()).toBe(text);
    }
    for (let steps = 0; steps < 10; steps++) window = step(window, windowLater, aside);
    expect(selected()).toBe(text);
  });

  it("is set aside past the hold's cap and put back with the same text when its rows return", () => {
    let window: TranscriptWindowBounds = { start: tailWindowStart(TOTAL), end: null };
    draw(window);
    document.getSelection()!.setBaseAndExtent(row("m2990").querySelector("p")!.lastChild!, 2, row("m2950").querySelector("b")!.firstChild!, 2);
    const text = selected();
    const aside = { held: null as SetAsideSelection | null };
    let widest = 0;
    for (let steps = 0; steps < 60; steps++) {
      window = step(window, windowEarlier, aside);
      widest = Math.max(widest, (window.end ?? TOTAL) - window.start);
    }
    expect(widest).toBeLessThanOrEqual(SELECTION_HOLD_MAX);
    expect(aside.held, "set aside once the reader is past the cap").not.toBeNull();
    expect(document.getSelection()!.isCollapsed).toBe(true);
    expect((window.end ?? TOTAL) - window.start).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_MAX);
    for (let steps = 0; steps < 60 && window.end !== null; steps++) window = step(window, windowLater, aside);
    expect(aside.held).toBeNull();
    expect(selected()).toBe(text);
    const selection = document.getSelection()!;
    expect(selection.anchorNode?.parentElement?.closest("[data-mid]")?.getAttribute("data-mid"), "the direction is kept").toBe("m2990");
  });

  it("never takes in rows drawn next to an end that lies outside the rows", () => {
    draw({ start: 100, end: 110 });
    document.getSelection()!.setBaseAndExtent(list, 0, row("m102").querySelector("p")!.firstChild!, 4);
    const text = selected();
    expect(selectedRows(list, indexOf)).toEqual({ first: 100, last: 102 });
    draw({ start: 70, end: 110 });
    expect(selected()).toBe(text);
  });

  it("moves an end outside the transcript onto the nearest selected row", () => {
    draw({ start: 100, end: 110 });
    document.getSelection()!.setBaseAndExtent(document.querySelector("header")!.firstChild!, 0, row("m101").querySelector("b")!.firstChild!, 2);
    expect(selectedRows(list, indexOf)).toEqual({ first: 100, last: 101 });
    const selection = document.getSelection()!;
    expect(selection.anchorNode).toBe(row("m100"));
    expect(selected().startsWith("Reply m100")).toBe(true);
  });

  it("puts a selection back when only the blank lines between its rows changed", () => {
    draw({ start: 100, end: 110 });
    document.getSelection()!.setBaseAndExtent(row("m101").querySelector("b")!.firstChild!, 0, row("m103").querySelector("b")!.firstChild!, 4);
    const text = selected();
    const aside = setSelectionAside(list)!;
    draw({ start: 0, end: 10 });
    draw({ start: 100, end: 110 });
    row("m102").append("\n\n");
    expect(restoreSelection(list, aside)).toBe("restored");
    expect(selected().replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });

  it("drops a set-aside selection whose rows no longer hold its text", () => {
    draw({ start: 100, end: 110 });
    document.getSelection()!.setBaseAndExtent(row("m101").querySelector("b")!.firstChild!, 0, row("m103").querySelector("b")!.firstChild!, 4);
    const aside = setSelectionAside(list)!;
    expect(document.getSelection()!.isCollapsed).toBe(true);
    draw({ start: 0, end: 10 });
    expect(restoreSelection(list, aside)).toBe("waiting");
    draw({ start: 100, end: 110 });
    row("m102").querySelector("b")!.textContent = "changed";
    expect(restoreSelection(list, aside)).toBe("dropped");
    expect(document.getSelection()!.isCollapsed).toBe(true);
  });
});
