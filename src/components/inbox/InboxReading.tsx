// One line of the inbox read in full inside the panel: who it is from, what about, when and where it came from, all of
// it, then its answer: an ask's own card, the very one it asks with in the chat, or a reply, and the way back to the list.
import { useState } from "react";
import { ArrowLeft, Check, ExternalLink } from "lucide-react";
import type { InboxRow, InboxView } from "../../../shared/inbox";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { readInboxLine, replyToInboxRow } from "@/state/inbox";
import { ASK_QUIET_ANSWER, AskReply } from "../AskCard";
import { ELEVATED_CARD } from "../elevated";
import { InboxSender } from "../InboxLine";
import { pendingApprovals, PendingApprovalActions, PendingApprovalPanel } from "../PendingApproval";
import { QuestionCard } from "../QuestionCard";
import { threadUpdatedLabel } from "../SidebarThreadRow";
import { askOf, closeResponse, subjectOf } from "./inbox-view";
import { useInboxActions } from "./use-inbox-actions";

/** The line as the chat shows it, so an ask answers here with the very card it asks with in the chat. */
export const asMessage = (row: InboxRow): Message => ({ id: row.id, role: "bot", kind: "options", text: row.text, at: row.at, card: row.card } as Message);

function settledLabel(row: InboxRow): string {
  if (row.kind !== "ask") return t("common.done");
  const card = row.card;
  if (card?.stopped) return t("ask.settled.stopped");
  if (card?.expired) return t(card.tool ? "approval.status.expired" : "ask.settled.expired");
  if (card?.answered === "allow") return t("approval.status.allowed");
  if (card?.answered === "deny") return t("approval.status.denied");
  return card?.answered === "answer" && !card.dismissed ? t("question.status.answered") : t("question.status.closed");
}

export function InboxReading({ view, row, now }: { view: InboxView; row: InboxRow; now: number }) {
  const { answer, openInChat, run, askerOf } = useInboxActions(view);
  const asker = askerOf(row);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const ask = askOf(row);
  const send = async (text: string) => {
    if (sending) return;
    setSending(true);
    try {
      await replyToInboxRow(view, row, text);
      setReply("");
    } finally {
      setSending(false);
    }
  };
  const approval = ask === "approval" && view.threadId ? pendingApprovals([asMessage(row)])[0] : undefined;
  const canReply = !ask && row.tab === "info" && row.replies === true;
  return (
    <article data-inbox-reading={row.id} aria-label={`${row.from.name} · ${subjectOf(row)}`} className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-start gap-2 border-b border-hairline/40 px-3 py-2.5">
        <button type="button" onClick={() => readInboxLine(null)} aria-label={t("inbox.action.back")} title={t("inbox.action.back")}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink pointer-coarse:size-9">
          <ArrowLeft size={15} aria-hidden="true" />
        </button>
        <span className="mt-0.5 shrink-0" aria-hidden="true"><InboxSender from={row.from} size={28} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 truncate text-[14px] font-semibold text-ink">{row.from.name}</span>
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-tertiary">{threadUpdatedLabel(row.at, now)}</span>
          </div>
          <div className="truncate text-[13px] text-ink">{subjectOf(row)}</div>
          {(row.origin || row.via) && (
            <div className="truncate text-[12px] text-ink-tertiary">
              {row.via && t("inbox.via", { name: row.via.name })}{row.via && row.origin && " · "}{row.origin && t("inbox.in", { title: row.origin.title })}
            </div>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {!ask && <p className="whitespace-pre-wrap break-words text-[14px] leading-6 text-ink">{row.text}</p>}
        {row.answers?.map((given) => (
          <p key={given.at} className="rounded-xl bg-ink/[0.045] px-3 py-2 text-[13px] text-ink-secondary">
            <span className="block text-[11px] font-medium text-ink-tertiary">{t(given.by === "assistant" ? "inbox.assistantAnswered" : "inbox.youReplied")}</span>
            <span className="whitespace-pre-wrap break-words">{given.text}</span>
          </p>
        ))}
        {row.tab === "done" && (
          <>
            {row.kind === "ask" && <p className="whitespace-pre-wrap break-words text-[14px] leading-6 text-ink">{row.card?.subtitle ?? row.text}</p>}
            <p className="flex items-center gap-1.5 text-[13px] text-ink-secondary"><Check size={14} aria-hidden="true" />{settledLabel(row)}</p>
          </>
        )}
        {ask === "question" && view.threadId && <QuestionCard threadId={view.threadId} asker={asker} message={asMessage(row)} />}
        {approval && view.threadId && (
          <div className={cn("rounded-[20px]", ELEVATED_CARD)}>
            <PendingApprovalPanel pending={approval} count={1} index={0} botName={asker?.name ?? row.from.name} asker={asker}
              actions={<PendingApprovalActions part="primary" tag="inbox" pending={approval} threadId={view.threadId} bot={asker} onCancelTurn={() => {}} />} />
          </div>
        )}
        {ask === "review" && <p className="text-[13px] text-ink-secondary">{t("inbox.reviewInChat")}</p>}
      </div>
      <footer className="space-y-2 border-t border-hairline/40 px-3 py-2.5">
        {canReply && (
          <AskReply label={t("inbox.reply.placeholder")} placeholder={t("inbox.reply.placeholder")} color={asker?.color} value={reply} onChange={setReply}
            onSend={(text) => void send(text)} sending={sending} multiline />
        )}
        <div className={cn("flex flex-wrap items-center gap-1.5", canReply && "pt-0.5")}>
          {ask === "question" && <button type="button" data-inbox-action="close" onClick={() => answer(row, closeResponse(row))} className={ASK_QUIET_ANSWER}>{t("inbox.action.closeQuestion")}</button>}
          {row.tab === "info" && <button type="button" data-inbox-action="done" onClick={() => { run(row, "done"); readInboxLine(null); }} className={ASK_QUIET_ANSWER}><Check size={15} aria-hidden="true" />{t("common.done")}</button>}
          <button type="button" data-inbox-action="open" onClick={() => openInChat(row)} className={ASK_QUIET_ANSWER}><ExternalLink size={15} aria-hidden="true" />{t("inbox.action.openInChat")}</button>
        </div>
      </footer>
    </article>
  );
}
