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
import { CalendarClock, ExternalLink, Loader2, Play, Trash2, X } from "lucide-react";
import type { DragEvent } from "react";

import { BotAvatar } from "./Avatar";
import { formatElapsed } from "@/lib/working-time";
import { t } from "@/lib/i18n";
import {
  cardSection,
  cardStatusLabel,
  elapsedLabel,
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
   * bot was deleted, which the card reports as such rather than pretending. */
  bot?: { id: string; name: string; mascotExpression?: string | null } | null;
  agent: BoardAgent | null | undefined;
  running: boolean;
  onRun: (card: BoardCard) => void;
  onStop: (card: BoardCard) => void;
  onDelete: (card: BoardCard) => void;
  onOpenChat: (card: BoardCard) => void;
  onDragStart: (card: BoardCard, event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  dragging: boolean;
}

export function TaskBoardCardView({
  card,
  bot,
  agent,
  running,
  onRun,
  onStop,
  onDelete,
  onOpenChat,
  onDragStart,
  onDragEnd,
  dragging,
}: TaskBoardCardProps) {
  const availability = runAvailability({ ...card, agent });
  const canStop = stopAvailability({ ...card, agent });
  const elapsed = elapsedLabel({ ...card, agent }, Date.now(), formatElapsed);
  const tone = statusTone({ ...card, agent });

  return (
    <div
      draggable
      onDragStart={(event) => onDragStart(card, event)}
      onDragEnd={onDragEnd}
      className={cn(
        "group rounded-xl border border-hairline/45 bg-card px-4 py-3 shadow-sm transition",
        dragging ? "opacity-50" : "hover:border-accent/30 hover:bg-raised/40",
      )}
    >
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
            <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-ink-secondary">{card.brief}</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => onDelete(card)}
          className="shrink-0 rounded-md p-1 text-ink-secondary/60 opacity-0 transition hover:bg-raised hover:text-danger focus:opacity-100 group-hover:opacity-100"
          aria-label={t("taskBoard.delete.label")}
          title={t("taskBoard.delete.label")}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* Why the work stopped stays on the card. A failure that only appears
          in a transcript nobody opened reads as a board that went quiet. */}
      {card.lastError && (
        <p className="mt-2 rounded-lg border border-danger/25 bg-danger/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-danger">
          {card.lastError}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {agent && bot ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <BotAvatar
              bot={{ ...bot, mascotExpression: bot.mascotExpression ?? undefined } as never}
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

        {elapsed && <span className="ml-auto text-[10.5px] tabular-nums text-ink-secondary/75">{elapsed}</span>}
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onRun(card)}
          disabled={!availability.canRun || running}
          title={availability.canRun ? t("taskBoard.run.label") : availability.reason}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12px] font-semibold text-white transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-45"
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
            className="flex items-center gap-1.5 rounded-lg border border-hairline/50 bg-card px-3 py-2 text-[12px] font-medium text-ink-secondary transition hover:bg-raised hover:text-ink"
            title={t("taskBoard.stop.hint")}
          >
            <X size={13} />
            {t("taskBoard.stop.label")}
          </button>
        )}

        <button
          type="button"
          onClick={() => onOpenChat(card)}
          disabled={!card.threadId}
          title={card.threadId ? t("taskBoard.card.openChat") : t("taskBoard.card.noChat")}
          className="ml-auto flex items-center gap-1.5 rounded-lg px-2 py-2 text-[11.5px] text-ink-secondary transition hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ExternalLink size={12} />
          {t("taskBoard.card.openChat")}
        </button>
      </div>

      {/* The reason a Start button is off belongs on the card, not only in a
          tooltip nobody hovers. */}
      {!availability.canRun && (
        <p className="mt-1.5 text-[10.5px] text-ink-secondary/75">{availability.reason}</p>
      )}
    </div>
  );
}