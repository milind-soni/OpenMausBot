// The question box: what the bot actually asked, and its own answers.
//
// This is the card for a structured ask — Claude's AskUserQuestion. The
// provider routes it through the permission channel, so without this it
// arrived as "Deny / Always allow / Allow once" over a question like "which
// model should this bot run on?", which is not an answer to anything.
//
// One tab per question (the model names them), the model's options as rows
// with their descriptions, an "Other" row for a reply it did not think of,
// and a single submit that sends every answer back at once — the shape a
// person can read at a glance and answer without scrolling back up.
import { useMemo, useState } from "react";
import { Check, MessageCircleQuestion } from "lucide-react";
import { useStore, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  answerWithoutPreamble,
  formatQuestionAnswers,
  MAX_CUSTOM_ANSWER,
  type AskQuestion,
} from "../../shared/ask-question";

/** What each question has been answered with so far. Option labels and the
 * free-text reply are kept apart so toggling "Other" off cannot silently
 * drop a choice the person already made. */
interface Draft {
  picked: string[];
  custom: string;
  /** "Other" is open. An empty open field is not an answer. */
  other: boolean;
}

const EMPTY: Draft = { picked: [], custom: "", other: false };

function answersOf(draft: Draft): string[] {
  const custom = draft.other ? draft.custom.trim() : "";
  return custom ? [...draft.picked, custom] : draft.picked;
}

/** The tab label: the model's own header, or a number when it gave none. */
function tabLabel(question: AskQuestion, index: number): string {
  return question.header ?? t("question.tab.numbered", { index: index + 1 });
}

