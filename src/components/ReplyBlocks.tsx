import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import type { ReplyBlock } from "@/lib/formatted-reply";
import { joinedCorners, SIMPLE_BOT_BUBBLE, SIMPLE_BUBBLE_MAX, type BubbleJoin } from "./chat-bubble";

/** Simple mode's reply with tables: the prose in bubbles and each table in its own card at the message's full width, so
 * every column shows. The first and last prose bubbles take the row's join corners; a table breaks the join. The hover
 * tray sits beside the first block. */
export function ReplyBlocks({ blocks, join, citation, tray, render }: {
  blocks: readonly ReplyBlock[];
  join?: BubbleJoin;
  citation: { messageId: string; ownerType: "bot" | "group"; ownerId: string; threadId: string };
  tray?: ReactNode;
  render: (text: string) => ReactNode;
}) {
  const last = blocks.length - 1;
  return (
    <div
      data-reply-blocks
      className="flex w-full flex-col items-start gap-1"
      data-citation-source={citation.messageId}
      data-citation-owner-type={citation.ownerType}
      data-citation-owner={citation.ownerId}
      data-citation-thread={citation.threadId}
    >
      {blocks.map((block, index) => {
        const body = block.kind === "table"
          ? <div key={index} data-reply-table className="my-2 w-full max-w-[var(--chat-card-pct)] first:mt-0 last:mb-0">{render(block.text)}</div>
          : (
            <div key={index} data-chat-bubble="simple" className={cn("w-fit", SIMPLE_BUBBLE_MAX, SIMPLE_BOT_BUBBLE,
              joinedCorners("start", { above: index === 0 && Boolean(join?.above), below: index === last && Boolean(join?.below) }))}>
              {render(block.text)}
            </div>
          );
        return index === 0 && tray ? <div key={index} className="flex w-full items-center gap-1.5">{body}{tray}</div> : body;
      })}
    </div>
  );
}
