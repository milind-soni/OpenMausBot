// The checkbox roster shared by "New Room" and "Manage Members": one row per
// bot, a tick on the ones picked. Both callers own their own selection state —
// this only draws it, so the two lists can never drift apart visually.
import { Check } from "lucide-react";
import type { Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { cn } from "@/lib/cn";

export function BotPickerList({
  bots,
  picked,
  onToggle,
  emptyHint,
}: {
  bots: Bot[];
  picked: Set<string>;
  onToggle: (id: string) => void;
  /** shown in place of the list when there is nothing to pick from */
  emptyHint: string;
}) {
  return (
    <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
      {bots.length === 0 && <div className="px-2 py-4 text-center text-[13px] text-ink-secondary">{emptyHint}</div>}
      {bots.map((b) => (
        <button
          key={b.id}
          onClick={() => onToggle(b.id)}
          role="checkbox"
          aria-checked={picked.has(b.id)}
          className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-raised/50"
        >
          <BotAvatar bot={b} state="happy" size={28} />
          <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{b.name}</span>
          <span
            className={cn(
              "flex size-[18px] shrink-0 items-center justify-center rounded-full border",
              picked.has(b.id) ? "border-accent bg-accent text-white" : "border-hairline/60",
            )}
          >
            {picked.has(b.id) && <Check size={12} />}
          </span>
        </button>
      ))}
    </div>
  );
}
