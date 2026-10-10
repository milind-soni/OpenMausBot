// The one place the desktop app's notices appear (src/lib/notices.ts): at the
// bottom left, one at a time, in order:
// 1. the card after the update, offering OpenMausBot Cloud's free trial to
//    someone with no plan (CloudTrialIntro);
// 2. the free trial's own notice, for someone in one (CloudTrialNotice);
// 3. This computer's My Cloud card, for someone with a plan (CloudNotice);
// 4. "Star us on GitHub".
// Never over setup, a dialog, busy work or an update, and only in the desktop
// app: This computer's page has all four; the person's own Cloud page has
// only the trial's notice (it has no Cloud account bridge); a browser, another
// server's page, companion mode and a dev build have none. The card after the
// update is never shown on a branded build or a desktop signed in with an
// organization: that desktop is not ours to advertise on.
import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import { api, CLOUD_LINK_SETTINGS, useStore } from "@/state/store";
import { APP_REPOSITORY } from "@/lib/app-links";
import { track } from "@/lib/analytics";
import { brandStatus } from "@/lib/brand";
import { buyOfferAllowed, cloudNoticeKind, cloudPlanView, cloudTrialNotice, cloudTrialView, offerTrialDays, personalAmount } from "@/lib/cloud-plan";
import { cloudSetupStage } from "@/lib/cloud-setup";
import { cornerPopupWaits } from "@/lib/corner-popup";
import { CLOUD_INTRO, CLOUD_NOTICE, CLOUD_TRIAL_NOTICE, dismissNotice, introShown, introStage, nextNotice, noticeSeen, STAR_NOTICE, usedBefore } from "@/lib/notices";
import { cloudSignInDue, type WelcomeViewer } from "@/lib/onboarding";
import { useUpdaterState } from "@/lib/updater";
import { t } from "@/lib/i18n";
import { engineReady } from "./EngineLibrary";
import { CLOUD_NOTICE_CARD, cloudNoticeStep, CloudNoticeCard } from "./CloudNotice";
import { CloudTrialIntroCard } from "./CloudTrialIntro";
import { CloudTrialNoticeCard, useCloudPlanSnapshot } from "./CloudTrialNotice";
import { LinkButton, NoticeCard, NoticeToast, NotNowButton } from "./NoticeCard";
import { localDesktopPage } from "./onboarding/WelcomeGate";

function StarCard({ onDismiss }: { onDismiss: () => void }) {
  return <NoticeCard titleId="github-star-title" notice="github-star" icon={Star} title={t("star.title")} onDismiss={onDismiss}>
    <p className="mb-3 mt-1 text-[12.5px] text-ink-secondary">{t("star.body")}</p>
    <div className="flex flex-wrap items-center gap-3">
      <LinkButton url={APP_REPOSITORY} label={t("star.button")} onOpened={onDismiss} />
      <NotNowButton onClick={onDismiss} />
    </div>
  </NoticeCard>;
}

/** A trial notice's identity: its trial's state and end. A new state is a new notice. */
const trialKey = (trial: { state: string; endsAt: number }) => `${trial.state}:${trial.endsAt}`;

