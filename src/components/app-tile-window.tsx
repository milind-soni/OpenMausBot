import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";

const TILE_HEIGHT = 56;
const OVERSCAN_ROWS = 6;

interface GridLayout {
  columns: number;
  /** Tiles that finish the grid row the cards before the list started. */
  lead: number;
  margin: number;
  gap: number;
}

const FIRST_LAYOUT: GridLayout = { columns: 1, lead: 0, margin: 0, gap: 0 };

const sameLayout = (a: GridLayout, b: GridLayout) =>
  a.columns === b.columns && a.lead === b.lead && a.gap === b.gap && Math.abs(a.margin - b.margin) < 0.5;

const gridColumns = (style: CSSStyleDeclaration) =>
  Math.max(1, style.gridTemplateColumns.split(" ").filter((track) => track.endsWith("px")).length);

/** The column the next auto-placed item takes after `items`, following `display: contents` and skipping hidden ones. */
function nextColumn(items: Element[], columns: number): number {
  let column = 0;
  const place = (element: Element) => {
    const style = getComputedStyle(element);
    if (style.display === "none") return;
    if (style.display === "contents") {
      for (const child of Array.from(element.children)) place(child);
      return;
    }
    column = style.gridColumnEnd === "-1" ? 0 : (column + 1) % columns;
  };
  for (const item of items) place(item);
  return column;
}

