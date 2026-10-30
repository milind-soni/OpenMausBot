import { useMemo, useState } from "react";
import { AudioLines, ChevronRight } from "lucide-react";

import { formatCallDuration } from "../../shared/live-call";
import { callRecordIsPartial, callRecordLines } from "@/lib/call-record";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { CallLineItem, CallSheet } from "./CallSheet";

export function CallRecordRow({ message, transcript, botName, threadId, busy, hasMore }: {
  message: Message;
  transcript: readonly Message[];
  botName: string;
  threadId?: string;
  busy: boolean;
  hasMore: boolean;
}) {
  const [open, setOpen] = useState(false);
  const call = message.call;
  const callId = call?.callId;
  const lines = useMemo(() => (callId === undefined ? [] : callRecordLines(transcript, callId)), [transcript, callId]);
  if (!call) return null;
  const title = call.title?.trim() || t("chat.callRecord.title", { name: botName });
  const duration = formatCallDuration(call.seconds);
  const partial = callRecordIsPartial(transcript, call, hasMore);
  // A labelled group, not a <section>: a named section is a landmark, and every call would add one.
  // The title line is the button a keyboard reaches, since a list cannot sit inside a button.
  return (
    <>
      <div
        role="group"
        data-testid="call-record"
        aria-label={t("chat.callRecord.label", { title, duration })}
        title={new Date(call.endedAt).toLocaleString()}
        onClick={() => setOpen(true)}
        className="mx-auto flex w-fit max-w-[min(32rem,90%)] cursor-pointer flex-col items-center gap-1 rounded-2xl border border-hairline/40 bg-panel px-4 py-2 text-[13px] text-ink-secondary transition-colors hover:border-hairline hover:bg-raised"
      >
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={t("chat.callRecord.open", { title })}
          className="flex max-w-full items-center gap-2 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <AudioLines size={14} aria-hidden="true" className="shrink-0 text-accent" />
          <span className="min-w-0 truncate font-medium text-ink">{title}</span>
          <span className="shrink-0 tabular-nums">{`· ${duration}`}</span>
          <ChevronRight size={13} aria-hidden="true" className="-mr-1 shrink-0 text-ink-tertiary" />
        </button>
        {lines.length > 0 && (
          <ul className="flex max-w-full min-w-0 flex-col gap-0.5 text-[13px]">
            {lines.map((line) => <CallLineItem key={line.id} line={line} busy={busy} />)}
          </ul>
        )}
        {partial && <p className="max-w-full text-center text-[12px] text-ink-tertiary">{t("chat.callRecord.partial")}</p>}
      </div>
      {open && (
        <CallSheet
          message={message}
          transcript={transcript}
          botName={botName}
          threadId={threadId}
          busy={busy}
          partial={partial}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
