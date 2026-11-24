import { Loader2, RefreshCw } from "lucide-react";

import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { localizedRelativeTime } from "@/lib/relative-time";
import {
  storageBand, storageBots, storageFullness, storageSize, storageSummary, type StorageAnswer, type StorageBand, type StorageBotRow, type StorageGroupKey,
} from "@/lib/storage-report";
import type { LocaleKey } from "@/locales";
import { SettingsEmptyRow, SettingsGroup, SettingsRows, SIMPLE_CARD } from "../SettingsPrimitives";
import { SettingsSkeletonRows } from "./SettingsStates";

const GROUP_LABEL: Record<StorageGroupKey, LocaleKey> = {
  work: "settings.storage.group.work", precious: "settings.storage.group.precious", rebuildable: "settings.storage.group.rebuildable",
  other: "settings.storage.group.other", unmeasured: "settings.storage.group.unmeasured",
};
const GROUP_FILL: Record<StorageGroupKey, string> = {
  work: "bg-ink", precious: "bg-ink/60", rebuildable: "bg-ink/35", other: "bg-ink/20", unmeasured: "bg-ink/[0.12]",
};
/** The legend's dots: the bar's fills, but the two faintest get a ring in the tertiary ink so they read on dark skins too. */
const GROUP_DOT: Record<StorageGroupKey, string> = {
  ...GROUP_FILL, other: "bg-ink/20 shadow-[inset_0_0_0_1px_var(--color-ink-tertiary)]", unmeasured: "shadow-[inset_0_0_0_1px_var(--color-ink-tertiary)]",
};
/** The unmeasured part is explained once it is at least this share of what is used. */
const UNMEASURED_NOTED = 0.05;
const PERCENT_INK: Record<StorageBand, string> = { ok: "text-ink", near: "text-warning", full: "text-danger" };

export interface StorageViewProps {
  answer: StorageAnswer | null;
  /** When the answer was read, on this computer's clock (the report's age counts from it). */
  fetchedAt: number;
  now: number;
  nameOf: (id: string) => string | null | undefined;
  /** A Team Cloud: a bot the app has no name for is a teammate's own, shown as a private bot. */
  team?: boolean;
  measuring: boolean;
  /** "Measure again", when the server takes one now. */
  onMeasure?: () => void;
}

/** Settings → Storage: how full this place's disk is, by plain group, its largest bots, and when it was measured. */
export function StorageView({ answer, fetchedAt, now, nameOf, team = false, measuring, onMeasure }: StorageViewProps) {
  const report = answer?.storage ?? null;
  if (!report) return <SettingsGroup label={t("settings.storage.section")} block="storage-used"><SettingsRows><SettingsSkeletonRows /></SettingsRows></SettingsGroup>;
  const running = report.running || measuring;
  const canMeasure = Boolean(onMeasure) && !running && answer?.measureInS === 0;
  const action = running
    ? <span role="status" className="flex items-center gap-1.5 text-[13px] leading-[18px] text-ink-secondary"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{t("settings.storage.measuring")}</span>
    : canMeasure ? <button type="button" onClick={onMeasure} className="settings-quiet flex cursor-pointer items-center gap-1.5"><RefreshCw size={14} aria-hidden="true" />{t("settings.storage.measureAgain")}</button>
    : undefined;
  const summary = storageSummary(answer);
  const full = storageFullness(answer);
  const measuredAt = report.ageS === null ? null : fetchedAt - report.ageS * 1000;
  const notes = [
    measuredAt !== null && t("settings.storage.measured", { when: localizedRelativeTime(measuredAt, activeLocale(), now) }),
    report.failed && (report.at === null ? t("settings.storage.failedFirst") : t("settings.storage.failed")),
    summary && summary.overcountBytes > 0 && t("settings.storage.overcount", { size: storageSize(summary.overcountBytes) }),
    summary?.groups.some((group) => group.key === "unmeasured" && group.bytes >= summary.usedBytes * UNMEASURED_NOTED) && t("settings.storage.unmeasuredNote"),
  ].filter(Boolean).join(" ");
  const bots = report.at === null ? [] : storageBots(report, nameOf, undefined, team);
  return <>
    <SettingsGroup label={t("settings.storage.section")} block="storage-used" actions={action} footnote={notes || undefined}>
      {full ? <StorageSummaryCard full={full} groups={summary?.groups ?? null} waiting={report.at === null && !report.failed} />
        : <SettingsRows><SettingsEmptyRow>{t("settings.storage.firstPass")}</SettingsEmptyRow></SettingsRows>}
    </SettingsGroup>
    {bots.length > 0 && (
      <SettingsGroup label={t("settings.storage.bots")} block="storage-bots" footnote={t("settings.storage.botsNote")}>
        <SettingsRows>{bots.map((row) => <BotRow key={row.key} row={row} />)}</SettingsRows>
      </SettingsGroup>
    )}
  </>;
}

