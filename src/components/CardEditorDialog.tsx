// The card editor: one dialog for making a card and for changing one.
//
// Creating and editing were a bare inline form and nothing at all. They are the
// same act on the same fields, so they are the same dialog — a card made here
// and a card edited here can never drift into asking for different things.
//
// The dialog owns no state that outlives it beyond the draft: it hands back a
// finished title/brief/agent and the page decides what route that becomes.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { BotSelect, type BotSelectOption } from "./BotSelect";
import { BriefMarkdown, hasMarkdownSyntax } from "./BriefMarkdown";
import { addDays, fromLocalDateInput, startOfDay, toLocalDateInput } from "@/lib/routine-calendar";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** A one-click day. Marked as chosen when the field already holds it, so the
 * quick button and the date field can never disagree about what is picked. */
function QuickDay({
  label,
  value,
  current,
  onPick,
}: {
  label: string;
  value: string;
  current: string;
  onPick: (value: string) => void;
}) {
  const chosen = current === value;
  return (
    <button
      type="button"
      onClick={() => onPick(value)}
      aria-pressed={chosen}
      className={cn(
        "rounded-lg px-2.5 py-2 text-[12px] font-medium transition",
        chosen ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}

export interface CardDraft {
  title: string;
  brief: string;
  /** `null` means "leave without a bot", which the server accepts. */
  ownerBotId: string | null;
  /** The day the card belongs to, as the start of that local day, or `null`
   * for "no particular day" — which the board resolves to the creation day. */
  day: number | null;
  /** A finish-by time, display only, or `null` for none. */
  dueAt: number | null;
}

export interface CardEditorDialogProps {
  open: boolean;
  /** Present when editing an existing card; absent when creating one. */
  card?: {
    id: string;
    title: string;
    brief?: string;
    ownerBotId?: string | null;
    day?: number;
    dueAt?: number;
  } | null;
  bots: BotSelectOption[];
  /** The day a brand-new card should start on. The board's own day filter, so
   * a card made while looking at Friday lands on Friday rather than silently
   * going to today and vanishing from the view that made it. */
  defaultDay?: number;
  onCancel: () => void;
  onSubmit: (draft: CardDraft) => void | Promise<void>;
}

export function CardEditorDialog({ open, card, bots, defaultDay, onCancel, onSubmit }: CardEditorDialogProps) {
  const editing = Boolean(card);
  const [title, setTitle] = useState(card?.title ?? "");
  const [brief, setBrief] = useState(card?.brief ?? "");
  const [agent, setAgent] = useState<string | null>(card?.ownerBotId ?? null);
  /** The date inputs hold `YYYY-MM-DD` strings, which is what `<input
   * type="date">` speaks, and are converted at the edges. Keeping them as
   * strings in state means a half-typed date is not silently reinterpreted
   * mid-keystroke. */
  const [day, setDay] = useState("");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);
  /** Why the last save failed. Kept in the dialog because that is where the
   * person is looking: the board's own error strip renders behind the modal,
   * so a failure reported only there reads as a button that did nothing. */
  const [failure, setFailure] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // The draft is seeded from whatever was opened, so reopening the same card
  // shows its current words rather than what was typed last time.
  useEffect(() => {
    if (!open) return;
    setTitle(card?.title ?? "");
    setBrief(card?.brief ?? "");
    setAgent(card?.ownerBotId ?? null);
    // A new card inherits the day the board is showing, so making one while
    // looking at Friday does not drop it onto today and out of sight. An
    // existing card shows its own date, and no date means an empty field
    // rather than today — the field is "which day is this FOR", and inventing
    // today there would silently pin every card the moment it was opened.
    setDay(card?.day !== undefined ? toLocalDateInput(card.day) : card ? "" : defaultDay !== undefined ? toLocalDateInput(defaultDay) : "");
    setDue(card?.dueAt !== undefined ? toLocalDateInput(card.dueAt) : "");
    setSaving(false);
    setFailure(null);
  }, [open, card, defaultDay]);

  /** Focus the title once, when the dialog opens — and never again.
 *
 * This is its own effect, keyed on `open` alone, on purpose. It used to share
 * an effect with the key handler, which depends on `onCancel` — a callback the
 * parent re-creates every render. So each keystroke re-rendered the dialog,
 * handed the effect a new `onCancel`, and re-ran it: the caret was yanked back
 * to the title and the text re-selected while the person was typing the brief.
 * Keying on `open` means focus is set on open whatever the parent's callbacks
 * do. */
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Selecting the existing title means editing starts with the caret on the
    // thing being changed, not appending to it.
    titleRef.current?.focus();
    titleRef.current?.select();
  }, [open]);

  /** The latest `onCancel`, held in a ref so the key handler can call it without
 * listing it as a dependency.
 *
 * The handler only needs to be installed once while the dialog is open. If it
 * depended on the callback, a parent that re-created that callback every
 * render would tear the listener down and re-add it on every keystroke — which
 * is exactly how this dialog used to lose the caret. Reading through a ref
 * makes that failure impossible rather than merely absent, so a future caller
 * cannot bring it back by passing an inline arrow. */
  const cancelRef = useRef(onCancel);
  useEffect(() => {
    cancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelRef.current();
        return;
      }
      if (event.key === "Tab") {
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (!controls?.length) return;
        const first = controls[0]!;
        const last = controls[controls.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `open` only — the callback is read through cancelRef above.
  }, [open]);

  // A title is the one thing a card cannot be without, so the submit button
  // says so by being off rather than by failing after the fact.
  const canSave = title.trim().length > 0 && !saving;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    setFailure(null);
    try {
      await onSubmit({
        title: title.trim(),
        brief: brief.trim(),
        ownerBotId: agent,
        // An empty date field is an explicit "no date", sent as null so the
        // PATCH clears rather than leaving the old value in place behind an
        // empty box.
        day: day ? fromLocalDateInput(day) : null,
        dueAt: due ? fromLocalDateInput(due) : null,
      });
      returnFocusRef.current?.focus();
    } catch (error) {
      // Shown here rather than only on the board behind the modal, and the
      // person's words are left untouched so nothing typed is lost.
      setFailure(error instanceof Error && error.message ? error.message : t("taskBoard.actionError"));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="card-editor-title"
        className="animate-pop-in flex max-h-[min(720px,calc(100dvh-2rem))] w-full max-w-[520px] flex-col rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none"
      >
        <header className="flex items-start justify-between gap-4 rounded-t-[24px] border-b border-hairline/40 px-5 py-4">
          <div className="min-w-0">
            <h2 id="card-editor-title" className="text-[15px] font-semibold text-ink">
              {editing ? t("taskBoard.editor.editTitle") : t("taskBoard.editor.newTitle")}
            </h2>
            <p className="mt-0.5 text-[12px] text-ink-secondary">
              {editing ? t("taskBoard.editor.editBody") : t("taskBoard.editor.newBody")}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label={t("taskBoard.editor.close")}
            className="shrink-0 rounded-lg p-1.5 text-ink-secondary transition hover:bg-raised hover:text-ink"
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">
              {t("taskBoard.editor.titleField")}
            </span>
            <input
              ref={titleRef}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={t("taskBoard.newCard.title")}
              className="w-full rounded-xl border border-hairline/50 bg-card px-3 py-2.5 text-[13.5px] text-ink outline-none transition placeholder:text-ink-secondary/60 focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </label>

          <label className="mt-4 block">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">
              {t("taskBoard.editor.briefField")}
            </span>
            <textarea
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              placeholder={t("taskBoard.newCard.brief")}
              rows={4}
              className="w-full resize-y rounded-xl border border-hairline/50 bg-card px-3 py-2.5 text-[13px] leading-relaxed text-ink outline-none transition placeholder:text-ink-secondary/60 focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40"
            />
            {/* The brief is not a note to self — it is the first thing the bot
                is told, which is worth saying once, here. */}
            <span className="mt-1.5 block text-[11px] text-ink-secondary/75">{t("taskBoard.editor.briefHint")}</span>
            {/* Formatting is typed, not clicked, so the syntax has to be
                visible somewhere. This says it once and shows the result: a
                hint nobody can check against their own text is a hint that
                gets ignored. */}
            <span className="mt-1 block text-[11px] text-ink-secondary/60">{t("taskBoard.editor.briefFormat")}</span>
            {brief.trim() && hasMarkdownSyntax(brief) && (
              <div className="mt-2 rounded-xl border border-hairline/40 bg-card/60 px-3 py-2">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-secondary/70">
                  {t("taskBoard.editor.briefPreview")}
                </span>
                <BriefMarkdown text={brief} />
              </div>
            )}
          </label>

          <div className="mt-4">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">
              {t("taskBoard.editor.dayField")}
            </span>
            {/* One field, with the two days a card is nearly always for offered
                as one click each. A card is usually for today or tomorrow, so
                making those the easy choices means the date picker is only
                opened when the answer is genuinely a different day. */}
            <div className="flex items-center gap-1.5">
              <div className="flex shrink-0 items-center gap-1">
                <QuickDay label={t("taskBoard.day.today")} value={toLocalDateInput(startOfDay(Date.now()))} current={day} onPick={setDay} />
                <QuickDay label={t("taskBoard.day.tomorrow")} value={toLocalDateInput(addDays(startOfDay(Date.now()), 1))} current={day} onPick={setDay} />
              </div>
              <input
                type="date"
                value={day}
                onChange={(event) => setDay(event.target.value)}
                aria-label={t("taskBoard.editor.dayField")}
                className="min-w-0 flex-1 rounded-xl border border-hairline/50 bg-card px-3 py-2 text-[13px] text-ink outline-none transition focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40 [color-scheme:dark]"
              />
              {/* A date picker with no way to unset it is a one-way door: once
                  a card has a day it would keep one forever. */}
              {day && (
                <button
                  type="button"
                  onClick={() => setDay("")}
                  aria-label={t("taskBoard.editor.dayClear")}
                  title={t("taskBoard.editor.dayClear")}
                  className="shrink-0 rounded-lg p-1.5 text-ink-secondary transition hover:bg-raised hover:text-ink"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>

          {/* The deadline is a second, less common thing, so it stays folded
              away until asked for. Both hints matter for different reasons: the
              day decides which board the card appears on, and the deadline
              decides nothing at all — saying the second out loud is what stops
              "finish by" being read as "starts at". */}
          <div className="mt-4">
            {due ? (
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                  {t("taskBoard.editor.dueField")}
                </span>
                <input
                  type="date"
                  value={due}
                  onChange={(event) => setDue(event.target.value)}
                  aria-label={t("taskBoard.editor.dueField")}
                  className="min-w-0 flex-1 rounded-xl border border-hairline/50 bg-card px-3 py-2 text-[13px] text-ink outline-none transition focus:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/40 [color-scheme:dark]"
                />
                <button
                  type="button"
                  onClick={() => setDue("")}
                  aria-label={t("taskBoard.editor.dueClear")}
                  title={t("taskBoard.editor.dueClear")}
                  className="shrink-0 rounded-lg p-1.5 text-ink-secondary transition hover:bg-raised hover:text-ink"
                >
                  <X size={13} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setDue(toLocalDateInput(startOfDay(Date.now())))}
                className="text-[11.5px] font-medium text-ink-secondary underline-offset-2 transition hover:text-accent hover:underline"
              >
                + {t("taskBoard.editor.dueField")}
              </button>
            )}
            {due && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-secondary/75">
                {t("taskBoard.editor.dueHint")}
              </p>
            )}
          </div>

          <div className="mt-4">
            <BotSelect
              bots={bots}
              value={agent}
              onChange={setAgent}
              placeholder={t("taskBoard.editor.noAgent")}
              label={t("taskBoard.editor.agentField")}
            />
          </div>
        </div>

        <footer className="flex items-center justify-between gap-3 rounded-b-[24px] border-t border-hairline/40 bg-panel px-5 py-4">
          {/* The reason a save did not land belongs next to the button that
              tried, not on the board hidden behind this dialog. */}
          {failure ? (
            <p role="alert" className="min-w-0 flex-1 truncate text-[12px] text-danger" title={failure}>
              {failure}
            </p>
          ) : (
            <span />
          )}
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary transition hover:bg-raised hover:text-ink"
            >
              {t("taskBoard.newCard.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSave}
              className={cn(
                "rounded-xl bg-accent px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-accent/90",
                !canSave && "cursor-not-allowed opacity-45",
              )}
            >
              {editing ? t("taskBoard.editor.save") : t("taskBoard.newCard.submit")}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}