export function QuestionCard({
  threadId,
  bot,
  message,
}: {
  /** answered by THREAD, so a question raised inside a room settles the
   * same way as one in a 1:1 chat */
  threadId: string;
  /** who is asking, for the "Name has a question" line */
  bot?: Bot;
  message: Message;
}) {
  const { dispatch } = useStore();
  const card = message.card;
  const questions = card?.questionRequest?.questions ?? [];
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [active, setActive] = useState(0);
  // The server settles the card, but only after a round trip. Holding the
  // sent answer here closes the window where the buttons are still live.
  const [sent, setSent] = useState<string | null>(null);

  const answered = useMemo(
    () => questions.map((_, index) => answersOf(drafts[index] ?? EMPTY).length > 0),
    [questions, drafts],
  );

  if (!card || !questions.length) return null;
  const settled = Boolean(card.answered) || sent !== null;
  const current = questions[Math.min(active, questions.length - 1)]!;
  const currentIndex = Math.min(active, questions.length - 1);
  const draft = drafts[currentIndex] ?? EMPTY;
  const answeredCount = answered.filter(Boolean).length;
  const complete = answeredCount === questions.length;

  const update = (index: number, next: Partial<Draft>) =>
    setDrafts((previous) => ({ ...previous, [index]: { ...(previous[index] ?? EMPTY), ...next } }));

  const choose = (label: string) => {
    if (settled) return;
    if (current.multiSelect) {
      const picked = draft.picked.includes(label)
        ? draft.picked.filter((entry) => entry !== label)
        : [...draft.picked, label];
      update(currentIndex, { picked });
      return;
    }
    // Single-select is a radio group: picking replaces, and picking an
    // option means the free-text answer was not the one they wanted.
    update(currentIndex, { picked: [label], other: false });
    // Move to the next question they still owe an answer to, the way the
    // tabs would have been clicked anyway. The last one stays put so the
    // submit button is under the cursor that just chose.
    const next = questions.findIndex((_, index) => index !== currentIndex && !answered[index]);
    if (next >= 0) setActive(next);
  };

  const toggleOther = () => {
    if (settled) return;
    if (draft.other) {
      update(currentIndex, { other: false });
      return;
    }
    update(currentIndex, { other: true, ...(current.multiSelect ? {} : { picked: [] }) });
  };

  const submit = () => {
    if (settled || !complete || !card.requestId) return;
    const answer = formatQuestionAnswers(questions, questions.map((_, index) => answersOf(drafts[index] ?? EMPTY)));
    if (!answer) return;
    setSent(answer);
    dispatch({
      type: "decideRequest",
      threadId,
      requestId: card.requestId,
      behavior: "answer",
      message: answer,
      // The answer never reached the bot, so the card must go back to
      // being answerable rather than sitting there looking settled.
      onError: () => setSent(null),
    });
  };

  return (
    <div
      role="group"
      aria-label={t("question.aria.card")}
      className={cn(
        "w-full max-w-[840px] rounded-2xl border bg-card p-4",
        settled ? "border-hairline/30 opacity-70" : "border-accent/40",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[15px] font-semibold text-ink">
          {bot ? t("question.card.named", { name: bot.name }) : t("question.card.title")}
        </div>
        {questions.length > 1 && !settled && (
          <span className="shrink-0 text-[11px] tabular-nums text-ink-secondary">
            {t("question.progress", { answered: answeredCount, count: questions.length })}
          </span>
        )}
      </div>

      {questions.length > 1 && (
        <div role="tablist" aria-label={t("question.aria.tabs")} className="mt-3 flex flex-wrap gap-1">
          {questions.map((question, index) => (
            <button
              key={`${index}-${question.question}`}
              role="tab"
              aria-selected={index === currentIndex}
              onClick={() => setActive(index)}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] transition-colors",
                index === currentIndex
                  ? "bg-control text-ink"
                  : "text-ink-secondary hover:bg-control/60 hover:text-ink",
              )}
            >
              {answered[index] && <Check size={12} className="text-success" />}
              {tabLabel(question, index)}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 text-[15px] leading-relaxed text-ink">{current.question}</div>
      {current.multiSelect && !settled && (
        <div className="mt-1 text-[12.5px] text-ink-secondary">{t("question.multiHint")}</div>
      )}

      {!settled && (
        <div
          role={current.multiSelect ? "group" : "radiogroup"}
          aria-label={current.question}
          className="mt-3 overflow-hidden rounded-lg border border-hairline/40"
        >
          {current.options.map((option, index) => {
            const picked = draft.picked.includes(option.label);
            return (
              <button
                key={option.label}
                role={current.multiSelect ? "checkbox" : "radio"}
                aria-checked={picked}
                onClick={() => choose(option.label)}
                className={cn(
                  "flex w-full items-start gap-3 px-3 py-2.5 text-left",
                  index > 0 && "border-t border-hairline/40",
                  // `raised` is the same value as the card in the light
                  // skins; `raised-hover` is the one tone every skin
                  // guarantees stands off a surface.
                  picked ? "bg-raised-hover" : "hover:bg-raised-hover/60",
                )}
              >
                <Marker checked={picked} multi={Boolean(current.multiSelect)} />
                <span className="min-w-0">
                  <span className="block text-[14.5px] font-medium text-ink">{option.label}</span>
                  {option.description && (
                    <span className="block text-[13px] leading-snug text-ink-secondary">{option.description}</span>
                  )}
                </span>
              </button>
            );
          })}
          <button
            role={current.multiSelect ? "checkbox" : "radio"}
            aria-checked={draft.other}
            onClick={toggleOther}
            className={cn(
              "flex w-full items-center gap-3 px-3 py-2.5 text-left",
              current.options.length > 0 && "border-t border-hairline/40",
              draft.other ? "bg-raised-hover" : "hover:bg-raised-hover/60",
            )}
          >
            <Marker checked={draft.other} multi={Boolean(current.multiSelect)} />
            <span className="text-[14.5px] text-ink">{t("question.other")}</span>
          </button>
          {draft.other && (
            <div className="border-t border-hairline/40 px-3 py-2.5">
              <input
                autoFocus
                value={draft.custom}
                maxLength={MAX_CUSTOM_ANSWER}
                onChange={(event) => update(currentIndex, { custom: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && complete) submit();
                }}
                placeholder={t("question.otherPlaceholder")}
                className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
              />
            </div>
          )}
        </div>
      )}

      {settled ? (
        <div className="mt-3 flex items-start gap-1.5 text-[13px] text-ink-secondary">
          <Check size={14} className="mt-0.5 shrink-0 text-success" />
          <span className="whitespace-pre-wrap break-words">
            {(() => {
              const answer = card.answeredText ?? sent;
              return answer ? answerWithoutPreamble(answer) : t("question.status.answered");
            })()}
          </span>
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-end gap-3">
          <span className="flex items-center gap-1.5 text-[13px] text-ink-secondary">
            <MessageCircleQuestion size={14} className="text-accent" />
            {t("question.status.waiting")}
          </span>
          <button
            onClick={submit}
            disabled={!complete}
            className="rounded-full bg-accent px-3.5 py-1.5 text-[13.5px] font-medium text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {questions.length > 1 ? t("question.submitAll") : t("question.submit")}
          </button>
        </div>
      )}
    </div>
  );
}

/** The radio dot / checkbox tick. Drawn rather than an <input> so the whole
 * row stays one button and the hit target is the row, not the 16px circle. */
function Marker({ checked, multi }: { checked: boolean; multi: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
        multi ? "rounded-[5px]" : "rounded-full",
        checked ? "border-accent bg-accent" : "border-hairline",
      )}
    >
      {checked &&
        (multi ? (
          <Check size={11} className="text-white" strokeWidth={3} />
        ) : (
          <span className="size-1.5 rounded-full bg-white" />
        ))}
    </span>
  );
}
