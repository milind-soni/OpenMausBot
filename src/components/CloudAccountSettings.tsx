import { useEffect, useRef, useState } from "react";
import type { CloudAccountBridge, CloudAccountState, CloudPlanBridge, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudCredit, CloudMachine, CloudTrial } from "../../electron/cloud-home.mjs";
import { CloudMoveSettings } from "./CloudMove";
import { activeLocale, t } from "@/lib/i18n";
import { buyOfferAllowed, cloudCreditLine, cloudPlanLabel, cloudPlanLine, cloudPlanView, cloudTrialView, moneyBackLine, offerTrialDays, trialRunning, type CloudPlanView } from "@/lib/cloud-plan";
import { useCloudOffer } from "@/lib/use-cloud-offer";
import type { LocaleKey } from "@/locales";
import { Card } from "./SettingsPrimitives";
import { CloudLending } from "./CloudLending";
import { useDesktopCapabilities } from "./DesktopCapabilities";

export { cloudPlanLabel };

const MACHINE_TEXT = {
  provisioning: "cloudHome.provisioning",
  ready: "cloudHome.ready",
  stopped: "cloudHome.stopped",
  "payment-problem": "cloudHome.paymentProblem",
  failed: "cloudHome.failed",
} as const;
const SETUP_STEPS = [
  ["reserving", "cloudHome.step.reserving"], ["storage", "cloudHome.step.storage"],
  ["starting", "cloudHome.step.starting"], ["checking", "cloudHome.step.checking"],
] as const satisfies ReadonlyArray<readonly [string, LocaleKey]>;

const time = (value: number) => new Intl.DateTimeFormat(activeLocale(), { timeStyle: "short" }).format(new Date(value));
const day = (value: number) => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium" }).format(new Date(value));

/** Setting up: the same four steps the Cloud page shows, when the Admin says
 * which one it is at. */
function setupSteps(machine: CloudMachine) {
  if (!machine.setup) return null;
  const at = SETUP_STEPS.findIndex(([step]) => step === machine.setup!.step);
  return <ol data-cloud-setup={machine.setup.step} className="flex flex-col gap-1 text-[13px]">
    {SETUP_STEPS.map(([step, key], index) => <li key={step} aria-current={index === at ? "step" : undefined}
      className={index === at ? "font-medium text-ink" : index < at ? "text-ink-secondary line-through decoration-ink-secondary/40" : "text-ink-secondary"}>{t(key)}</li>)}
  </ol>;
}

/** A free trial and its Claude credit, in the same words as the trial's popup and
 * the Cloud page (lib/cloud-plan). A render helper (no hooks). */
function trialLines(trial: CloudTrial | undefined, credit: CloudCredit | undefined) {
  if (!trial && !credit) return null;
  const view = trial ? cloudTrialView(trial) : null;
  return <div data-cloud-trial={trial?.state ?? "none"} className="flex flex-col gap-1">
    {view && <p className="text-[13px] font-medium text-ink">{view.title}</p>}
    {view && <p className="text-[13px] leading-relaxed text-ink-secondary">{view.body}</p>}
    {credit && <p data-cloud-credit={credit.state} className="text-[13px] leading-relaxed text-ink-secondary">{cloudCreditLine(credit)}</p>}
  </div>;
}

/** The person's Cloud machine: where it stands, and one way in. Status and
 * address come only from the verified native snapshot; the pairing code
 * never reaches this page. A render helper (no hooks), part of the card.
 * `trial`: a free trial says what happens to a stopped Cloud above, so here
 * it is only stopped. */
