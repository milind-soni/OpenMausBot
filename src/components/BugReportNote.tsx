import { Bug } from "lucide-react";
import { t } from "@/lib/i18n";
import type { BugReportStatus } from "../../shared/devs-report-status";

/** A @devs report's status in the person's words (server/host/devs-reports.ts keeps it on the message that sent it). */
export function bugReportStatusText(report: BugReportStatus): string {
  if (report.status === "received") return t("devs.report.received");
  if (!report.fixedIn) return t("devs.report.fixedSoon");
  return report.running ? t("devs.report.fixed", { version: report.fixedIn }) : t("devs.report.fixedComing", { version: report.fixedIn });
}

/** The one line that tells the reporter the fix runs here now. */
export const bugReportFixedText = (report: BugReportStatus): string | null =>
  report.status === "fixed" && report.fixedIn ? t("devs.report.tryAgain", { version: report.fixedIn }) : null;

/** Under the person's @devs message: what became of its report. */
export function BugReportNote({ report }: { report: BugReportStatus }) {
  const label = bugReportStatusText(report);
  return (
    <span data-bug-report={report.status} className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-ink-tertiary" title={label}>
      <Bug aria-hidden="true" size={11} className="shrink-0" />
      <bdi dir="auto" className="min-w-0 truncate">{label}</bdi>
    </span>
  );
}
