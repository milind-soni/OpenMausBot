// The day and time line between a conversation's days.
import { dayLabel } from "@/lib/transcript-derivations";
import { formatTime } from "@/state/store";

export function DaySeparator({ at, today }: { at: number; today: number }) {
  return (
    <div className="text-center text-[13px] text-ink-secondary py-3">
      {dayLabel(at, today)} {formatTime(at)}
    </div>
  );
}
