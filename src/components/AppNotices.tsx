import { useEffect, useState } from "react";
import { Rocket, Star } from "lucide-react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import { api, useStore } from "@/state/store";
import { APP_REPOSITORY } from "@/lib/app-links";
import { track } from "@/lib/analytics";
import { brandStatus } from "@/lib/brand";
import { buyOfferAllowed, cloudNoticeKind, cloudPlanView, cloudTrialNotice, cloudTrialView, offerTrialDays } from "@/lib/cloud-plan";
import { jobRoutine, useCloudIntent } from "@/lib/cloud-intent";
import { CLOUD_INTENT_GIVEN, cloudSetupStage } from "@/lib/cloud-setup";
import { cornerPopupWaits } from "@/lib/corner-popup";
import { CLOUD_INTRO, CLOUD_NOTICE, CLOUD_PRO_UPDATE_NOTICE, CLOUD_TRIAL_NOTICE, dismissNotice, introShown, introStage, nextNotice, noticeSeen, PRODUCT_HUNT_NOTICE, PRODUCT_HUNT_UNTIL, PRODUCT_HUNT_URL, STAR_NOTICE, UPDATES_CONSENT_NOTICE, usedBefore } from "@/lib/notices";
import { cloudSignInDue, onboardingCloudOffered, type WelcomeViewer } from "@/lib/onboarding";
import { useUpdaterState } from "@/lib/updater";
import { t } from "@/lib/i18n";
import { engineReady } from "./EngineLibrary";
import { CLOUD_NOTICE_CARD, cloudNoticeStep, CloudNoticeCard } from "./CloudNotice";
import { CLOUD_PRO_POPUP_SOURCE, CloudProPopup, cloudProCloudPageView, cloudProPopupView, reportCloudProPopup, useDesktopNotices, useOtherDialogOpen,
  type CloudProPopupAction } from "./CloudProPopup";
import { CloudTrialIntroCard } from "./CloudTrialIntro";
import { useMoveQuiet } from "./CloudSendStrip";
import { CloudTrialNoticeCard, useCloudPlanSnapshot } from "./CloudTrialNotice";
import { LinkButton, NoticeCard, NoticeToast, NotNowButton } from "./NoticeCard";
import { localDesktopPage } from "./onboarding/WelcomeGate";
import { UpdatesConsentDialog, updatesConsentBridge, useUpdatesConsent } from "./UpdatesConsent";

function StarCard({ onDismiss }: { onDismiss: () => void }) {
  return <NoticeCard titleId="github-star-title" notice="github-star" icon={Star} title={t("star.title")} onDismiss={onDismiss}>
    <p className="mb-3 mt-1 text-[12.5px] text-ink-secondary">{t("star.body")}</p>
    <div className="flex flex-wrap items-center gap-3">
      <LinkButton url={APP_REPOSITORY} label={t("star.button")} onOpened={onDismiss} />
      <NotNowButton onClick={onDismiss} />
    </div>
  </NoticeCard>;
}

function ProductHuntCard({ onDone }: { onDone: (action: "upvote" | "not_now" | "close") => void }) {
  return <NoticeCard titleId="product-hunt-title" notice="product-hunt" icon={Rocket} title={t("productHunt.title")} onDismiss={() => onDone("close")}>
    <p className="mb-3 mt-1 text-[12.5px] text-ink-secondary">{t("productHunt.body")}</p>
    <div className="flex flex-wrap items-center gap-3">
      <LinkButton url={PRODUCT_HUNT_URL} label={t("productHunt.button")} onOpened={() => onDone("upvote")} />
      <NotNowButton onClick={() => onDone("not_now")} />
    </div>
  </NoticeCard>;
}

const trialKey = (trial: { state: string; endsAt: number }) => `${trial.state}:${trial.endsAt}`;
const CLOUD_SETTINGS = { type: "toggleAppSettings", open: true, section: "cloudAccount" } as const;

