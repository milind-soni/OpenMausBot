import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { errorText } from "@/lib/bug-report";
import { t } from "@/lib/i18n";

type PreviewState =
  | { status: "loading" }
  | { status: "ready"; preview: BugReportPreview }
  | { status: "failed"; error: string };

function usePreview(open: boolean, threadId: string | undefined, includeChat: boolean): PreviewState {
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  useEffect(() => {
    const preview = window.ogb?.previewBugReport;
    if (!open || !preview) return;
    let alive = true;
    setState({ status: "loading" });
    preview(threadId ? { threadId, includeChatLog: includeChat } : {})
      .then((result) => { if (alive) setState({ status: "ready", preview: result }); })
      .catch((cause: unknown) => { if (alive) setState({ status: "failed", error: errorText(cause) }); });
    return () => { alive = false; };
  }, [open, threadId, includeChat]);
  return state;
}

function Section({ title, text }: { title: string; text: string }) {
  return (
    <section className="mt-3 first:mt-0">
      <h3 className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-tertiary">{title}</h3>
      <pre dir="auto" className="mt-1 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink-secondary">{text}</pre>
    </section>
  );
}

export function BugReportPreviewBody({ state, description }: { state: PreviewState; description: string }) {
  if (state.status === "loading") {
    return (
      <p role="status" className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-secondary">
        <Loader2 size={12} className="animate-spin" aria-hidden="true" />{t("bugReport.previewLoading")}
      </p>
    );
  }
  if (state.status === "failed") return <p role="alert" className="mt-2 text-[12px] text-danger">{t("bugReport.previewFailed", { error: state.error })}</p>;
  const { preview } = state;
  return (
    <div data-testid="bug-report-preview" className="mt-2 max-h-[260px] overflow-auto rounded-lg border border-hairline/40 bg-inset p-3">
      <Section title={t("bugReport.preview.description")} text={description || "—"} />
      <Section title={t("bugReport.preview.app")} text={`installId=${preview.installId}\nappVersion=${preview.appVersion}\nplatform=${preview.platform}`} />
      <Section title={t("bugReport.preview.diagnostics")} text={preview.diagnostics} />
      {preview.chatLog !== undefined && <Section title={t("bugReport.preview.chat")} text={preview.chatLog} />}
    </div>
  );
}

/** The conversation checkbox, offered only while one is open, and the "See exactly what's sent" disclosure. */
export function BugReportExtras({
  threadId,
  includeChat,
  onIncludeChat,
  description,
  disabled = false,
}: {
  threadId?: string;
  includeChat: boolean;
  onIncludeChat: (include: boolean) => void;
  description: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const preview = usePreview(open, threadId, includeChat);
  return (
    <>
      {threadId && (
        <label className="mt-3 flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={includeChat} disabled={disabled} className="accent-accent"
            onChange={(event) => onIncludeChat(event.target.checked)} />
          {t("bugReport.includeChat")}
        </label>
      )}
      <details className="mt-3" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer text-[12.5px] font-medium text-accent-text">{t("bugReport.preview")}</summary>
        {open && <BugReportPreviewBody state={preview} description={description} />}
      </details>
    </>
  );
}
