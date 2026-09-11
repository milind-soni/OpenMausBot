import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Message } from "@/state/store";

/** Quiet transcript marker for a forced host-session reset. Earlier
 * messages stay in the thread; the model received the state vector. */
export function CompactionDivider({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const summary = (message.compaction?.summary ?? message.text ?? "").trim();
  return (
    <div className="px-5 py-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-center gap-1.5 py-1 text-[12px] text-ink-secondary hover:text-ink"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Context refreshed — host session reset · earlier messages stay
      </button>
      {open && summary && (
        <pre className="mx-auto mt-1 max-w-[40rem] overflow-x-auto whitespace-pre-wrap rounded-lg bg-inset px-3 py-2 text-[12px] leading-relaxed text-ink-secondary">
          {summary}
        </pre>
      )}
    </div>
  );
}