function cloudHomeCard({ machine, busy, failed, onConnect, lending, trial = false }: { machine: CloudMachine; busy: boolean; failed: boolean; onConnect: () => void; lending?: CloudAccountBridge["lending"]; trial?: boolean }) {
  const connectable = machine.status === "ready";
  const text = trial && (machine.status === "stopped" || machine.status === "payment-problem") ? t("cloudHome.stoppedTrial")
    : machine.status === "failed" && machine.retryAt ? t("cloudHome.failedRetry", { time: time(machine.retryAt) })
    : machine.status === "provisioning" && machine.setup?.slow ? t("cloudHome.slow") : t(MACHINE_TEXT[machine.status]);
  return <Card title={t("cloudHome.title")}>
    <div data-cloud-home={machine.status} className="flex flex-col items-start gap-3">
      <p role="status" className={machine.status === "ready" ? "text-[14px] text-ink" : "text-[13px] text-ink-secondary"}>{text}</p>
      {machine.status === "provisioning" && setupSteps(machine)}
      {connectable && <>
        <button type="button" disabled={busy} className="ui-button" onClick={onConnect}>{t("cloudHome.connect")}</button>
        <p className="text-[12px] text-ink-secondary">{t("cloudHome.connectHelp")}</p>
      </>}
      {failed && <p role="alert" className="text-[13px] text-danger">{t("cloudHome.connectFailed")}</p>}
      {/* Part of connecting: lend this Mac to the Cloud, or not. A switch, never a dialog. */}
      {lending && <CloudLending bridge={lending} />}
    </div>
  </Card>;
}

/** A paid plan's Cloud on the phone: the phone app paired with the Cloud
 * rather than this computer keeps working when this computer is off. One
 * click opens the Cloud in this window on its phone pairing; when the Cloud
 * cannot be opened (not Ready yet, or opening failed), the two steps
 * instead. A render helper (no hooks), part of the view. */
function cloudPhoneCard({ ready, busy, failed, onUse }: { ready: boolean; busy: boolean; failed: boolean; onUse: () => void }) {
  return <Card title={t("cloudPhone.title")} subtitle={t("cloudPhone.subtitle")}>
    <div data-cloud-phone={ready ? "open" : "steps"} className="flex flex-col items-start gap-3">
      {ready && <>
        <button type="button" disabled={busy} className="ui-button" onClick={onUse}>{t("cloudPhone.action")}</button>
        <p className="text-[12px] text-ink-secondary">{t("cloudPhone.help")}</p>
      </>}
      {failed && <p role="alert" className="text-[13px] text-danger">{t("cloudPhone.failed")}</p>}
      {(!ready || failed) && <>
        <p className="text-[13px] text-ink-secondary">{t(ready ? "cloudPhone.stepsIntro" : "cloudPhone.notReady")}</p>
        <ol className="list-decimal ps-5 text-[13px] leading-relaxed text-ink-secondary">
          <li>{t("cloudPhone.step1")}</li>
          <li>{t("cloudPhone.step2")}</li>
        </ol>
      </>}
    </div>
  </Card>;
}

/** What this view does by itself when the Cloud page's "Open in the app"
 * (openmausbot://cloud) opened it. `arrived`: the first snapshot since that
 * link. Only then does signed out mean "sign me in"; a later sign-out is the
 * person's own choice. A Ready Cloud is connected to once per link. A saved
 * sign-in still being read is not "signed out". */
export function cloudLinkAction(account: CloudAccountState, link: { arrived: boolean; connected: boolean }): "sign-in" | "connect" | null {
  if (link.arrived && account.status === "signed-out" && account.message !== "restoring") return "sign-in";
  if (!link.connected && account.status === "connected" && account.machine?.status === "ready") return "connect";
  return null;
}

/** A saved sign-in that may only be locked is kept and read again by itself.
 * Where a keychain can be locked, unlocking it is the one step; Windows has
 * nothing to unlock. Never Sign out: that would delete the sign-in the app is
 * about to read, with nothing revoked on the Cloud. */
const RESTORE_RETRY: Partial<Record<DesktopCapabilities["host"]["platform"], LocaleKey>> = {
  darwin: "cloudAccount.restoreRetryKeychain",
  linux: "cloudAccount.restoreRetryKeyring",
};

