import type { Bot, Message } from "@/state/store";
import { ApprovalCard } from "./ApprovalCard";
import { OptionCard } from "./OptionCard";

export function GroupRequestCard({
  groupId,
  bot,
  message,
}: {
  groupId: string;
  bot?: Bot;
  message: Message;
}) {
  if (message.kind !== "options" || !message.card?.requestId) return null;
  return (
    <div className="flex justify-start">
      {message.card.tool
        ? <ApprovalCard bot={bot} message={message} />
        : <OptionCard groupId={groupId} message={message} />}
    </div>
  );
}
