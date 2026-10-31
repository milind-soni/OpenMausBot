import { useEffect, useState } from "react";
import { Rocket, Star } from "lucide-react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import { api, useStore } from "@/state/store";
import { APP_REPOSITORY } from "@/lib/app-links";
import { track } from "@/lib/analytics";
import { boatOfferRuns } from "@/lib/boat-offer";
import { brandStatus } from "@/lib/brand";
import { buyOfferAllowed, cloudNoticeKind, cloudPlanView, cloudTrialNotice, cloudTrialView, offerTrialDays } from "@/lib/cloud-plan";
import { jobRoutine, useCloudIntent } from "@/lib/cloud-intent";
import { CLOUD_INTENT_GIVEN, cloudSetupStage } from "@/lib/cloud-setup";
import { cornerPopupWaits, firstReplyPending } from "@/lib/corner-popup";
import { BOAT_OFFER_NOTICE, CLOUD_INTRO, CLOUD_NOTICE, CLOUD_TRIAL_NOTICE, dismissNotice, introShown, introStage, launchNotice, markLaunchNotice, nextNotice, noticeSeen, PRODUCT_HUNT_NOTICE, PRODUCT_HUNT_UNTIL, PRODUCT_HUNT_URL, SIMPLE_MODE_NOTICE, STAR_NOTICE, TWO_PLACES_NOTICE, UPDATES_CONSENT_NOTICE, usedBefore, WHATS_NEW_NOTICE } from "@/lib/notices";
import { useTwoPlaces } from "@/lib/two-places";
import { useSimpleModePromptSeen } from "@/lib/simple-mode-prompt";
import { reportWhatsNew, WHATS_NEW_SOURCES, whatsNewAudience, whatsNewView, type WhatsNewAction, type WhatsNewSlide } from "@/lib/whats-new";
import { cloudSignInDue, onboardingCloudOffered, welcomeFinishedThisLaunch, type WelcomeViewer } from "@/lib/onboarding";
import { launchDialogShown, markLaunchDialog } from "@/lib/launch-dialogs";
import { useUpdaterState } from "@/lib/updater";
import { t } from "@/lib/i18n";
import { BoatOfferCard, reportBoatOffer, type BoatOfferAction } from "./BoatOffer";
import { engineReady } from "./EngineLibrary";
import { CLOUD_NOTICE_CARD, cloudNoticeStep, CloudNoticeCard } from "./CloudNotice";
import { CloudTrialIntroCard } from "./CloudTrialIntro";
import { useMoveQuiet } from "./CloudSendStrip";
import { CloudTrialNoticeCard, useCloudPlanSnapshot } from "./CloudTrialNotice";
import { LinkButton, NoticeCard, NoticeToast, NotNowButton } from "./NoticeCard";
import { useDesktopNotices, useOtherDialogOpen } from "./notice-dialogs";
import { localDesktopPage } from "./onboarding/WelcomeGate";
import { UpdatesConsentDialog, updatesConsentBridge, useUpdatesConsent } from "./UpdatesConsent";
import { useMausBotWelcomeDue } from "./MausBotWelcome";
import { reportSimpleModePrompt, SimpleModePrompt } from "./SimpleModePrompt";
import { TwoPlacesCard } from "./TwoPlacesCard";
import { WhatsNewPopup } from "./whats-new/WhatsNewPopup";

function StarCard({ onDismiss }: { onDismiss: () => void }) {
  return <NoticeCard titleId="github-star-title" notice="github-star" icon={Star} title={t("star.title")} onDismiss={onDismiss}>
    <p className="mb-3 mt-1 text-[13px] text-ink-secondary">{t("star.body")}</p>
    <div className="flex flex-wrap items-center gap-3">
      <LinkButton url={APP_REPOSITORY} label={t("star.button")} onOpened={onDismiss} />
      <NotNowButton onClick={onDismiss} />
    </div>
  </NoticeCard>;
}

function ProductHuntCard({ onDone }: { onDone: (action: "upvote" | "not_now" | "close") => void }) {
  return <NoticeCard titleId="product-hunt-title" notice="product-hunt" icon={Rocket} title={t("productHunt.title")} onDismiss={() => onDone("close")}>
    <p className="mb-3 mt-1 text-[13px] text-ink-secondary">{t("productHunt.body")}</p>
    <div className="flex flex-wrap items-center gap-3">
      <LinkButton url={PRODUCT_HUNT_URL} label={t("productHunt.button")} onOpened={() => onDone("upvote")} />
      <NotNowButton onClick={() => onDone("not_now")} />
    </div>
  </NoticeCard>;
}

