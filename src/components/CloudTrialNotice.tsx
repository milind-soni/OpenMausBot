// The free trial's notice (docs/cloud-pro.md, "Free trial"): the one message
// and next step for the trial on the person's Cloud, on this computer's page
// and on My Cloud's own page alike. Main says when a notice is due and shows
// each at most once a day across both (electron/cloud-trial-notice.mjs);
// lib/cloud-plan's cloudTrialView says what it says, as Settings does. When
// it shows is the notice queue's (AppNotices): never over onboarding, a
// dialog, an update being offered, or another card.
import { useEffect, useState } from "react";
import { ArrowUpRight, CalendarClock, CloudOff, CreditCard } from "lucide-react";
import type { CloudPlanBridge, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudTrialState } from "../../electron/cloud-home.mjs";
import type { CloudTrialView } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { NoticeCard, NotNowButton, PRIMARY_BUTTON } from "./NoticeCard";

/** My Cloud's page hears no account updates: it asks again this often, and whenever the window comes back. */
export const CLOUD_PLAN_REFRESH_MS = 5 * 60_000;

/** The plan as main reports it to this page, this computer's or the person's
 * own Cloud's (cloud-plan:state); null until main answers. Where main refuses
 * (a Cloud that is not this account's), it stops asking. */
export function useCloudPlanSnapshot(bridge: CloudPlanBridge | undefined): CloudPlanSnapshot | null {
  const [plan, setPlan] = useState<CloudPlanSnapshot | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const stop = () => { active = false; unsubscribe?.(); clearInterval(timer); window.removeEventListener?.("focus", read); };
    // Refused (a page main does not answer): no plan to show, and nothing more asked.
    const read = () => { void bridge.state().then(next => { if (active) setPlan(next); }, () => { if (active) setPlan({ status: "none" }); stop(); }); };
    // This computer's page hears each verified check with OpenMausBot Cloud.
    const unsubscribe = window.ogb?.cloudAccount?.onState(read);
    const timer = setInterval(read, CLOUD_PLAN_REFRESH_MS);
    window.addEventListener?.("focus", read);
    read();
    return stop;
  }, [bridge]);
  return bridge ? plan : null;
}

const ICON: Record<CloudTrialState, typeof CalendarClock> = {
  active: CalendarClock, ending: CalendarClock, processing: CreditCard, late: CreditCard, ended: CloudOff,
};

/** The card alone: one message, at most one next step, and a way to close it. */
export function CloudTrialNoticeCard({ view, failed = false, onAction, onClose }: {
  view: CloudTrialView; failed?: boolean; onAction: () => void; onClose: () => void;
}) {
  return <NoticeCard titleId="cloud-trial-notice-title" notice={`cloud-trial-${view.state}`} icon={ICON[view.state]} title={view.title} onDismiss={onClose} dismissLabel={t("cloudAdd.close")}>
    <div id="cloud-trial-notice-body">
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-secondary">{view.body}</p>
      {view.credit && <p className="mt-1.5 text-[12.5px] text-ink-secondary">{view.credit}</p>}
      {view.switchPlan && <p className="mt-1.5 text-[12.5px] text-ink-secondary">{view.switchPlan}</p>}
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
