// One card on the board.
//
// A card is a record, not a live view of a turn: it says what the work is,
// who has it, and whether anything is happening right now. Everything it
// shows about the running turn comes from the bot the server reported beside
// it, so the board never keeps a second opinion about what a bot is doing.
//
// Two rules live in this file. A disabled button always says why — the person
// looking at the button is looking at the card, not at a chat. And a card
// never starts work by being dropped somewhere: the buttons are the only way,
// and they are deliberate.
import { CalendarClock, HelpCircle, Loader2, MessageCircle, Pencil, Play, Trash2, X } from "lucide-react";
import type { DragEvent } from "react";

import { BotAvatar } from "./Avatar";
import { BriefMarkdown } from "./BriefMarkdown";
import { formatElapsed } from "@/lib/working-time";
import { t } from "@/lib/i18n";
import {
  cardMark,
  cardSection,
  cardStatusLabel,
  elapsedLabel,
  isOverdue,
  runIsLive,
  runAvailability,
  statusTone,
  stopAvailability,
  type BoardAgent,
  type BoardCard,
} from "@/lib/task-board";
import { cn } from "@/lib/cn";

/** The drag type this board owns. A dedicated type keeps a card from being
 * confused with a sidebar folder, which drags in the same window. */
export const CARD_DRAG_TYPE = "application/x-openmausbot-task";

/** A deadline as a person reads it: the day, and the time only when it is not
 * midnight.
 *
 * A date field (`<input type="date">`) stores local midnight, so showing
 * "00:00" beside it would be a time nobody chose. A deadline that does carry a
 * time was set deliberately, so it is shown. */
