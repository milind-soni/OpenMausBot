// A bot reply, split the way it was written: the lead, then the detail.
//
// A reply has two audiences — somebody reading the transcript and somebody
// listening to it — and `shared/reply-sections.ts` decides where the line
// between them falls. The lead is the message here; the sections under it sit
// behind one row, the same reversible fold this transcript already uses for
// tool runs and turn narration, and for the same reason: the reader came for
// the answer, and the diff should be one click away instead of in the way.
//
// A reply that never adopted the convention renders as one markdown block,
// exactly as it did before there was a convention.
import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";

import type { MentionPeer } from "@/lib/mentions";
import { t } from "@/lib/i18n";
import { splitReply } from "../../shared/reply-sections";
import type { MessageAttachmentContext } from "./AttachmentPreview";
import { ChatMarkdown } from "./ChatMarkdown";

/** A fold row has one line, and a reply can have eight sections. */
const MAX_TITLES = 3;

export function ReplySections({
  text,
  message,
  mentionPeers,
  everyone,
}: {
  text: string;
  /** file actions and inline images need the thread they belong to */
  message?: MessageAttachmentContext;
  mentionPeers?: readonly MentionPeer[];
  everyone?: boolean;
}) {
  const parts = useMemo(() => splitReply(text), [text]);
  const [open, setOpen] = useState(false);
  const markdown = (body: string) => (
    <ChatMarkdown text={body} message={message} mentionPeers={mentionPeers} everyone={everyone} />
  );

  // no headings: nothing was authored to fold, and splitting a reply the
  // reader never structured would hide a paragraph they did not ask to hide.
  // It renders `display`, not the raw prop, so a payload stripped for the
  // voice is gone from the reader's half too.
  if (!parts.structured) return markdown(parts.display);

  const shown = parts.titles.slice(0, MAX_TITLES).join(" · ");
  return (
    <div className="flex flex-col gap-1.5">
      {/* a reply that opened with its own heading: the label it chose, kept
          for the eye, and out of the spoken lead */}
      {parts.title && <div className="text-[13px] font-semibold text-ink-secondary">{parts.title}</div>}
      {parts.lead ? markdown(parts.lead) : null}
      {parts.detail ? (
        <>
          <div className="flex justify-start">
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              className="flex max-w-full items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control"
            >
              <ChevronRight size={13} className={open ? "rotate-90" : undefined} />
              <span className="truncate">
                {t(open ? "chat.reply.hideDetail" : "chat.reply.showDetail")}
                {shown ? ` · ${shown}` : ""}
              </span>
            </button>
          </div>
          {open ? markdown(parts.detail) : null}
        </>
      ) : null}
    </div>
  );
}
