// A check-back's quiet line: when the bot comes back, with Cancel while it waits. Nothing here asks anything.
import { Clock } from "lucide-react";
import { useState } from "react";
import type { CheckBackLine as Line } from "../../shared/check-back";
import { clockOptions, namesLocale } from "@/lib/clock-time";
import { intlLocale, t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { api } from "@/state/store";

const WEEK = 6 * 24 * 60 * 60_000;

/** "Fri 9:00 AM" within the coming week, "Mon 1 Dec, 9:00 AM" after it; today's reads as the time alone. */
export function checkBackWhen(at: number, now = Date.now()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const locale = intlLocale();
  const clock = new Intl.DateTimeFormat(locale, clockOptions(locale)).format(date);
  if (date.toDateString() === new Date(now).toDateString()) return clock;
  const day = new Intl.DateTimeFormat(namesLocale(), Math.abs(at - now) < WEEK ? { weekday: "short" } : { weekday: "short", day: "numeric", month: "short" }).format(date);
  return `${day} ${clock}`;
}

export function checkBackText(line: Line, now = Date.now()): string {
  switch (line.status) {
    case "pending": return t("chat.checkBack.pending", { when: checkBackWhen(line.dueAt, now) });
    case "started": return t("chat.checkBack.started", { when: checkBackWhen(line.startedAt ?? line.dueAt, now) });
    case "failed": return t("chat.checkBack.failed", { when: checkBackWhen(line.dueAt, now) });
    default: return t("chat.checkBack.cancelled");
  }
}

export function CheckBackLine({ line }: { line: Line }) {
  const [cancelling, setCancelling] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = line.status === "pending";
  async function cancel() {
    setCancelling(true);
    setFailed(false);
    try {
      await api(`/api/check-backs/${encodeURIComponent(line.id)}/cancel`, { method: "POST" });
    } catch {
      setFailed(true);
    } finally {
      setCancelling(false);
    }
  }
  return (
    <div data-check-back={line.status} title={line.why ? `${line.note}\n${line.why}` : line.note}
      className={cn("flex min-w-0 items-center gap-1.5 py-0.5 pl-0.5 text-[12px]", line.status === "failed" ? "text-danger" : "text-ink-tertiary")}>
      <Clock size={12} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 truncate">{checkBackText(line)}</span>
      {pending && (
        <>
          <span aria-hidden="true">·</span>
          <button type="button" data-check-back-cancel onClick={() => { void cancel(); }} disabled={cancelling}
            className="shrink-0 text-ink-secondary underline-offset-2 hover:underline disabled:opacity-60">
            {t("chat.checkBack.cancel")}
          </button>
          {failed && <span className="text-danger">{t("chat.checkBack.cancelFailed")}</span>}
        </>
      )}
    </div>
  );
}