export function AppNotices({ quiet = false, viewer = null, now = Date.now }: { quiet?: boolean; viewer?: WelcomeViewer | null; now?: () => number }) {
  const { state, dispatch } = useStore();
  const remote = window.ogb?.remoteClient?.active === true;
  // This computer's own page has the Cloud account; the person's own Cloud page has only its plan.
  const bridge = !remote && localDesktopPage() ? window.ogb?.cloudAccount : undefined;
  const planBridge = !remote && (bridge || viewer?.cloudHome) ? window.ogb?.cloudPlan : undefined;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const plan = useCloudPlanSnapshot(planBridge);
  // What this person may buy (undefined: not asked yet), whether this desktop
  // is signed in with an organization (null: not known yet).
  const [offer, setOffer] = useState<CloudOffer | null | undefined>(undefined);
  const [organization, setOrganization] = useState<boolean | null>(window.ogb?.organization ? null : false);
  // One notice closed here leaves the rest for another launch; the trial
  // notice on screen stays until it is closed or its trial moves on.
  const [closed, setClosed] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);
  const [trialOpen, setTrialOpen] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const updater = useUpdaterState();
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState(next => { updated = true; if (active) setAccount(next); });
    // Reads the native snapshot only; never signs in or refreshes by itself.
    void bridge.state().then(next => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  useEffect(() => {
    const org = window.ogb?.organization;
    if (!org) return;
    let active = true;
    const read = (next: { status: string; organization?: unknown }) => { if (active) setOrganization(next.status !== "signed-out" && Boolean(next.organization)); };
    const unsubscribe = org.onState(read);
    void org.state().then(read, () => { if (active) setOrganization(false); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const view = bridge ? cloudPlanView(account) : null;
  const record = state.config?.onboarding;
  const introAllowed = Boolean(bridge) && brandStatus().source !== "file" && organization !== true;
  const stage = introStage(record, now());
  // Asked only while the card after the update could be due (and, for
  // someone in a trial on this computer's page, for Personal's price in its
  // last days); main keeps the answer for a while.
  const trialDue = cloudTrialNotice(plan);
  const wantOffer = Boolean(bridge?.offer) && ((introAllowed && view !== null && buyOfferAllowed(view) && stage !== "done") || trialDue?.state === "active");
  const offerKey = wantOffer ? `${view?.kind}:${JSON.stringify(account?.offer ?? null)}` : null;
  useEffect(() => {
    if (!offerKey || !bridge?.offer) return;
    let active = true;
    void bridge.offer().then(next => { if (active) setOffer(next); }, () => { if (active) setOffer(null); });
    return () => { active = false; };
  }, [offerKey, bridge]);

  const trial = plan?.trial;
  const key = trial ? trialKey(trial) : null;
  // Onboarding first, here and on My Cloud: its engine sign-in and its setup checklist (which sits in this corner).
  const setupHere = cloudSignInDue(viewer, state, engineReady)
    || ["waiting", "shown"].includes(cloudSetupStage({ viewer, connected: state.connected, enginesKnown: state.instances.length > 0,
      engineReady: state.instances.some(engineReady), onboarding: record }));
  const waits = cornerPopupWaits(state, updater, { quiet, idle: true, viewer }) || Boolean(state.cloudAdd) || state.cloudHowTo || setupHere;
  const kind = view ? cloudNoticeKind(view, account) : null;
  // The card after the update: someone who may buy, has used the app before
  // this launch, and only while a trial is offered (it waits for one). Shown
  // today already, it waits for tomorrow and holds the cards after it; on
  // screen, it stays until it is closed.
  const introDue = (): boolean | null => {
    if (!introAllowed || !view) return false;
    if (view.kind === "unknown" || view.kind === "connecting" || organization === null) return null;
    if (!buyOfferAllowed(view) || !usedBefore(state.bots)) return false;
    if (offer === undefined) return null;
    if (offerTrialDays(offer) === null) return false;
    return introOpen || stage === "due" ? true : null;
  };
  const notice = !closed && !waits && (bridge || planBridge) ? nextNotice({
    [CLOUD_INTRO]: introDue(),
    // The trial's notice: the state main says is due; on screen, it stays
    // until it is closed or its trial moves on (main then says it was seen).
    [CLOUD_TRIAL_NOTICE]: planBridge && plan === null ? null : Boolean(key && (trialDue || trialOpen === key)),
    // This computer's My Cloud card: unknown holds the star; Not now is per card.
    [CLOUD_NOTICE]: !view ? false : view.kind === "unknown" ? null
      : Boolean(kind && !noticeSeen(record, CLOUD_NOTICE_CARD[kind].dismissed)),
    [STAR_NOTICE]: Boolean(bridge) && brandStatus().source !== "file" && usedBefore(state.bots),
  }, id => id === CLOUD_INTRO ? stage === "done" && !introOpen : id === STAR_NOTICE ? noticeSeen(record, id) : false) : null;

  // Shown: the card after the update counts today; the trial's notice tells
  // main, which shows it no more today on either page.
  const shownKey = notice === CLOUD_TRIAL_NOTICE ? key : notice;
  useEffect(() => {
    if (!shownKey) return;
    if (shownKey === CLOUD_INTRO) {
      setIntroOpen(true);
      track("cloud_card_shown", { variant: view?.kind === "signed-out" ? "signed_out" : "free" });
      const patch = introShown(record, now());
      if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) }).then(config => dispatch({ type: "configStatus", config })).catch(() => {});
    } else if (notice === CLOUD_TRIAL_NOTICE && trialOpen !== shownKey) {
      setTrialOpen(shownKey);
      void planBridge?.noticeSeen?.().catch(() => {});
    }
  }, [shownKey]);

  const save = (id: string) => {
    const patch = dismissNotice(record, id);
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) })
      .then(config => dispatch({ type: "configStatus", config })).catch(() => {});
  };
  const close = () => { setClosed(true); setTrialOpen(null); setFailed(false); };
  if (toast) return <NoticeToast text={toast} onDone={() => setToast(null)} />;
  if (!notice) return null;

  if (notice === CLOUD_INTRO && offer) {
    // Any button, the X and Escape end it for good. Sign in only hides it for now.
    const done = (action: string) => { track("cloud_card_action", { action }); close(); save(CLOUD_INTRO); };
    return <CloudTrialIntroCard offer={offer}
      onStart={() => { done("start"); dispatch({ type: "openCloudAdd", source: "app_card" }); }}
      onHowTo={() => { done("howto"); dispatch({ type: "cloudHowTo", open: true }); }}
      onSignIn={view?.kind === "signed-out" ? () => { track("cloud_card_action", { action: "signin" }); close(); dispatch(CLOUD_LINK_SETTINGS); } : undefined}
      onNotNow={() => { done("not_now"); setToast(t("cloudIntro.later")); }}
      onDismiss={() => { done("close"); setToast(t("cloudIntro.later")); }} />;
  }
  if (notice === CLOUD_TRIAL_NOTICE && trial) {
    const shown = cloudTrialView(trial, plan?.credit, { personal: personalAmount(offer) });
    // Opens the Plan page in the browser: subscribing, the billing portal, payment status.
    const act = () => { setFailed(false); void planBridge?.manage().then(close, () => setFailed(true)); };
    return <CloudTrialNoticeCard view={shown} failed={failed} onAction={act} onClose={close} />;
  }
  if (notice === CLOUD_NOTICE && kind && bridge) {
    const act = () => {
      if (busy) return;
      setFailed(false); setBusy(true);
      void cloudNoticeStep(kind, bridge).then(next => setAccount(next), () => setFailed(true)).finally(() => setBusy(false));
    };
    return <CloudNoticeCard kind={kind} busy={busy} failed={failed} onAction={act} onNotNow={() => { close(); save(CLOUD_NOTICE_CARD[kind].dismissed); }} />;
  }
  if (notice === STAR_NOTICE) return <StarCard onDismiss={() => { close(); save(STAR_NOTICE); }} />;
  return null;
}
