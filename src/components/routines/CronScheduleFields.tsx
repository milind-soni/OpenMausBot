import { useMemo } from "react";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { nextCronRuns, type RoutineCronSchedule } from "../../../shared/routine-schedule";
import type { CronChoice, CronDraft } from "./cron-editor";
import { Select } from "../Select";

const fieldClass = "min-w-0 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent [color-scheme:dark]";
const TIME_ZONES = ["UTC", ...(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [])];

export function CronRunDates({ runs, timeZone, paused = false }: { runs: number[]; timeZone: string; paused?: boolean }) {
  if (!runs.length) return null;
  const format = new Intl.DateTimeFormat(activeLocale(), { timeZone, weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return <div className="space-y-1 text-[11px] leading-relaxed text-ink-secondary" aria-label={t(paused ? "routines.cron.pausedAria" : "routines.cron.nextAria")}>
    <div className="font-medium">{t(paused ? "routines.cron.pausedPreview" : "routines.cron.nextRuns")} · {timeZone}</div>
    {runs.map((at) => <div key={at}><time dateTime={new Date(at).toISOString()}>{format.format(at)}</time></div>)}
    <div className="pt-1">{t("routines.cron.clockChanges")}</div>
  </div>;
}

export function CronSchedulePreview({ schedule, paused = false }: { schedule: RoutineCronSchedule; paused?: boolean }) {
  const runs = useMemo(() => {
    try { return nextCronRuns(schedule, Date.now(), 3); } catch { return []; }
  }, [schedule]);
  return <CronRunDates runs={runs} timeZone={schedule.timeZone} paused={paused} />;
}

export function CronScheduleFields({ choice, value, onChange, runs, error }: {
  choice: CronChoice; value: CronDraft; onChange: (draft: CronDraft) => void; runs: number[]; error: string;
}) {
  const update = (patch: Partial<CronDraft>) => onChange({ ...value, ...patch });
  const months = Array.from({ length: 12 }, (_, index) => new Intl.DateTimeFormat(activeLocale(), { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, index, 1))));
  return <div className="space-y-3">
    {choice === "cron" ? <label className="block space-y-1.5 text-[12px] text-ink-secondary">
      <span>{t("routines.cron.expression")}</span>
      <input value={value.expression} onChange={(event) => update({ expression: event.target.value })} placeholder="0 9 1 * *" spellCheck={false} autoComplete="off" aria-invalid={Boolean(error)} aria-describedby="routine-cron-help routine-cron-error" className={cn(fieldClass, "w-full font-mono")} />
      <span id="routine-cron-help" className="block text-[11px]">{t("routines.cron.help")}</span>
    </label> : <div className="flex flex-wrap items-end gap-2">
      {choice === "yearly" && <label className="space-y-1.5 text-[12px] text-ink-secondary"><span className="block">{t("routines.cron.month")}</span><Select value={value.month} onChange={(event) => update({ month: event.target.value })}>{months.map((month, index) => <option key={month} value={String(index + 1)}>{month}</option>)}</Select></label>}
      <label className="space-y-1.5 text-[12px] text-ink-secondary"><span className="block">{t("routines.cron.dayOfMonth")}</span><Select value={value.day} onChange={(event) => update({ day: event.target.value })}>{Array.from({ length: 31 }, (_, index) => <option key={index + 1} value={String(index + 1)}>{index + 1}</option>)}<option value="L">{t("routines.cron.lastDay")}</option></Select></label>
      <label className="space-y-1.5 text-[12px] text-ink-secondary"><span className="block">{t("routines.cron.time")}</span><input type="time" step={60} value={value.time} onChange={(event) => update({ time: event.target.value })} className={fieldClass} /></label>
    </div>}
    {choice !== "cron" && Number(value.day) > 28 && <p className="text-[11px] text-ink-secondary">{t("routines.cron.skipMissingDate")}</p>}
    <label className="block space-y-1.5 text-[12px] text-ink-secondary"><span>{t("routines.cron.timeZone")}</span><input list="routine-time-zones" value={value.timeZone} onChange={(event) => update({ timeZone: event.target.value })} placeholder="America/New_York" spellCheck={false} autoComplete="off" aria-invalid={Boolean(error)} aria-describedby="routine-cron-error" className={cn(fieldClass, "block w-full")} /></label>
    <datalist id="routine-time-zones">{TIME_ZONES.map(zone => <option key={zone} value={zone} />)}</datalist>
    {error && <p id="routine-cron-error" role="alert" className="text-[12px] text-danger">{error}</p>}
    {!error && <CronRunDates runs={runs} timeZone={value.timeZone.trim()} />}
  </div>;
}
