// The question box: what the bot actually asked, and its own answers.
//
// This is the card for a structured ask — Claude's AskUserQuestion. The
// provider routes it through the permission channel, so without this it
// arrived as "Deny / Always allow / Allow once" over a question like "which
// model should this bot run on?", which is not an answer to anything.
//
// The question itself is the title. Its options sit in one rounded group,
// each row keyed by a letter (A, B, C) that is also its keyboard shortcut,
// with a free-text field under the group for a reply the model did not
// think of. A set of questions gets one tab each and a single submit. It
// sits in the shared AskCard shell, and folds into one line once answered.
import { useMemo, useState, type KeyboardEvent } from "react";
import { Check, X } from "lucide-react";
import { useStore, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  answerWithoutPreamble,
  formatQuestionAnswers,
  MAX_CUSTOM_ANSWER,
  questionAnswersByQuestion,
  type AskQuestion,
} from "../../shared/ask-question";
import {
  ASK_PRIMARY_BUTTON,
  ASK_QUIET_BUTTON,
  ASK_SMALL_PILL,
  AskCard,
  AskSettledLine,
  moveChoiceFocus,
  returnFocusToComposer,
} from "./AskCard";
import { ExpandableText } from "./ExpandableText";

/** What each question has been answered with so far. Option labels and the
 * free-text reply are kept apart so toggling "Other" off cannot silently
 * drop a choice the person already made. */
interface Draft {
  picked: string[];
  custom: string;
  /** the field holds an answer of their own. An empty field is not one. */
  other: boolean;
}

const EMPTY: Draft = { picked: [], custom: "", other: false };
/** A question with nothing to choose from is answered in words only. */
const OPEN: Draft = { picked: [], custom: "", other: true };

/** Where an untouched question's draft starts. */
export function initialDraft(question: AskQuestion): Draft {
  return question.options.length ? EMPTY : OPEN;
}

/** One question, one pick: choosing it is the whole answer, so the card
 * sends it right away rather than waiting for Submit. */
export function answersInOneTap(questions: readonly AskQuestion[]): boolean {
  return questions.length === 1 && !questions[0]!.multiSelect && questions[0]!.options.length > 0;
}

function answersOf(draft: Draft): string[] {
  const custom = draft.other ? draft.custom.trim() : "";
  return custom ? [...draft.picked, custom] : draft.picked;
}

/** The tab label: the model's own header, or a number when it gave none. */
function tabLabel(question: AskQuestion, index: number): string {
  return question.header ?? t("question.tab.numbered", { index: index + 1 });
}

/** The key that picks option `index`: A, B, C… Shown on the row and
 * pressed on the keyboard. Latin in every locale, since it is a key. */
export function choiceKey(index: number): string {
  return String.fromCharCode(65 + index);
}

/** Option index for a pressed key, or -1. Plain letters only: a shortcut
 * never fires while typing in a field or with a modifier held. */
export function choiceIndexForKey(key: string, count: number): number {
  if (key.length !== 1) return -1;
  const index = key.toUpperCase().charCodeAt(0) - 65;
  return index >= 0 && index < count && index < 26 ? index : -1;
}

/** Up to this length the question is the card's title. A longer one keeps
 * a short title and opens below it with its own "show full question". */
const TITLE_MAX = 160;

const CHOICE_ROW =
  "flex w-full items-center gap-3 px-3 py-2.5 text-start transition-colors focus-visible:bg-ink/[0.06] focus-visible:outline-none";
const CHOICE_ROW_IDLE = "hover:bg-ink/[0.04]";
const CHOICE_ROW_PICKED = "bg-ink/[0.07]";

/**
 * The one line an answered card folds into: what was asked, then what was
 * answered. A single question names itself by its header (or its text); a
 * set lists each header beside its answer. The answer text the server kept
 * is read back per question, so the line never shows the model-facing
 * Q:/A: lead-in.
 */
