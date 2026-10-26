import { useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Gauge, Loader2, X } from "lucide-react";

import type { CloudPlanBridge, CloudPlanSnapshot, CloudUpgradePreview, CloudUpgradeRefusal } from "../../electron/cloud-account.mjs";
import type { CloudUsage, CloudUsageMeter } from "../../electron/cloud-home.mjs";
import { cloudPlanChanged, useCloudPlanSnapshot } from "./CloudTrialNotice";
import { ConfirmDialog } from "./ConfirmDialog";
import { Card } from "./SettingsPrimitives";
import { localDesktopPage } from "./onboarding/WelcomeGate";
import { cloudPlanLabel } from "@/lib/cloud-plan";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  meterAmounts, meterBand, meterLabel, meterPercent, nextPlan, readUsageCardDismissed, rememberUsageCardDismissed, resetLine, upgradeConfirmBody,
  upgradeLabel, upgradePath, usageCardView, type MeterBand,
} from "@/lib/usage-meter";
import type { LocaleKey } from "@/locales";
import { useStore } from "@/state/store";

const TEAM_TIERS: readonly string[] = ["team", "business"];
export type UpgradeSource = "app_usage" | "app_settings";

export function usageBridge(cloudHome: boolean): CloudPlanBridge | undefined {
  if (window.ogb?.remoteClient?.active === true) return undefined;
  return localDesktopPage() ? (window.ogb?.cloudAccount ? window.ogb?.cloudPlan : undefined) : cloudHome ? window.ogb?.cloudPlan : undefined;
}

export function useCloudUsage(): { usage: CloudUsage | null; bridge: CloudPlanBridge | undefined; teamHome: boolean } {
  const { state } = useStore();
  const bridge = usageBridge(state.config?.cloudHome === true);
  const plan: CloudPlanSnapshot | null = useCloudPlanSnapshot(bridge);
  return { usage: plan?.status === "paid" ? plan.usage ?? null : null, bridge, teamHome: Boolean(state.config?.cloudHome && state.config?.team) };
}

export function MeterBar({ meter, label, compact = false }: { meter: CloudUsageMeter; label: string; compact?: boolean }) {
  const percent = meterPercent(meter), band = meterBand(percent);
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={meterAmounts(meter)}
      data-meter={meter.kind} data-band={band} className={cn("w-full overflow-hidden rounded-full bg-inset", compact ? "h-1.5" : "h-2")}>
      <div className={cn("h-full rounded-full", BAR[band])} style={{ width: `${Math.max(percent, meter.used > 0 ? 2 : 0)}%` }} />
    </div>
  );
}
const BAR: Record<MeterBand, string> = { ok: "bg-accent", near: "bg-warning", full: "bg-danger" };
const AMOUNT: Record<MeterBand, string> = { ok: "text-ink-secondary", near: "text-warning", full: "text-danger" };

export function MeterRow({ meter, compact = false }: { meter: CloudUsageMeter; compact?: boolean }) {
  const label = meterLabel(meter.kind), band = meterBand(meterPercent(meter));
  return (
    <div className={compact ? "mt-2.5" : "py-2.5"}>
      <div className={cn("mb-1 flex flex-wrap items-baseline justify-between gap-x-3", compact ? "text-[12px]" : "text-[13px]")}>
        <span className="min-w-0 text-ink">{label}</span>
        <span className={cn("ms-auto shrink-0 tabular-nums", AMOUNT[band])}>{meterAmounts(meter)}</span>
      </div>
      <MeterBar meter={meter} label={label} compact={compact} />
    </div>
  );
}

const REFUSAL: Record<CloudUpgradeRefusal, LocaleKey> = {
  payment_failed: "usageMeter.err.paymentFailed", not_subscribed: "usageMeter.err.notSubscribed", already_on_plan: "usageMeter.err.alreadyOnPlan",
  plan_change_unavailable: "usageMeter.err.unavailable", confirmation_required: "usageMeter.err.priceChanged", price_changed: "usageMeter.err.priceChanged",
  rate_limited: "usageMeter.err.rateLimited",
};
export type UpgradeNote = { tone: "good" | "info" | "bad"; text: string };
const failed = (): UpgradeNote => ({ tone: "bad", text: t("usageMeter.err.failed") });
const done = (tier: string): UpgradeNote => ({ tone: "good", text: t("usageMeter.done", { plan: cloudPlanLabel(tier) }) });
const pending = (): UpgradeNote => ({ tone: "info", text: t("usageMeter.pending") });

