// On a Team Cloud, in the person's inbox chat: one card that keeps what waits on them in view. It sits under the newest
// line that needed them and updates in place: how many need them and how many are news, the newest few that need them
// with their answers right there (the line it sits under answers on its own card), and the way into the whole inbox.
// With nothing open it shrinks to one line.
import { useEffect, useState } from "react";
import { Check, CornerUpLeft, Inbox } from "lucide-react";
import type { InboxRow, InboxView } from "../../../shared/inbox";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { openInbox, readInboxRow, useInboxView } from "@/state/inbox";
import { pendingApprovals, PendingApprovalActions } from "../PendingApproval";
import { ASK_QUIET_ANSWER, ASK_QUIET_BUTTON, AskChoices, AskError } from "../AskCard";
import { ELEVATED_CARD } from "../elevated";
import { InboxRowItem } from "./InboxRow";
import { asMessage } from "./InboxReading";
import { askOf, CARD_ROWS, choiceResponse, choicesOf, rowsIn, tabCounts } from "./inbox-view";
import { useInboxActions } from "./use-inbox-actions";

/** Most choices a question shows as buttons on the card; one with more opens in the inbox. */
const CARD_CHOICES = 3;

/** The card goes under one line of the inbox conversation only: the line the inbox says it sits under. */
export function InboxCardSlot({ threadId, messageId }: { threadId: string; messageId: string }) {
  const view = useInboxView();
  if (!view || view.threadId !== threadId || view.anchor !== messageId) return null;
  return <InboxCard view={view} />;
}

function Answers({ row, view }: { row: InboxRow; view: InboxView }) {
  const { answer, askerOf } = useInboxActions(view);
  const [sending, setSending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const ask = askOf(row);
  const choices = choicesOf(row);
  const reading = () => { readInboxRow(row); openInbox({ reading: row.id }); };
  if (ask === "approval") {
    const pending = view.threadId ? pendingApprovals([asMessage(row)])[0] : undefined;
    return pending ? (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <PendingApprovalActions part="primary" tag="inbox" pending={pending} threadId={view.threadId!} bot={askerOf(row)} onCancelTurn={() => {}} />
      </div>
    ) : null;
  }
  const pick = (choice: string) => {
    setFailed(false);
    setSending(choice);
    answer(row, choiceResponse(row, choice), () => { setSending(null); setFailed(true); });
  };
  return (
    <div>
      {choices.length > 0 && choices.length <= CARD_CHOICES && (
        <AskChoices choices={choices.map((label) => ({ label }))} label={row.card?.subtitle ?? row.text} sending={sending} tag="data-inbox-choice" onPick={pick} />
      )}
      <div className="mt-1.5 flex justify-end">
        <button type="button" data-inbox-action="reply" onClick={reading} className={ASK_QUIET_ANSWER}><CornerUpLeft size={15} aria-hidden="true" />{t("chat.reply")}</button>
      </div>
      {failed && <AskError>{t("ask.error")}</AskError>}
    </div>
  );
}

export function InboxCard({ view }: { view: InboxView }) {
  const { run } = useInboxActions(view);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const counts = tabCounts(view);
  const rows = rowsIn(view, "needs-you").slice(0, CARD_ROWS);
  const openRow = (row: InboxRow) => { readInboxRow(row); openInbox({ reading: row.id }); };
  const openAll = () => openInbox({ tab: counts["needs-you"] ? "needs-you" : "info" });
  const shell = cn("my-1 w-full max-w-[560px] rounded-[20px]", ELEVATED_CARD);
  if (!rows.length) {
    return (
      <section data-inbox-card="caught-up" aria-label={t("inbox.card.caughtUp")} className={cn(shell, "flex items-center gap-2 px-4 py-2 text-[13px] text-ink-secondary")}>
        <Check size={14} aria-hidden="true" className="shrink-0 text-success" />
        <span className="min-w-0 flex-1 truncate">{t("inbox.card.caughtUp")}{counts.info > 0 && ` · ${t("inbox.card.forInfo", { count: counts.info })}`}</span>
        <button type="button" onClick={openAll} className={cn(ASK_QUIET_BUTTON, "-me-2")}>{t("inbox.card.open")}</button>
      </section>
    );
  }
  return (
    <section data-inbox-card="open" aria-label={t("inbox.card.summary", { needs: counts["needs-you"], info: counts.info })} className={cn(shell, "overflow-hidden")}>
      <header className="flex items-center gap-2 px-4 pb-1 pt-3">
        <Inbox size={15} aria-hidden="true" className="shrink-0 text-ink-secondary" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-secondary">{t("inbox.card.summary", { needs: counts["needs-you"], info: counts.info })}</span>
        <button type="button" onClick={openAll} className={cn(ASK_QUIET_BUTTON, "-me-2")}>{t("inbox.card.open")}</button>
      </header>
      {rows.map((row) => (
        <div key={row.id} className="border-t border-ink/[0.06] first-of-type:border-t-0">
          <InboxRowItem row={row} now={now} onOpen={openRow} onAction={run} inCard />
          {row.id !== view.anchor && <div className="px-4 pb-3 ps-[2.625rem]"><Answers row={row} view={view} /></div>}
        </div>
      ))}
    </section>
  );
}