/** Keeps the measurements current and the focused tile known while the window is on. */
function watchGrid(grid: HTMLElement, scroller: HTMLElement, measure: () => void, onFocus: (slug: string | null) => void, ownCount: () => number) {
  const resizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
  resizes?.observe(grid);
  resizes?.observe(scroller);
  const mutations = new MutationObserver(measure);
  mutations.observe(grid, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  const ownTile = (target: EventTarget | null) => {
    const children = Array.from(grid.children);
    const own = children.slice(children.length - ownCount());
    return own.find((child) => target instanceof Node && child.contains(target))?.getAttribute("data-app-tile") ?? null;
  };
  const onFocusIn = (event: FocusEvent) => onFocus(ownTile(event.target));
  const onFocusOut = (event: FocusEvent) => {
    if (event.relatedTarget !== null && ownTile(event.relatedTarget) === null) onFocus(null);
  };
  grid.addEventListener("focusin", onFocusIn);
  grid.addEventListener("focusout", onFocusOut);
  return () => {
    resizes?.disconnect();
    mutations.disconnect();
    grid.removeEventListener("focusin", onFocusIn);
    grid.removeEventListener("focusout", onFocusOut);
  };
}

/**
 * Mounts only the grid rows of `cards` near the view, as the last items of the grid at `gridRef`, scrolled by
 * `scrollRef`. Columns, row gap and the place the first card lands are read from the laid-out grid, and full-width
 * spacers stand in for the rows left out, so the grid looks as it would with every card in it. The row of the focused
 * tile and of `keep` stay mounted.
 */
export function useAppTileWindow<Card extends { slug: string }>(cards: readonly Card[], enabled: boolean, keep: string | null) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [kept, setLayout] = useState(FIRST_LAYOUT);
  // Measured while the list is short as well, so the render that turns the window on already places it.
  const seen = useRef(FIRST_LAYOUT);
  const wasEnabled = useRef(false);
  const layout = enabled && !wasEnabled.current ? seen.current : kept;
  const focused = useRef<string | null>(null);
  const placed = useRef<number[]>([]);
  const columns = layout.columns;
  const lead = Math.min(layout.lead, cards.length);
  const rows = enabled ? Math.ceil((cards.length - lead) / columns) : 0;
  const indexOf = useMemo(() => new Map(cards.map((card, index) => [card.slug, index])), [cards]);
  const getItemKey = useCallback((row: number) => `${columns}:${cards[lead + row * columns]?.slug}`, [cards, lead, columns]);
  const virtualizer = useVirtualizer({
    count: rows,
    enabled,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TILE_HEIGHT,
    getItemKey,
    overscan: OVERSCAN_ROWS,
    gap: layout.gap,
    scrollMargin: layout.margin,
    initialRect: { width: 0, height: scrollRef.current?.offsetHeight ?? 0 },
    // The virtualizer scrolls to this offset when it takes the scroller, and the list can turn on part way down.
    initialOffset: () => scrollRef.current?.scrollTop ?? 0,
    rangeExtractor: (range) => {
      const shown = new Set(defaultRangeExtractor(range));
      for (const slug of [focused.current, keep]) {
        const index = slug === null ? undefined : indexOf.get(slug);
        if (index !== undefined && index >= lead) shown.add(Math.floor((index - lead) / columns));
      }
      return [...shown].sort((a, b) => a - b);
    },
  });
  // The rows are in the page's flow, so the browser's scroll anchoring already keeps the view still when one above it
  // changes height; moving the scroll as well would move it twice.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;

  const pass: number[] = [];
  const measure = useRef(() => {});
  measure.current = () => {
    const grid = gridRef.current;
    const scroller = scrollRef.current;
    if (!grid || !scroller) return;
    const own = placed.current;
    const children = Array.from(grid.children);
    const first = children.length - own.length;
    const style = getComputedStyle(grid);
    const nextColumns = gridColumns(style);
    const column = nextColumn(children.slice(0, first), nextColumns);
    const nextLead = column === 0 ? 0 : nextColumns - column;
    const start = children[first + nextLead];
    const next = {
      columns: nextColumns,
      lead: nextLead,
      margin: start ? start.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop : layout.margin,
      gap: parseFloat(style.rowGap) || 0,
    };
    seen.current = next;
    if (!enabled) return;
    if (!sameLayout(next, kept)) {
      setLayout(next);
      return;
    }
    const heights = new Map<number, number>();
    own.forEach((index, position) => {
      if (index < lead) return;
      const row = Math.floor((index - lead) / columns);
      const height = (children[first + position] as HTMLElement).offsetHeight;
      heights.set(row, Math.max(heights.get(row) ?? 0, height));
    });
    for (const [row, height] of heights) if (height > 0) virtualizer.resizeItem(row, height);
  };

  const watched = useRef<{ grid: HTMLElement; scroller: HTMLElement; stop: () => void } | null>(null);
  useLayoutEffect(() => {
    placed.current = pass;
    wasEnabled.current = enabled;
    const grid = gridRef.current;
    const scroller = scrollRef.current;
    const watch = enabled && grid && scroller ? { grid, scroller } : null;
    if (watched.current && (watched.current.grid !== watch?.grid || watched.current.scroller !== watch?.scroller)) {
      watched.current.stop();
      watched.current = null;
    }
    if (watch && !watched.current) {
      const stop = watchGrid(watch.grid, watch.scroller, () => measure.current(), (slug) => { focused.current = slug; }, () => placed.current.length);
      watched.current = { ...watch, stop };
    }
    measure.current();
  });
  useLayoutEffect(() => () => {
    watched.current?.stop();
    watched.current = null;
  }, []);

  const render = (renderCard: (card: Card) => ReactNode): ReactNode[] => {
    if (!enabled) {
      pass.push(...cards.keys());
      return cards.map(renderCard);
    }
    const nodes: ReactNode[] = [];
    const add = (index: number) => {
      nodes.push(renderCard(cards[index]!));
      pass.push(index);
    };
    const spacer = (key: string, height: number) => {
      nodes.push(<div key={key} aria-hidden="true" data-tile-gap="" className="col-span-full" style={{ height: Math.max(0, height) }} />);
      pass.push(-1);
    };
    for (let index = 0; index < lead; index += 1) add(index);
    const { gap, scrollMargin } = virtualizer.options;
    // A spacer is a grid row of its own, so it takes the row gap on each side that the rows it replaces had between them.
    let end = scrollMargin - gap;
    let next = 0;
    for (const row of virtualizer.getVirtualItems()) {
      if (row.index > next) spacer(`gap-${next}`, row.start - end - 2 * gap);
      const last = Math.min(cards.length, lead + (row.index + 1) * columns);
      for (let index = lead + row.index * columns; index < last; index += 1) add(index);
      end = row.end;
      next = row.index + 1;
    }
    if (next < rows) spacer(`gap-${next}`, virtualizer.getTotalSize() + scrollMargin - end - gap);
    return nodes;
  };

  return { scrollRef, gridRef, render };
}
