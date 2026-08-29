// A folded stretch of tool chips: one row saying what ran, click to open.
//
// Collapsed by default. Failures stay visible in the summary without dumping
// internal commands into the transcript; search navigation can still force
// the matching run open.
import { useEffect, useState } from "react";
import { ChevronRight, Check, X } from "lucide-react";
import type { Message } from "@/state/store";
import { describeRun } from "@/lib/activity-runs";
import { cn } from "@/lib/cn";

export function ActivityRun({
  messages,
  forceOpen = false,
  children,
}: {
  messages: Message[];
  /** landing on a step inside this run — a search hit cannot scroll to a
   * row that a fold has kept out of the DOM */
  forceOpen?: boolean;
  /** the individual chips, rendered by whichever transcript owns them */
  children: React.ReactNode;
}) {
  const failed = messages.some((message) => message.tool?.ok === false);
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  if (open) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex min-w-0 justify-start">
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-expanded
            className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control"
          >
            <ChevronRight size={13} className="shrink-0 rotate-90" />
            <span className="min-w-0 truncate">{describeRun(messages)}</span>
          </button>
        </div>
        {children}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 justify-start">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        title="Show every step"
        className={cn(
          "flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] hover:bg-control",
          failed ? "text-danger" : "text-ink-secondary",
        )}
      >
        {failed ? <X size={13} className="shrink-0" /> : <Check size={13} className="shrink-0 text-success" />}
        <span className="min-w-0 truncate">{describeRun(messages)}</span>
        <ChevronRight size={13} className="shrink-0" />
      </button>
    </div>
  );
}