export async function previewUpgrade(bridge: CloudPlanBridge, usage: CloudUsage, source: UpgradeSource, tier: string | undefined = nextPlan(usage)?.tier):
  Promise<{ preview: CloudUpgradePreview } | { note: UpgradeNote }> {
  if (upgradePath(usage) !== "app" || !tier || !bridge.upgradePreview) {
    await bridge.manage();
    return { note: { tone: "info", text: t("usageMeter.browser") } };
  }
  const shown = await bridge.upgradePreview(tier, source);
  switch (shown.outcome) {
    case "preview": return { preview: shown.preview };
    case "settled": return { note: shown.status === "upgraded" ? done(shown.tier) : pending() };
    case "browser": return { note: { tone: "info", text: t("usageMeter.browser") } };
    case "refused": return { note: { tone: "bad", text: t(REFUSAL[shown.code]) } };
    default: return { note: failed() };
  }
}

/** Security: only the confirm's own button calls this; nothing else sends a plan change. */
export async function confirmUpgrade(bridge: CloudPlanBridge, preview: CloudUpgradePreview, source: UpgradeSource): Promise<UpgradeNote> {
  if (!bridge.upgrade) return failed();
  const result = await bridge.upgrade(preview.plan, source);
  switch (result.outcome) {
    case "upgraded": return done(result.tier);
    case "pending": return pending();
    case "unconfirmed": return { tone: "info", text: t("usageMeter.unconfirmed") };
    case "refused": return { tone: "bad", text: t(REFUSAL[result.code]) };
    default: return failed();
  }
}

export function useUpgrade(bridge: CloudPlanBridge | undefined, usage: CloudUsage | null, source: UpgradeSource) {
  const [busy, setBusy] = useState<"preview" | "change" | null>(null);
  const [preview, setPreview] = useState<CloudUpgradePreview | null>(null);
  const [note, setNote] = useState<UpgradeNote | null>(null);
  const running = useRef(false);
  const run = (phase: "preview" | "change", work: () => Promise<void>) => {
    if (running.current || !bridge) return;
    running.current = true; setBusy(phase); setNote(null);
    void work().catch(() => setNote(failed())).finally(() => { running.current = false; setBusy(null); });
  };
  const start = (tier?: string) => run("preview", async () => {
    if (!usage) return;
    const next = await previewUpgrade(bridge!, usage, source, tier ?? nextPlan(usage)?.tier);
    if ("preview" in next) setPreview(next.preview); else { setNote(next.note); cloudPlanChanged(); }
  });
  const confirm = () => run("change", async () => {
    if (!preview) return;
    try { setNote(await confirmUpgrade(bridge!, preview, source)); } finally { setPreview(null); cloudPlanChanged(); }
  });
  const dialog = (
    <ConfirmDialog
      open={preview !== null}
      tone="neutral"
      icon={<Gauge size={18} className="text-accent" />}
      title={preview ? t("usageMeter.confirm.title", { plan: cloudPlanLabel(preview.plan) }) : ""}
      body={preview ? upgradeConfirmBody(preview) : ""}
      confirmLabel={preview ? t("usageMeter.confirm.action", { plan: cloudPlanLabel(preview.plan) }) : ""}
      cancelLabel={t("usageMeter.confirm.cancel")}
      pending={busy === "change"}
      onCancel={() => { if (busy !== "change") setPreview(null); }}
      onConfirm={confirm}
    />
  );
  return { busy, note, start, dialog, confirming: preview !== null };
}

export function NoteLine({ note }: { note: UpgradeNote | null }) {
  if (!note) return null;
  return <p role={note.tone === "bad" ? "alert" : "status"} className={cn("text-[12px] leading-relaxed", note.tone === "bad" ? "text-danger" : note.tone === "good" ? "text-success" : "text-ink-secondary")}>{note.text}</p>;
}

type UpgradeUi = { busy: "preview" | "change" | null; note: UpgradeNote | null; onUpgrade: (tier?: string) => void };

