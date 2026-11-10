import { useEffect, useState } from "react";
import { ArrowUp, Check, LoaderCircle, X } from "lucide-react";
import { formatQuestionAnswers, MAX_CUSTOM_ANSWER, type AskQuestion } from "../../../shared/ask-question";
import type { InboxRow } from "../../../shared/inbox";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { imeComposing } from "@/lib/send-key";
import type { CardResponse } from "@/lib/card-answer";
import { askPrimary, ASK_ICON_SHAPE, AskError, type Asker } from "../AskCard";
import { cardAnswerFor } from "../bot-access/access-card";
import { recommendedOf } from "./inbox-answer";
import { closeResponse } from "./inbox-view";

const KEYED_CHOICES = 9;

export function questionResponse(row: InboxRow, question: AskQuestion, picked: readonly string[], note: string): CardResponse | null {
  const words = note.trim();
  if (!picked.length && !words) return null;
  if (row.card?.questionRequest) {
    const message = formatQuestionAnswers([question], [[...picked, ...(words ? [words] : [])]]);
    return message ? { behavior: "answer", message } : null;
  }
  const chosen = picked.map((label) => cardAnswerFor(row.card, label)).join(", ");
  return { behavior: "answer", message: chosen && words ? `${chosen}\n\n${words}` : chosen || words };
}

const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

export function InboxQuestionAnswer({ row, question, asker, onAnswer }: {
  row: InboxRow;
  question: AskQuestion;
  asker?: Asker;
  /** Sends the answer; `failed` runs when it didn't reach the card. */
  onAnswer(response: CardResponse, failed: () => void): void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const multi = question.multiSelect === true;
  const freeText = question.custom !== false;
  const response = questionResponse(row, question, picked, note);

  const toggle = (label: string) => {
    if (sending) return;
    setPicked((now) => (now.includes(label) ? now.filter((one) => one !== label) : multi ? [...now, label] : [label]));
  };
  const send = (answer: CardResponse | null = response) => {
    if (!answer || sending) return;
    setFailed(false);
    setSending(true);
    onAnswer(answer, () => { setSending(false); setFailed(true); });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || editable(event.target)) return;
      const index = Number(event.key) - 1;
      const option = Number.isInteger(index) && index >= 0 && index < KEYED_CHOICES ? question.options[index] : undefined;
      if (!option) return;
      event.preventDefault();
      toggle(option.label);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <div data-inbox-answer="question" className="rounded-2xl bg-ink/[0.03] p-2 ring-[0.5px] ring-ink/[0.12]">
      {question.options.length > 0 && (
        <div className="flex items-start gap-1">
          <div role="group" aria-label={question.question} className="min-w-0 flex-1 space-y-1.5">
            {question.options.map((option, index) => {
              const { label, recommended } = recommendedOf(option.label);
              const on = picked.includes(option.label);
              return (
                <button key={option.label} type="button" role={multi ? "checkbox" : "radio"} aria-checked={on} data-inbox-option={label} disabled={sending}
                  onClick={() => toggle(option.label)}
                  className={cn("flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60",
                    on ? "bg-ink/[0.10]" : "bg-ink/[0.045] hover:bg-ink/[0.075]")}>
                  <span aria-hidden="true" className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px] border",
                    on ? "border-ink bg-ink text-app" : "border-ink/35")}>
                    {on && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium leading-5 text-ink">{label}</span>
                    {recommended && (
                      <span data-inbox-recommended className="mt-0.5 inline-flex items-center gap-1 rounded-md bg-ink/[0.07] px-1.5 py-px text-[11px] font-medium text-ink-secondary">
                        <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />{t("inbox.recommended")}
                      </span>
                    )}
                    {option.description && <span className="mt-0.5 block text-[12px] leading-[18px] text-ink-secondary">{option.description}</span>}
                  </span>
                  {index < KEYED_CHOICES && <span aria-hidden="true" className="shrink-0 text-[11px] tabular-nums text-ink-tertiary">{index + 1}</span>}
                </button>
              );
            })}
          </div>
          <button type="button" data-inbox-action="close" onClick={() => send(closeResponse(row))} disabled={sending}
            aria-label={t("inbox.action.closeQuestion")} title={t("inbox.action.closeQuestion")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-ink/[0.07] hover:text-ink">
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
      <form className="mt-1 flex items-end gap-2 px-1.5" onSubmit={(event) => { event.preventDefault(); send(); }}>
        {freeText ? (
          <textarea dir="auto" rows={1} value={note} maxLength={MAX_CUSTOM_ANSWER} disabled={sending}
            aria-label={question.options.length ? t("inbox.note") : question.question}
            placeholder={question.options.length ? t("inbox.note") : t("question.answerPlaceholder")}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || imeComposing(event.nativeEvent)) return;
              event.preventDefault();
              send();
            }}
            className="block max-h-32 min-h-9 flex-1 resize-none bg-transparent py-2 text-[13px] leading-5 text-ink outline-none placeholder:text-ink-tertiary [field-sizing:content]" />
        ) : <span className="flex-1" />}
        <button type="submit" data-inbox-send disabled={!response || sending} aria-label={t("chat.send")} title={t("chat.send")} aria-busy={sending || undefined}
          {...askPrimary(asker?.color, ASK_ICON_SHAPE)}>
          {sending ? <LoaderCircle size={16} aria-hidden="true" className="motion-safe:animate-spin" /> : <ArrowUp size={16} strokeWidth={2.4} aria-hidden="true" />}
        </button>
      </form>
      {failed && <AskError>{t("ask.error")}</AskError>}
    </div>
  );
}
