import { useEffect, useRef, useState } from "react";
import { Crown, Loader2 } from "lucide-react";
import { useStore } from "@/state/store";
import { useCloudPlan } from "./ProIntroduction";
import { useCloudOffer } from "@/lib/use-cloud-offer";
import { usd } from "@/lib/cloud-plan";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { CloudUpgradeResult } from "../../electron/cloud-account.mjs";

const UPGRADE_POLL_MS = 3_000;
const UPGRADE_WAIT_MS = 3 * 60_000;

type Outcome = "waiting" | "slow" | "unavailable" | "done" | LocaleKey | null;

export function GetMaxButton({ className }: { className?: string }) {
  const { dispatch } = useStore();
  const plan = useCloudPlan();
  const bridge = window.ogb?.cloudAccount;
  const offer = useCloudOffer(plan !== null, plan?.account?.offer);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const inFlight = useRef(false);
  const waiting = outcome === "waiting";

  useEffect(() => {
    if (!waiting || !bridge) return;
    let active = true;
    const stop = () => { active = false; clearInterval(poll); clearTimeout(deadline); };
    const poll = setInterval(() => {
      void bridge.refresh().then((next) => { if (active && next.entitlement?.tier === "max") { stop(); setOutcome("done"); } }, () => {});
    }, UPGRADE_POLL_MS);
    const deadline = setTimeout(() => { stop(); setOutcome("slow"); }, UPGRADE_WAIT_MS);
    return stop;
  }, [waiting, bridge]);

  if (!plan || !bridge || outcome === "done") return null;
  const { view, account } = plan;
  const mode = view.kind === "signed-out" || view.kind === "free" ? "checkout"
    : view.kind === "paid" ? (account?.entitlement?.tier === "max" ? null : "upgrade")
      : view.kind === "unknown" || view.kind === "connecting" ? null : "settings";
  if (mode === null || (mode === "checkout" && !bridge.checkout) || (mode === "upgrade" && !bridge.upgrade)) return null;

  const max = offer?.plans.find((entry) => entry.tier === "max");
  const price = max ? usd(max.amount / 100) : null;
  const label = price ? t("science.getMax", { price }) : t("science.getMaxNoPrice");
  const asking = confirming && mode === "upgrade";

  const run = async (kind: "checkout" | "upgrade") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setConfirming(false);
    setBusy(true);
    setOutcome(null);
    try {
      const result = kind === "upgrade" ? await bridge.upgrade!("max", "science") : await bridge.checkout!("max", "science");
      setOutcome(outcomeFor(kind, result.outcome));
    } catch {
      setOutcome(kind === "upgrade" ? "science.upgradeUnknown" : "cloudAdd.failed");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const start = () => {
    if (inFlight.current) return;
    if (mode === "settings") { dispatch({ type: "toggleAppSettings", open: true, section: "cloudAccount" }); return; }
    if (mode === "checkout") { void run("checkout"); return; }
    setOutcome(null);
    setConfirming(true);
  };

  return (
    <div className={cn("flex flex-col items-end gap-1.5", className)}>
      <button type="button" disabled={busy || waiting || asking} onClick={start} className="flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-2 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40">
        {busy || waiting ? <Loader2 size={14} className="animate-spin" /> : <Crown size={14} />} {label}
      </button>
      {asking && (
        <div className="flex max-w-xs flex-col items-end gap-1.5 text-right text-[11.5px] text-ink-secondary">
          {price ? t("science.upgradeConfirm", { price }) : t("science.upgradeConfirmNoPrice")}
          <div className="flex gap-1.5">
            <button type="button" onClick={() => setConfirming(false)} className="rounded-lg bg-control px-2.5 py-1.5 text-[12px] text-ink hover:bg-raised-hover">{t("common.cancel")}</button>
            <button type="button" onClick={() => void run("upgrade")} className="rounded-lg bg-accent px-2.5 py-1.5 text-[12px] font-medium text-white hover:brightness-110">{t("science.upgradeConfirmAction")}</button>
          </div>
        </div>
      )}
      {waiting && <div role="status" className="text-[11.5px] text-ink-secondary">{t("science.upgradePending")}</div>}
      {outcome === "slow" && <div role="status" className="max-w-xs text-right text-[11.5px] text-ink-secondary">{t("science.upgradeSlow")}</div>}
      {outcome === "unavailable" && (
        <div role="alert" className="flex max-w-xs flex-col items-end gap-1.5 text-right text-[11.5px] text-warning">
          {t("science.planChangeUnavailable")}
          <button type="button" onClick={() => void bridge.openDashboard()} className="rounded-lg bg-control px-2.5 py-1.5 text-[12px] text-ink hover:bg-raised-hover">{t("cloudProPopup.manage")}</button>
        </div>
      )}
      {outcome && outcome !== "waiting" && outcome !== "slow" && outcome !== "unavailable" && (
        <div role="alert" className="max-w-xs text-right text-[11.5px] text-danger">{t(outcome)}</div>
      )}
    </div>
  );
}

function outcomeFor(mode: "checkout" | "upgrade", outcome: CloudUpgradeResult["outcome"]): Outcome {
  switch (outcome) {
    case "upgraded":
    case "already-on-plan":
      return "done";
    case "pending":
      return "waiting";
    case "unavailable":
      return "unavailable";
    case "payment-failed":
      return "science.upgradeFailed";
    case "rate-limited":
      return mode === "upgrade" ? "science.upgrade.rateLimited" : "cloudAdd.rateLimited";
    case "opened":
    case "signing-in":
      return null;
    case "unknown":
      return "science.upgradeUnknown";
    case "failed":
    case "not-subscribed":
    case "conflict":
      return mode === "upgrade" ? "science.upgradeError" : "cloudAdd.failed";
  }
}
