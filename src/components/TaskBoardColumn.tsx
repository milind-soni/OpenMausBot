// One column of the board: a positioned, resizable window onto a status, and
// the drop target for cards dragged onto it.
//
// Dropping a card moves it; it never starts it. That is the whole reason this
// component exists separately from the card: an agent that began working the
// moment a card was dragged into "In progress" would be work nobody asked for,
// triggered by a gesture that can happen by accident.
//
// A drop writes the same PATCH any other edit writes. The new order is one
// number placed between its neighbours, so the rest of the column is not
// renumbered and two people dragging at once do not fight over a whole list.
//
// The column is placed by the canvas rather than by a grid, so it is given an
// absolute box. Two gestures live here and they are deliberately different:
// dragging the column's HEADER moves the window, dragging the card area moves
// CARDS. Nothing moves a card by grabbing the column, which is what stops an
// accidental drag from rearranging work.
import { useEffect, useRef, useState, type DragEvent } from "react";
import { Check, Pencil, RotateCcw, X } from "lucide-react";

import { TaskBoardCardView } from "./TaskBoardCard";
import { CARD_DRAG_TYPE, type TaskBoardCardProps } from "./TaskBoardCard";
import { t } from "@/lib/i18n";
import type { BoardCard, WorkColumn } from "@/lib/task-board";
import { cn } from "@/lib/cn";
import {
  resizeBox,
  type ColumnBox,
  type ResizeEdge,
} from "@/lib/board-layout";

export interface TaskBoardColumnProps {
  column: WorkColumn;
  title: string;
  /** The app's own label for this column, so a custom name can be reset back
   * to it. Passed in because the column does not know what it would be called
   * if nobody had renamed it. */
  fallbackTitle: string;
  /** Whether the viewer renamed this column, which is what decides if the
   * reset control is offered at all. */
  renamed?: boolean;
  /** Shown in the header. Passed in rather than counted here, because the
   * header must agree with the list the page actually handed over — including
   * when a card arrives from another column mid-render. */
  count: number;
  box: ColumnBox;
  cards: BoardCard[];
  renderCard: (card: BoardCard) => Omit<TaskBoardCardProps, "card">;
  onDrop: (cardId: string, beforeId: string | null) => void;
  /** Move the column. The canvas decides whether the drop is allowed, so this
   * is a request, not a commit. */
  /** Move the column while it is held. Nothing else on the board moves. */
  onMove: (column: WorkColumn, box: ColumnBox) => void;
  /** Put it down. The board tidies here, and only here. */
  onCommit: (column: WorkColumn, box: ColumnBox) => void;
  /** Grow the column while its edge is held. */
  onResize: (column: WorkColumn, box: ColumnBox) => void;
  /** Finish a resize, which also settles the board. */
  onResizeCommit: (column: WorkColumn, box: ColumnBox) => void;
  onRename: (column: WorkColumn, name: string | null) => void;
  /** True while this column is the one being dragged, so the canvas can lift
   * it and the column can dim itself. */
  moving?: boolean;
  /** A past day. The work on it is shown for reference and cannot be changed:
   * drops are refused, cards are not draggable, and the buttons that would run
   * or move something are gone. Reading history is the whole point of looking
   * at a day that has already happened. */
  readOnly?: boolean;
}

/** How far a pointer must travel before it counts as a drag. A click on the
 * header is often the start of a rename, and a column that shifted a pixel
 * under every click would be infuriating to arrange. */
const DRAG_THRESHOLD = 4;

/** The edge handles, and which way each one grows the box. */
const HANDLES: Array<{ edge: ResizeEdge; className: string; cursor: string }> = [
  { edge: "left", className: "left-0 top-3 bottom-3 w-1.5", cursor: "ew-resize" },
  { edge: "right", className: "right-0 top-3 bottom-3 w-1.5", cursor: "ew-resize" },
  { edge: "top", className: "top-0 left-3 right-3 h-1.5", cursor: "ns-resize" },
  { edge: "bottom", className: "bottom-0 left-3 right-3 h-1.5", cursor: "ns-resize" },
  { edge: "corner", className: "bottom-0 right-0 size-3.5", cursor: "nwse-resize" },
];

