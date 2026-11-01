// A bot's question to the person, whatever asked it: a pick from its choices, its own words, or both. The same card
// answers in the chat, in the inbox's copy of it and in the inbox panel.
import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { useStore, type Message } from "@/state/store";
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
  AskCard,
  AskChoices,
  AskError,
  AskHeader,
  AskReply,
  AskSettledLine,
  ASK_QUIET_BUTTON,
  ASK_SMALL_PILL,
  askPrimary,
  returnFocusToComposer,
  settledAnswer,
  type Asker,
} from "./AskCard";
import { ExpandableText } from "./ExpandableText";
import { useInboxOrigin } from "./InboxLine";
import { accessRequestWords, cardAnswerFor } from "./bot-access/access-card";

export { isQuestionCard } from "@/lib/question-card";

interface Draft {
  picked: string[];
  custom: string;
}

const EMPTY: Draft = { picked: [], custom: "" };
const TITLE_MAX = 160;

/** The questions a card asks: a provider's structured set, or one question with the card's own choices. */
export function cardQuestions(card: NonNullable<Message["card"]>): AskQuestion[] {
  if (card.questionRequest?.questions.length) return card.questionRequest.questions;
  if (!card.subtitle && !card.title) return [];
  const words = accessRequestWords(card);
  return [{ question: words?.question ?? (card.subtitle || card.title), options: (words?.options ?? card.options).map((label) => ({ label })), ...(card.fixedOptions && card.options.length ? { custom: false as const } : {}) }];
}

export function answersInOneTap(questions: readonly AskQuestion[]): boolean {
  return questions.length === 1 && !questions[0]!.multiSelect && questions[0]!.options.length > 0;
}

function answersOf(draft: Draft): string[] {
  const custom = draft.custom.trim();
  return custom ? [...draft.picked, custom] : draft.picked;
}

