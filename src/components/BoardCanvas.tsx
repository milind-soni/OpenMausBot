// The board's canvas: the columns live on a pannable, zoomable surface that
// remembers how each viewer arranged it.
//
// Two rules shape this file.
//
// First, a column always lands where it was put. Whatever it lands on slides
// out of the way, so no two columns ever overlap and the gesture is never
// refused. Refusing would be safe but it fights the person — they aimed
// somewhere and the board said no without offering an alternative.
//
// Second, nothing here is the board's data. Positions, sizes and names are the
// viewer's own arrangement of their screen, so they live in this browser under
// the environment's id, and clearing site data costs a layout rather than work.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";

import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import type { WorkColumn } from "@/lib/task-board";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clamp,
  contentBounds,
  defaultBoxes,
  keepOnScreen,
  parseLayout,
  resolveBoxes,
  settleInto,
  type BoardLayout,
  type ColumnBox,
} from "@/lib/board-layout";

export interface BoardCanvasProps {
  children: (boxes: Record<WorkColumn, ColumnBox>, api: BoardCanvasApi) => ReactNode;
}

export interface BoardCanvasApi {
  /** Move a column while it is held. Free: nothing else moves. */
  move: (column: WorkColumn, box: ColumnBox) => void;
  /** Put it down. The board tidies here, and only here. */
  commit: (column: WorkColumn, box: ColumnBox) => void;
  /** Grow a column while its edge is held. Free, like a move. */
  resize: (column: WorkColumn, box: ColumnBox) => void;
  /** Finish a resize, which settles the board. */
  commitResize: (column: WorkColumn, box: ColumnBox) => void;
  rename: (column: WorkColumn, name: string | null) => void;
  names: Partial<Record<WorkColumn, string>>;
  /** The column currently being dragged, so it can be drawn as in-flight. */
  moving: WorkColumn | null;
}