export function TaskBoardColumn({
  column,
  title,
  fallbackTitle,
  renamed = false,
  count,
  box,
  cards,
  renderCard,
  onDrop,
  onMove,
  onCommit,
  onResize,
  onResizeCommit,
  onRename,
  moving = false,
  readOnly = false,
}: TaskBoardColumnProps) {
  const [over, setOver] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);
  const nameRef = useRef<HTMLInputElement>(null);
  const gesture = useRef<
    | { kind: "move"; startX: number; startY: number; box: ColumnBox; moved?: boolean; latest?: ColumnBox }
    | { kind: "resize"; edge: ResizeEdge; startX: number; startY: number; box: ColumnBox; moved?: boolean; latest?: ColumnBox }
    | null
  >(null);

  /** Whether a drag carries one of THIS board's cards. A sidebar folder uses
   * its own type, and must not be treated as a card just because it is being
   * dragged across the same window. */
  const accepts = (event: DragEvent<HTMLElement>) =>
    event.dataTransfer.types.includes(CARD_DRAG_TYPE);

  const handleOver = (event: DragEvent<HTMLElement>) => {
    // A past day refuses the drop at the hover stage, so the card shows it
    // cannot land here instead of travelling across the board and snapping
    // back with no explanation.
    if (readOnly || !accepts(event)) return;
    // Calling preventDefault is what marks this a valid drop target; without
    // it the browser rejects the drop and the card snaps back with no reason.
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setOver(true);
  };

  const handleDrop = (event: DragEvent<HTMLElement>, beforeId: string | null) => {
    if (readOnly || !accepts(event)) return;
    event.preventDefault();
    setOver(false);
    const cardId = event.dataTransfer.getData(CARD_DRAG_TYPE);
    if (cardId) onDrop(cardId, beforeId);
  };

  /** Focus and select the whole name when renaming starts, the way renaming
   * anywhere else in the app does. */
  useEffect(() => {
    if (!renaming) return;
    nameRef.current?.focus();
    nameRef.current?.select();
  }, [renaming]);

  const beginRename = () => {
    setDraft(title);
    setRenaming(true);
  };

  const commitRename = () => {
    const next = draft.trim();
    setRenaming(false);
    // An empty name is not a name: it falls back to the app's label rather
    // than leaving the column nameless.
    onRename(column, next && next !== fallbackTitle ? next : null);
  };

  /** Put the app's own name back. Closing the editor too, since the reason to
   * press this is that the custom name was not wanted. */
  const resetRename = () => {
    setRenaming(false);
    onRename(column, null);
  };

  /** Pointer gestures for moving and resizing, so both share one shape and one
   * cancel path. */
  const startGesture = (
    event: React.PointerEvent,
    next: NonNullable<typeof gesture.current>,
  ) => {
    // A gesture that starts on a button is the button's, not the column's.
    if ((event.target as HTMLElement).closest("button, input, [draggable=true]")) return;
    if (event.button !== 0) return;
    gesture.current = next;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const active = gesture.current;
    if (!active) return;
    const dx = event.clientX - active.startX;
    const dy = event.clientY - active.startY;
    // A click on the header is a click, not a one-pixel move. Without this
    // threshold every attempt to rename a column would also shove it.
    if (!active.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    active.moved = true;
    if (active.kind === "move") {
      // Held in the hand: free movement over the others, nothing displaced.
      active.latest = { ...active.box, x: active.box.x + dx, y: active.box.y + dy };
      onMove(column, active.latest);
    } else {
      // The resize maths lives in the pure lib, so a dragged edge is testable
      // without a browser.
      active.latest = resizeBox(active.box, active.edge, dx, dy);
      onResize(column, active.latest);
    }
  };

  /** Let go. This is the only moment the board rearranges itself: the column
   * lands where it was held, and the canvas seats anything it covered. */
  const endGesture = (event: React.PointerEvent) => {
    const active = gesture.current;
    if (!active) return;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // A click that never travelled has nothing to commit.
    if (active.moved && active.latest) {
      if (active.kind === "move") onCommit(column, active.latest);
      else onResizeCommit(column, active.latest);
    }
  };

  const widthPx = Math.round(box.width);
  const heightPx = Math.round(box.height);

  return (
    <section
      onDragOver={handleOver}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => handleDrop(event, null)}
      style={{ left: box.x, top: box.y, width: widthPx, height: heightPx }}
      className={cn(
        // The Team map's tile language: a panel surface, a hairline, a soft
        // shadow, and the accent only when something is happening to it.
        "absolute flex flex-col rounded-2xl border bg-panel/90 shadow-sm transition-colors group/column",
        over ? "border-accent/50 bg-accent/5" : "border-hairline/50",
        // A dragged column floats ABOVE the others. No ring around it: the
        // Team map draws no outline on a tile it is moving, and a focus ring
        // in this app means "the keyboard is here", which is a different
        // thing from "this is in your hand".
        moving && "z-30 shadow-xl shadow-black/40",
      )}
      aria-label={title}
      data-column={column}
    >
      {/* Header. This is the move handle: a column is rearranged by its title,
          never by the cards inside it. */}
      <header
        onPointerDown={(event) =>
          startGesture(event, { kind: "move", startX: event.clientX, startY: event.clientY, box })
        }
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        className="flex h-11 shrink-0 cursor-grab touch-none items-center justify-between gap-2 px-3 active:cursor-grabbing"
      >
        {renaming ? (
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <input
              ref={nameRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setRenaming(false);
                }
              }}
              maxLength={40}
              aria-label={t("taskBoard.column.renameField")}
              className="min-w-0 flex-1 rounded-md border border-accent/50 bg-card px-1.5 py-1 text-[12px] font-semibold text-ink outline-none"
            />
            <button
              type="button"
              onClick={commitRename}
              aria-label={t("taskBoard.column.renameSave")}
              className="rounded-md p-1 text-accent hover:bg-raised"
            >
              <Check size={13} />
            </button>
            <button
              type="button"
              onClick={() => setRenaming(false)}
              aria-label={t("taskBoard.column.renameCancel")}
              className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={13} />
            </button>
            {/* Only offered when the name is actually custom: a reset button
                that does nothing is worse than no button, and this is the one
                place a person is already thinking about the name. */}
            {renamed && (
              <button
                type="button"
                onClick={resetRename}
                aria-label={t("taskBoard.column.renameReset")}
                title={t("taskBoard.column.renameResetHint", { name: fallbackTitle })}
                className="rounded-md p-1 text-ink-secondary transition hover:bg-raised hover:text-warning"
              >
                <RotateCcw size={13} />
              </button>
            )}
          </span>
        ) : (
          <>
            {/* The title is the rename affordance: clicking it is the whole
                gesture, and the pencil appears on hover so the header stays
                calm. It is a real button, so keyboard users reach it too — a
                rename that only works on hover is a rename half the people
                cannot find.

                The button is only as wide as the name. A full-width hit area
                painted a highlight across the whole header, which read as
                "this column is selected" rather than "this word is a
                control"; hovering the empty space beside the name now does
                nothing. */}
            <span className="flex min-w-0 flex-1 items-center">
              <button
                type="button"
                onClick={beginRename}
                title={t("taskBoard.column.renameHint")}
                aria-label={t("taskBoard.column.rename", { name: title })}
                className="group/name flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition hover:bg-raised/70"
              >
                <span className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                  {title}
                </span>
                <Pencil
                  size={10}
                  className="shrink-0 text-ink-secondary/40 opacity-0 transition group-hover/name:opacity-100"
                  aria-hidden="true"
                />
              </button>
            </span>
            <span className="shrink-0 text-[10.5px] tabular-nums text-ink-secondary/70">{count}</span>
          </>
        )}
      </header>

      <div data-card-list className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
        {cards.length === 0 && (
          <p className="px-2 py-6 text-center text-[11px] text-ink-secondary/55">{t("taskBoard.emptyColumn")}</p>
        )}
        {cards.map((card, index) => (
          <div
            key={card.id}
            onDragOver={(event) => {
              if (!accepts(event)) return;
              // Dropping ON a card means "put it here", which is how a card
              // lands between two others instead of only at the end.
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
              event.stopPropagation();
              handleDrop(event, card.id);
            }}
          >
            <TaskBoardCardView card={card} {...renderCard(card)} appearIndex={index} readOnly={readOnly} />
          </div>
        ))}
      </div>

      {/* Resize edges. Each is a thin strip inside the column's own border so
          it never overlaps a neighbour's hit area. */}
      {HANDLES.map(({ edge, className, cursor }) => (
        <span
          key={edge}
          role="separator"
          aria-label={t("taskBoard.column.resize", { name: title })}
          onPointerDown={(event) =>
            startGesture(event, { kind: "resize", edge, startX: event.clientX, startY: event.clientY, box })
          }
          onPointerMove={onPointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
          style={{ cursor, touchAction: "none" }}
          className={cn("absolute z-10", className)}
        />
      ))}

      {/* The corner grip: the only visible hint that a column can be resized.
          A bare invisible edge is discoverable by accident at best, and this
          is the same diagonal-ridges idea as a textarea's grabber, so it reads
          as "drag me" without a label. It fades in on hover so a resting board
          stays calm. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-1 right-1 opacity-0 transition-opacity group-hover/column:opacity-100"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="text-ink-secondary/45">
          <path d="M9 1 1 9M9 5 5 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </span>
    </section>
  );
}