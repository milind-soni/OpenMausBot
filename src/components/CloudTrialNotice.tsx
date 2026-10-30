import { useEffect, useState } from "react";
import { ArrowUpRight, CalendarClock, CloudOff, CreditCard } from "lucide-react";
import type { CloudPlanBridge, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudTrialState } from "../../electron/cloud-home.mjs";
import type { CloudTrialView } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { NoticeCard, NotNowButton, PRIMARY_BUTTON } from "./NoticeCard";

export const CLOUD_PLAN_REFRESH_MS = 5 * 60_000;
const PLAN_CHANGED = "omb:cloud-plan-changed";
export const cloudPlanChanged = () => globalThis.window?.dispatchEvent?.(new Event(PLAN_CHANGED));

export function useCloudPlanSnapshot(bridge: CloudPlanBridge | undefined): CloudPlanSnapshot | null {
  const [plan, setPlan] = useState<CloudPlanSnapshot | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const stop = () => { active = false; unsubscribe?.(); clearInterval(timer); window.removeEventListener?.("focus", read); window.removeEventListener?.(PLAN_CHANGED, read); };
    const read = () => { void bridge.state().then(next => { if (active) setPlan(next); }, () => { if (active) setPlan({ status: "none" }); stop(); }); };
    const unsubscribe = window.ogb?.cloudAccount?.onState(read);
    const timer = setInterval(read, CLOUD_PLAN_REFRESH_MS);
    window.addEventListener?.("focus", read);
    window.addEventListener?.(PLAN_CHANGED, read);
    read();
    return stop;
  }, [bridge]);
  return bridge ? plan : null;
}

const ICON: Record<CloudTrialState, typeof CalendarClock> = {
  active: CalendarClock, ending: CalendarClock, processing: CreditCard, late: CreditCard, ended: CloudOff,
};

export function CloudTrialNoticeCard({ view, failed = false, onAction, onClose }: {
  view: CloudTrialView; failed?: boolean; onAction: () => void; onClose: () => void;
}) {
  return <NoticeCard titleId="cloud-trial-notice-title" notice={`cloud-trial-${view.state}`} icon={ICON[view.state]} title={view.title} onDismiss={onClose} dismissLabel={t("cloudAdd.close")}>
    <div id="cloud-trial-notice-body">
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">{view.body}</p>
      {view.credit && <p className="mt-1.5 text-[13px] text-ink-secondary">{view.credit}</p>}
      {view.switchPlan && <p className="mt-1.5 text-[13px] text-ink-secondary">{view.switchPlan}</p>}
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      {view.action ? <>
        <button type="button" className={PRIMARY_BUTTON} onClick={onAction}>{view.action.label}<ArrowUpRight size={14} aria-hidden="true" /></button>
        <NotNowButton onClick={onClose} />
      </> : <button type="button" className={PRIMARY_BUTTON} onClick={onClose}>{t("cloudTrial.ok")}</button>}
    </div>
    {failed && <p role="alert" className="mt-2 text-[12px] text-danger">{t("notice.openFailed")}</p>}
  </NoticeCard>;
}
