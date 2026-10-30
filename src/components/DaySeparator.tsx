// The day and time line between a conversation's days (ChatView.tsx).
import { cn } from "@/lib/cn";
import { dayLabel } from "@/lib/transcript-derivations";
import { formatTime } from "@/state/store";

export function DaySeparator({ at, today, simple = false }: { at: number; today: number; simple?: boolean }) {
  return (
    <div className={cn("text-center text-[13px] text-ink-secondary", simple ? "pt-5 pb-1 leading-[18px]" : "py-3")}>
      {dayLabel(at, today)} {formatTime(at)}
    </div>
  );
}