export function AppNotices({ quiet = false, viewer = null, now = Date.now }: { quiet?: boolean; viewer?: WelcomeViewer | null; now?: () => number }) {
  const { state, dispatch } = useStore();
  const remote = window.ogb?.remoteClient?.active === true;
  const local = localDesktopPage();
  const bridge = !remote && local ? window.ogb?.cloudAccount : undefined;
  const desktop = remote ? undefined : window.ogb?.desktopNotices;
  const desktopState = useDesktopNotices(desktop);
  // Asked once main has restored the Cloud sign-in, which it waits for before answering desktopState.
  const planBridge = !remote && (bridge || (viewer?.cloudHome && (desktopState || !desktop))) ? window.ogb?.cloudPlan : undefined;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const plan = useCloudPlanSnapshot(planBridge);
  const [offer, setOffer] = useState<CloudOffer | null | undefined>(undefined);
  const [offerFor, setOfferFor] = useState<string | null>(null);
  const [organization, setOrganization] = useState<boolean | null>(window.ogb?.organization ? null : false);
  const [closed, setClosed] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);
  const [trialOpen, setTrialOpen] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [popupShown, setPopupShown] = useState(false);
  const consentHere = (local || viewer?.cloudHome === true) && brandStatus().source !== "file";
  const consent = useUpdatesConsent(consentHere ? updatesConsentBridge() : undefined);
  const [consentDone, setConsentDone] = useState(false);
  const updater = useUpdaterState();
  const intent = useCloudIntent();
  const moving = useMoveQuiet(now);
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState(next => { updated = true; if (active) setAccount(next); });
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
  const introAllowed = Boolean(bridge) && brandStatus().source !== "file" && organization !== true && !onboardingCloudOffered(record);
  const stage = introStage(record, now());
  const trialDue = cloudTrialNotice(plan);
  const popupHere = Boolean(desktop) && (local ? Boolean(bridge) : viewer?.cloudHome === true) && brandStatus().source !== "file";
  const seenHere = local && (noticeSeen(record, CLOUD_PRO_UPDATE_NOTICE) || onboardingCloudOffered(record));
  const popupPending = popupHere && !seenHere && (!desktopState
    || (desktopState.cloud && !desktopState.seen.includes(CLOUD_PRO_UPDATE_NOTICE)));
  const wantOffer = Boolean(bridge?.offer) && ((introAllowed && view !== null && buyOfferAllowed(view) && stage !== "done")
    || (popupPending && view !== null && buyOfferAllowed(view)));
  const offerKey = wantOffer ? `${view?.kind}:${JSON.stringify(account?.offer ?? null)}` : null;
  useEffect(() => {
    if (!offerKey || !bridge?.offer) return;
    let active = true;
    const answer = (next: CloudOffer | null) => { if (active) { setOffer(next); setOfferFor(offerKey); } };
    void bridge.offer().then(answer, () => answer(null));
    return () => { active = false; };
  }, [offerKey, bridge]);
  useEffect(() => {
    if (seenHere && desktopState && !desktopState.seen.includes(CLOUD_PRO_UPDATE_NOTICE)) void desktop?.seen(CLOUD_PRO_UPDATE_NOTICE).catch(() => {});
  }, [seenHere, desktopState]);
  const page = local ? "local" : "my_cloud";
  const popupState = !popupPending ? null : !desktopState || !viewer ? "loading"
    : bridge ? cloudProPopupView(account, !bridge.offer ? null : offerFor === offerKey ? offer : undefined)
    : planBridge ? cloudProCloudPageView(plan) : "loading";
  const popupView = typeof popupState === "object" ? popupState : null;
  const popupBlocked = useOtherDialogOpen(popupPending) || Boolean(state.liveCall && state.liveCall.status !== "ended");
  const consentDue = consent.state?.available === true && consent.state.due && !consentDone;
  const consentBlocked = useOtherDialogOpen(consentDue) || Boolean(state.liveCall && state.liveCall.status !== "ended");
  const consentFact = !consentHere || consentDone ? false : consent.state === undefined ? null : consentDue ? (consentBlocked ? null : true) : false;

  const trial = plan?.trial;
  const key = trial ? trialKey(trial) : null;
  const setupRecord = record && (intent.pending || intent.sent) ? { ...record, hintsSeen: [...record.hintsSeen, CLOUD_INTENT_GIVEN] } : record;
  const setupHere = cloudSignInDue(viewer, state, engineReady)
    || ["waiting", "shown"].includes(cloudSetupStage({ viewer, connected: state.connected, enginesKnown: state.instances.length > 0,
      engineReady: state.instances.some(engineReady), onboarding: setupRecord, planned: Boolean(jobRoutine(state.routines, intent.sent)) }));
  const waits = cornerPopupWaits(state, updater, { quiet, idle: true, viewer }) || Boolean(state.cloudAdd) || state.cloudHowTo || setupHere;
  const kind = view ? cloudNoticeKind(view, account) : null;
  const introDue = (): boolean | null => {
    if (!introAllowed || !view) return false;
    if (view.kind === "unknown" || view.kind === "connecting" || organization === null) return null;
    if (!buyOfferAllowed(view) || !usedBefore(state.bots)) return false;
    if (offer === undefined) return null;
    if (offerTrialDays(offer) === null) return false;
    return introOpen || stage === "due" ? true : null;
  };
  const cards = Boolean(bridge || planBridge);
  // After a closed popup only the product-updates question may follow in this launch; nothing else does.
  const notice = waits ? null : closed ? (consentFact === true ? UPDATES_CONSENT_NOTICE : null) : cards || popupHere || consentHere ? nextNotice({
    [CLOUD_PRO_UPDATE_NOTICE]: !popupPending || moving ? false : popupState === "loading" || moving === null || (popupView !== null && popupBlocked) ? null : popupView !== null,
    [UPDATES_CONSENT_NOTICE]: consentFact,
    [PRODUCT_HUNT_NOTICE]: !cards || moving || brandStatus().source === "file" || now() >= PRODUCT_HUNT_UNTIL ? false
      : organization === null || moving === null ? null : !organization,
    [CLOUD_INTRO]: moving ? false : moving === null ? null : introDue(),
    [CLOUD_TRIAL_NOTICE]: planBridge && plan === null ? null : Boolean(key && (trialDue || trialOpen === key)),
    [CLOUD_NOTICE]: !view ? false : view.kind === "unknown" ? null
      : Boolean(kind && !noticeSeen(record, CLOUD_NOTICE_CARD[kind].dismissed)),
    [STAR_NOTICE]: !bridge || moving || brandStatus().source === "file" || !usedBefore(state.bots) ? false : moving === null ? null : true,
  }, id => id === CLOUD_INTRO ? stage === "done" && !introOpen
    : id === STAR_NOTICE || id === PRODUCT_HUNT_NOTICE ? noticeSeen(record, id) : false) : null;

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
    } else if (shownKey === CLOUD_PRO_UPDATE_NOTICE && !popupShown && popupView) {
      setPopupShown(true);
      void desktop?.shown(CLOUD_PRO_UPDATE_NOTICE).then(first => { if (first) reportCloudProPopup("shown", popupView, page); }, () => {});
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

  if (notice === CLOUD_PRO_UPDATE_NOTICE && popupView && desktop) {
    const report = (action: CloudProPopupAction) => reportCloudProPopup(action, popupView, page);
    const end = () => { void desktop.seen(CLOUD_PRO_UPDATE_NOTICE).catch(() => {}); close(); };
    const plans = (action: CloudProPopupAction) => { report(action); end(); dispatch({ type: "openCloudAdd", source: CLOUD_PRO_POPUP_SOURCE }); };
    const primary = popupView.primary.via === "add-cloud" ? () => plans("upgrade") : () => { report("manage"); end(); dispatch(CLOUD_SETTINGS); };
    return <CloudProPopup view={popupView}
      onPrimary={primary}
      onSeePlans={() => plans("see_plans")}
      onNotNow={() => { report("not_now"); end(); }}
      onClose={() => { report("close"); end(); }} />;
  }

  if (notice === UPDATES_CONSENT_NOTICE && consent.state) {
    const done = () => { setConsentDone(true); close(); };
    return <UpdatesConsentDialog signedIn={consent.state.signedIn}
      onYes={async email => { await consent.choose("opted_in", email); done(); }}
      onNo={() => { done(); void consent.choose("declined").catch(() => {}); }} />;
  }
  if (notice === CLOUD_INTRO && offer) {
    const done = (action: string) => { track("cloud_card_action", { action }); close(); save(CLOUD_INTRO); };
    return <CloudTrialIntroCard offer={offer}
      onStart={() => { done("start"); dispatch({ type: "openCloudAdd", source: "app_card" }); }}
      onHowTo={() => { done("howto"); dispatch({ type: "cloudHowTo", open: true }); }}
      onSignIn={view?.kind === "signed-out" ? () => { track("cloud_card_action", { action: "signin" }); close(); dispatch({ type: "openCloudAdd", source: "app_card", signIn: true }); } : undefined}
      onNotNow={() => { done("not_now"); setToast(t("cloudIntro.later")); }}
      onDismiss={() => { done("close"); setToast(t("cloudIntro.later")); }} />;
  }
  if (notice === CLOUD_TRIAL_NOTICE && trial) {
    const shown = cloudTrialView(trial, plan?.credit);
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
  if (notice === PRODUCT_HUNT_NOTICE) {
    return <ProductHuntCard onDone={action => { track("product_hunt_card", { action }); close(); save(PRODUCT_HUNT_NOTICE); }} />;
  }
  if (notice === STAR_NOTICE) return <StarCard onDismiss={() => { close(); save(STAR_NOTICE); }} />;
  return null;
}
