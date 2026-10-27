// The welcome's Cloud beat: MausBot Cloud offered to a new desktop where it can be bought now. Start opens the buy sheet
// over the welcome (which goes on when the sheet closes); Not now goes on at once.
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import type { CloudAccountState } from "../../../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../../../electron/cloud-home.mjs";
import { CloudMascotScene } from "@/components/cloud-buy/CloudMascotScene";
import { track } from "@/lib/analytics";
import { brandStatus } from "@/lib/brand";
import { buyOfferAllowed, cloudBeatTerms, cloudPlanView } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { CLOUD_PRO_UPDATE_NOTICE } from "@/lib/notices";
import { cloudBeatPossible, cloudBeatWanted, hintSeenPatch, ONBOARDING_CLOUD_HINT } from "@/lib/onboarding";
import type { LocaleKey } from "@/locales";
import { api, useStore } from "@/state/store";
import { localDesktopPage } from "../WelcomeGate";
import { QuietButton, staggerIndex, type BeatProps } from "./shared";

/** How long the welcome waits for the Admin's offer before it leaves the Cloud beat out. */
export const CLOUD_BEAT_WAIT_MS = 6_000;
const TICKS: readonly LocaleKey[] = ["onboarding.cloud.routines", "onboarding.cloud.phone", "onboarding.cloud.move"];

/** The offer for the welcome's Cloud beat, or null: decided once, within `wait`, and never waited on; none once this
 * desktop has seen the Cloud Pro popup. `shown` (the preview) stands in for the bridge. */
export function useCloudBeatOffer(hosted: boolean, shown?: CloudOffer | null, wait = CLOUD_BEAT_WAIT_MS): CloudOffer | null {
  const remote = !localDesktopPage() || window.ogb?.remoteClient?.active === true;
  const bridge = remote ? undefined : window.ogb?.cloudAccount;
  const desktop = remote ? undefined : window.ogb?.desktopNotices;
  const place = { bridge: Boolean(bridge?.offer), branded: brandStatus().source === "file", hosted, remote };
  const possible = shown === undefined && cloudBeatPossible(place);
  const [decided, setDecided] = useState<CloudOffer | null>(null);
  useEffect(() => {
    if (!possible || !bridge?.offer) return;
    let active = true, done = false, account: CloudAccountState | null = null, offer: CloudOffer | null | undefined;
    let popupSeen: boolean | undefined = desktop ? undefined : false;
    const settle = (value: CloudOffer | null) => { if (active && !done) { done = true; setDecided(value); } };
    const check = () => {
      if (popupSeen) return settle(null);
      const view = cloudPlanView(account);
      if (view.kind === "unknown" || offer === undefined || popupSeen === undefined) return;
      settle(cloudBeatWanted({ ...place, mayBuy: buyOfferAllowed(view), offer }) ? offer : null);
    };
    const unsubscribe = bridge.onState(next => { account = next; check(); });
    void bridge.state().then(next => { account ??= next; check(); }, () => settle(null));
    void bridge.offer().then(next => { offer = next; check(); }, () => settle(null));
    void desktop?.state().then(next => { popupSeen = next.seen.includes(CLOUD_PRO_UPDATE_NOTICE); check(); }, () => settle(null));
    const timer = setTimeout(() => settle(null), wait);
    return () => { active = false; unsubscribe(); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [possible, bridge]);
  return shown !== undefined ? shown : decided;
}

export function CloudBeat({ offer, onNext, onSkip, setMascot }: BeatProps & { offer: CloudOffer }) {
  const { state, dispatch } = useStore();
  const [sheet, setSheet] = useState<"asked" | "open" | null>(null);
  const terms = cloudBeatTerms(offer);
  useEffect(() => {
    setMascot("working");
    const patch = hintSeenPatch(state.config?.onboarding, ONBOARDING_CLOUD_HINT);
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) }).then(config => dispatch({ type: "configStatus", config })).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The sheet opened from here sits over the welcome; once it has been open and closes, the welcome goes on.
  useEffect(() => {
    if (sheet === "asked" && state.cloudAdd) setSheet("open");
    else if (sheet === "open" && !state.cloudAdd) { setSheet(null); onNext(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, state.cloudAdd]);
  const start = () => {
    track("onboarding_cloud", { action: "start_trial", trial: terms.trial });
    setSheet("asked");
    dispatch({ type: "openCloudAdd", source: "app_onboarding" });
  };
  const notNow = () => { track("onboarding_cloud", { action: "not_now" }); onSkip(); };
  return <div data-cloud-beat className="flex flex-col">
    <p className="animate-rise mt-1 text-[14px] leading-relaxed text-ink-secondary">{t("onboarding.cloud.body")}</p>
    <div className="animate-rise mt-3" style={staggerIndex(1)}><CloudMascotScene variant="beat" paused={sheet !== null} /></div>
    <ul aria-label={t("onboarding.cloud.ticks")} className="stagger mt-3 flex flex-col gap-2">
      {TICKS.map((key, index) => <li key={key} className="animate-rise flex items-center gap-2.5 text-[14px] text-ink" style={staggerIndex(index + 2)}>
        <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-full bg-accent/12 text-accent-text"><Check size={13} strokeWidth={2.6} /></span>{t(key)}
      </li>)}
    </ul>
    <p data-cloud-beat-terms className="animate-rise mt-4 rounded-xl border border-hairline/70 bg-card/70 px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-secondary" style={staggerIndex(5)}>{terms.line}</p>
    <button type="button" data-primary onClick={start} className="ui-button ui-button-primary mt-5 min-h-11 w-full rounded-xl text-[15px] font-semibold">{terms.action}</button>
    <QuietButton type="button" onClick={notNow} className="mt-2.5 self-center py-1 text-[13px]">{t("notice.notNow")}</QuietButton>
    <p className="mt-2 text-center text-[12px] text-ink-tertiary">{t("onboarding.cloud.later")}</p>
  </div>;
}
