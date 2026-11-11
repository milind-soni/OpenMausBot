import { useEffect, useState, type ReactNode } from "react";
import type { CloudRenewal } from "../../../electron/cloud-list.mjs";
import type { CloudUsage } from "../../../electron/cloud-home.mjs";
import { activeLocale, t } from "@/lib/i18n";
import { meterAmounts, meterLabel, meterPercent, resetLine } from "@/lib/usage-meter";
import { CloudCancelSheet, endedLine, type CloudRenewalActions } from "../CloudCancelPlan";
import { MeterBar, UpgradeButton, type UpgradeUi } from "../CloudUsageMeter";
import { ProCompareRow } from "../ProIntroduction";
import { SettingRow, SettingsGroup, SettingsLinkRow, SettingsRows } from "../SettingsPrimitives";
import { fetchTraces, formatCost, usagePeriodRange } from "@/lib/usage-trace";
import { setAdvancedMode } from "@/lib/interface-mode";

const day = (value: number) => new Intl.DateTimeFormat(activeLocale(), { month: "short", day: "numeric" }).format(new Date(value));

/** "Pro", "Pro · ends Dec 3", "Pro free trial". */
export function planTitle(label: string, renewal?: CloudRenewal | null, trial = false): string {
  const name = trial ? t("settings.plan.trialName", { plan: label }) : label;
  const at = renewal?.cancelled ? renewal.endsAt ?? renewal.renewsAt : null;
  return at ? t("settings.plan.ends", { plan: name, date: day(at) }) : name;
}

/** This week: one row per allowance, its bar in ink on an ink 8% track, and when it resets under the card. */
export function ThisWeek({ usage, upgrade }: { usage: CloudUsage; upgrade?: UpgradeUi }) {
  return (
    <SettingsGroup label={t("settings.plan.thisWeek")} block="this-week" footnote={resetLine(usage)}
      actions={upgrade ? <UpgradeButton usage={usage} upgrade={upgrade} secondary /> : undefined}>
      <SettingsRows>
        {usage.meters.map((meter) => (
          <div key={meter.kind} data-plan-meter={meter.kind} className="flex flex-col gap-2 px-4 py-3">
            <div className="flex items-baseline justify-between gap-6">
              <span className="text-[14px] leading-5 text-ink">{meterLabel(meter.kind)}</span>
              <span className="shrink-0 text-[13px] leading-5 tabular-nums text-ink-secondary">{meterAmounts(meter)} · {meterPercent(meter)}%</span>
            </div>
            <MeterBar meter={meter} label={meterLabel(meter.kind)} compact />
          </div>
        ))}
      </SettingsRows>
    </SettingsGroup>
  );
}

/** The plan card's last row: a title-only row whose quiet Cancel plan (Cancel trial) opens the cancel flow. */
export function CancelPlanRow({ renewal, actions, onChanged }: { renewal: CloudRenewal; actions: CloudRenewalActions; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  if (renewal.cancelled) return null;
  return <>
    <div data-settings-block="cancel" className="contents">
      <SettingRow title={t(renewal.trial ? "cloudCancel.cancelTrial" : "cloudCancel.cancelPlan")}>
        <button type="button" data-cloud-cancel="renewing" data-danger="" className="settings-quiet cursor-pointer" onClick={() => setOpen(true)}
          aria-label={t(renewal.trial ? "cloudCancel.cancelTrial" : "cloudCancel.cancelPlan")}>
          {t("settings.plan.cancelAction")}
        </button>
      </SettingRow>
    </div>
    {open && <CloudCancelSheet renewal={renewal} actions={actions} onClose={(changed) => { setOpen(false); if (changed) onChanged?.(); }} />}
  </>;
}

/** "Renews on Dec 3" ("Trial ends on Dec 3"): the plan row's own status line. */
export function renewalLine(renewal?: CloudRenewal | null): string | undefined {
  if (!renewal || renewal.cancelled || !renewal.renewsAt) return undefined;
  return t(renewal.trial ? "settings.plan.trialEnds" : "settings.plan.renews", { date: day(renewal.renewsAt) });
}

/** Keep my plan: the page's one primary while the plan is cancelled. */
export function KeepPlanButton({ actions, onChanged }: { actions: CloudRenewalActions; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false), [note, setNote] = useState<string | null>(null);
  return <>
    <button type="button" className="ui-button ui-button-primary" data-cloud-cancel="cancelled" disabled={busy} onClick={() => {
      setBusy(true); setNote(null);
      void actions.keep().then((result) => {
        if (result.outcome === "kept") onChanged?.();
        else setNote(t(result.outcome === "browser" ? "cloudCancel.browser" : "cloudCancel.failed"));
      }, () => setNote(t("cloudCancel.failed"))).finally(() => setBusy(false));
    }}>{t(busy ? "cloudCancel.keeping" : "cloudCancel.keep")}</button>
    {note && <span className="sr-only" role="status">{note}</span>}
  </>;
}

/** One Plan & billing page on every rail: one Plan card (the plan with its one primary, Compare plans, the way to My
 * Cloud, Cancel plan last), then This week. Called as a function (no state of its own), so the tree it returns is the
 * caller's own. */
export function planLayout({ title, subtitle, message, primary, usage, upgrade, links, extra, cancel, footnote }: {
  title: string;
  subtitle?: ReactNode;
  message?: ReactNode;
  primary?: ReactNode;
  usage?: CloudUsage | null;
  upgrade?: UpgradeUi;
  /** Open My Cloud (absent on My Cloud's own page) and the like, after Compare plans */
  links?: ReactNode;
  /** Simple's What this place cost row */
  extra?: ReactNode;
  /** the last row: Cancel plan */
  cancel?: ReactNode;
  footnote?: ReactNode;
}) {
  return <>
    <SettingsGroup label={t("settings.simple.billing.plan")} block="plan" footnote={footnote}>
      <SettingsRows>
        <SettingRow title={title} subtitle={subtitle} message={message || undefined}>{primary ?? null}</SettingRow>
        <ProCompareRow />
        {links}
        {extra}
        {cancel}
      </SettingsRows>
    </SettingsGroup>
    {usage && usage.meters.length > 0 && <ThisWeek usage={usage} upgrade={upgrade} />}
  </>;
}

/** Simple's line for what this place has cost this week; it opens Spending, turning Advanced mode on. */
export function SpentRow({ place, onOpen }: { place: string; onOpen: () => void }) {
  const [cost, setCost] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void fetchTraces(usagePeriodRange("week")).then((list) => { if (alive) setCost(list.totals.costUsd); }).catch(() => { if (alive) setCost(undefined); });
    return () => { alive = false; };
  }, []);
  return <SettingsLinkRow title={t("settings.plan.spent", { place })} data={{ "data-plan-spent": "" }}
    value={cost === undefined ? undefined : t("settings.plan.spentWeek", { cost: formatCost(cost) })}
    onClick={() => { setAdvancedMode(true); onOpen(); }} />;
}

export { endedLine };
