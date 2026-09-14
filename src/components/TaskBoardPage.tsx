// The task board.
//
// A board of work, one agent per card, started and stopped by hand. It is a
// view over records the server owns — nothing here is the source of truth for
// what a bot is doing, and nothing here runs a turn of its own. Every action
// calls a route the chat already uses, so the board cannot drift into being a
// second, subtly different way to run an agent.
//
// The Teams switcher filters cards AND the agent list together. A person
// looking at one team must not be able to assign a card to a bot from another
// one, so the same section key answers both questions.
import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { ArrowLeft, CalendarDays, Columns3, LayoutGrid, Plus, RefreshCw, Trash2, X } from "lucide-react";

import { BoardCanvas } from "./BoardCanvas";
import { BoardDayPicker } from "./BoardDayPicker";
import { TaskBoardColumn } from "./TaskBoardColumn";
import { CARD_DRAG_TYPE } from "./TaskBoardCard";
import { CardEditorDialog, type CardDraft } from "./CardEditorDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { columnTitle } from "@/lib/board-layout";
import { startOfDay } from "@/lib/routine-calendar";
import {
  WORK_COLUMNS,
  columnsOf,
  dayLabel,
  dropPatch,
  filterByDay,
  filterByTeam,
  isPastDay,
  placeIn,
  type BoardCard,
  type WorkColumn,
} from "@/lib/task-board";
import { cn } from "@/lib/cn";

/** Read at render, not at import: a module-level lookup would freeze the
 * labels in whatever language was active when the file was first loaded. */
function columnLabel(status: WorkColumn): string {
  switch (status) {
    case "backlog":
      return t("taskBoard.column.backlog");
    case "todo":
      return t("taskBoard.column.todo");
    case "in_progress":
      return t("taskBoard.column.in_progress");
    case "blocked":
      return t("taskBoard.column.blocked");
    case "done":
      return t("taskBoard.column.done");
    case "cancelled":
      return t("taskBoard.column.cancelled");
  }
}

/** The shortest gap a drop may write. Past this, halving again would produce
 * orders so close together that a double-precision comparison stops telling
 * neighbours apart, so the column is renumbered instead. */
const MIN_ORDER_GAP = 1e-6;

/** What the board shows before anyone has put a card on it.
 *
 * "No cards yet" plus a sentence is a dead end — it names the absence without
 * showing what the thing is. This draws a small, unmistakably-not-real board
 * (a card sitting in a column) beside the one action worth taking from here,
 * so the empty screen says what a board is for and how to start one. */