function StorageSummaryCard({ full, groups, waiting }: {
  full: { usedBytes: number; sizeBytes: number; percent: number }; groups: Array<{ key: StorageGroupKey; bytes: number }> | null; waiting: boolean;
}) {
  const band = storageBand(full.percent);
  const label = t("settings.storage.summary", { percent: String(full.percent) });
  const parts = groups ?? [{ key: "unmeasured" as const, bytes: full.usedBytes }];
  return (
    <section data-storage-summary="" data-band={band} aria-label={label} className={cn(SIMPLE_CARD, "px-4 py-3.5")}>
      <p className="text-[13px] leading-[18px] text-ink">{t("settings.storage.used", { used: storageSize(full.usedBytes), size: storageSize(full.sizeBytes) })}</p>
      <p className="mt-2 flex items-baseline gap-1.5">
        <span className={cn("text-[22px] font-medium leading-7 tracking-[-0.012em] tabular-nums", PERCENT_INK[band])}>{full.percent}%</span>
        <span className="text-[13px] text-ink-secondary">{t("settings.storage.full")}</span>
      </p>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={full.percent}
        aria-valuetext={t("settings.storage.used", { used: storageSize(full.usedBytes), size: storageSize(full.sizeBytes) })}
        className="mt-2 flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-ink/[0.06]">
        {parts.map((part) => <div key={part.key} data-storage-part={part.key} className={cn("h-full", GROUP_FILL[part.key])}
          style={{ width: `${Math.max((part.bytes / full.sizeBytes) * 100, part.bytes > 0 ? 0.5 : 0)}%` }} />)}
      </div>
      {waiting && <p role="status" className="mt-2 text-[12px] leading-4 text-ink-secondary">{t("settings.storage.firstPass")}</p>}
      {groups && (
        <ul className="mt-3 flex flex-col gap-1.5" aria-label={t("settings.storage.breakdown")}>
          {groups.map((group) => (
            <li key={group.key} data-storage-group={group.key} className="flex min-w-0 items-center gap-2 text-[13px] leading-[18px]">
              <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", GROUP_DOT[group.key])} />
              <span className="min-w-0 flex-1 truncate text-ink">{t(GROUP_LABEL[group.key])}</span>
              <span className="shrink-0 tabular-nums text-ink-secondary">{storageSize(group.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BotRow({ row }: { row: StorageBotRow }) {
  const name = row.kind === "gone" ? t("settings.storage.deletedBots") : row.kind === "rest" ? t("settings.storage.otherBots")
    : row.kind === "private" ? t("settings.storage.privateBot") : row.name ?? t("settings.storage.unnamedBot");
  return (
    <div data-storage-bot={row.kind} className="flex min-h-11 items-center gap-3 px-4 py-3">
      <span title={name} className={cn("min-w-0 flex-1 truncate text-[14px] leading-5", row.kind === "bot" && row.name ? "text-ink" : "text-ink-secondary")}>{name}</span>
      <span className="shrink-0 text-[13px] leading-[18px] tabular-nums text-ink-secondary">{storageSize(row.bytes)}</span>
    </div>
  );
}