function formatDue(at: number): string {
  const date = new Date(at);
  const when = date.toLocaleDateString([], { month: "short", day: "numeric" });
  return date.getHours() === 0 && date.getMinutes() === 0
    ? when
    : `${when} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

const toneClasses = {
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
  accent: "bg-accent/15 text-accent",
  idle: "bg-ink-secondary/15 text-ink-secondary",
} as const;

export interface TaskBoardCardProps {
  card: BoardCard;
  /** The bot as the app knows it, for the avatar. Absent when the assigned
   * bot was deleted, which the card reports as such rather than pretending.
   * `color` and `mascotBody` are part of the shape because BotAvatar draws
   * its mascot from them — a card that left them out showed the default
   * colour, so every bot on the board looked the same. */
  bot?: { id: string; name: string; color?: string | null; mascotBody?: string | null; mascotExpression?: string | null } | null;
  agent: BoardAgent | null | undefined;
  running: boolean;
  onRun: (card: BoardCard) => void;
  onStop: (card: BoardCard) => void;
  onEdit: (card: BoardCard) => void;
  onDelete: (card: BoardCard) => void;
  onOpenChat: (card: BoardCard) => void;
  onDragStart: (card: BoardCard, event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  dragging: boolean;
  /** Stagger for the board's entry animation, so a column fills top-down
   * instead of every card appearing at once. */
  appearIndex?: number;
  /** A card on a past day: shown for reference, with no way to change it. */
  readOnly?: boolean;
}

export function TaskBoardCardView({
  card,
  bot,
  agent,
  running,
  onRun,
  onStop,
  onEdit,
  onDelete,
  onOpenChat,
  onDragStart,
  onDragEnd,
  dragging,
  appearIndex = 0,
  readOnly = false,
}: TaskBoardCardProps) {
  // A live clock counts only while a turn is actually running. `startedAt` is
  // set when a card is put in a working column, which is a person arranging
  // the board — not work happening. Showing a timer for that made a card
  // nobody had started look like it had been running for hours.
  const liveRun = runIsLive({ ...card, agent }) && card.agent?.busy === true;
  const elapsed = liveRun
    ? elapsedLabel({ ...card, agent }, Date.now(), formatElapsed)
    : card.finishedAt !== undefined
      // A finished run still reports how long it took — that is a fact about
      // the past, not a clock.
      ? elapsedLabel({ ...card, agent }, Date.now(), formatElapsed)
      : null;
  const availability = runAvailability({ ...card, agent });
  const canStop = stopAvailability({ ...card, agent });
  const tone = statusTone({ ...card, agent });
  const mark = cardMark({ ...card, agent });
  const overdue = isOverdue(card, Date.now());

  return (
    <div
      draggable={!readOnly}
      onDragStart={(event) => !readOnly && onDragStart(card, event)}
      onDragEnd={onDragEnd}
      style={{ animationDelay: `${Math.min(appearIndex, 8) * 40}ms` }}
      className={cn(
        "animate-rise group relative rounded-xl border border-hairline/45 bg-card px-4 py-3 shadow-sm transition",
        // The Team map's hover, not the accent: a blue border on hover reads
        // as "this card is selected", which is a different thing. Here it
        // means only "the pointer is on this", so it stays neutral.
        dragging ? "opacity-50" : "hover:border-ink-secondary/40 hover:bg-raised/40",
      )}
    >
      {/* A rail, not a repaint: the card stays legible while the state is
          visible from across the board.

          An error used to get a red frame around the whole card as well.
          Removed: the status chip already says "Needs attention" and the
          reason sits in its own red box, so the frame only repeated them
          louder. The rail keeps the at-a-glance signal without outlining
          every failing card. */}
      {mark !== "none" && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-0 top-3 bottom-3 w-[2px] rounded-r-full",
            mark === "error" ? "bg-danger" : mark === "working" ? "bg-accent" : "bg-warning",
          )}
        />
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            {card.origin === "routine" && (
              <CalendarClock size={12} className="shrink-0 text-ink-secondary" aria-label={t("taskBoard.card.fromRoutine")} />
            )}
            <h3 className="truncate text-[13.5px] font-semibold text-ink" title={card.title}>
              {card.title}
            </h3>
          </div>
          {card.brief && (
            /* Clamped to two lines whatever the brief says, so a long one
               cannot stretch a card down the column. A brief worth reading in
               full is read in the editor. */
            <div className="mt-1 line-clamp-2 overflow-hidden">
              <BriefMarkdown text={card.brief} />
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
          {!readOnly && (
            <>
              <button
                type="button"
                onClick={() => onEdit(card)}
                className="rounded-md p-1 text-ink-secondary/60 transition hover:bg-raised hover:text-ink focus-visible:opacity-100"
                aria-label={t("taskBoard.edit.label")}
                title={t("taskBoard.edit.label")}
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                onClick={() => onDelete(card)}
                className="rounded-md p-1 text-ink-secondary/60 transition hover:bg-raised hover:text-danger focus-visible:opacity-100"
                aria-label={t("taskBoard.delete.label")}
                title={t("taskBoard.delete.label")}
              >
                <Trash2 size={13} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Why the work stopped stays on the card. A failure that only appears
          in a transcript nobody opened reads as a board that went quiet. */}
      {card.lastError && (
        <p className="mt-2 rounded-lg border border-danger/25 bg-danger/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-danger">
          {card.lastError}
        </p>
      )}

      {/* A bot standing still because it asked something is the one state a
          person must not miss, so it says so in words and offers the way to
          answer it. */}
      {mark === "question" && !card.lastError && (
        <button
          type="button"
          onClick={() => onOpenChat(card)}
          disabled={!card.threadId}
          className="mt-2 flex w-full items-center gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-left text-[11px] text-warning transition hover:bg-warning/15 disabled:cursor-not-allowed"
        >
          <HelpCircle size={12} className="shrink-0" />
          <span className="truncate">{t("taskBoard.card.waitingHint")}</span>
        </button>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {agent && bot ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <BotAvatar
              bot={{ ...bot, mascotExpression: bot.mascotExpression ?? undefined } as never}
              // Everywhere else in the app a bot that has just failed shows its
              // alert face, because `stateForBot` reads the last message's
              // activity. The card drew a plain resting face, so the one screen
              // whose whole job is "which work needs attention" was the one
              // place a failure did not show on the bot itself.
              state={cardMark({ ...card, agent }) === "error" ? "alerting" : undefined}
              size={20}
              motion="none"
              motionKey={0}
              animated={false}
            />
            <span className="truncate text-[11.5px] text-ink-secondary">{agent.name}</span>
          </span>
        ) : (
          <span className="text-[11.5px] text-ink-secondary/70">{t("taskBoard.card.unassigned")}</span>
        )}

        {cardSection(card) && (
          <span className="rounded-md bg-ink-secondary/10 px-1.5 py-0.5 text-[10.5px] text-ink-secondary">
            {cardSection(card)}
          </span>
        )}

        <span className={cn("rounded-md px-1.5 py-0.5 text-[10.5px] font-medium", toneClasses[tone])}>
          {cardStatusLabel({ ...card, agent })}
        </span>

        {/* A deadline is worth showing on the card face, because "what is late"
            is exactly the question a board is scanned for. It is a plain label
            and nothing else: no run is started, nothing moves, and the chip
            disappears the moment the work reaches a terminal column. */}
        {card.dueAt !== undefined && (
          <span
            className={cn(
              "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px]",
              overdue ? "bg-danger/15 text-danger" : "bg-ink-secondary/10 text-ink-secondary",
            )}
            title={overdue
              ? t("taskBoard.card.overdue", { when: formatDue(card.dueAt) })
              : t("taskBoard.card.due", { when: formatDue(card.dueAt) })}
          >
            <CalendarClock size={10} className="shrink-0" aria-hidden="true" />
            {formatDue(card.dueAt)}
          </span>
        )}

        {elapsed && (
          /* A running clock is marked as running; a finished one is a plain
             duration. Without the dot the two read identically, and "how long
             it took" is mistaken for "how long it has been going". */
          <span className="ml-auto flex items-center gap-1.5 text-[10.5px] tabular-nums text-ink-secondary/75">
            {liveRun && <span className="size-1.5 shrink-0 animate-status-pulse rounded-full bg-accent" aria-hidden="true" />}
            {elapsed}
          </span>
        )}
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        {/* A past day keeps the way into the conversation — that history is
            the reason to look at yesterday at all — and drops the controls
            that would change it. */}
        {!readOnly && (
          <>
            <button
              type="button"
              onClick={() => onRun(card)}
              disabled={!availability.canRun || running}
              title={availability.canRun ? t("taskBoard.run.label") : availability.reason}
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12px] font-semibold text-white transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              {/* The button always says what pressing it would do. Only a card
                  that is genuinely mid-start swaps the label, so a disabled
                  button never claims work is happening when it is not — the
                  reason underneath says why it cannot be pressed. */}
              {running ? t("taskBoard.card.working") : t("taskBoard.run.label")}
            </button>

            {canStop && (
              <button
                type="button"
                onClick={() => onStop(card)}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline/50 bg-card px-3 py-2 text-[12px] font-medium text-ink-secondary transition hover:bg-raised hover:text-ink"
                title={t("taskBoard.stop.hint")}
              >
                <X size={13} />
                {t("taskBoard.stop.label")}
              </button>
            )}
          </>
        )}

        {/* Icon-only, and pinned to the end: the label wrapped to two lines
            and pushed the row taller than the buttons beside it. The title
            and aria-label carry the words, so nothing is lost by dropping
            them from the face of the card. */}
        <button
          type="button"
          onClick={() => onOpenChat(card)}
          disabled={!card.threadId}
          aria-label={t("taskBoard.card.openChat")}
          title={card.threadId ? t("taskBoard.card.openChat") : t("taskBoard.card.noChat")}
          className="ml-auto flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary transition hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          <MessageCircle size={14} />
        </button>
      </div>

      {/* The reason a Start button is off belongs on the card, not only in a
          tooltip nobody hovers. There is no Start button on a past day, so
          there is no reason to give. */}
      {!readOnly && !availability.canRun && (
        <p className="mt-1.5 text-[10.5px] text-ink-secondary/75">{availability.reason}</p>
      )}
    </div>
  );
}