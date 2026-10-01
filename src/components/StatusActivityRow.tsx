import { Info, RefreshCw } from "lucide-react";
import { statusActivity } from "@/lib/activity-runs";
import type { Message } from "@/state/store";

/** An engine's own word about this conversation: automatic recovery moved it
 * to another engine, or the engine runs another model than the one saved.
 * Always shown, whatever Settings → Tool calls says. */
export function StatusActivityRow({ message }: { message: Message }) {
  const status = statusActivity(message);
  if (!status) return null;
  const Icon = status.kind === "recovery" ? RefreshCw : Info;
  return (
    <div role="status" className="flex w-fit max-w-full items-start gap-2 rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink-secondary">
      <Icon size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">{status.text}</span>
    </div>
  );
}