/** The one message for a state, or none. */
function accountMessage(account: CloudAccountState | null, view: CloudPlanView, platform: DesktopCapabilities["host"]["platform"]): string | null {
  if (!account) return null;
  if (account.message === "signout-local-only") return t("cloudAccount.signoutLocalOnly");
  // Clearing it failed: Sign out again is the retry.
  if (account.message === "signout-storage-failed") return t("cloudAccount.storageFailed");
  if (account.message === "restore-failed") return t(RESTORE_RETRY[platform] ?? "cloudAccount.restoreRetry");
  if (view.kind === "reauth") return t(view.reason === "expired" ? "cloudAccount.reauthExpired" : "cloudAccount.reauthEnded");
  if (view.kind === "unverified") return t("cloudAccount.unavailable");
  if (view.kind === "purchase") return view.paidAt ? t("cloudAccount.purchaseNote", { date: day(view.paidAt) }) : t("cloudAccount.purchaseNoteNoDate");
  // A Cloud still there explains itself in its own card below; a free trial, in its own lines.
  if (view.kind === "attention" && !account.machine && !account.trial) return t("cloudAccount.attention");
  if (account.status === "signed-out" && account.message === "enrollment-expired") return t("cloudAccount.codeExpired");
  if (account.status === "signed-out" && account.message === "restore-removed") return t("cloudAccount.restoreRemoved");
  if (account.status === "signed-out" && account.message && account.message !== "restoring") return t("cloudAccount.signinFailed");
  return null;
}

/** The browser button: what fits the state, never "choose a plan" to someone
 * who has one. A free trial's next step, when it has one, names it. Someone
 * with no plan gets the Add a Cloud dialog instead (addCloudButton). */
function dashboardLabel(account: CloudAccountState, view: CloudPlanView): string {
  const trial = account.trial ? cloudTrialView(account.trial).action : null;
  if (trial) return trial.label;
  if (view.kind === "paid" || (view.kind === "unverified" && view.label)) return t("cloudAccount.manage");
  if (account.machine?.status === "payment-problem") return t("cloudAccount.updatePayment");
  return t("cloudAccount.dashboard");
}

/** On the person's own Cloud, open in this app's window: the plan, read only,
 * Manage in the browser, and back to this computer. When this app cannot
 * vouch for this Cloud (its state is refused), it says where the plan is
 * managed and offers nothing that would fail. `onConnectPhone`: Use your
 * Cloud on your phone, already here, opens this Cloud's phone pairing. */