export function CloudUsageCardView({ usage, meters, band, upgrade, onHide, onSeeAll, children }: {
  usage: CloudUsage; meters: CloudUsageMeter[]; band: "near" | "full"; upgrade: UpgradeUi; onHide: () => void; onSeeAll: () => void; children?: ReactNode;
}) {
  const path = upgradePath(usage), target = nextPlan(usage);
  return (
    <section aria-labelledby="cloud-usage-card-title" data-cloud-usage-card={band}
      className="mb-2 rounded-xl border border-hairline/50 bg-card p-3 text-ink shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <h2 id="cloud-usage-card-title" className="min-w-0 text-[13px] font-semibold leading-5">{t(band === "full" ? "usageMeter.card.full" : "usageMeter.card.near")}</h2>
        <button type="button" onClick={onHide} aria-label={t("usageMeter.card.hide")} title={t("usageMeter.card.hide")} className="ui-icon-button -me-1 -mt-0.5 shrink-0"><X size={14} /></button>
      </div>
      {meters.map((meter) => <MeterRow key={meter.kind} meter={meter} compact />)}
      <p className="mt-2 text-[11.5px] text-ink-secondary">{resetLine(usage)}</p>
      {path !== "top" && (
        <button type="button" className="ui-button ui-button-primary mt-2.5 w-full justify-center gap-1.5" disabled={upgrade.busy !== null} onClick={() => upgrade.onUpgrade()}>
          {upgrade.busy === "preview" && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
          {target ? t("usageMeter.upgradeToShort", { plan: cloudPlanLabel(target.tier) }) : t("usageMeter.upgrade")}
          {path === "browser" && <ArrowUpRight size={13} aria-hidden="true" />}
        </button>
      )}
      <button type="button" className="mt-1.5 w-full py-1 text-center text-[12px] text-ink-secondary hover:text-ink" onClick={onSeeAll}>{t("usageMeter.card.seeAll")}</button>
      {upgrade.note && <div className="mt-1"><NoteLine note={upgrade.note} /></div>}
      {children}
    </section>
  );
}

export function CloudUsageCard() {
  const { dispatch } = useStore();
  const { usage, bridge, teamHome } = useCloudUsage();
  const [dismissed, setDismissed] = useState(readUsageCardDismissed);
  const upgrade = useUpgrade(bridge, usage, "app_usage");
  const view = usageCardView({ usage, teamHome, dismissed });
  if (!view || !usage) return null;
  const hide = () => { rememberUsageCardDismissed(view.dismissKey); setDismissed(view.dismissKey); };
  return (
    <CloudUsageCardView usage={usage} meters={view.meters} band={view.band} upgrade={{ busy: upgrade.busy, note: upgrade.note, onUpgrade: upgrade.start }}
      onHide={hide} onSeeAll={() => dispatch({ type: "toggleAppSettings", open: true, section: "general" })}>
      {upgrade.dialog}
    </CloudUsageCardView>
  );
}

export function CloudUsageSettingsView({ usage, upgrade, children }: { usage: CloudUsage; upgrade: UpgradeUi; children?: ReactNode }) {
  const path = upgradePath(usage), target = nextPlan(usage), others = [...usage.upgrades].sort((a, b) => a.amount - b.amount).slice(1);
  return (
    <Card title={t("usageMeter.title")} subtitle={t("usageMeter.subtitle", { plan: cloudPlanLabel(usage.tier) })}>
      <div data-cloud-usage={usage.tier}>
        {usage.meters.length ? <div className="divide-y divide-hairline/30">{usage.meters.map((meter) => <MeterRow key={meter.kind} meter={meter} />)}</div>
          : <p className="text-[13px] text-ink-secondary">{t("usageMeter.empty")}</p>}
        <p className="mt-2 text-[12px] text-ink-secondary">{resetLine(usage)}</p>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          {path === "top" ? (
            <p className="text-[13px] text-ink-secondary">{t(TEAM_TIERS.includes(usage.tier) ? "usageMeter.teamPlan" : "usageMeter.topPlan")}</p>
          ) : (
            <button type="button" className="ui-button ui-button-primary gap-1.5" disabled={upgrade.busy !== null} onClick={() => upgrade.onUpgrade()}>
              {upgrade.busy === "preview" && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
              {target ? upgradeLabel(target) : t("usageMeter.upgrade")}
              {path === "browser" && <ArrowUpRight size={13} aria-hidden="true" />}
            </button>
          )}
          {path === "app" && others.map((other) => (
            <button key={other.tier} type="button" disabled={upgrade.busy !== null} onClick={() => upgrade.onUpgrade(other.tier)}
              className="cursor-pointer text-[12.5px] text-ink-secondary underline underline-offset-2 hover:text-ink disabled:opacity-50">{upgradeLabel(other)}</button>
          ))}
        </div>
        {upgrade.note && <div className="mt-2"><NoteLine note={upgrade.note} /></div>}
      </div>
      {children}
    </Card>
  );
}

export function CloudUsageSettings() {
  const { usage, bridge, teamHome } = useCloudUsage();
  const upgrade = useUpgrade(bridge, usage, "app_settings");
  if (!usage || (teamHome && !TEAM_TIERS.includes(usage.tier))) return null;
  return (
    <CloudUsageSettingsView usage={usage} upgrade={{ busy: upgrade.busy, note: upgrade.note, onUpgrade: upgrade.start }}>
      {upgrade.dialog}
    </CloudUsageSettingsView>
  );
}