function BoardEmptyState({ onCreate }: { onCreate: () => void }) {
  const preview: Array<{ title: string; width: string; delay: string }> = [
    { title: t("taskBoard.empty.sample1"), width: "w-[78%]", delay: "0ms" },
    { title: t("taskBoard.empty.sample2"), width: "w-[62%]", delay: "120ms" },
    { title: t("taskBoard.empty.sample3"), width: "w-[70%]", delay: "240ms" },
  ];
  return (
    <div className="flex flex-col items-center py-10 text-center">
      {/* aria-hidden: this is a picture of a board, not a board. A screen
          reader should get the heading and the button, nothing else. */}
      <div
        aria-hidden="true"
        className="animate-pop-in relative w-full max-w-[420px] rounded-2xl border border-hairline/40 bg-panel/60 p-3"
      >
        <div className="mb-2 flex items-center gap-2 px-1">
          <LayoutGrid size={13} className="text-accent" />
          <span className="h-1.5 w-16 rounded-full bg-ink-secondary/25" />
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div className="rounded-xl border border-hairline/40 bg-card/70 p-2.5">
            <span className="mb-2 block h-1.5 w-10 rounded-full bg-ink-secondary/25" />
            <div className="space-y-1.5">
              {preview.map((row) => (
                <div
                  key={row.title}
                  style={{ animationDelay: row.delay }}
                  className="animate-rise rounded-lg border border-hairline/40 bg-card px-2.5 py-2 text-left"
                >
                  <span className="block truncate text-[11px] font-medium text-ink-secondary/85">{row.title}</span>
                  <span className={cn("mt-1.5 block h-1 rounded-full bg-ink-secondary/15", row.width)} />
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-dashed border-hairline/40 bg-card/30 p-2.5">
            <span className="mb-2 block h-1.5 w-8 rounded-full bg-ink-secondary/20" />
            <div className="flex h-[calc(100%-1.25rem)] items-center justify-center">
              <Plus size={16} className="text-ink-secondary/35" />
            </div>
          </div>
        </div>
      </div>

      <h2 className="mt-6 text-[15px] font-semibold text-ink">{t("taskBoard.empty.title")}</h2>
      <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-ink-secondary">
        {t("taskBoard.empty.body")}
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-4 flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2.5 text-[12.5px] font-semibold text-white transition hover:bg-accent/90"
      >
        <Plus size={14} />
        {t("taskBoard.empty.cta")}
      </button>
    </div>
  );
}

/** The board has cards, but none on the day being looked at.
 *
 * This is not the empty board, and must not read like one: a person with a
 * dozen cards being told to "create your first" would reasonably conclude the
 * board had lost them. So it says which day is empty and offers the one thing
 * worth doing from an empty day — putting something on it.
 *
 * The day is always a real day, so there is no "show everything" escape to
 * offer here. Reaching another day is the switcher's job, one line up. */
function BoardFilteredEmpty({
  day,
  now,
  team,
  teams,
  readOnly,
  onCreate,
}: {
  day: number;
  now: number;
  team: string | null;
  teams: Array<{ key: string; name: string }>;
  readOnly: boolean;
  onCreate: () => void;
}) {
  const teamName = team === null ? null : teams.find((entry) => entry.key === team)?.name ?? t("taskBoard.team.all");
  return (
    <div className="flex flex-col items-center py-14 text-center">
      <CalendarDays size={22} className="text-ink-secondary/40" />
      <h2 className="mt-3 text-[14px] font-semibold text-ink">{t("taskBoard.filtered.title")}</h2>
      <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-ink-secondary">
        {teamName
          ? t("taskBoard.filtered.bodyBoth", { day: dayLabel(day, now), team: teamName })
          : t("taskBoard.filtered.bodyDay", { day: dayLabel(day, now) })}
      </p>
      {/* No "add one" on a day that has passed — the banner above already
          says the day is read-only, and offering the button would contradict
          it. A past day with nothing on it simply had nothing on it. */}
      {!readOnly && (
        <button
          type="button"
          onClick={onCreate}
          className="mt-4 flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-semibold text-white transition hover:bg-accent/90"
        >
          <Plus size={14} />
          {t("taskBoard.newCard")}
        </button>
      )}
    </div>
  );
}

/** The board's own loading state: the shape of what is coming, rather than a
 * line of text where six columns will be. */
function BoardSkeleton() {
  return (
    <div aria-busy="true" aria-label={t("taskBoard.loading")} className="@container">
      <div className="grid grid-cols-1 items-start gap-3 @md:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-6">
        {WORK_COLUMNS.map((status) => (
          <div key={status} className="rounded-2xl border border-hairline/40 bg-panel/60 p-2.5">
            <div className="mb-2 flex items-center justify-between px-1.5">
              <span className="h-1.5 w-14 rounded-full bg-ink-secondary/20" />
              <span className="h-1.5 w-3 rounded-full bg-ink-secondary/15" />
            </div>
            <div className="animate-pulse space-y-2">
              <div className="h-[74px] rounded-xl border border-hairline/40 bg-card/60" />
              <div className="h-[74px] rounded-xl border border-hairline/40 bg-card/40" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TaskBoardPage({ onBack }: { onBack?: () => void } = {}) {
  const { state, dispatch } = useStore();
  const bots = state.bots;

  const [cards, setCards] = useState<BoardCard[]>([]);
  const [teams, setTeams] = useState<Array<{ key: string; name: string }>>([]);
  const [team, setTeam] = useState<string | null>(null);
  /** The day the board opens on, and the selection it always has.
   *
   * It starts on TODAY rather than "everything" because a card with no date of
   * its own belongs to the day it was made — so on a board nobody has dated by
   * hand, every card is today's, and starting on "everything" would make the
   * whole control appear inert. A day is always selected; there is no "all
   * days" state, because every card is reachable through the calendar behind
   * the Day label. */
  const [day, setDay] = useState(() => startOfDay(Date.now()));
  /** The moment the current render is judged against, refreshed with the
   * board so "Today" and the overdue chips cannot go stale on a tab left open
   * across midnight. It is only ever replaced by a newer board fetch, so it
   * cannot drift away from the cards it is describing. */
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** The card the editor is open on, or `"new"` when making one. `null` is
   * closed — three states, because "editing nothing" and "creating" are not
   * the same dialog. */
  const [editorTarget, setEditorTarget] = useState<BoardCard | "new" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BoardCard | null>(null);

  const refresh = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      // The server answers the team split, so the switcher's counts come from
      // the same rule that filtered the cards rather than a client recount.
      const [board, roster] = await Promise.all([
        api("/api/task-board"),
        api("/api/task-board/teams"),
      ]);
      setCards(board.items ?? []);
      setTeams(roster.teams ?? []);
      setNow(Date.now());
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  /** Whether the day on screen has already passed. Shown for reference, and not
   * changeable: the work on a finished day is a record of what happened, and
   * moving a card out of it would rewrite that. */
  const readOnly = useMemo(() => isPastDay(day, now), [day, now]);

  /** Day first, then team. The two filters are independent, and applying the
   * day first is what makes the team chips' counts describe the board that is
   * actually on screen rather than a board the viewer cannot see. */
  const visibleByDay = useMemo(() => filterByDay(cards, day), [cards, day]);
  const visible = useMemo(() => filterByTeam(visibleByDay, team), [visibleByDay, team]);

  /** Bots a card may be assigned to, filtered by the SAME team the cards are.
   * Assignment is the other half of the switcher, so it answers to the same
   * choice: one team on screen means one team in the picker. */
  const assignable = useMemo(() => {
    if (team === null) return bots;
    return bots.filter((bot) => (bot.section?.trim() ?? "") === team);
  }, [bots, team]);

  const columns = useMemo(() => columnsOf(visible), [visible]);

  /** The editor's bot list and its cancel handler are memoized so the dialog
   * is not handed new props on every board poll. A fresh `onCancel` each
   * render is what used to re-run the dialog's focus effect mid-typing and
   * drag the caret back to the title. */
  const assignableOptions = useMemo(
    () => assignable.map((bot) => ({
      id: bot.id,
      name: bot.name,
      subtitle: bot.section?.trim() || null,
      // Carried through so the picker draws each bot's own mascot rather than
      // the default colour.
      color: bot.color ?? null,
      mascotBody: bot.mascotBody ?? null,
      mascotExpression: bot.mascotExpression ?? null,
    })),
    [assignable],
  );

  const closeEditor = useCallback(() => setEditorTarget(null), []);

  const botById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);

  const fail = useCallback((requestError: unknown) => {
    setError(
      requestError instanceof Error && requestError.message
        ? requestError.message
        : t("taskBoard.actionError"),
    );
    void refresh();
  }, [refresh]);

  const run = useCallback(async (card: BoardCard) => {
    setRunningIds((ids) => new Set(ids).add(card.id));
    setError(null);
    try {
      await api(`/api/task-board/items/${card.id}/run`, { method: "POST" });
    } catch (requestError) {
      // The refusal is already recorded on the card by the server; reload so
      // the reason the person just earned is what they see.
      fail(requestError);
    } finally {
      setRunningIds((ids) => {
        const next = new Set(ids);
        next.delete(card.id);
        return next;
      });
      void refresh();
    }
  }, [fail, refresh]);

  const stop = useCallback(async (card: BoardCard) => {
    try {
      await api(`/api/task-board/items/${card.id}/stop`, { method: "POST" });
    } catch (requestError) {
      fail(requestError);
    } finally {
      void refresh();
    }
  }, [fail, refresh]);

  /** Deleting is confirmed in the app's own dialog, not the browser's. The
   * bot's chat is kept — deleting a card is deleting the reminder, not the
   * conversation, and the dialog says so before anything happens. */
  const confirmDelete = useCallback(async () => {
    const card = pendingDelete;
    setPendingDelete(null);
    if (!card) return;
    try {
      await api(`/api/task-board/items/${card.id}`, { method: "DELETE" });
    } catch (requestError) {
      fail(requestError);
    } finally {
      void refresh();
    }
  }, [fail, pendingDelete, refresh]);

  const openChat = useCallback((card: BoardCard) => {
    if (!card.ownerBotId) return;
    dispatch({ type: "select", id: card.ownerBotId });
  }, [dispatch]);

  /** One submit for both halves of the editor: a new card is a POST, an
   * edited one is a PATCH, and the only difference is which route and which
   * fields the server already has. */
  const saveCard = useCallback(async (draft: CardDraft) => {
    const target = editorTarget;
    const body = {
      title: draft.title,
      brief: draft.brief,
      // Sent explicitly on both routes so clearing the bot is a real edit
      // rather than a field the PATCH quietly ignores.
      ownerBotId: draft.ownerBotId,
      // Same rule for the two dates: an empty field arrives as `null` and has
      // to travel as `null`, or clearing a date in the editor would leave it
      // on the card while the box looked empty.
      day: draft.day,
      dueAt: draft.dueAt,
    };
    try {
      if (target === "new") {
        await api("/api/task-board/items", { method: "POST", body: JSON.stringify(body) });
      } else if (target) {
        await api(`/api/task-board/items/${target.id}`, { method: "PATCH", body: JSON.stringify(body) });
      }
      setEditorTarget(null);
    } catch (requestError) {
      // The dialog stays open on a failure, with the person's words still in
      // it. Rethrown so the dialog knows the save did not happen and keeps
      // itself open rather than closing over a card that was never written.
      fail(requestError);
      throw requestError;
    } finally {
      void refresh();
    }
  }, [editorTarget, fail, refresh]);

  const handleDragStart = useCallback((card: BoardCard, event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData(CARD_DRAG_TYPE, card.id);
    event.dataTransfer.effectAllowed = "move";
    setDraggingId(card.id);
  }, []);

  /** Move a card to where it was dropped.
   *
   * Only the order (and, when it crossed columns, the status) is written. The
   * card is never started by this: dragging is arrangement, not execution. */
  const handleDrop = useCallback(async (status: WorkColumn, cardId: string, beforeId: string | null) => {
    // Clear the drag mark here as well as on the drop source's own `dragend`.
    // A card that lands in a DIFFERENT column is unmounted from where the
    // drag started, so that node's `dragend` never fires and the card stayed
    // dimmed until something else re-rendered it. This is the one place every
    // completed drop passes through, whatever the browser did with the source.
    setDraggingId(null);
    const column = columns[status];
    const moved = column.find((card) => card.id === cardId) ?? cards.find((card) => card.id === cardId);
    if (!moved) return;

    // dropPatch reads the TARGET column, which does not contain a card that
    // arrived from another column — so a cross-column drop computes its own
    // place among the cards already there, and a reorder within one column
    // uses dropPatch directly.
    const patch = dropPatch(column, cardId, beforeId)
      ?? (moved.status !== status ? { order: placeIn(column, beforeId) } : null);
    const crossed = moved.status !== status;
    if (!patch && !crossed) return;

    // Halving between two neighbours eventually runs out of precision, and
    // two cards whose orders are that close sort unpredictably. Past that
    // point the drop lands at the end of the column instead, where the next
    // drag has room again.
    const tooClose = patch !== null && Math.abs(patch.order - moved.order) < MIN_ORDER_GAP;
    const order = tooClose ? (column[column.length - 1]?.order ?? 0) + 1 : patch?.order;

    try {
      await api(`/api/task-board/items/${cardId}`, {
        method: "PATCH",
        body: JSON.stringify({
          status,
          ...(order !== undefined ? { order } : {}),
        }),
      });
    } catch (requestError) {
      fail(requestError);
    } finally {
      void refresh();
    }
  }, [cards, columns, fail, refresh]);

  const dragEnd = useCallback(() => setDraggingId(null), []);

  /** A drag abandoned outside the board — dropped on the sidebar, or cancelled
   * with Escape — fires no drop and, on some browsers, no `dragend` on the
   * source either. Without this the card stayed dimmed with nothing to clear
   * it. `pointerup` on the window covers every way a drag can end without a
   * drop landing. */
  useEffect(() => {
    if (draggingId === null) return;
    const clear = () => setDraggingId(null);
    window.addEventListener("pointerup", clear);
    window.addEventListener("dragend", clear);
    return () => {
      window.removeEventListener("pointerup", clear);
      window.removeEventListener("dragend", clear);
    };
  }, [draggingId]);

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-hairline/40 px-7 py-5">
        <div className="flex min-w-0 items-start gap-3">
          {/* The board owns the whole window, so it draws the way back itself
              — the sidebar that used to sit here is gone. */}
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={t("taskBoard.back")}
              title={t("taskBoard.back")}
              className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-secondary transition hover:bg-raised hover:text-ink"
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <Columns3 size={20} className="shrink-0 text-accent" />
              <h1 className="text-[18px] font-semibold">{t("taskBoard.title")}</h1>
            </div>
            <p className="mt-1 max-w-2xl text-[12.5px] text-ink-secondary max-md:hidden">{t("taskBoard.subtitle")}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setEditorTarget("new")}
            disabled={readOnly}
            title={readOnly ? t("taskBoard.day.readOnly") : undefined}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-semibold text-white transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Plus size={14} />
            {t("taskBoard.newCard")}
          </button>
          <button
            type="button"
            onClick={() => void refresh(true)}
            disabled={loading}
            className="rounded-lg border border-hairline/50 bg-card p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
            aria-label={t("taskBoard.retry")}
            title={t("taskBoard.retry")}
          >
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </header>

      {/* The day switcher narrows the board before the team switcher does, so
          both the cards and the counts below describe the day on screen. */}
      <div className="shrink-0 border-b border-hairline/30 px-7 py-2.5">
        <BoardDayPicker cards={cards} value={day} onChange={setDay} now={now} />
      </div>

      {/* A past day looks like a board that has stopped responding unless it
          says why, so the reason is stated rather than left to be inferred
          from missing buttons. */}
      {readOnly && (
        <div className="shrink-0 border-b border-hairline/30 bg-ink-secondary/5 px-7 py-2 text-[11.5px] text-ink-secondary">
          {t("taskBoard.day.readOnly")}
        </div>
      )}

      {/* The team switcher filters the cards and the agent picker together, so
          a card can never be handed to a bot the current team cannot see. */}
      <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-hairline/30 px-7 py-2.5">
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          {t("taskBoard.team.label")}
        </span>
        <button
          type="button"
          onClick={() => setTeam(null)}
          className={cn(
            "shrink-0 rounded-lg px-2.5 py-1 text-[12px] font-medium transition",
            team === null ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink",
          )}
        >
          {t("taskBoard.team.all")}
        </button>
        {teams.map((entry) => (
          <button
            key={entry.key || "__general__"}
            type="button"
            onClick={() => setTeam(entry.key)}
            className={cn(
              "shrink-0 rounded-lg px-2.5 py-1 text-[12px] font-medium transition",
              team === entry.key ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink",
            )}
          >
            {entry.name}
          </button>
        ))}
      </div>

      {/* The canvas fills the pane and pans itself, so it must not sit inside
          a scrolling box — a scroll container and a pan gesture fight over
          the same wheel events. The loading and empty states still want
          padding, so they keep their own wrapper below. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {error && (
          <div className="mx-5 mt-4 flex items-start justify-between gap-3 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger sm:mx-7">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label={t("taskBoard.retry")}>
              <X size={13} />
            </button>
          </div>
        )}

        {loading && cards.length === 0 ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
            <BoardSkeleton />
          </div>
        ) : visible.length === 0 && cards.length > 0 ? (
          /* A board that has cards but none on THIS day is not an empty board,
             and telling someone to "create your first card" when they already
             have a dozen would read as the board having lost them. */
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
            <BoardFilteredEmpty
              day={day}
              now={now}
              team={team}
              teams={teams}
              readOnly={readOnly}
              onCreate={() => setEditorTarget("new")}
            />
          </div>
        ) : visible.length === 0 ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
            <BoardEmptyState onCreate={() => setEditorTarget("new")} />
          </div>
        ) : (
          /* The board's columns live on a canvas: each one is a window the viewer can
             move and resize, and the arrangement is remembered in this browser.
             The canvas refuses a drop that would land one column on another —
             a board is read at a glance, and a column half-hidden under its
             neighbour is work nobody sees. */
          <BoardCanvas>
            {(boxes, canvas) => (
              <>
                {WORK_COLUMNS.map((status) => (
                  <TaskBoardColumn
                    key={status}
                    column={status}
                    title={columnTitle(status, canvas.names, columnLabel)}
                    fallbackTitle={columnLabel(status)}
                    renamed={Boolean(canvas.names[status])}
                    count={columns[status].length}
                    box={boxes[status]}
                    cards={columns[status]}
                    moving={canvas.moving === status}
                    onMove={canvas.move}
                    onCommit={canvas.commit}
                    onResize={canvas.resize}
                    onResizeCommit={canvas.commitResize}
                    onRename={canvas.rename}
                    readOnly={readOnly}
                    onDrop={(cardId, beforeId) => void handleDrop(status, cardId, beforeId)}
                    renderCard={(card) => ({
                      bot: card.ownerBotId ? botById.get(card.ownerBotId) ?? null : null,
                      agent: card.agent,
                      running: runningIds.has(card.id),
                      onRun: (target) => void run(target),
                      onStop: (target) => void stop(target),
                      onEdit: (target) => setEditorTarget(target),
                      onDelete: (target) => setPendingDelete(target),
                      onOpenChat: openChat,
                      onDragStart: handleDragStart,
                      onDragEnd: dragEnd,
                      dragging: draggingId === card.id,
                    })}
                  />
                ))}
              </>
            )}
          </BoardCanvas>
        )}
      </div>

      <CardEditorDialog
        open={editorTarget !== null}
        card={editorTarget && editorTarget !== "new" ? editorTarget : null}
        bots={assignableOptions}
        // A card made while a day is selected belongs to that day. Otherwise
        // it would be created on today, filtered straight out of the view that
        // made it, and appear to have not been created at all.
        //
        // Not on a past day: nobody is putting work on yesterday from this
        // screen, and the read-only banner has already explained why. Such a
        // card takes today, which is where a new card belongs.
        defaultDay={readOnly ? undefined : day}
        onCancel={closeEditor}
        onSubmit={saveCard}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("taskBoard.delete.title")}
        body={t("taskBoard.delete.confirm")}
        confirmLabel={t("taskBoard.delete.confirmAction")}
        tone="danger"
        icon={<Trash2 size={18} />}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
    </main>
  );
}