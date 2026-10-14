import { useState } from "react";
import { Bug, Loader2, RefreshCw, Send, X } from "lucide-react";

import { BUG_REPORT_LIMITS, bugReportDraftText, bugReportOutcome } from "../../shared/bug-report";
import { canSendBugReports, errorText, settleBugReportCard } from "@/lib/bug-report";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { ASK_CHIP, ASK_CHIP_IDLE, ASK_PRIMARY_BUTTON, AskCard, AskSettledLine, returnFocusToComposer } from "./AskCard";
import { BugReportExtras } from "./BugReportExtras";

/** A bot's draft: nothing reaches the OpenMausBot team until the person presses Send in the desktop app. */
export function BugReportCard({ botId, botName, threadId, message }: { botId: string; botName: string; threadId: string; message: Message }) {
  const card = message.bugReport!;
  const [text, setText] = useState(() => bugReportDraftText(card));
  const [includeChat, setIncludeChat] = useState(false);
  const [pending, setPending] = useState<"send" | "dismiss" | null>(null);
  // Set once the report reached the team: a retry then only records it, never sends it twice.
  const [sentId, setSentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const outcome = bugReportOutcome(card);
  const ref = { botId, threadId, messageId: message.id };
  const desktop = canSendBugReports();
  const locked = pending !== null || sentId !== null;

  const send = async () => {
    const sendBugReport = window.ogb?.sendBugReport;
    const description = text.trim();
    if (pending || !sendBugReport || !description) return;
    setPending("send");
    setError(null);
    try {
      let id = sentId;
      if (!id) {
        const result = await sendBugReport({ description, source: "bot", threadId, includeChatLog: includeChat });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        id = result.id;
        setSentId(id);
      }
      await settleBugReportCard(ref, "sent", id);
      returnFocusToComposer();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(null);
    }
  };

  const dismiss = async () => {
    if (pending) return;
    setPending("dismiss");
    setError(null);
    try {
      await settleBugReportCard(ref, "dismissed");
      returnFocusToComposer();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(null);
    }
  };

  if (card.superseded || (card.stopped && !outcome)) {
    return (
      <AskSettledLine icon={<X size={13} />} ariaLabel={t("bugReport.card.title")}>
        <span className="text-ink-secondary">{t("bugReport.card.title")}</span>
        <span> · {t(card.superseded ? "bugReport.card.superseded" : "chat.turnStopped")}</span>
      </AskSettledLine>
    );
  }

  if (outcome) {
    return (
      <AskSettledLine ariaLabel={t("bugReport.card.title")} icon={outcome === "dismissed" ? <X size={13} className="text-ink-tertiary" /> : undefined}>
        <span className="text-ink-secondary">{t(outcome === "sent" ? "bugReport.card.sent" : "bugReport.card.dismissed")}</span>
        {card.resumed && <span> · {t("bugReport.card.resumed", { name: botName })}</span>}
      </AskSettledLine>
    );
  }

  return (
    <AskCard
      ariaLabel={t("bugReport.card.label", { name: botName })}
      icon={<Bug size={15} />}
      title={t("bugReport.card.title")}
      footer={<>
        <button type="button" onClick={() => void dismiss()} disabled={locked} className={cn(ASK_CHIP, ASK_CHIP_IDLE)}>
          {pending === "dismiss" ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
          {t("bugReport.card.dismiss")}
        </button>
        {desktop && (
          <button type="button" onClick={() => void send()} disabled={pending !== null || !text.trim()} className={ASK_PRIMARY_BUTTON}>
            {pending === "send" ? <Loader2 size={14} className="animate-spin" /> : error ? <RefreshCw size={14} /> : <Send size={14} />}
            {t(error ? "bugReport.tryAgain" : "bugReport.send")}
          </button>
        )}
      </>}
    >
      <p className="text-[12.5px] leading-snug text-ink-secondary">{t("bugReport.card.explain", { name: botName })}</p>
      {desktop ? (
        <>
          <textarea value={text} rows={6} maxLength={BUG_REPORT_LIMITS.description} disabled={locked}
            aria-label={t("bugReport.whatWentWrong")} onChange={(event) => setText(event.target.value)}
            className="mt-2 w-full resize-y rounded-xl border border-hairline/50 bg-inset px-3 py-2 text-[13px] leading-snug text-ink focus:border-focus focus:outline-none" />
          <BugReportExtras threadId={threadId} includeChat={includeChat} onIncludeChat={setIncludeChat} description={text.trim()} disabled={locked} />
        </>
      ) : (
        <>
          <p dir="auto" data-testid="bug-report-draft" className="mt-2 whitespace-pre-wrap break-words rounded-xl bg-inset px-3 py-2 text-[13px] leading-snug text-ink">{text}</p>
          <p className="mt-2 text-[12px] text-ink-tertiary">{t("bugReport.card.desktopOnly")}</p>
        </>
      )}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </AskCard>
  );
}