function tabLabel(question: AskQuestion, index: number): string {
  return question.header ?? t("question.tab.numbered", { index: index + 1 });
}

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
  asker,
  message,
  typedPast = false,
}: {
  threadId: string;
  asker?: Asker;
  message: Message;
  /** The person has written in the chat since: the choices recede, and still answer. */
  typedPast?: boolean;
}) {
  const { dispatch } = useStore();
  const origin = useInboxOrigin(message);
  const card = message.card;
  const questions = useMemo(() => (card ? cardQuestions(card) : []), [card]);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [active, setActive] = useState(0);
  const [sent, setSent] = useState<{ answer: string; label?: string } | null>(null);
  const [failed, setFailed] = useState(false);

  if (!card?.requestId || !questions.length) return null;
  if (decidedByBot(card)) return <DecidedQuestion threadId={threadId} asker={asker} card={card} questions={questions} />;
  if (card.answered || card.expired || card.stopped) return <SettledQuestion card={card} questions={questions} />;

  const currentIndex = Math.min(active, questions.length - 1);
  const current = questions[currentIndex]!;
  const draft = drafts[currentIndex] ?? EMPTY;
  const oneTap = answersInOneTap(questions);
  const answered = questions.map((_, index) => answersOf(drafts[index] ?? EMPTY).length > 0);
  const complete = answered.every(Boolean);
  const sending = sent !== null && !failed;
  const multi = Boolean(current.multiSelect);
  const freeText = current.custom !== false;
  const single = questions.length === 1;
  const title = single && current.question.length <= TITLE_MAX ? current.question : single && current.header ? current.header : null;
  const update = (index: number, next: Partial<Draft>) =>
    setDrafts((previous) => ({ ...previous, [index]: { ...(previous[index] ?? EMPTY), ...next } }));

  function send(final: Record<number, Draft>, label?: string) {
    if (sending || !card?.requestId) return;
    const answers = questions.map((_, index) => answersOf(final[index] ?? EMPTY));
    if (answers.some((entry) => !entry.length)) return;
    const message = card.questionRequest ? formatQuestionAnswers(questions, answers) : cardAnswerFor(card, answers[0]![0]!);
    if (!message) return;
    setFailed(false);
    setSent({ answer: message, ...(label ? { label } : {}) });
    returnFocusToComposer();
    dispatch({ type: "decideRequest", threadId, requestId: card.requestId, behavior: "answer", message, onError: () => setFailed(true) });
  }

  const choose = (label: string) => {
    if (sending) return;
    if (multi) {
      update(currentIndex, { picked: draft.picked.includes(label) ? draft.picked.filter((entry) => entry !== label) : [...draft.picked, label] });
      return;
    }
    const next = { ...drafts, [currentIndex]: { picked: [label], custom: "" } };
    setDrafts(next);
    if (oneTap) {
      send(next, label);
      return;
    }
    const open = questions.findIndex((_, index) => index !== currentIndex && !answersOf(next[index] ?? EMPTY).length);
    if (open >= 0) setActive(open);
  };

  const typed = (text: string) => {
    const next = { ...drafts, [currentIndex]: { picked: multi ? draft.picked : [], custom: text } };
    setDrafts(next);
    if (questions.every((_, index) => answersOf(next[index] ?? EMPTY).length > 0)) send(next);
  };

  const header = asker
    ? <AskHeader asker={asker} line={t("ask.header.asks", { name: asker.name })} origin={origin} />
    : undefined;
  const needsSubmit = !oneTap || multi || questions.length > 1;

  return (
    <AskCard
      ariaLabel={t("question.aria.card")}
      header={header}
      title={title ?? (asker ? t("question.card.named", { name: asker.name }) : t("question.card.title"))}
      meta={!single ? t("question.progress", { answered: answered.filter(Boolean).length, count: questions.length }) : undefined}
      footer={needsSubmit && current.options.length > 0 ? (
        <button type="button" onClick={() => send(drafts)} disabled={!complete || sending} {...askPrimary(asker?.color)}>
          {multi && single ? t("question.done") : questions.length > 1 ? t("question.submitAll") : t("question.submit")}
        </button>
      ) : undefined}
    >
      {card.questionRequest?.origin === "output" && <p className="-mt-1 mb-2 text-[12px] text-ink-secondary">{t("question.origin.badge")}</p>}
      {questions.length > 1 && (
        <div role="tablist" aria-label={t("question.aria.tabs")} className="-mt-1 mb-3 flex flex-wrap items-center gap-1.5">
          {questions.map((question, index) => (
            <button
              key={`${index}-${question.question}`}
              type="button"
              role="tab"
              aria-selected={index === currentIndex}
              onClick={() => setActive(index)}
              className={cn(ASK_SMALL_PILL, index === currentIndex ? "bg-ink/[0.08] text-ink" : "text-ink-secondary hover:bg-ink/[0.06] hover:text-ink")}
            >
              {answered[index] && <Check size={13} strokeWidth={2.4} className="text-success" />}
              {tabLabel(question, index)}
            </button>
          ))}
        </div>
      )}
      {!title && <ExpandableText text={current.question} className="mb-3 text-[15px] leading-[22px] text-ink" />}
      {multi && <p className="-mt-1 mb-2 text-[12px] text-ink-tertiary">{t("question.multiHint")}</p>}
      {current.options.length > 0 && (
        <div data-quiet={typedPast || undefined}>
          <AskChoices
            choices={current.options}
            label={current.question}
            multi={multi}
            picked={draft.picked}
            sending={sending && oneTap ? sent?.label ?? null : null}
            disabled={sending && !oneTap}
            quiet={typedPast}
            onPick={choose}
          />
        </div>
      )}
      {freeText && (
        <div className={current.options.length > 0 ? "mt-2" : undefined}>
          <AskReply
            label={current.options.length ? t("question.somethingElse") : current.question}
            placeholder={current.options.length ? t("question.somethingElse") : t("question.answerPlaceholder")}
            color={asker?.color}
            value={draft.custom}
            onChange={(value) => update(currentIndex, { custom: value })}
            onSend={typed}
            sending={sending && !sent?.label}
            maxLength={MAX_CUSTOM_ANSWER}
            multiline={!current.options.length}
          />
        </div>
      )}
      {failed && <AskError>{t("ask.error")}</AskError>}
    </AskCard>
  );
}

