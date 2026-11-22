// An Edu crew job's quiet line: what it is doing, with Cancel while it runs and Details for its spec and result. A failure
// is this one line too, never an error card.
import { Users } from "lucide-react";
import { useEffect, useState } from "react";
import type { EduCrewDetails, EduCrewLine as Line } from "../../shared/edu-brain";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { api, type Message } from "@/state/store";

const live = (line: Line) => line.status === "running" || line.status === "waiting";

export function EduCrewLine({ message, line }: { message: Message; line: Line }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [details, setDetails] = useState<EduCrewDetails | null>(null);
  const [open, setOpen] = useState(false);
  const path = `/api/edu/crew/${encodeURIComponent(line.jobId)}`;
  async function cancel() {
    setBusy(true);
    setFailed(null);
    try {
      await api(`${path}/cancel`, { method: "POST" });
    } catch {
      setFailed(t("eduCrew.line.cancelFailed"));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!open) return;
    let current = true;
    setFailed(null);
    api<EduCrewDetails>(path).then((loaded) => { if (current) setDetails(loaded); }, () => { if (current) setFailed(t("eduCrew.line.detailsFailed")); });
    return () => { current = false; };
  }, [open, path, line.status]);
  const words = message.tool?.name ?? line.title;
  return (
    <div data-edu-crew={line.status} className="min-w-0 py-0.5 pl-0.5 text-[12px]">
      <div className={cn("flex min-w-0 items-center gap-1.5", line.status === "failed" ? "text-danger" : "text-ink-tertiary")}>
        <Users size={12} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate" title={words}>{words}</span>
        <span aria-hidden="true">·</span>
        <button type="button" data-edu-crew-details aria-expanded={open} onClick={() => setOpen(!open)}
          className="shrink-0 text-ink-secondary underline-offset-2 hover:underline">
          {t(open ? "eduCrew.line.hide" : "eduCrew.line.details")}
        </button>
        {live(line) && (
          <>
            <span aria-hidden="true">·</span>
            <button type="button" data-edu-crew-cancel onClick={() => { void cancel(); }} disabled={busy}
              className="shrink-0 text-ink-secondary underline-offset-2 hover:underline disabled:opacity-60">
              {t("eduCrew.line.cancel")}
            </button>
          </>
        )}
        {failed && <span className="text-danger">{failed}</span>}
      </div>
      {open && details && (
        <div data-edu-crew-panel className="mt-1 max-w-[640px] rounded-md border border-hairline px-2 py-1.5 text-ink-secondary">
          <p dir="auto" className="break-words">{t("eduCrew.gate.folder", { folder: details.folder })}</p>
          {details.spec && <DetailBlock label={t("eduCrew.line.spec")} text={details.spec} />}
          {details.summary && <DetailBlock label={t("eduCrew.line.summary")} text={details.summary} />}
        </div>
      )}
    </div>
  );
}

function DetailBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="mt-1.5">
      <p className="font-medium text-ink">{label}</p>
      <pre dir="auto" className="mt-0.5 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-[17px]">{text}</pre>
    </div>
  );
}