export function settledQuestionLine(
  questions: readonly AskQuestion[],
  answer: string | null | undefined,
): { label: string; value: string } {
  if (!answer) return { label: t("question.status.answered"), value: "" };
  const byQuestion = questionAnswersByQuestion(answer, questions);
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  if (questions.length === 1) {
    const only = questions[0]!;
    const value = byQuestion[only.question] ?? answerWithoutPreamble(answer);
    return { label: only.header ?? only.question, value: flat(value) };
  }
  const parts = questions.flatMap((question, index) => {
    const value = byQuestion[question.question];
    return value ? [`${tabLabel(question, index)}: ${flat(value)}`] : [];
  });
  return {
    label: t("question.status.answered"),
    value: parts.length ? parts.join(" · ") : flat(answerWithoutPreamble(answer)),
  };
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
  bot?: Pick<Bot, "name">;
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
    () => questions.map((question, index) => answersOf(drafts[index] ?? initialDraft(question)).length > 0),
    [questions, drafts],
  );

  if (!card || !questions.length) return null;
  const settled = Boolean(card.answered) || sent !== null;
  const current = questions[Math.min(active, questions.length - 1)]!;
  const currentIndex = Math.min(active, questions.length - 1);
  const draft = drafts[currentIndex] ?? initialDraft(current);
  const oneTap = answersInOneTap(questions);
  const answeredCount = answered.filter(Boolean).length;
  const complete = answeredCount === questions.length;

  const update = (index: number, next: Partial<Draft>) =>
    setDrafts((previous) => ({ ...previous, [index]: { ...(previous[index] ?? initialDraft(questions[index]!)), ...next } }));

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
    update(currentIndex, { picked: [label], other: false, custom: "" });
    if (oneTap) {
      send({ ...drafts, [currentIndex]: { picked: [label], other: false, custom: "" } });
      return;
    }
    // Move to the next question they still owe an answer to, the way the
    // tabs would have been clicked anyway. The last one stays put so the
    // submit button is under the cursor that just chose.
    const next = questions.findIndex((_, index) => index !== currentIndex && !answered[index]);
    if (next >= 0) setActive(next);
  };

  // Typing an answer of their own replaces a single pick: the field is the
  // answer now. A multi-select keeps its picks beside the typed one.
  const type = (value: string) => {
    if (settled) return;
    update(currentIndex, {
      custom: value,
      other: value.trim().length > 0,
      ...(current.multiSelect || !value.trim() ? {} : { picked: [] }),
    });
  };

  const submit = () => {
    if (complete) send(drafts);
  };

  function send(final: Record<number, Draft>) {
    if (settled || !card?.requestId) return;
    const answers = questions.map((question, index) => answersOf(final[index] ?? initialDraft(question)));
    if (answers.some((entry) => !entry.length)) return;
    const answer = formatQuestionAnswers(questions, answers);
    if (!answer) return;
    setSent(answer);
    returnFocusToComposer();
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
  }

  if (settled) {
    const answer = card.answeredText ?? sent;
    // A question nobody answered (the run ended, or it was closed) is not
    // "answered": say so, and offer nothing to expand.
    if (!answer && card.answered && card.answered !== "answer") {
      return (
        <AskSettledLine ariaLabel={t("question.aria.card")} icon={<X size={13} />}>
          {t("question.status.closed")}
        </AskSettledLine>
      );
    }
    return <SettledQuestion questions={questions} answer={answer} />;
  }

  const single = questions.length === 1;
  const named = bot ? t("question.card.named", { name: bot.name }) : t("question.card.title");
  // The question is the title, the way a person would ask it. A long one,
  // or a set of them, keeps a short title and shows the text below.
  const questionIsTitle = single && current.question.length <= TITLE_MAX;
  const title = questionIsTitle ? current.question : single && current.header ? current.header : named;
  const meta = !single ? t("question.progress", { answered: answeredCount, count: questions.length }) : undefined;
  const multi = Boolean(current.multiSelect);
  const freeText = current.custom !== false;

  // A, B, C pick an option from the card itself or a choice row. Not from a
  // text field, and not from another control (a tab), where a letter
  // should do nothing.
  const onCardKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (target.closest("input, textarea, select, [contenteditable]")) return;
    if (target.closest("button, a") && !target.closest("[data-ask-choice]")) return;
    const index = choiceIndexForKey(event.key, current.options.length);
    if (index < 0) return;
    event.preventDefault();
    choose(current.options[index]!.label);
  };

  return (
    <AskCard
      ariaLabel={t("question.aria.card")}
      plain
      title={title}
      meta={meta}
      onKeyDown={onCardKey}
      // a single pick answers in one tap, so there is nothing to submit
      // until they type an answer of their own
      footer={oneTap && !draft.custom.trim() ? undefined : (
        <>
          <span className="me-auto text-[12px] text-ink-tertiary">{t("question.status.waiting")}</span>
          <button type="button" onClick={submit} disabled={!complete} className={ASK_PRIMARY_BUTTON}>
            {questions.length > 1 ? t("question.submitAll") : t("question.submit")}
          </button>
        </>
      )}
    >
      {card.questionRequest?.origin === "output" && (
        <div className="-mt-1 mb-1.5 text-[12px] text-ink-secondary">{t("question.origin.badge")}</div>
      )}

      {questions.length > 1 && (
        <div role="tablist" aria-label={t("question.aria.tabs")} className="-mt-0.5 mb-2 flex flex-wrap items-center gap-2">
          {questions.map((question, index) => (
            <button
              key={`${index}-${question.question}`}
              type="button"
              role="tab"
              aria-selected={index === currentIndex}
              onClick={() => setActive(index)}
              className={cn(
                ASK_SMALL_PILL,
                index === currentIndex
                  ? "bg-ink/[0.07] text-ink"
                  : "text-ink-secondary hover:bg-ink/[0.07] hover:text-ink",
              )}
            >
              {answered[index] && <Check size={14} className="text-success" />}
              {tabLabel(question, index)}
            </button>
          ))}
        </div>
      )}

      {!questionIsTitle && (
        <ExpandableText text={current.question} className="mb-2.5 text-[14px] leading-relaxed text-ink" />
      )}
      {multi && <div className="-mt-1 mb-2 text-[12px] text-ink-tertiary">{t("question.multiHint")}</div>}

      {current.options.length > 0 && (
        <div
          role={multi ? "group" : "radiogroup"}
          aria-label={current.question}
          onKeyDown={moveChoiceFocus}
          // one rounded group with hairlines between the rows
          // (an ink tint rather than `hairline`, which vanishes on the
          // composer surface in the dark skins)
          className="divide-y divide-ink/[0.12] overflow-hidden rounded-2xl border border-ink/[0.12]"
        >
          {current.options.map((option, index) => {
            const picked = draft.picked.includes(option.label);
            return (
              <button
                key={option.label}
                type="button"
                data-ask-choice=""
                role={multi ? "checkbox" : "radio"}
                aria-checked={picked}
                aria-keyshortcuts={choiceKey(index)}
                onClick={() => choose(option.label)}
                // the row follows the chat's direction, so the key badge
                // sits at the start and mirrors in a right-to-left chat
                className={cn(CHOICE_ROW, picked ? CHOICE_ROW_PICKED : CHOICE_ROW_IDLE)}
              >
                <KeyBadge letter={choiceKey(index)} picked={picked} />
                <span className="min-w-0 flex-1">
                  {/* plaintext bidi: each label orders its own script, while
                      it still lines up at the row's start beside the badge */}
                  <span className="block break-words text-[15px] leading-6 text-ink [unicode-bidi:plaintext]">{option.label}</span>
                  {option.description && (
                    <span className="block break-words text-[13px] leading-snug text-ink-secondary [unicode-bidi:plaintext]">{option.description}</span>
                  )}
                </span>
                {multi && picked && <Check size={16} strokeWidth={2.5} aria-hidden="true" className="shrink-0 text-accent-text" />}
              </button>
            );
          })}
        </div>
      )}
      {/* an options-only question (an ACP engine answers with an option
          id, never text) has no free-text answer it could send */}
      {freeText && (
        // A textarea, so an answer can run to a few lines: Enter sends,
        // Shift+Enter starts a new line, and it grows with its text up to a
        // cap. It never takes focus on its own, so a question that arrives
        // while they type in the composer does not steal the cursor.
        <textarea
          dir="auto"
          rows={1}
          value={draft.custom}
          maxLength={MAX_CUSTOM_ANSWER}
          aria-label={current.options.length ? t("question.otherPlaceholder") : current.question}
          onChange={(event) => type(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (complete) submit();
          }}
          placeholder={current.options.length ? t("question.otherPlaceholder") : t("question.answerPlaceholder")}
          className={cn(
            "block max-h-40 min-h-11 w-full resize-none rounded-xl border border-ink/[0.12] bg-inset px-3 py-2.5 text-[15px] leading-6 text-ink outline-none placeholder:text-ink-tertiary focus:border-accent/70 [field-sizing:content]",
            current.options.length > 0 && "mt-2.5",
          )}
        />
      )}
    </AskCard>
  );
}

