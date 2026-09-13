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
import { Columns3, Plus, RefreshCw, X } from "lucide-react";

import { TaskBoardColumn } from "./TaskBoardColumn";
import { CARD_DRAG_TYPE } from "./TaskBoardCard";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import {
  WORK_COLUMNS,
  columnsOf,
  dropPatch,
  filterByTeam,
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

export function TaskBoardPage() {
  const { state, dispatch } = useStore();
  const bots = state.bots;

  const [cards, setCards] = useState<BoardCard[]>([]);
  const [teams, setTeams] = useState<Array<{ key: string; name: string }>>([]);
  const [team, setTeam] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBrief, setDraftBrief] = useState("");
  const [draftAgent, setDraftAgent] = useState("");

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

  const visible = useMemo(() => filterByTeam(cards, team), [cards, team]);

  /** Bots a card may be assigned to, filtered by the SAME team the cards are.
   * Assignment is the other half of the switcher, so it answers to the same
   * choice: one team on screen means one team in the picker. */
  const assignable = useMemo(() => {
    if (team === null) return bots;
    return bots.filter((bot) => (bot.section?.trim() ?? "") === team);
  }, [bots, team]);

  const columns = useMemo(() => columnsOf(visible), [visible]);

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

  const remove = useCallback(async (card: BoardCard) => {
    // The bot's chat is kept — deleting a card is deleting the reminder, not
    // the conversation, and the copy says so before anything happens.
    if (!window.confirm(t("taskBoard.delete.confirm"))) return;
    try {
      await api(`/api/task-board/items/${card.id}`, { method: "DELETE" });
    } catch (requestError) {
      fail(requestError);
    } finally {
      void refresh();
    }
  }, [fail, refresh]);

  const openChat = useCallback((card: BoardCard) => {
    if (!card.ownerBotId) return;
    dispatch({ type: "select", id: card.ownerBotId });
  }, [dispatch]);

  const create = useCallback(async () => {
    const title = draftTitle.trim();
    if (!title) return;
    try {
      await api("/api/task-board/items", {
        method: "POST",
        body: JSON.stringify({
          title,
          ...(draftBrief.trim() ? { brief: draftBrief.trim() } : {}),
          ...(draftAgent ? { ownerBotId: draftAgent } : {}),
        }),
      });
      setDraftTitle("");
      setDraftBrief("");
      setDraftAgent("");
      setComposing(false);
    } catch (requestError) {
      fail(requestError);
    } finally {
      void refresh();
    }
  }, [draftAgent, draftBrief, draftTitle, fail, refresh]);

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
    const column = columns[status];
    const moved = column.find((card) => card.id === cardId) ?? cards.find((card) => card.id === cardId);
    if (!moved) return;

    const patch = dropPatch(column, cardId, beforeId);
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

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink">
      <header className="flex shrink-0 items-center justify-between border-b border-hairline/40 px-7 py-5 max-md:pl-12">
        <div>
          <div className="flex items-center gap-2.5">
            <Columns3 size={20} className="text-accent" />
            <h1 className="text-[18px] font-semibold">{t("taskBoard.title")}</h1>
          </div>
          <p className="mt-1 max-w-2xl text-[12.5px] text-ink-secondary">{t("taskBoard.subtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setComposing((open) => !open)}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-semibold text-white transition hover:bg-accent/90"
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

      {/* The team switcher filters the cards and the agent picker together, so
          a card can never be handed to a bot the current team cannot see. */}
      <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-hairline/30 px-7 py-2.5 max-md:pl-12">
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

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        {error && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label={t("taskBoard.retry")}>
              <X size={13} />
            </button>
          </div>
        )}

        {composing && (
          <div className="mb-5 rounded-2xl border border-hairline/50 bg-panel p-4">
            <input
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              placeholder={t("taskBoard.newCard.title")}
              className="w-full rounded-lg border border-hairline/50 bg-card px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/50"
              autoFocus
            />
            <textarea
              value={draftBrief}
              onChange={(event) => setDraftBrief(event.target.value)}
              placeholder={t("taskBoard.newCard.brief")}
              rows={2}
              className="mt-2 w-full resize-none rounded-lg border border-hairline/50 bg-card px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent/50"
            />
            <div className="mt-2 flex items-center gap-2">
              <select
                value={draftAgent}
                onChange={(event) => setDraftAgent(event.target.value)}
                className="rounded-lg border border-hairline/50 bg-card px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent/50"
              >
                <option value="">{t("taskBoard.newCard.agent")}</option>
                {assignable.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void create()}
                disabled={!draftTitle.trim()}
                className="rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-semibold text-white transition hover:bg-accent/90 disabled:opacity-45"
              >
                {t("taskBoard.newCard.submit")}
              </button>
              <button
                type="button"
                onClick={() => setComposing(false)}
                className="rounded-lg px-3 py-2 text-[12.5px] text-ink-secondary hover:text-ink"
              >
                {t("taskBoard.newCard.cancel")}
              </button>
            </div>
          </div>
        )}

        {loading && cards.length === 0 ? (
          <p className="py-10 text-center text-[12.5px] text-ink-secondary">{t("taskBoard.loading")}</p>
        ) : visible.length === 0 ? (
          <div className="py-14 text-center">
            <p className="text-[14px] font-semibold text-ink">{t("taskBoard.empty.title")}</p>
            <p className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-ink-secondary">
              {t("taskBoard.empty.body")}
            </p>
          </div>
        ) : (
          <div className="flex min-h-0 items-start gap-3">
            {WORK_COLUMNS.map((status) => (
              <TaskBoardColumn
                key={status}
                title={columnLabel(status)}
                cards={columns[status]}
                onDrop={(cardId, beforeId) => void handleDrop(status, cardId, beforeId)}
                renderCard={(card) => ({
                  bot: card.ownerBotId ? botById.get(card.ownerBotId) ?? null : null,
                  agent: card.agent,
                  running: runningIds.has(card.id),
                  onRun: (target) => void run(target),
                  onStop: (target) => void stop(target),
                  onDelete: (target) => void remove(target),
                  onOpenChat: openChat,
                  onDragStart: handleDragStart,
                  onDragEnd: dragEnd,
                  dragging: draggingId === card.id,
                })}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}