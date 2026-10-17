import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import { MINUTES_PER_OUTCOME, OUTCOME_CATEGORIES, type OutcomeCategory } from "../../shared/today-outcomes";
import type { TodayReport } from "../../shared/today";
import type { LocaleKey } from "@/locales";

export type TodayRange = "today" | "week";

const REFRESH_MS = 30_000;

/** Local midnight today, or six days before it for the last seven days. */
export function rangeStart(range: TodayRange, now = new Date()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range === "week") start.setDate(start.getDate() - 6);
  return start.getTime();
}

export const TILE_LABEL: Record<OutcomeCategory, LocaleKey> = {
  emailRead: "today.tile.emailRead",
  draft: "today.tile.draft",
  emailSent: "today.tile.emailSent",
  message: "today.tile.message",
  doc: "today.tile.doc",
  report: "today.tile.report",
  lead: "today.tile.lead",
  other: "today.tile.other",
};

export function durationText(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.round(totalMinutes % 60);
  if (!hours) return t("today.duration.minutes", { minutes });
  return minutes ? t("today.duration.hoursMinutes", { hours, minutes }) : t("today.duration.hours", { hours });
}

/** The tooltip that says how time saved is estimated, from the same per-outcome minutes the server adds up. */
export function timeSavedExplanation(): string {
  const minutes = OUTCOME_CATEGORIES.map((category) => t("today.timeSaved.minutes", { label: t(TILE_LABEL[category]), minutes: MINUTES_PER_OUTCOME[category] }));
  return t("today.timeSaved.how", { minutes: minutes.join(", ") });
}

export function isEmptyReport(report: TodayReport): boolean {
  return !report.tiles.length && !report.lines.length && !report.needsYou.length && !report.routines.ok && !report.routines.failed;
}

export function useTodayReport(range: TodayRange): { report: TodayReport | null; error: string | null; reload: () => void } {
  const [report, setReport] = useState<TodayReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const load = useCallback(() => {
    const id = ++request.current;
    api<TodayReport>(`/api/today?since=${rangeStart(range)}`, { timeoutMs: 20_000 })
      .then((next) => { if (id === request.current) { setReport(next); setError(null); } })
      .catch((cause: unknown) => { if (id === request.current) setError(cause instanceof Error ? cause.message : String(cause)); });
  }, [range]);
  useEffect(() => {
    setReport(null);
    load();
    const timer = setInterval(load, REFRESH_MS);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      request.current += 1;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);
  return { report, error, reload: load };
}
