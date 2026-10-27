import { Info, RefreshCw } from "lucide-react";
import { statusActivity } from "@/lib/activity-runs";
import type { Message } from "@/state/store";
import { CancelledTurnRow } from "./CancelledTurnRow";
import { FirstReplyRescueRow } from "./FirstReplyRescueRow";

export function StatusActivityRow({ message }: { message: Message }) {
  const status = statusActivity(message);
  if (!status) return null;
  if (status.kind === "stopped") return <CancelledTurnRow name={message.tool?.name} />;
  if (message.tool?.rescue) return <FirstReplyRescueRow rescue={message.tool.rescue} text={status.text} at={message.at} />;
  const Icon = status.kind === "recovery" ? RefreshCw : Info;
  return (
    <div role="status" className="flex w-fit max-w-full items-start gap-2 rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink-secondary">
      <Icon size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">{status.text}</span>
    </div>
  );
}