/** At Full access a bot decides a teammate's question instead of the person: it blocks nothing, and the person may still
 * give their own answer. */
export const decidedByBot = (card: NonNullable<Message["card"]>): boolean =>
  card.answeredBy?.kind === "bot" && card.answered === "answer" && !card.dismissed && !card.expired && !card.stopped;

function DecidedQuestion({ threadId, asker, card, questions }: { threadId: string; asker?: Asker; card: NonNullable<Message["card"]>; questions: readonly AskQuestion[] }) {
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "failed">("idle");
  const name = card.answeredBy?.kind === "bot" ? card.answeredBy.name : "";
  const picked = card.answeredText;
  const question = questions[0]!.question;
  const send = (text: string) => {
    if (!card.requestId) return;
    setState("sending");
    returnFocusToComposer();
    dispatch({ type: "decideRequest", threadId, requestId: card.requestId, behavior: "answer", message: text, onError: () => setState("failed") });
  };
  return (
    <div className="w-full max-w-[560px]">
      <AskSettledLine
        ariaLabel={t("question.aria.card")}
        action={!open ? (
          <button type="button" onClick={() => setOpen(true)} className={ASK_QUIET_BUTTON}>{t(picked === undefined ? "question.decided.answer" : "question.decided.change")}</button>
        ) : undefined}
      >
        {picked === undefined ? t("question.decided.deciding", { name })
          : picked ? <><span>{t("question.decided.picked", { name })}</span> <span className="text-ink-secondary">{picked}</span></>
            : t("question.decided.own", { name })}
      </AskSettledLine>
      {open && (
        <div className="mt-2">
          <p dir="auto" className="mb-2 text-[13px] leading-[18px] text-ink-secondary">{question}</p>
          <AskReply label={question} placeholder={t("question.answerPlaceholder")} color={asker?.color} value={draft} onChange={setDraft}
            onSend={send} sending={state === "sending"} maxLength={MAX_CUSTOM_ANSWER} />
          {state === "failed" && <AskError>{t("ask.error")}</AskError>}
        </div>
      )}
    </div>
  );
}

function SettledQuestion({ card, questions }: { card: NonNullable<Message["card"]>; questions: readonly AskQuestion[] }) {
  const [open, setOpen] = useState(false);
  if (card.stopped) return <AskSettledLine tone="stopped" ariaLabel={t("question.aria.card")}>{t("ask.settled.stopped")}</AskSettledLine>;
  if (card.expired) return <AskSettledLine tone="expired" ariaLabel={t("question.aria.card")}>{t("ask.settled.expired")}</AskSettledLine>;
  const answer = card.answeredText ?? (card.answered === "answer" ? null : undefined);
  if (answer === undefined || card.answered === "unavailable" || card.dismissed && !card.answeredText) {
    return <AskSettledLine tone="closed" ariaLabel={t("question.aria.card")}>{t("question.status.closed")}</AskSettledLine>;
  }
  const line = settledQuestionLine(questions, answer);
  const full = answer ? answerWithoutPreamble(answer) : "";
  const choices = questions.length === 1 ? questions[0]!.options.map((option) => option.label) : [];
  const many = questions.length > 1;
  return (
    <AskSettledLine
      ariaLabel={t("question.aria.card")}
      action={many && full ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className={ASK_QUIET_BUTTON}>
          {open ? t("question.hideDetails") : t("question.details")}
        </button>
      ) : undefined}
      detail={open && full && (
        <div dir="auto" className="ms-[22px] mt-1.5 whitespace-pre-wrap break-words rounded-xl bg-ink/[0.045] px-3 py-2 text-[13px] leading-5 text-ink-secondary">
          {full}
        </div>
      )}
    >
      {many || !line.value ? <span>{line.label}{line.value && <span className="text-ink-secondary"> · {line.value}</span>}</span> : settledAnswer(line.value, choices)}
    </AskSettledLine>
  );
}
