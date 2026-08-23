// Emoji reactions — iMessage grammar: a hover bar to give one, small chips
// under the bubble to show them. `by` is "user" or a member botId; in rooms
// a bot's own reactions render with its name in the tooltip.
import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { useStore, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";

export const REACTION_SET = ["👍", "❤️", "😂", "🎉", "👀"] as const;

/** The extended palette behind the "+". Kept to single-grapheme emoji the
 * API's 8-char cap carries comfortably — no long ZWJ sequences. */
const EXTENDED_SET = [
  "👍", "👎", "❤️", "🔥", "🚀", "🧠",
  "💡", "🫡", "💯", "❓", "‼️", "😂",
  "🤖", "🎯", "👀", "🤝", "⚡", "💎",
  "💀", "✨", "🎉", "☕",
] as const;

export function ReactionBar({ threadId, message }: { threadId: string; message: Message }) {
  const { dispatch } = useStore();
  const [pickerOpen, setPickerOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // same dismiss contract as the sidebar menus: outside click, Escape, blur
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!pickerRef.current?.contains(target) && !anchorRef.current?.contains(target)) {
        setPickerOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPickerOpen(false);
    const onBlur = () => setPickerOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [pickerOpen]);

  return (
    <div className="relative">
      <div
        ref={anchorRef}
        className="flex items-center gap-0.5 rounded-full border border-hairline/40 bg-panel px-1 py-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {REACTION_SET.map((emoji) => (
          <button
            key={emoji}
            onClick={() => dispatch({ type: "toggleReaction", threadId, messageId: message.id, emoji })}
            aria-label={`React ${emoji}`}
            className="rounded-full px-1 py-0.5 text-[13px] leading-none hover:bg-control"
          >
            {emoji}
          </button>
        ))}
        <button
          onClick={() => setPickerOpen((o) => !o)}
          aria-label="More reactions"
          aria-expanded={pickerOpen}
          title="More reactions"
          className="flex size-[22px] items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink"
        >
          {pickerOpen ? <X size={12} /> : <Plus size={12} />}
        </button>
      </div>
      {pickerOpen && (
        <div
          ref={pickerRef}
          data-reaction-picker
          className="absolute bottom-full right-0 z-40 mb-1.5 w-[218px] rounded-xl border border-hairline/50 bg-card p-2 shadow-2xl shadow-black/60"
        >
          <div className="grid grid-cols-6 gap-0.5">
            {EXTENDED_SET.map((emoji) => (
              <button
                key={emoji}
                onClick={() => {
                  dispatch({ type: "toggleReaction", threadId, messageId: message.id, emoji });
                  setPickerOpen(false);
                }}
                aria-label={`React ${emoji}`}
                className="rounded-lg px-1 py-1 text-[15px] leading-none hover:bg-control"
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ReactionChips({
  threadId,
  message,
  members,
  align = "left",
}: {
  threadId: string;
  message: Message;
  members?: Bot[];
  align?: "left" | "right";
}) {
  const { dispatch } = useStore();
  const reactions = message.reactions ?? [];
  if (!reactions.length) return null;
  // group identical emoji into one chip with a count
  const grouped = new Map<string, string[]>();
  for (const r of reactions) grouped.set(r.emoji, [...(grouped.get(r.emoji) ?? []), r.by]);
  const nameOf = (by: string) =>
    by === "user" ? "You" : (members?.find((b) => b.id === by)?.name ?? "Bot");
  return (
    <div className={cn("mt-1 flex flex-wrap gap-1", align === "right" ? "justify-end" : "justify-start")}>
      {[...grouped].map(([emoji, bys]) => (
        <button
          key={emoji}
          onClick={() => dispatch({ type: "toggleReaction", threadId, messageId: message.id, emoji })}
          title={bys.map(nameOf).join(", ")}
          className={cn(
            "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[12px] leading-none",
            bys.includes("user")
              ? "border-accent/50 bg-accent/15"
              : "border-hairline/40 bg-panel hover:bg-control",
          )}
        >
          <span>{emoji}</span>
          {bys.length > 1 && <span className="text-[11px] text-ink-secondary">{bys.length}</span>}
        </button>
      ))}
    </div>
  );
}