export function BoardCanvas({ children }: BoardCanvasProps) {
  useStore();
  const [boxes, setBoxes] = useState<Record<WorkColumn, ColumnBox>>(defaultBoxes);
  const [names, setNames] = useState<Partial<Record<WorkColumn, string>>>({});
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [moving, setMoving] = useState<WorkColumn | null>(null);
  const storageKey = useRef<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pan = useRef<{ startX: number; startY: number; view: { x: number; y: number } } | null>(null);

  /** Layout is personal presentation, not board data. Keying it to the
   * workspace id keeps two hosted workspaces from sharing an arrangement —
   * the same key shape the Team map uses. */
  useEffect(() => {
    let active = true;
    void api("/.well-known/openmausbot/environment", { signal: AbortSignal.timeout(5_000) })
      .then((environment) => {
        if (!active || typeof environment.environmentId !== "string") return;
        storageKey.current = `omb-task-board-layout:${environment.environmentId}`;
        try {
          const saved = parseLayout(localStorage.getItem(storageKey.current));
          setNames(saved.names ?? {});
          setBoxes(resolveBoxes(saved.boxes));
          if (saved.view) setView(saved.view);
        } catch {
          /* Private browsing may disable storage; the board still works. */
        }
      })
      .catch(() => {
        /* An older companion can use the board without persistence. */
      });
    return () => {
      active = false;
    };
  }, []);

  const save = useCallback((layout: BoardLayout) => {
    if (!storageKey.current) return;
    try {
      localStorage.setItem(storageKey.current, JSON.stringify(layout));
    } catch {
      /* A full or disabled store must not stop someone arranging their board. */
    }
  }, []);

  const persist = useCallback(
    (nextBoxes: Record<WorkColumn, ColumnBox>, nextNames = names, nextView = view) => {
      save({ boxes: nextBoxes, names: nextNames, view: nextView });
    },
    [names, save, view],
  );

  /** While a column is being dragged it moves FREELY over the others.
   *
   * No neighbour is displaced here, and nothing is written to storage. A drag
   * is a person holding a column in their hand: the board rearranging itself
   * underneath the pointer is what made this feel like the other columns were
   * running away. The tidying happens once, on `commit`, after the drop. */
  const move = useCallback((column: WorkColumn, box: ColumnBox) => {
    setMoving(column);
    setBoxes((current) => ({ ...current, [column]: box }));
  }, []);

  /** The drop. This is where the board tidies: the column stays exactly where
   * it was put and anything it landed on is re-seated, then the result is
   * persisted. */
  const commit = useCallback(
    (column: WorkColumn, box: ColumnBox) => {
      setMoving(null);
      setBoxes((current) => {
        const viewport = viewportRef.current;
        const kept = viewport
          ? keepOnScreen(box, { width: viewport.clientWidth, height: viewport.clientHeight }, view)
          : box;
        const next = settleInto(column, kept, current);
        persist(next);
        return next;
      });
    },
    [persist, view],
  );

  /** Growing a column is free while the edge is held, for the same reason a
   * move is: the board rearranging itself under the pointer is the thing that
   * made dragging feel unpredictable. */
  const resize = useCallback((column: WorkColumn, box: ColumnBox) => {
    setBoxes((current) => ({ ...current, [column]: box }));
  }, []);

  /** Letting go of a resize settles the board, exactly as letting go of a
   * column does — a column grown into its neighbour pushes it aside once,
   * rather than continuously while the edge is dragged. */
  const commitResize = useCallback(
    (column: WorkColumn, box: ColumnBox) => {
      setBoxes((current) => {
        const next = settleInto(column, box, current);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const rename = useCallback(
    (column: WorkColumn, name: string | null) => {
      setNames((current) => {
        const next = { ...current };
        if (name) next[column] = name;
        else delete next[column];
        persist(boxes, next);
        return next;
      });
    },
    [boxes, persist],
  );

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const bounds = contentBounds(boxes);
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const padding = 32;
    const scale = clamp(
      Math.min(
        (viewport.clientWidth - padding * 2) / bounds.width,
        (viewport.clientHeight - padding * 2) / bounds.height,
      ),
      MIN_ZOOM,
      1,
    );
    setView({
      x: padding - bounds.left * scale,
      y: padding - bounds.top * scale,
      scale,
    });
  }, [boxes]);

  // Centre the board on first paint, once the saved layout has arrived.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current) return;
    fitted.current = true;
    const timer = window.setTimeout(fit, 60);
    return () => window.clearTimeout(timer);
  }, [fit]);

  /** Wheel: Ctrl/Cmd zooms about the cursor, plain wheel pans. Matching the
   * Team map means the gesture people have learned there works here.
   *
   * A wheel that lands on a column's own card list is left alone, because that
   * list scrolls and the event would otherwise bubble up and pan the board
   * instead — so scrolling a long column dragged the whole arrangement out
   * from under the pointer. The list is only given the event when it actually
   * has somewhere to scroll; at its ends the pan resumes, which is what keeps
   * a short column from swallowing the gesture. */
  const onWheel = (event: React.WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) {
      // Anywhere inside a column that has a scrollable card list keeps the
      // wheel to itself. The attribute is on the column, not only on the list,
      // because a wheel over the column's header or padding is still a gesture
      // aimed at that column — and panning the board from there was the same
      // bug in a slightly different place.
      const column = (event.target as HTMLElement).closest<HTMLElement>("[data-column]");
      const list = column?.querySelector<HTMLElement>("[data-card-list]");
      if (list && list.scrollHeight > list.clientHeight) {
        const atTop = list.scrollTop <= 0 && event.deltaY < 0;
        const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1 && event.deltaY > 0;
        // At either end the column has nothing left to show, so the gesture
        // falls through to the board and the pan still works from here.
        //
        // Returning is enough. The browser performs the list's own scroll
        // regardless of a wheel event being handled, and this listener sits on
        // the viewport that contains the column, so there is no outer listener
        // for the event to reach.
        if (!atTop && !atBottom) return;
      }
    }
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const pointX = event.clientX - rect.left;
      const pointY = event.clientY - rect.top;
      const next = clamp(view.scale * (event.deltaY < 0 ? 1.1 : 0.9), MIN_ZOOM, MAX_ZOOM);
      // Keep the point under the cursor fixed while the scale changes.
      const ratio = next / view.scale;
      setView({
        scale: next,
        x: pointX - (pointX - view.x) * ratio,
        y: pointY - (pointY - view.y) * ratio,
      });
      return;
    }
    setView((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
  };

  /** Dragging empty canvas pans it. The columns handle their own drags and
   * stop propagation, so this only ever sees the background. */
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("[data-column]")) return;
    pan.current = { startX: event.clientX, startY: event.clientY, view: { x: view.x, y: view.y } };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const active = pan.current;
    if (!active) return;
    setView((current) => ({
      ...current,
      x: active.view.x + (event.clientX - active.startX),
      y: active.view.y + (event.clientY - active.startY),
    }));
  };

  const onPointerUp = (event: React.PointerEvent) => {
    if (!pan.current) return;
    pan.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    persist(boxes, names, view);
  };

  const zoomBy = (factor: number) => {
    setView((current) => ({ ...current, scale: clamp(current.scale * factor, MIN_ZOOM, MAX_ZOOM) }));
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={viewportRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="relative h-full w-full touch-none overflow-hidden outline-none"
        style={{
          backgroundImage:
            "radial-gradient(circle, color-mix(in srgb, var(--color-ink-secondary) 16%, transparent) 1px, transparent 1px)",
          backgroundSize: `${24 * view.scale}px ${24 * view.scale}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          {children(boxes, { move, commit, resize, commitResize, rename, names, moving })}
        </div>
      </div>

      {/* The canvas' own controls, floating over it rather than in the header:
          zoom belongs to the surface you are zooming. */}
      <div className="absolute bottom-4 right-4 z-20 flex items-center gap-1 rounded-xl border border-hairline/60 bg-panel p-1 shadow-sm">
        <button
          type="button"
          onClick={() => zoomBy(0.9)}
          aria-label={t("taskBoard.canvas.zoomOut")}
          title={t("taskBoard.canvas.zoomOut")}
          className="flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          onClick={fit}
          aria-label={t("taskBoard.canvas.fit")}
          title={t("taskBoard.canvas.fit")}
          className="flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <Maximize2 size={14} />
        </button>
        <button
          type="button"
          onClick={() => zoomBy(1.1)}
          aria-label={t("taskBoard.canvas.zoomIn")}
          title={t("taskBoard.canvas.zoomIn")}
          className="flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}