/** The answered card: one line, with the whole answer one tap away. */
function SettledQuestion({ questions, answer }: { questions: readonly AskQuestion[]; answer: string | null }) {
  const [open, setOpen] = useState(false);
  const line = settledQuestionLine(questions, answer);
  const full = answer ? answerWithoutPreamble(answer) : "";
  return (
    <AskSettledLine
      ariaLabel={t("question.aria.card")}
      action={full && (
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className={ASK_QUIET_BUTTON}>
          {open ? t("question.hideDetails") : t("question.details")}
        </button>
      )}
      detail={open && full && (
        <div dir="auto" className="ms-[19px] mt-1.5 whitespace-pre-wrap break-words rounded-lg bg-inset px-3 py-2 text-[12.5px] leading-relaxed text-ink-secondary">
          {full}
        </div>
      )}
    >
      <span>{line.label}</span>
      {line.value && <span className="text-ink-secondary"> · {line.value}</span>}
    </AskSettledLine>
  );
}

/** The letter that picks a row. Small and neutral, a touch stronger when
 * its row is the pick. */
function KeyBadge({ letter, picked }: { letter: string; picked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md text-[12px] font-medium leading-none transition-colors",
        picked ? "bg-ink/[0.16] text-ink" : "bg-ink/[0.08] text-ink-secondary",
      )}
    >
      {letter}
    </span>
  );
}
