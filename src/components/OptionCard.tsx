import { useState } from "react";
import { X } from "lucide-react";
import { useStore, type Message } from "@/state/store";
import { cn } from "@/lib/cn";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

export function OptionCard({
  botId,
  message,
}: {
  botId: string;
  message: Message;
}) {
  const { dispatch } = useStore();
  const [custom, setCustom] = useState("");
  const card = message.card;
  if (!card || card.dismissed) return null;

  const answer = (text: string) => {
    if (!text.trim()) return;
    dispatch({ type: "answerCard", botId, messageId: message.id, answer: text.trim() });
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
          onClick={() =>
            dispatch({ type: "dismissCard", botId, messageId: message.id })
          }
          className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      <div className="mt-3 overflow-hidden rounded-lg border border-hairline/40">
        {card.options.map((opt, i) => (
          <button
            key={opt}
            disabled={!!card.answered}
            onClick={() => answer(opt)}
            className={cn(
              "flex w-full items-center gap-3 px-3 py-3 text-left text-[15px] text-ink",
              i > 0 && "border-t border-hairline/40",
              // `raised` is the wrong fill here: the light skins define it as
              // pure white, the same value as the card underneath, so a
              // hovered or answered row used to be invisible. `raised-hover`
              // is the one tone every skin guarantees stands off a surface.
              card.answered === opt
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

      {/* a permission ask has no free-text answer — the broker only accepts
          allow/deny, so typing here used to fail silently */}
      {!card.answered && !card.tool && (
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