export function CloudPlanOnCloud({ bridge, onConnectPhone }: { bridge: CloudPlanBridge; onConnectPhone?: () => void }) {
  const [plan, setPlan] = useState<CloudPlanSnapshot | null>(null), [failed, setFailed] = useState(false), [refused, setRefused] = useState(false);
  useEffect(() => {
    let active = true;
    void bridge.state().then(next => { if (active) setPlan(next); }).catch(() => { if (active) setRefused(true); });
    return () => { active = false; };
  }, [bridge]);
  if (refused) {
    return <Card title={t("settings.section.cloudAccount")}>
      <p data-cloud-plan="elsewhere" className="text-[13px] text-ink-secondary">{t("cloudAccount.onCloudNone")}</p>
    </Card>;
  }
  const label = cloudPlanLabel(plan?.tier);
  const line = plan?.status === "paid" ? t(trialRunning(plan.trial) ? "cloudAccount.trialPlan" : "cloudAccount.pro", { plan: label }) : plan?.status === "attention" ? t("cloudAccount.inactive", { plan: plan.tier ? label : "MausBot Cloud" })
    : plan?.status === "checking" ? t("cloudAccount.lastPlan", { plan: label }) : plan?.status === "signin" ? (plan.tier ? t("cloudAccount.planName", { plan: label }) : null)
      : plan ? t("cloudAccount.onCloudNone") : null;
  const act = (action: () => Promise<void>) => { setFailed(false); void action().catch(() => setFailed(true)); };
  return <Card title={t("settings.section.cloudAccount")} subtitle={t("cloudAccount.onCloud")}>
    <div data-cloud-plan={plan?.status ?? "loading"} className="flex flex-col items-start gap-3">
      {line ? <p role="status" className="text-[15px] font-medium text-ink">{line}</p> : !plan && <p role="status" className="text-[13px] text-ink-secondary">{t("cloudAccount.loading")}</p>}
      {plan?.status === "signin" && <p className="text-[13px] text-ink-secondary">{t("cloudAccount.onCloudSignIn")}</p>}
      {trialLines(plan?.trial, plan?.credit)}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ui-button" onClick={() => act(() => bridge.manage())}>{(plan?.trial && cloudTrialView(plan.trial).action?.label) || t("cloudAccount.manageInBrowser")}</button>
        <button type="button" className="ui-button" onClick={() => act(() => bridge.useThisComputer())}>{t("cloudAccount.useThisComputer")}</button>
        {plan && onConnectPhone && <button type="button" className="ui-button" onClick={onConnectPhone}>{t("cloudPhone.action")}</button>}
      </div>
      {failed && <p role="alert" className="text-[13px] text-danger">{t("cloudAccount.actionFailed")}</p>}
    </div>
  </Card>;
}

/** The public native snapshot carries no credential and cannot activate a plan.
 * `linkRequest` is non-zero only while openmausbot://cloud has this open.
 * `onConnectPhone` opens Settings on this window's phone pairing (on the
 * Cloud itself). `onAddCloud` opens the Add a Cloud dialog: someone signed
 * out or with no plan starts there. */
