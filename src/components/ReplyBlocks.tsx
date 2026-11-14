import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import type { ReplyBlock } from "@/lib/formatted-reply";
import { joinedCorners, SIMPLE_BOT_BUBBLE, type BubbleJoin } from "./chat-bubble";

/** Simple mode's reply with tables: one bubble holding the prose and each table in order. The bubble may grow to the
 * message's card width so a table's columns show; its prose keeps the reading width. The hover tray sits beside it. */
export function ReplyBlocks({ blocks, join, citation, tray, render }: {
  blocks: readonly ReplyBlock[];
  join?: BubbleJoin;
  citation: { messageId: string; ownerType: "bot" | "group"; ownerId: string; threadId: string };
  tray?: ReactNode;
  render: (text: string) => ReactNode;
}) {
  return (
    <div
      data-reply-blocks
      className="flex w-full items-center gap-1.5"
      data-citation-source={citation.messageId}
      data-citation-owner-type={citation.ownerType}
      data-citation-owner={citation.ownerId}
      data-citation-thread={citation.threadId}
    >
      <div data-chat-bubble="simple" data-reply-bubble className={cn("flex w-fit min-w-0 max-w-[var(--chat-card-pct)] flex-col gap-3", SIMPLE_BOT_BUBBLE,
        joinedCorners("start", { above: Boolean(join?.above), below: Boolean(join?.below) }))}>
        {blocks.map((block, index) => block.kind === "table"
          ? <div key={index} data-reply-table className="min-w-0">{render(block.text)}</div>
          : <div key={index} className="max-w-[var(--chat-bubble-max)]">{render(block.text)}</div>)}
      </div>
      {tray}
    </div>
  );
}
