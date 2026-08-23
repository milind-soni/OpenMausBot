import { useEffect, useRef, useState } from "react";
import { TriangleAlert, X } from "lucide-react";
import { useStore, type Message } from "@/state/store";
import { cn } from "@/lib/cn";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

export interface QuestionAnswerPayload {
  answer: string;
  selected: string[];
  custom?: string;
}

export interface QuestionSubmissionGate {
  claim(): boolean;
  reset(): void;
}

export function createQuestionSubmissionGate(): QuestionSubmissionGate {
  let submitted = false;
  return {
    claim() {
      if (submitted) return false;
      submitted = true;
      return true;
    },
    reset() {
      submitted = false;
    },
  };
}

export function questionAnswerPayload(selected: string[], custom: string): QuestionAnswerPayload {
  const customAnswer = custom.trim() || undefined;
  const payload: QuestionAnswerPayload = {
    answer: customAnswer ?? (selected.join(", ") || "Skipped"),
    selected,
  };
  if (customAnswer) payload.custom = customAnswer;
  return payload;
}

interface OptionCardViewProps {
  message: Message;
  custom: string;
  selected: string[];
  setCustom(value: string): void;
  toggle(option: string): void;
  claimSubmission(): boolean;
  onAnswer(payload: QuestionAnswerPayload): void;
  onDismiss(): void;
}

export function OptionCardView({
  message,
  custom,
  selected,
  setCustom,
  toggle,
  claimSubmission,
  onAnswer,
  onDismiss,
}: OptionCardViewProps) {
  const card = message.card;
  const answered = card?.answered !== undefined;
  const unavailable = card?.answered === "unavailable";
  if (!card || (card.dismissed && !unavailable)) return null;

  const answer = (payload: QuestionAnswerPayload) => {
    if (claimSubmission()) onAnswer(payload);
  };
  const dismiss = () => {
    if (claimSubmission()) onDismiss();
  };

  return (
    <div className="w-full max-w-[840px] rounded-2xl border border-hairline/50 bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[16px] font-semibold text-ink">{card.title}</div>
          <div className="mt-0.5 text-[14px] text-ink-secondary">
            {card.subtitle}
          </div>
        </div>
        <button
          onClick={dismiss}
          disabled={answered}
          aria-label="Dismiss question"
          className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      <div className="mt-3 overflow-hidden rounded-lg border border-hairline/40">
        {card.options.map((opt, i) => (
          <button
            key={opt}
            disabled={answered}
            onClick={() => {
              if (card.multiSelect) return toggle(opt);
              answer(questionAnswerPayload([opt], ""));
            }}
            className={cn(
              "flex w-full items-center gap-3 px-3 py-3 text-left text-[15px] text-ink",
              i > 0 && "border-t border-hairline/40",
              // `raised` is the wrong fill here: the light skins define it as
              // pure white, the same value as the card underneath, so a
              // hovered or answered row used to be invisible. `raised-hover`
              // is the one tone every skin guarantees stands off a surface.
              (card.multiSelect ? selected.includes(opt) : card.answered === opt)
                ? "bg-raised-hover"
                : "hover:bg-raised-hover/60 disabled:hover:bg-transparent",
            )}
          >
            {/* `control` is the chip tone every skin guarantees on a card; the
                hairline keeps it a chip even on a row that is itself filled */}
            <span className="flex size-6 items-center justify-center rounded-md border border-hairline/50 bg-control text-[12px] font-medium text-ink-secondary">
              {LETTERS[i]}
            </span>
            {opt}
          </button>
        ))}
      </div>

      {unavailable && (
        <div className="mt-3 flex items-center gap-1.5 text-[13px] text-warning">
          <TriangleAlert size={14} /> Unavailable · no answer was sent
        </div>
      )}

      {card.multiSelect && !answered && (
        <button
          onClick={() => answer(questionAnswerPayload(selected, custom))}
          className="mt-3 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {selected.length || custom.trim() ? "Submit selection" : "Skip"}
        </button>
      )}

      {/* a permission ask has no free-text answer — the broker only accepts
          allow/deny, so typing here used to fail silently */}
      {!answered && !card.tool && (
        <div className="mt-3 flex gap-2">
          <input
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || card.multiSelect) return;
              event.preventDefault();
              answer(questionAnswerPayload([], custom));
            }}
            placeholder="Type your own answer"
            className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
          />
          {!card.multiSelect && (
            <button
              onClick={() => answer(questionAnswerPayload([], custom))}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white"
            >
              {custom.trim() ? "Submit" : "Skip"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function OptionCard({
  botId,
  groupId,
  message,
}: {
  botId?: string;
  groupId?: string;
  message: Message;
}) {
  const { dispatch } = useStore();
  const [custom, setCustom] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const submission = useRef(createQuestionSubmissionGate());
  const card = message.card;
  const answered = card?.answered !== undefined;

  useEffect(() => {
    if (!answered) submission.current.reset();
  }, [answered]);
  if (!card || (card.dismissed && card.answered !== "unavailable")) return null;

  const answer = (payload: QuestionAnswerPayload) => {
    const action = {
      messageId: message.id,
      ...payload,
    };
    if (groupId) dispatch({ type: "answerGroupCard", groupId, ...action });
    else if (botId) dispatch({ type: "answerCard", botId, ...action });
  };
  const dismiss = () => {
    if (groupId) dispatch({ type: "dismissGroupCard", groupId, messageId: message.id });
    else if (botId) dispatch({ type: "dismissCard", botId, messageId: message.id });
  };
  const toggle = (option: string) => {
    setSelected((current) => current.includes(option) ? current.filter((value) => value !== option) : [...current, option]);
  };

  return <OptionCardView
    message={message}
    custom={custom}
    selected={selected}
    setCustom={setCustom}
    toggle={toggle}
    claimSubmission={() => submission.current.claim()}
    onAnswer={answer}
    onDismiss={dismiss}
  />;
}
