import { useState } from "react";
import { Check, X } from "lucide-react";
import { usePermissionAutoApprove, useStore, type Message } from "@/state/store";
import { cn } from "@/lib/cn";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

export function OptionCard({
  botId,
  threadId,
  message,
}: {
  botId: string;
  threadId?: string;
  message: Message;
}) {
  const { dispatch } = useStore();
  const { countdown, cancel } = usePermissionAutoApprove();
  const [custom, setCustom] = useState("");
  const [clickedAnswer, setClickedAnswer] = useState<string | null>(null);
  const card = message.card;
  if (!card || card.dismissed) return null;
  const timerKey = `${threadId ?? botId}:${message.id}`;
  const timer = countdown[timerKey];
  const isPermission = card.requestType === "permission";
  // Drivers can resolve with lower-case "allow"/"deny"; show the actual label.
  const selectedAnswer = card.answered
    ? card.options.find(option => option.toLowerCase() === card.answered?.toLowerCase()) ?? card.answered
    : undefined;

  const answer = (text: string) => {
    if (!text.trim() || card.answered || timer?.firing) return;
    setClickedAnswer(text.trim());
    cancel(timerKey);
    dispatch({ type: "answerCard", botId, threadId, messageId: message.id, answer: text.trim() });
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
          type="button"
          aria-label="Dismiss prompt"
          onClick={() => {
            cancel(timerKey);
            dispatch({ type: "dismissCard", botId, threadId, messageId: message.id });
          }}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      {card.autoApproved ? (
        <div className="mt-3 text-[12px] font-medium text-success">Auto-approved after inactivity</div>
      ) : isPermission && !card.answered && timer?.remaining !== undefined ? (
        <div className="mt-3 flex items-center justify-between gap-3 text-[12px] text-ink-secondary">
          <span>Auto-approving in {timer.remaining}s</span>
          <button type="button" onClick={() => cancel(timerKey)} className="font-medium text-accent hover:underline">Cancel auto-approve</button>
        </div>
      ) : isPermission && !card.answered && timer?.cancelled ? (
        <div className="mt-3 text-[12px] text-ink-secondary">Auto-approve cancelled. Choose Allow or Deny.</div>
      ) : isPermission && !card.answered && timer?.firing ? (
        <div className="mt-3 text-[12px] text-ink-secondary">Auto-approving…</div>
      ) : null}

      <div className="mt-3 overflow-hidden rounded-lg border border-hairline/40">
        {card.options.map((opt, i) => {
          const selected = selectedAnswer === opt;
          const animate = selected && clickedAnswer === opt;
          return (
            <button
              type="button"
              key={opt}
              disabled={!!card.answered || !!timer?.firing}
              aria-pressed={selected}
              onClick={() => answer(opt)}
              className={cn(
                "flex w-full items-center gap-3 px-3 py-3 text-left text-[15px] text-ink transition-[background-color,opacity] duration-200 motion-reduce:transition-none",
                i > 0 && "border-t border-hairline/40",
                selected
                  ? "option-choice-selected font-semibold text-accent"
                  : card.answered ? "opacity-40" : "hover:bg-raised/60 disabled:hover:bg-transparent",
                animate && "option-choice-pulse",
              )}
            >
              <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-md text-[12px] font-medium", selected ? "bg-accent text-white" : "bg-raised text-ink-secondary")}>
                {selected ? <Check size={15} strokeWidth={3} aria-hidden className={animate ? "option-check-pop" : undefined} /> : LETTERS[i]}
              </span>
              <span className="min-w-0 flex-1">{opt}</span>
              {selected && <span className="shrink-0 text-[11px] font-medium text-accent">Selected</span>}
            </button>
          );
        })}
      </div>

      {selectedAnswer && <div role="status" aria-live="polite" className="mt-3 text-[12px] text-ink-secondary">Selected: <span className="font-semibold text-accent">{selectedAnswer}</span></div>}

      {!card.answered && !isPermission && (
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && answer(custom)}
          placeholder="Type your own answer"
          className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
        />
      )}
    </div>
  );
}
