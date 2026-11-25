import { use } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ChatBusyContext } from "@/components/MessageActions";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";

/** The arrows between versions of a message; it alone reads whether the turn runs, so a bubble does not redraw when that changes. */
export function VersionSwitch({ versions, index, onSwitch }: { versions: readonly Message[]; index: number; onSwitch: (version: Message) => void }) {
  const busy = use(ChatBusyContext);
  const go = (version: Message | undefined) => { if (version && !busy) onSwitch(version); };
  return (
    <div className="mt-1 flex items-center gap-0.5 pr-1 text-[12px] text-ink-secondary">
      <button
        onClick={() => go(versions[index - 1])}
        disabled={index <= 0 || busy}
        className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
        title={t("chat.previousVersion")}
      >
        <ChevronLeft size={14} />
      </button>
      <span className="tabular-nums">
        {index + 1}/{versions.length}
      </span>
      <button
        onClick={() => go(versions[index + 1])}
        disabled={index >= versions.length - 1 || busy}
        className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
        title={t("chat.nextVersion")}
      >
        <ChevronRight size={14} />
      </button>
    </div>
  );
}
