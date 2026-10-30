import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type { Bot, Message } from "@/state/store";
import { handoffResult } from "@/lib/handoff-result";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { BotAvatar } from "./Avatar";

export function HandoffReply({ message, children }: { message: Message; children: ReactNode }) {
  const result = handoffResult(message);
  const doneWhen = message.doneWhen?.trim();
  if (doneWhen) {
    return (
      <div className="flex flex-col items-start gap-1">
        {children}
        <p data-handoff-done-when className="max-w-[min(38rem,100%)] truncate px-3 text-[12px] text-ink-secondary" title={doneWhen}>
          {t("chat.handoffDoneWhen", { criteria: doneWhen })}
        </p>
      </div>
    );
  }
  if (!result) return <div className="flex justify-start">{children}</div>;
  return (
    <div className="flex flex-col items-start gap-1" data-handoff-reply={message.roomRequest?.id}>
      {children}
      {result.more === null
        ? <p className={"max-w-[min(38rem,100%)] rounded-xl border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] break-words text-ink-secondary"}>{result.preview}</p>
        : (
          <details className="group/reply w-fit max-w-full rounded-xl border border-hairline/40 bg-panel text-[13px] open:w-[min(38rem,100%)]">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-1.5 text-ink-secondary hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
              <span className="min-w-0 max-w-[34rem] truncate">{result.preview}</span>
              <ChevronRight size={13} className="ml-auto shrink-0 group-open/reply:rotate-90" aria-hidden="true" />
            </summary>
            <p className="max-h-80 overflow-auto border-t border-hairline/40 px-3 py-2 whitespace-pre-wrap break-words text-ink">{result.more}</p>
          </details>
        )}
    </div>
  );
}

/** A row about a teammate's work elsewhere (a chat or a room): a pill with their avatar and the row's name, and their reply under it. */
export function HandoffChip({ message, bots, title, onClick }: { message: Message; bots: readonly Bot[]; title: string; onClick: () => void }) {
  const comm = message.comm;
  if (!comm || !message.tool) return null;
  const withBot = bots.find((bot) => bot.id === comm.withBotId);
  return (
    <HandoffReply message={message}>
      <button type="button" onClick={onClick} title={title} className={cn("ui-pill", message.tool.ok === false && "text-danger")}>
        <BotAvatar bot={withBot ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} animated={false} />
        <span className="max-w-[480px] truncate">{message.tool.name}</span>
        <ChevronRight size={13} />
      </button>
    </HandoffReply>
  );
}
