import { useState, type ReactNode } from "react";
import type { CloudRenewal } from "../../../electron/cloud-list.mjs";
import type { CloudUsage } from "../../../electron/cloud-home.mjs";
import { activeLocale, t } from "@/lib/i18n";
import { meterAmounts, meterLabel, meterPercent, resetLine } from "@/lib/usage-meter";
import { CloudCancelSheet, endedLine, type CloudRenewalActions } from "../CloudCancelPlan";
import { MeterBar, UpgradeButton, type UpgradeUi } from "../CloudUsageMeter";
import { ProCompareRow } from "../ProIntroduction";
import { SettingRow, SettingsGroup, SettingsRows } from "../SettingsPrimitives";

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

/** The last row: Cancel plan (Cancel trial), a quiet button that opens the cancel flow. */
export function CancelPlanRow({ renewal, actions, onChanged }: { renewal: CloudRenewal; actions: CloudRenewalActions; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  if (renewal.cancelled) return null;
  return (
    <SettingsGroup block="cancel">
      <SettingsRows>
        <SettingRow title={renewal.renewsAt ? t(renewal.trial ? "settings.plan.trialEnds" : "settings.plan.renews", { date: day(renewal.renewsAt) }) : t(renewal.trial ? "cloudCancel.titleTrial" : "cloudCancel.titlePlan")}>
          <button type="button" data-cloud-cancel="renewing" data-danger="" className="settings-quiet cursor-pointer" onClick={() => setOpen(true)}>
            {t(renewal.trial ? "cloudCancel.cancelTrial" : "cloudCancel.cancelPlan")}
          </button>
        </SettingRow>
      </SettingsRows>
      {open && <CloudCancelSheet renewal={renewal} actions={actions} onClose={(changed) => { setOpen(false); if (changed) onChanged?.(); }} />}
    </SettingsGroup>
  );
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

/** One Plan & billing page on every rail: the plan with its one primary, This week, the links, and Cancel plan last.
 * Called as a function (no state of its own), so the tree it returns is the caller's own. */
export function planLayout({ title, subtitle, message, primary, usage, upgrade, links, cancel, footnote }: {
  title: string;
  subtitle?: ReactNode;
  message?: ReactNode;
  primary?: ReactNode;
  usage?: CloudUsage | null;
  upgrade?: UpgradeUi;
  /** Open My Cloud (absent on My Cloud's own page), then Compare plans */
  links?: ReactNode;
  cancel?: ReactNode;
  footnote?: ReactNode;
}) {
  return <>
    <SettingsGroup label={t("settings.simple.billing.plan")} block="plan" footnote={footnote}>
      <SettingsRows>
        <SettingRow title={title} subtitle={subtitle} message={message}>{primary ?? null}</SettingRow>
      </SettingsRows>
    </SettingsGroup>
    {usage && usage.meters.length > 0 && <ThisWeek usage={usage} upgrade={upgrade} />}
    <SettingsGroup block="plan-links">
      <SettingsRows>{links}<ProCompareRow /></SettingsRows>
    </SettingsGroup>
    {cancel}
  </>;
}

export { endedLine };