export function CloudAccountSettings({ linkRequest = 0, cloudHome = false, onConnectPhone, onAddCloud }: { linkRequest?: number; cloudHome?: boolean; onConnectPhone?: () => void; onAddCloud?: () => void } = {}) {
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
  const { platform } = useDesktopCapabilities().capabilities.host;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [confirm, setConfirm] = useState(false);
  const [homeFailed, setHomeFailed] = useState(false), [phoneFailed, setPhoneFailed] = useState(false);
  const generation = useRef(0), revision = useRef(0), pending = useRef(false);
  const link = useRef({ request: 0, arrived: false, connected: false });
  useEffect(() => {
    const current = ++generation.current, initial = revision.current;
    const accept = (next: CloudAccountState) => {
      if (generation.current !== current) return;
      revision.current++; setAccount(next); setError(false);
      if (next.status === "signed-out") setConfirm(false);
    };
    const unsubscribe = bridge?.onState(accept);
    void bridge?.state().then(next => { if (revision.current === initial) accept(next); }).catch(() => {
      if (generation.current === current && revision.current === initial) setError(true);
    });
    return () => { generation.current++; unsubscribe?.(); };
  }, [bridge]);
  const perform = async (action: () => Promise<CloudAccountState>) => {
    if (!bridge || pending.current) return;
    pending.current = true; setBusy(true); setError(false);
    const current = generation.current, started = revision.current;
    try { const next = await action(); if (generation.current === current && revision.current === started) setAccount(next); }
    catch { if (generation.current === current && revision.current === started) setError(true); }
    finally { pending.current = false; if (generation.current === current) setBusy(false); }
  };
  const connectHome = () => {
    if (!bridge) return;
    setHomeFailed(false);
    void perform(async () => {
      try { return await bridge.connectHome(); } catch { setHomeFailed(true); return bridge.state(); }
    });
  };
  // The same switch, landing on the Cloud's phone pairing; what failed says the steps.
  const openOnPhone = () => {
    if (!bridge) return;
    setPhoneFailed(false);
    void perform(async () => {
      try { return await bridge.connectHomeForPhone(); } catch { setPhoneFailed(true); return bridge.state(); }
    });
  };
  // A normal visit (linkRequest 0) never signs in or connects by itself.
  useEffect(() => {
    if (!linkRequest) link.current.request = 0;
    if (!bridge || !linkRequest || !account || pending.current) return;
    if (link.current.request !== linkRequest) link.current = { request: linkRequest, arrived: true, connected: false };
    // A saved sign-in still being read decides nothing yet.
    if (account.status === "signed-out" && account.message === "restoring") return;
    const action = cloudLinkAction(account, link.current);
    link.current.arrived = false;
    if (action === "sign-in") void perform(() => bridge.begin());
    if (action === "connect") { link.current.connected = true; connectHome(); }
  }, [bridge, linkRequest, account, busy]);
  // Signed out or with no plan: what OpenMausBot Cloud offers, for the button's words and money-back.
  const offer = useCloudOffer(Boolean(account) && buyOfferAllowed(cloudPlanView(account)), account?.offer);
  if (!bridge) {
    // Only on an OMB Cloud home: any other server open in this window (a VPS,
    // a hosted workspace, someone else's) has no plan of this person's to show.
    const plan = window.ogb?.remoteClient?.active || !cloudHome ? undefined : window.ogb?.cloudPlan;
    return plan ? <CloudPlanOnCloud bridge={plan} onConnectPhone={onConnectPhone} /> : <p className="text-[13px] text-ink-secondary">{t("cloudAccount.desktopOnly")}</p>;
  }
  const view = cloudPlanView(account);
  const signed = account && ["connected", "unavailable", "reauth-required"].includes(account.status);
  // Status comes only from the server-verified native snapshot; checkout never sets it.
  const message = accountMessage(account, view, platform);
  const line = cloudPlanLine(view);
  // A paid plan's Cloud before the Admin lists it is being set up.
  const machine: CloudMachine | undefined = account?.status === "connected" ? account.machine ?? (view.kind === "paid" ? { status: "provisioning" } : undefined) : undefined;
  const enrollment = account?.status === "connecting" ? account.enrollment : undefined;
  // Someone who may buy: Start free trial (or Add a Cloud) opens the dialog, with money-back beside it.
  const moneyBack = moneyBackLine(offer);
  const addCloudButton = onAddCloud && buyOfferAllowed(view) && <div className="flex flex-col items-start gap-1">
    <button type="button" disabled={busy} className="ui-button" onClick={onAddCloud}>{t(offerTrialDays(offer) !== null ? "cloudIntro.start" : "cloudAccount.upgrade")}</button>
    {moneyBack && <p className="text-[12px] text-ink-secondary">{moneyBack}</p>}
  </div>;
  return <>
    <p className="text-[13px] leading-relaxed text-ink-secondary">{t("cloudAccount.optional")}</p>
    <Card title={t("settings.section.cloudAccount")} subtitle={t("cloudAccount.separate")}>
      {(!account || view.kind === "unknown") && <p role="status" className="text-[13px] text-ink-secondary">{t("cloudAccount.loading")}</p>}
      {message && <p role="status" className="mb-3 text-[13px] text-ink-secondary">{message}</p>}
      {(view.kind === "signed-out" || view.kind === "removed") && <div className="flex flex-col items-start gap-3">
        {addCloudButton}
        <button type="button" disabled={busy} className={addCloudButton ? "text-[13px] font-medium text-accent-text underline underline-offset-2 hover:text-ink" : "ui-button"}
          onClick={() => void perform(() => bridge.begin())}>{t("cloudAccount.signIn")}</button>
      </div>}
      {account?.status === "connecting" && <div className="flex flex-col items-start gap-3">
        <p role="status" className="text-[13px] text-ink-secondary">{t("cloudAccount.browser")}</p>
        {/* The browser asks to check this code: it is shown, not tucked away. */}
        {enrollment && <div data-cloud-code className="flex flex-col gap-1">
          <p className="text-[13px] text-ink-secondary">{t("cloudAccount.codeCheck")}</p>
          <code dir="ltr" className="select-all text-[18px] font-semibold tracking-widest text-ink">{enrollment.userCode}</code>
          <p className="text-[12px] text-ink-secondary">{t("cloudAccount.codeUntil", { time: time(enrollment.expiresAt) })}</p>
        </div>}
        <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} className="ui-button" onClick={() => void perform(() => bridge.reopen())}>{t("organization.reopen")}</button>
          <button type="button" disabled={busy} className="ui-button" onClick={() => void perform(() => bridge.cancel())}>{t("organization.cancel")}</button></div>
      </div>}
      {signed && <div className="flex flex-col gap-3">
        {account.account && <p className="break-all text-[14px] text-ink">{account.account.email}</p>}
        {line && <p role="status" data-cloud-plan={view.kind} className="text-[15px] font-medium text-ink">{line}
          {view.kind === "paid" && view.checking && <span className="ms-2 text-[12px] font-normal text-ink-secondary">{t("cloudAccount.checking")}</span>}</p>}
        {account.status === "connected" && trialLines(account.trial, account.credit)}
        {view.kind === "free" && addCloudButton}
        <div className="flex flex-wrap gap-2">
          {view.kind === "reauth"
            ? <button type="button" disabled={busy} className="ui-button" onClick={() => void perform(() => bridge.signInAgain())}>{t("cloudAccount.signInAgain")}</button>
            : <>
              {!(view.kind === "free" && addCloudButton) && <button type="button" disabled={busy} className="ui-button" onClick={() => void perform(() => bridge.openDashboard())}>{view.kind === "free" ? t("cloudAccount.dashboard") : dashboardLabel(account, view)}</button>}
              <button type="button" disabled={busy} className="ui-button" onClick={() => void perform(() => bridge.refresh())}>{t("organization.refresh")}</button>
            </>}
          {!confirm && <button type="button" disabled={busy} className="ui-button" onClick={() => setConfirm(true)}>{t("cloudAccount.signOut")}</button>}
        </div>
        {/* A plan bought with another email sits on that account. */}
        {view.kind === "free" && !confirm && <p className="text-[12px] text-ink-secondary">{t("cloudAccount.otherEmail")}{" "}
          <button type="button" disabled={busy} className="underline hover:text-ink" onClick={() => setConfirm(true)}>{t("cloudAccount.useOtherEmail")}</button></p>}
        {confirm && <div role="group" aria-label={t("cloudAccount.signoutTitle")} className="rounded-lg border border-hairline/40 p-3">
          <p className="text-[13px] text-ink-secondary">{t("cloudAccount.signoutHelp")}</p><div className="mt-3 flex flex-wrap gap-2">
            <button type="button" autoFocus disabled={busy} className="ui-button" onClick={() => setConfirm(false)}>{t("cloudAccount.keep")}</button>
            <button type="button" disabled={busy} className="ui-button text-danger" onClick={() => void perform(() => bridge.signOut())}>{t("cloudAccount.signOut")}</button>
          </div></div>}
      </div>}
      {error && <p role="alert" className="mt-3 text-[13px] text-danger">{t("cloudAccount.actionFailed")}</p>}
      {!account && <button type="button" disabled={busy} className="ui-button mt-3" onClick={() => void perform(() => bridge.state())}>{t("organization.refresh")}</button>}
    </Card>
    {machine && cloudHomeCard({ machine, busy, failed: homeFailed, onConnect: connectHome, lending: bridge.lending, trial: Boolean(account?.trial) })}
    {signed && view.kind === "paid" && cloudPhoneCard({ ready: machine?.status === "ready", busy, failed: phoneFailed, onUse: openOnPhone })}
    {machine?.status === "ready" && <CloudMoveSettings destination="cloud" />}
  </>;
}
