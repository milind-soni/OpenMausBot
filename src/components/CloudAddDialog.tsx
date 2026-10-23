// Security: checkout never runs in the app; main opens the provider's checkout page in the default browser and the app
// follows its own session, never the return. The emailed code's attempt, the token and the checkout page stay in main.
import { useEffect, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { CloudColor } from "../../electron/cloud-buy.mjs";
import type { CloudAccountState, CloudCheckoutOutcome } from "../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { cloudColor, cloudNameShown, DEFAULT_CLOUD_COLOR } from "@/lib/cloud-look";
import { cloudAddView, offerPlan, sameTerms, startedSleeps, type CloudAddView, type CloudSignInPhase } from "@/lib/cloud-plan";
import { t } from "@/lib/i18n";
import { welcomeOnScreen } from "@/lib/onboarding";
import { useStore } from "@/state/store";
import { ChooseScreen } from "./cloud-buy/ChooseScreen";
import { OneCloudScreen, StatusScreen } from "./cloud-buy/OneCloudScreen";
import { PayScreen } from "./cloud-buy/PayScreen";
import { StagingMark } from "./cloud-buy/parts";
import { SetupScreen, TeamReadyScreen, TeamSetupScreen } from "./cloud-buy/SetupScreen";
import { BrowserSignInScreen, codeDigits, SignInScreen } from "./cloud-buy/SignInScreen";

export interface CloudAddActions {
  /** A plan card's button: the in-app sign-in when signed out, then (or else) that plan's checkout. */
  start(tier: string): void;
  signIn(): void;
  back(): void;
  email(value: string): void;
  sendCode(): void;
  changeEmail(): void;
  code(value: string): void;
  resend(): void;
  /** The browser approval: single sign-on, two-step, or an Admin without the email route. */
  browser(): void;
  reopenBrowser(): void;
  cancelSignIn(): void;
  reopenCheckout(): void;
  copyLink(): void;
  changePlan(): void;
  retry(): void;
  name(value: string): void;
  color(value: CloudColor): void;
  openCloud(): void;
  /** A Team or Business plan's Cloud: the team's, opened as the switcher opens it. */
  openTeam(teamId: string): void;
  notNow(): void;
  interest(): void;
  close(): void;
}

/** What the sheet holds itself: typed words, the chosen plan, the countdown and short notes. Never a code or a token.
 * `current` is the tier of the plan this account already has, from its verified entitlement. */
export interface CloudAddUi {
  chosen: string | null; current: string | null; offerShown: CloudOffer | null; now: number; busy: boolean; openFailed: boolean;
  email: string; code: string; profileEmail: string | null;
  look: { typed: string; name: string; color: CloudColor };
  counting: number | null; copied: boolean; payFailed: boolean; interest: "sent" | "failed" | null;
}

export function CloudAddPanel({ view, ui, actions }: { view: CloudAddView; ui: CloudAddUi; actions: CloudAddActions }) {
  switch (view.kind) {
    case "checking": return <StatusScreen kind="checking" line={null} onClose={actions.close} />;
    case "unreachable": return <StatusScreen kind="unreachable" line={t("cloudAdd.unreachable")} onRetry={actions.retry} onClose={actions.close} />;
    case "error": return <StatusScreen kind={`error-${view.reason}`} line={t(view.reason === "rate-limited" ? "cloudAdd.rateLimited" : "cloudAdd.failed")}
      onRetry={actions.retry} onClose={actions.close} />;
    case "offer": return <ChooseScreen offer={view.offer} current={ui.current} now={ui.now} busy={ui.busy} signedOut={view.signedOut}
      notice={view.notice ? t(view.notice === "code-expired" ? "cloudAdd.codeExpired" : view.notice === "signin-ended" ? "cloudAdd.signInEnded"
        : view.notice === "terms" ? "cloudBuy.termsChanged" : "cloudAdd.preparing") : null}
      onStart={actions.start} onSignIn={actions.signIn} />;
    case "sign-in": return <SignInScreen phase={view.phase} email={ui.email} code={ui.code} profileEmail={ui.profileEmail} busy={ui.busy} now={ui.now}
      onBack={actions.back} onEmail={actions.email} onSend={actions.sendCode} onChangeEmail={actions.changeEmail} onCode={actions.code}
      onResend={actions.resend} onBrowser={actions.browser} />;
    case "signing-in": return <BrowserSignInScreen code={view.code} checkout={view.checkout} busy={ui.busy}
      trial={ui.offerShown ? Boolean(offerPlan(ui.offerShown, ui.chosen).trialDays) : false} onReopen={actions.reopenBrowser} onCancel={actions.cancelSignIn} />;
    case "waiting": return <PayScreen plan={view.plan} offer={ui.offerShown} browser={view.browser} late={view.late} link={view.link} email={view.email}
      busy={ui.busy} copied={ui.copied} failed={ui.payFailed} onReopen={actions.reopenCheckout} onCopy={actions.copyLink} onChangePlan={actions.changePlan} />;
    case "starting": case "ready": return <SetupScreen started={view} received={view.kind === "starting" && view.received} step={view.kind === "starting" ? view.step : null}
      slow={view.kind === "starting" && view.slow} ready={view.kind === "ready"} sleeps={startedSleeps(view, ui.offerShown)} name={ui.look.name} typed={ui.look.typed} color={ui.look.color}
      counting={ui.counting} busy={ui.busy} openFailed={ui.openFailed} onName={actions.name} onColor={actions.color} onOpen={actions.openCloud} onNotNow={actions.notNow} />;
    case "has-cloud": return <OneCloudScreen name={ui.look.name} color={ui.look.color} busy={ui.busy} interest={ui.interest} openFailed={ui.openFailed}
      onInterest={actions.interest} onOpen={actions.openCloud} />;
    case "team-starting": return <TeamSetupScreen team={view.team} step={view.step} slow={view.slow} />;
    case "team-ready": return <TeamReadyScreen name={view.team.name} busy={ui.busy} openFailed={ui.openFailed} onOpen={() => actions.openTeam(view.team.id)} />;
    case "settings": return null;
  }
}

const WIDTH: Partial<Record<CloudAddView["kind"], string>> = { offer: "max-w-[900px]", starting: "max-w-[720px]", ready: "max-w-[720px]" };
/** Mid sign-in, checkout or setup a stray click beside the sheet (say, back from paying in the browser) must not lose it: there only Close and Esc do. */
const HELD: ReadonlySet<CloudAddView["kind"]> = new Set(["sign-in", "signing-in", "waiting", "starting", "team-starting"]);

/** The sheet over the app: one width per screen, the close button, and the staging mark when the app is on staging.
 * Above the z-50 layers (Settings, the welcome flow), which it may be opened over. */
export function CloudAddSheet({ kind, staging, onClose, children }: { kind: CloudAddView["kind"]; staging: boolean; onClose: () => void; children: ReactNode }) {
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 sm:p-6" onMouseDown={event => event.target === event.currentTarget && !HELD.has(kind) && onClose()}>
    <div role="dialog" aria-modal="true" aria-labelledby="cloud-add-title" data-cloud-add-dialog tabIndex={-1}
      className={cn("animate-pop-in relative max-h-full w-full overflow-y-auto overscroll-contain rounded-[18px] border border-hairline/70 bg-panel shadow-2xl outline-none", WIDTH[kind] ?? "max-w-[540px]")}>
      <button type="button" onClick={onClose} aria-label={t("cloudAdd.close")} className="ui-icon-button absolute end-3.5 top-3.5 z-10"><X size={18} /></button>
      {staging && <StagingMark className="absolute end-14 top-[19px] z-10" />}
      {children}
    </div>
  </div>;
}
const OFFER_VIEWS: ReadonlyArray<CloudAddView["kind"]> = ["offer", "checking", "unreachable", "waiting", "sign-in", "signing-in"];
const FOCUSABLE = "button:not([disabled]):not([tabindex='-1']), input:not([disabled]):not([tabindex='-1']), [href], [tabindex='0']";
const free = (state: CloudAccountState) => state.status === "connected" && state.entitlement?.plan === "free" && !state.purchase && !state.machine;
const currentTier = (state: CloudAccountState | null | undefined) =>
  state?.status === "connected" && state.entitlement?.plan === "pro" && state.entitlement.status === "active" ? state.entitlement.tier ?? "pro" : null;
type AutoOpen = number | "off" | "done" | null;
type Note = "copied" | "pay-failed" | "interest-sent" | "interest-failed" | null;

export function CloudAddDialog({ now = Date.now }: { now?: () => number }) {
  const { state, dispatch } = useStore();
  const request = state.cloudAdd;
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const [offer, setOffer] = useState<CloudOffer | null | undefined>(undefined);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<"failed" | "rate-limited" | null>(null);
  const [conflict, setConflict] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [asked, setAsked] = useState(0);
  const [reported, setReported] = useState<string[]>([]);
  const [signIn, setSignIn] = useState<CloudSignInPhase | null>(null);
  const [form, setForm] = useState({ email: "", code: "" });
  const [look, setLook] = useState<{ typed: string; color: CloudColor; dirty: boolean } | null>(null);
  const [auto, setAuto] = useState<AutoOpen>(null);
  const [note, setNote] = useState<Note>(null);
  const [, setTick] = useState(0);
  const [arrived, setArrived] = useState(false);
  const [terms, setTerms] = useState(false);
  const open = Boolean(request && bridge);
  const profileEmail = state.config?.profile?.email?.trim() || null;
  // Over the welcome flow the sheet is as good as closed for "ready": main notifies, and nothing switches the window away.
  const overWelcome = welcomeOnScreen();
  useEffect(() => {
    if (!open || !bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState(next => { updated = true; if (active) setAccount(next); });
    void bridge.state().then(next => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [open, bridge]);
  const view = open ? cloudAddView(account, offer, { now: now(), error, choosing, conflict, signIn, arrived, terms }) : null;
  const offerKey = open && view && OFFER_VIEWS.includes(view.kind) && account ? `${account.status}:${JSON.stringify(account.offer ?? null)}:${asked}` : null;
  useEffect(() => {
    if (!offerKey || !bridge?.offer) return;
    let active = true;
    void bridge.offer().then(next => { if (active) setOffer(next); }, () => { if (active) setOffer(null); });
    return () => { active = false; };
  }, [offerKey, bridge]);
  const defaultName = t("cloudSetup.myCloud");
  const shownLook = { typed: look?.typed ?? defaultName, color: look?.color ?? DEFAULT_CLOUD_COLOR, name: cloudNameShown(look?.typed ?? defaultName, defaultName) };
  const close = () => {
    if (signIn) void bridge?.signInCancel?.().catch(() => {});
    dispatch({ type: "closeCloudAdd" });
    setError(null); setConflict(false); setChoosing(false); setOpenFailed(false); setReported([]); setChosen(null);
    setSignIn(null); setForm({ email: "", code: "" }); setLook(null); setAuto(null); setNote(null); setArrived(false); setTerms(false);
  };
  // Capture phase, key marked handled: Escape and Tab reach this before anything underneath (Settings). Focus goes back to the opener.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement as HTMLElement | null;
    const opener = active && active !== document.body && typeof active.focus === "function" ? active : null;
    if (request?.signIn) { setSignIn({ step: "email", intent: false, problem: null }); setForm({ email: profileEmail ?? "", code: "" }); }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab") return;
      const controls = [...(document.querySelector("[data-cloud-add-dialog]")?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (!controls.length) return;
      event.preventDefault();
      const at = controls.indexOf(document.activeElement as HTMLElement);
      controls[at === -1 ? 0 : (at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]!.focus();
    };
    window.addEventListener("keydown", onKey, true);
    (document.querySelector("#cloud-add-title") as HTMLElement | null ?? document.querySelector("[data-cloud-add-dialog]") as HTMLElement | null)?.focus();
    return () => { window.removeEventListener("keydown", onKey, true); if (opener?.isConnected) opener.focus(); };
  }, [open]);
  useEffect(() => {
    if (!open || !bridge?.sheet || overWelcome) return;
    void bridge.sheet(true).catch(() => {});
    return () => { void bridge.sheet?.(false).catch(() => {}); };
  }, [open, bridge, overWelcome]);
  const kind = view?.kind ?? null;
  const focusKey = view?.kind === "sign-in" ? `sign-in-${view.phase.step}` : kind;
  useEffect(() => {
    if (!focusKey || focusKey === "checking" || focusKey === "settings") return;
    if ((document.activeElement as HTMLElement | null)?.closest?.("[data-cloud-add-dialog]")) return;
    (document.querySelector("[data-cloud-add-dialog] [data-autofocus]") as HTMLElement | null ?? document.querySelector("#cloud-add-title") as HTMLElement | null)?.focus();
  }, [focusKey]);
  // Pay or Setting up seen in this sheet: when the Cloud is ready, it is theirs to open here (not "one Cloud for now").
  // Ready shown here ends the purchase for main, so a later Add a Cloud… is one Cloud for now.
  useEffect(() => {
    if ((kind === "waiting" || kind === "starting" || kind === "ready") && !arrived) setArrived(true);
    if (kind === "ready" || kind === "team-ready") void bridge?.readySeen?.().catch(() => {});
  }, [kind]);
  useEffect(() => {
    if (!kind || !request) return;
    if (kind === "settings") { close(); dispatch({ type: "toggleAppSettings", open: true, section: "cloudAccount" }); return; }
    if (kind === "checking") return;
    const first = reported.length === 0;
    if (first) track("cloud_dialog_shown", { source: request.source, view: kind });
    if (["starting", "ready"].includes(kind) && !reported.includes(kind)) track("cloud_dialog_view", { view: kind });
    if (first || !reported.includes(kind)) setReported([...reported, kind]);
  }, [kind]);
  // The setup screen saves what its preview shows, even untouched, so the switcher matches it; One Cloud for now changes nothing.
  useEffect(() => {
    if (!kind || !["starting", "ready", "has-cloud"].includes(kind) || look || !bridge?.look) return;
    let active = true;
    void bridge.look().then(next => { if (active) setLook({ typed: next.name, color: cloudColor(next.color) ?? DEFAULT_CLOUD_COLOR, dirty: kind !== "has-cloud" }); }, () => {});
    return () => { active = false; };
  }, [kind]);
  useEffect(() => {
    if (!look?.dirty || !bridge?.setLook) return;
    const timer = setTimeout(() => { void bridge.setLook?.(shownLook.name, look.color).catch(() => {}); }, 400);
    return () => clearTimeout(timer);
  }, [look?.typed, look?.color]);
  // Ready while this sheet is open in the focused window: "Opening in 3…", then the Cloud opens; Not now stops it.
  useEffect(() => {
    if (kind !== "ready" || auto !== null) return;
    setAuto(!overWelcome && typeof document.hasFocus === "function" && document.hasFocus() ? 3 : "off");
  }, [kind]);
  const resendAt = signIn?.step === "code" ? signIn.resendAt : 0;
  useEffect(() => {
    if (!resendAt || resendAt <= now()) return;
    const timer = setTimeout(() => setTick(now()), 1000);
    return () => clearTimeout(timer);
  });
  useEffect(() => {
    if (note !== "copied") return;
    const timer = setTimeout(() => setNote(null), 2500);
    return () => clearTimeout(timer);
  }, [note]);
  const run = (step: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setOpenFailed(false);
    void step().catch(() => setError("failed")).finally(() => setBusy(false));
  };
  const openCloud = () => {
    if (busy || !bridge) return;
    setBusy(true); setOpenFailed(false); setAuto("done");
    void (async () => {
      if (look?.dirty && bridge.setLook) await bridge.setLook(shownLook.name, look.color).catch(() => {});
      await bridge.connectHome();
    })().then(() => close(), () => setOpenFailed(true)).finally(() => setBusy(false));
  };
  const openTeam = (teamId: string) => {
    if (busy || !bridge?.openTeam) return;
    setBusy(true); setOpenFailed(false);
    void bridge.openTeam(teamId).then(() => close(), () => setOpenFailed(true)).finally(() => setBusy(false));
  };
  useEffect(() => {
    if (typeof auto !== "number") return;
    const timer = setTimeout(() => { if (auto > 1) setAuto(auto - 1); else openCloud(); }, 1000);
    return () => clearTimeout(timer);
  }, [auto]);
  // Focus left the window while counting: the person is elsewhere, so nothing switches; Open {name} waits for them.
  const counting = typeof auto === "number";
  useEffect(() => {
    if (!counting) return;
    const stop = () => setAuto("off");
    window.addEventListener("blur", stop);
    return () => window.removeEventListener("blur", stop);
  }, [counting]);
  if (!open || !view || !request || !bridge || view.kind === "settings") return null;

  const offerShown = offer ?? null;
  const planNow = () => view.kind === "waiting" && !chosen ? view.plan : offerShown ? offerPlan(offerShown, chosen).tier : null;
  const openCheckout = async (plan: string | null) => {
    if (!plan || !bridge.checkout) { setError("failed"); return; }
    const trial = Boolean(offerShown?.plans.find(entry => entry.tier === plan)?.trialDays);
    const result = await bridge.checkout(plan, request.source);
    const outcome: CloudCheckoutOutcome = result.outcome;
    setAccount(result.state);
    if (outcome === "opened" || outcome === "signing-in") {
      setChoosing(false); setError(null); setConflict(false); setNote(null); setTerms(false); track("cloud_checkout_opened", { plan, trial, source: request.source });
    }
    else if (outcome === "rate-limited") setError("rate-limited");
    else if (outcome === "failed") setError("failed");
    else setConflict(true);
  };
  const enterSignIn = (intent: boolean) => {
    setSignIn({ step: "email", intent, problem: null });
    setForm({ email: form.email || profileEmail || "", code: "" });
  };
  const sendCode = () => {
    if (busy || !bridge.signInStart || !signIn || signIn.step === "done") return;
    const phase = signIn;
    setBusy(true);
    void bridge.signInStart(form.email).then(result => {
      if (result.outcome === "sent") {
        setSignIn({ step: "code", intent: phase.intent, email: result.email, resendAt: result.resendAt, problem: null, triesLeft: null,
          ...(result.signupOpen === false ? { signupOpen: false } : {}) });
        setForm({ email: result.email, code: "" });
        track("cloud_signin", { step: "code_sent", source: request.source });
      } else setSignIn({ ...phase, problem: result.outcome });
    }, () => setSignIn({ ...phase, problem: "failed" })).finally(() => setBusy(false));
  };
  const verify = (code: string) => {
    if (!bridge.signInVerify || signIn?.step !== "code") return;
    const phase = signIn, plan = phase.intent ? planNow() : null;
    setBusy(true);
    void (async () => {
      try {
        const result = await bridge.signInVerify!(code);
        if (result.outcome !== "signed-in") {
          setForm({ email: form.email, code: "" });
          setSignIn({ ...phase, problem: result.outcome, triesLeft: result.outcome === "wrong-code" ? result.triesLeft : null });
          return;
        }
        setAccount(result.state); setArrived(true);
        track("cloud_signin", { step: "signed_in", source: request.source });
        if (plan && free(result.state)) {
          // The account's own offer may differ from the one shown signed out (a trial already used, another price).
          if (sameTerms(offerShown, result.state.offer, plan)) { setSignIn({ step: "done", intent: true }); await openCheckout(plan); }
          else { setTerms(true); setChosen(plan); }
        }
        setSignIn(null); setForm({ email: form.email, code: "" });
      } catch { setSignIn({ ...phase, problem: "failed", triesLeft: null }); }
      finally { setBusy(false); }
    })();
  };
  const actions: CloudAddActions = {
    start: tier => {
      setChosen(tier); setConflict(false);
      if (view.kind === "offer" && view.signedOut && bridge.signInStart) { enterSignIn(true); return; }
      run(() => openCheckout(tier));
    },
    signIn: () => enterSignIn(false),
    back: () => { setSignIn(null); void bridge.signInCancel?.().catch(() => {}); },
    email: value => setForm({ email: value, code: form.code }),
    sendCode,
    changeEmail: () => { if (signIn) { setSignIn({ step: "email", intent: signIn.intent, problem: null }); void bridge.signInCancel?.().catch(() => {}); } },
    code: value => {
      const digits = codeDigits(value);
      setForm({ email: form.email, code: digits });
      if (digits.length === 8 && !busy) verify(digits);
    },
    resend: sendCode,
    browser: () => run(async () => {
      const plan = signIn?.intent ? planNow() : null;
      setSignIn(null);
      await bridge.signInCancel?.().catch(() => {});
      track("cloud_signin", { step: "browser", source: request.source });
      if (plan) await openCheckout(plan);
      else setAccount(await bridge.begin());
    }),
    reopenBrowser: () => run(async () => setAccount(await bridge.reopen())),
    cancelSignIn: () => run(async () => setAccount(await bridge.cancel())),
    reopenCheckout: () => {
      if (view.kind !== "waiting" || busy) return;
      setBusy(true); setNote(null);
      const again = bridge.reopenCheckout ? bridge.reopenCheckout(view.plan, request.source) : bridge.checkout!(view.plan, request.source);
      void again.then(result => { setAccount(result.state); if (result.outcome !== "opened") setNote("pay-failed"); }, () => setNote("pay-failed")).finally(() => setBusy(false));
    },
    copyLink: () => { void bridge.copyCheckoutLink?.().then(copied => setNote(copied ? "copied" : "pay-failed"), () => setNote("pay-failed")); },
    changePlan: () => { setChosen(view.kind === "waiting" ? view.plan : chosen); setChoosing(true); setNote(null); },
    retry: () => { setError(null); setConflict(false); setOffer(undefined); setAsked(asked + 1); },
    name: value => setLook({ typed: value, color: shownLook.color, dirty: true }),
    color: value => setLook({ typed: shownLook.typed, color: value, dirty: true }),
    openCloud,
    openTeam,
    notNow: () => setAuto("off"),
    interest: () => {
      if (busy || !bridge.interest) return;
      setBusy(true);
      void bridge.interest().then(() => setNote("interest-sent"), () => setNote("interest-failed")).finally(() => setBusy(false));
    },
    close,
  };
  const ui: CloudAddUi = { chosen, current: currentTier(account), offerShown, now: now(), busy, openFailed, email: form.email, code: form.code, profileEmail, look: shownLook,
    counting: typeof auto === "number" ? auto : null, copied: note === "copied", payFailed: note === "pay-failed",
    interest: note === "interest-sent" ? "sent" : note === "interest-failed" ? "failed" : null };
  return <CloudAddSheet kind={view.kind} staging={account?.staging === true} onClose={close}><CloudAddPanel view={view} ui={ui} actions={actions} /></CloudAddSheet>;
}
