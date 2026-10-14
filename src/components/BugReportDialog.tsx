import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bug, Loader2 } from "lucide-react";

import { useModalDialog } from "@/hooks/use-modal-dialog";
import { errorText } from "@/lib/bug-report";
import { t } from "@/lib/i18n";
import { BugReportExtras } from "./BugReportExtras";

type Phase = { kind: "editing" } | { kind: "sending" } | { kind: "sent" } | { kind: "failed"; error: string };

/** `threadId`: the conversation open when the person asked, which they may choose to include. */
export function BugReportDialog({ threadId, onClose }: { threadId?: string; onClose: () => void }) {
  const [description, setDescription] = useState("");
  const [includeChat, setIncludeChat] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });
  const dialog = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const sending = phase.kind === "sending";
  const close = () => { if (!sending) onClose(); };
  useModalDialog(dialog, close);
  useEffect(() => { field.current?.focus(); }, []);
  useEffect(() => { if (phase.kind === "sent") done.current?.focus(); }, [phase.kind]);

  const send = async () => {
    const sendBugReport = window.ogb?.sendBugReport;
    const text = description.trim();
    if (!sendBugReport || !text || sending) return;
    setPhase({ kind: "sending" });
    try {
      const result = await sendBugReport({ description: text, source: "button", ...(threadId ? { threadId, includeChatLog: includeChat } : {}) });
      setPhase(result.ok ? { kind: "sent" } : { kind: "failed", error: result.error });
    } catch (cause) {
      setPhase({ kind: "failed", error: errorText(cause) });
    }
  };

  return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
    onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div ref={dialog} role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="bug-report-title" aria-busy={sending || undefined}
      className="max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-2xl border border-hairline/50 bg-panel p-5 text-ink shadow-2xl">
      <h2 id="bug-report-title" className="flex items-center gap-2 text-[15px] font-semibold"><Bug size={16} aria-hidden="true" />{t("bugReport.title")}</h2>
      {phase.kind === "sent" ? (
        <>
          <p role="status" className="mt-3 text-[13px] leading-relaxed text-ink">{t("bugReport.sent")}</p>
          <div className="mt-5 flex justify-end">
            <button ref={done} type="button" onClick={onClose} className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white">{t("common.close")}</button>
          </div>
        </>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{t("bugReport.intro")}</p>
          <label className="mt-4 block text-[12px] text-ink-secondary">{t("bugReport.whatWentWrong")}
            <textarea ref={field} value={description} required rows={5} maxLength={10_000} disabled={sending}
              placeholder={t("bugReport.placeholder")} onChange={(event) => setDescription(event.target.value)}
              className="mt-1 w-full resize-y rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink focus:border-focus focus:outline-none" />
          </label>
          <BugReportExtras threadId={threadId} includeChat={includeChat} onIncludeChat={setIncludeChat} description={description.trim()} disabled={sending} />
          {phase.kind === "failed" && <p role="alert" className="mt-3 text-[12px] text-danger">{phase.error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" disabled={sending} onClick={close}
              className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised disabled:opacity-40">{t("common.cancel")}</button>
            <button type="submit" disabled={sending || !description.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-40">
              {sending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              {t(sending ? "bugReport.sending" : phase.kind === "failed" ? "bugReport.tryAgain" : "bugReport.send")}
            </button>
          </div>
        </form>
      )}
    </div>
  </div>, document.body);
}