const trialKey = (trial: { state: string; endsAt: number }) => `${trial.state}:${trial.endsAt}`;

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
  const [simpleShown, setSimpleShown] = useState(false);
  const [boatShown, setBoatShown] = useState(false);
  const consentHere = (local || viewer?.cloudHome === true) && brandStatus().source !== "file";
  const consent = useUpdatesConsent(consentHere ? updatesConsentBridge() : undefined);
  const [consentDone, setConsentDone] = useState(false);
  const updater = useUpdaterState();
  const intent = useCloudIntent();
  const moving = useMoveQuiet(now);
  const mausBot = useMausBotWelcomeDue(viewer);
  // Bots in two places: this computer's page only, where main knows what lives here.
  const two = useTwoPlaces();
  const twoFact = !local || two.suggest === null ? false : two.suggest === undefined ? null : true;
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
  // What's new: This computer's page of a desktop that sells MausBot Cloud, once per person; never on a branded build or a
  // desktop an organization runs.
  const whatsNewHere = Boolean(bridge && desktop) && brandStatus().source !== "file";
  const whatsNewSeen = noticeSeen(record, WHATS_NEW_NOTICE);
  const whatsNewDue = !whatsNewHere || whatsNewSeen || organization === true ? false : !desktopState || organization === null ? null
    : desktopState.cloud && !desktopState.seen.includes(WHATS_NEW_NOTICE);
  const whatsNewFor = whatsNewDue === false ? null : whatsNewAudience(account);
  const wantOffer = Boolean(bridge?.offer) && ((introAllowed && view !== null && buyOfferAllowed(view) && stage !== "done")
    || whatsNewFor === "none" || whatsNewFor === "own");
  const offerKey = wantOffer ? `${view?.kind}:${JSON.stringify(account?.offer ?? null)}` : null;
  useEffect(() => {
    if (!offerKey || !bridge?.offer) return;
    let active = true;
    const answer = (next: CloudOffer | null) => { if (active) { setOffer(next); setOfferFor(offerKey); } };
    void bridge.offer().then(answer, () => answer(null));
    return () => { active = false; };
  }, [offerKey, bridge]);
  useEffect(() => {
    if (whatsNewSeen && desktopState && !desktopState.seen.includes(WHATS_NEW_NOTICE)) void desktop?.seen(WHATS_NEW_NOTICE).catch(() => {});
  }, [whatsNewSeen, desktopState]);
  const whatsNewState = whatsNewDue === false ? "none" : whatsNewView(account, !bridge?.offer ? null : offerFor === offerKey ? offer : undefined);
  const whatsNew = typeof whatsNewState === "object" ? whatsNewState : null;
  const whatsNewBlocked = useOtherDialogOpen(whatsNewDue !== false) || Boolean(state.liveCall && state.liveCall.status !== "ended");
  const consentDue = consent.state?.available === true && consent.state.due && !consentDone;
  const consentBlocked = useOtherDialogOpen(consentDue) || Boolean(state.liveCall && state.liveCall.status !== "ended");
  const consentFact = !consentHere || consentDone ? false : consent.state === undefined ? null : consentDue ? (consentBlocked ? null : true) : false;
  // Every page with the app's chrome, desktop or Cloud, new install or not: once per browser, as the mode is.
  const simpleDue = !useSimpleModePromptSeen();
  const simpleBlocked = useOtherDialogOpen(simpleDue) || Boolean(state.liveCall && state.liveCall.status !== "ended");
  const boatHere = boatOfferRuns(now()) && brandStatus().source !== "file";

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
  // Promotions never land on a new install's first chat: they wait for its first reply, and the full-screen What's new popup
  // also for a launch after the one whose welcome just finished. Account and billing notices keep their own rules.
  // Unknown (null) until the bots have loaded, so nothing lower in the queue flashes up before them.
  const firstChat = firstReplyPending(state);
  // MausBot's first-launch card goes first: the popup and the question wait while it is due. The popup skips a launch the
  // card used; the question may follow the card once it closes, as it follows the popup.
  const afterWelcome = welcomeFinishedThisLaunch() || launchDialogShown() === "mausbot" || firstChat;
  const consentWaits = welcomeFinishedThisLaunch() || firstChat;
  const mausBotFirst = mausBot.due;
  const consentNow = consentWaits === true || consentFact === false ? false : consentWaits === null || mausBotFirst ? null : consentFact;
  // After a closed popup only the product-updates question may follow in this launch; nothing else does.
  const notice = waits ? null : closed ? (consentNow === true ? UPDATES_CONSENT_NOTICE : null) : cards || whatsNewHere || consentHere || simpleDue || boatHere || twoFact !== false ? nextNotice({
    // As the What's new popup: never in the launch whose welcome just finished, nor over MausBot's first-launch card.
    [SIMPLE_MODE_NOTICE]: !simpleDue || afterWelcome === true ? false : afterWelcome === null || mausBotFirst || simpleBlocked ? null : true,
    [WHATS_NEW_NOTICE]: whatsNewDue === false || whatsNewState === "none" || moving || afterWelcome === true ? false
      : whatsNewDue === null || whatsNewState === "loading" || !viewer || afterWelcome === null || mausBotFirst || moving === null || whatsNewBlocked ? null : true,
    [UPDATES_CONSENT_NOTICE]: consentNow,
    [TWO_PLACES_NOTICE]: twoFact,
    [PRODUCT_HUNT_NOTICE]: !cards || moving || firstChat === true || brandStatus().source === "file" || now() >= PRODUCT_HUNT_UNTIL ? false
      : organization === null || moving === null || firstChat === null ? null : !organization,
    [CLOUD_INTRO]: moving ? false : moving === null ? null : introDue(),
    [CLOUD_TRIAL_NOTICE]: planBridge && plan === null ? null : Boolean(key && (trialDue || trialOpen === key)),
    [CLOUD_NOTICE]: !view ? false : view.kind === "unknown" ? null
      : Boolean(kind && !noticeSeen(record, CLOUD_NOTICE_CARD[kind].dismissed)),
    [BOAT_OFFER_NOTICE]: !boatHere || moving || afterWelcome === true || !usedBefore(state.bots) || desktopState?.seen.includes(BOAT_OFFER_NOTICE) ? false
      : organization === null || moving === null || afterWelcome === null || mausBotFirst || (desktop && !desktopState) ? null : !organization,
    [STAR_NOTICE]: !bridge || moving || brandStatus().source === "file" || !usedBefore(state.bots) ? false : moving === null ? null : true,
  }, id => id === CLOUD_INTRO ? stage === "done" && !introOpen
    : id === STAR_NOTICE || id === PRODUCT_HUNT_NOTICE || id === BOAT_OFFER_NOTICE ? noticeSeen(record, id) : false, launchNotice()) : null;

  const shownKey = notice === CLOUD_TRIAL_NOTICE ? key : notice;
  useEffect(() => {
    if (!shownKey || !notice) return;
    markLaunchNotice(notice);
    // The popups and the question own this launch: MausBot's first-launch card waits for a later one.
    if (shownKey === SIMPLE_MODE_NOTICE || shownKey === WHATS_NEW_NOTICE || shownKey === UPDATES_CONSENT_NOTICE) markLaunchDialog("notices");
    if (shownKey === CLOUD_INTRO) {
      setIntroOpen(true);
      track("cloud_card_shown", { variant: view?.kind === "signed-out" ? "signed_out" : "free" });
      const patch = introShown(record, now());
      if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) }).then(config => dispatch({ type: "configStatus", config })).catch(() => {});
    } else if (notice === CLOUD_TRIAL_NOTICE && trialOpen !== shownKey) {
      setTrialOpen(shownKey);
      void planBridge?.noticeSeen?.().catch(() => {});
    } else if (shownKey === SIMPLE_MODE_NOTICE && !simpleShown) {
      setSimpleShown(true);
      reportSimpleModePrompt("shown");
    } else if (shownKey === BOAT_OFFER_NOTICE && !boatShown) {
      setBoatShown(true);
      reportBoatOffer("shown", "card");
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

  if (notice === SIMPLE_MODE_NOTICE) return <SimpleModePrompt onClose={close} />;

  if (notice === WHATS_NEW_NOTICE && whatsNew && desktop) {
    const report = (action: WhatsNewAction, slide: WhatsNewSlide) => reportWhatsNew(action, slide, whatsNew);
    const done = () => { close(); save(WHATS_NEW_NOTICE); void desktop.seen(WHATS_NEW_NOTICE).catch(() => {}); };
    return <WhatsNewPopup view={whatsNew} report={report} onDone={done} onBuy={slide => dispatch({ type: "openCloudAdd", source: WHATS_NEW_SOURCES[slide] })} />;
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
  if (notice === TWO_PLACES_NOTICE && two.suggest) {
    const { key, kind } = two.suggest;
    return <TwoPlacesCard suggest={two.suggest}
      onBring={() => { track("two_places_card", { action: "bring", kind }); return two.accept(key).then(close); }}
      onDismiss={() => { track("two_places_card", { action: "not_now", kind }); two.dismiss(key); close(); }} />;
  }
  if (notice === PRODUCT_HUNT_NOTICE) {
    return <ProductHuntCard onDone={action => { track("product_hunt_card", { action }); close(); save(PRODUCT_HUNT_NOTICE); }} />;
  }
  if (notice === BOAT_OFFER_NOTICE) {
    const done = (action: BoatOfferAction) => {
      reportBoatOffer(action, "card"); close(); save(BOAT_OFFER_NOTICE);
      void desktop?.seen(BOAT_OFFER_NOTICE).catch(() => {});
    };
    return <BoatOfferCard onDone={done} />;
  }
  if (notice === STAR_NOTICE) return <StarCard onDismiss={() => { close(); save(STAR_NOTICE); }} />;
  return null;
}
