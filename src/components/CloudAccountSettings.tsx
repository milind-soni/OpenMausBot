import { useEffect, useRef, useState } from "react";
import type { CloudAccountState, CloudPlanBridge, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudCredit, CloudMachine, CloudTrial } from "../../electron/cloud-home.mjs";
import { planTeam, teamPlan } from "../../electron/cloud-team-plan.mjs";
import { cloudFilesBridge } from "@/lib/cloud-files";
import { moveLine } from "@/lib/cloud-send";
import { activeLocale, t } from "@/lib/i18n";
import { buyOfferAllowed, cloudCreditLine, cloudPlanLabel, cloudPlanLine, cloudPlanView, cloudTrialView, moneyBackLine, offerTrialDays, trialRunning, type CloudPlanView } from "@/lib/cloud-plan";
import { useCloudOffer } from "@/lib/use-cloud-offer";
import type { LocaleKey } from "@/locales";
import { AccountsSheet } from "./AccountMenu";
import { Card, SettingRow, SettingsGroup, SettingsLinkRow, SettingsRows } from "./SettingsPrimitives";
import { productName } from "@/lib/brand";
import { ProCompareRow } from "./ProIntroduction";
import { CloudCancelPlan, type CloudRenewalActions } from "./CloudCancelPlan";
import { StagingMark } from "./cloud-buy/parts";
import { CloudSetupSteps } from "./CloudSetupSteps";
import { useCloudSendNotice } from "./CloudSendStrip";
import { OpenFilesButton } from "./OpenFilesButton";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { PausedBotsButton } from "./AwakeBotsPicker";

export { cloudPlanLabel };

const MACHINE_TEXT = {
  provisioning: "cloudHome.provisioning",
  ready: "cloudHome.ready",
  stopped: "cloudHome.stopped",
  "payment-problem": "cloudHome.paymentProblem",
  failed: "cloudHome.failed",
} as const;

const time = (value: number) => new Intl.DateTimeFormat(activeLocale(), { timeStyle: "short" }).format(new Date(value));
const day = (value: number) => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium" }).format(new Date(value));

function trialLines(trial: CloudTrial | undefined, credit: CloudCredit | undefined) {
  if (!trial && !credit) return null;
  const view = trial ? cloudTrialView(trial) : null;
  return <div data-cloud-trial={trial?.state ?? "none"} className="flex flex-col gap-1">
    {view && <p className="text-[13px] font-medium text-ink">{view.title}</p>}
    {view && <p className="text-[13px] leading-relaxed text-ink-secondary">{view.body}</p>}
    {credit && <p data-cloud-credit={credit.state} className="text-[13px] leading-relaxed text-ink-secondary">{cloudCreditLine(credit)}</p>}
  </div>;
}

/**
 * Security: status and address come only from the verified native snapshot; the pairing code never reaches this page.
 * `moving`: the one-time move's own line while the bots go to My Cloud, which then opens by itself: nothing to open or
 * switch back to meanwhile. `team`: a Team or Business plan's Cloud, the team's, under the team's name; it has no Files or
 * move of its own here.
 */
function cloudHomeCard({ machine, busy, failed, onConnect, trial = false, waking = false, moving = null, team = null }: { machine: CloudMachine; busy: boolean; failed: boolean; onConnect: () => void; trial?: boolean; waking?: boolean; moving?: string | null; team?: { name: string | null } | null }) {
  const unreachable = machine.status === "ready" ? machine.unreachable : undefined;
  const connectable = machine.status === "ready" && !unreachable;
  const text = unreachable ? t(unreachable.cause === "host" ? "cloudHome.unreachableHost" : "cloudHome.unreachable")
    : moving ?? (waking && connectable ? t("cloudHome.waking")
    : team?.name && machine.status === "ready" ? t("cloudHome.team.ready", { name: team.name })
    : machine.status === "ready" && machine.power?.sleeps ? t("cloudHome.readySleeps")
    : trial && (machine.status === "stopped" || machine.status === "payment-problem") ? t("cloudHome.stoppedTrial")
    : machine.status === "failed" && machine.retryAt ? t("cloudHome.failedRetry", { time: time(machine.retryAt) })
    : machine.status === "provisioning" && machine.setup?.slow ? t("cloudHome.slow")
    : team && machine.status === "provisioning" ? t("cloudHome.team.provisioning") : t(MACHINE_TEXT[machine.status]));
  const label = team?.name ? t("cloudBuy.setup.open", { name: team.name }) : t("settings.plan.openCloud", { place: t("cloudSetup.myCloud") });
  return <div data-cloud-home={machine.status} data-cloud-team={team ? true : undefined} data-cloud-unreachable={unreachable?.cause} data-cloud-waking={waking && connectable ? true : undefined} data-cloud-moving={moving && !unreachable ? true : undefined}>
    <SettingRow title={team ? team.name ?? t("cloudHome.team.title") : t("cloudSetup.myCloud")} subtitle={<p role="status">{text}</p>}
      message={<>
        {machine.status === "provisioning" && machine.setup && <CloudSetupSteps step={machine.setup.step} />}
        {connectable && !team && cloudFilesBridge() && <OpenFilesButton label={t("cloudHome.filesLink")} className="text-[12px] leading-4 text-accent-text hover:underline" />}
        {failed && !unreachable && <p role="alert" className="text-danger">{t("cloudHome.connectFailed")}</p>}
      </>}>
      {connectable && !moving && <button type="button" disabled={busy} className="ui-button" onClick={onConnect}>{label}</button>}
    </SettingRow>
  </div>;
}

export function cloudLinkAction(account: CloudAccountState, link: { arrived: boolean; connected: boolean }): "sign-in" | "connect" | null {
  if (link.arrived && account.status === "signed-out" && account.message !== "restoring") return "sign-in";
  if (!link.connected && account.status === "connected" && account.machine?.status === "ready" && !account.machine.unreachable) return "connect";
  return null;
}

/**
 * Never Sign out here: it deletes the sign-in the app is about to read and revokes nothing on the Cloud. Windows has no
 * keychain to unlock.
 */
const RESTORE_RETRY: Partial<Record<DesktopCapabilities["host"]["platform"], LocaleKey>> = {
  darwin: "cloudAccount.restoreRetryKeychain",
  linux: "cloudAccount.restoreRetryKeyring",
};

function accountMessage(account: CloudAccountState | null, view: CloudPlanView, platform: DesktopCapabilities["host"]["platform"]): string | null {
  if (!account) return null;
  if (account.message === "signout-local-only") return t("cloudAccount.signoutLocalOnly");
  if (account.message === "signout-storage-failed") return t("cloudAccount.storageFailed");
  if (account.message === "restore-failed") return t(RESTORE_RETRY[platform] ?? "cloudAccount.restoreRetry");
  if (view.kind === "reauth") return t(view.reason === "expired" ? "cloudAccount.reauthExpired" : "cloudAccount.reauthEnded");
  if (view.kind === "unverified") return t("cloudAccount.unavailable");
  if (view.kind === "purchase") return view.paidAt ? t("cloudAccount.purchaseNote", { date: day(view.paidAt) }) : t("cloudAccount.purchaseNoteNoDate");
  if (view.kind === "attention" && !account.machine && !account.trial) return t("cloudAccount.attention");
  if (account.status === "signed-out" && account.message === "enrollment-expired") return t("cloudAccount.codeExpired");
  if (account.status === "signed-out" && account.message === "restore-removed") return t("cloudAccount.restoreRemoved");
  if (account.status === "signed-out" && account.message && account.message !== "restoring") return t("cloudAccount.signinFailed");
  return null;
}

function dashboardLabel(account: CloudAccountState, view: CloudPlanView): string {
  const trial = account.trial && !account.renewal?.cancelled ? cloudTrialView(account.trial).action : null;
  if (trial) return trial.label;
  if (view.kind === "paid" || (view.kind === "unverified" && view.label)) return t("cloudAccount.manage");
  if (account.machine?.status === "payment-problem") return t("cloudAccount.updatePayment");
  return t("cloudAccount.dashboard");
}

export function CloudPlanOnCloud({ bridge, onConnectPhone }: { bridge: CloudPlanBridge; onConnectPhone?: () => void }) {
  const [plan, setPlan] = useState<CloudPlanSnapshot | null>(null), [failed, setFailed] = useState(false), [refused, setRefused] = useState(false);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let active = true;
    void bridge.state().then(next => { if (active) setPlan(next); }).catch(() => { if (active) setRefused(true); });
    return () => { active = false; };
  }, [bridge, reads]);
  const renewal: CloudRenewalActions | null = bridge.cancel && bridge.keep ? { cancel: survey => bridge.cancel!(survey), keep: () => bridge.keep!() } : null;
  if (refused) {
    return <Card title={t("settings.section.cloudAccount")}>
      <p data-cloud-plan="elsewhere" className="text-[13px] text-ink-secondary">{t("cloudAccount.onCloudNone")}</p>
    </Card>;
  }
  const label = cloudPlanLabel(plan?.tier);
  const home = plan?.home === true;
  const line = plan?.status === "paid" ? t(trialRunning(plan.trial) ? "cloudAccount.trialPlan" : "cloudAccount.pro", { plan: label }) : plan?.status === "attention" ? t("cloudAccount.inactive", { plan: plan.tier ? label : "MausBot Cloud" })
    : plan?.status === "checking" ? t("cloudAccount.lastPlan", { plan: label }) : plan?.status === "signin" ? (plan.tier ? t("cloudAccount.planName", { plan: label }) : null)
      : plan ? t(home ? "cloudAccount.onCloudNoneHome" : "cloudAccount.onCloudNone") : null;
  const act = (action: () => Promise<void>) => { setFailed(false); void action().catch(() => setFailed(true)); };
  return <Card title={t("settings.section.cloudAccount")} subtitle={t(home ? "cloudAccount.onCloudHome" : "cloudAccount.onCloud")}>
    <div data-cloud-plan={plan?.status ?? "loading"} className="flex flex-col items-start gap-3">
      {line ? <p role="status" className="text-[15px] font-medium text-ink">{line}</p> : !plan && <p role="status" className="text-[13px] text-ink-secondary">{t("cloudAccount.loading")}</p>}
      {plan?.status === "signin" && <p className="text-[13px] text-ink-secondary">{t("cloudAccount.onCloudSignIn")}</p>}
      {trialLines(plan?.trial, plan?.credit)}
      <div className="flex flex-wrap gap-2">
        {plan?.status === "signin" && bridge.signIn && <button type="button" className="ui-button ui-button-primary" onClick={() => act(() => bridge.signIn!())}>{t("cloudAccount.signInAgain")}</button>}
        <button type="button" className="ui-button" onClick={() => act(() => bridge.manage())}>{(plan?.trial && !plan.renewal?.cancelled && cloudTrialView(plan.trial).action?.label) || t("cloudAccount.manageInBrowser")}</button>
        {plan && onConnectPhone && <button type="button" className="ui-button" onClick={onConnectPhone}>{t("cloudPhone.action")}</button>}
        <PausedBotsButton />
      </div>
      {plan?.renewal && <CloudCancelPlan renewal={plan.renewal} actions={renewal} onChanged={() => setReads(count => count + 1)} />}
      {failed && <p role="alert" className="text-[13px] text-danger">{t("cloudAccount.actionFailed")}</p>}
    </div>
  </Card>;
}

/** Security: the public native snapshot carries no credential and cannot activate a plan. */
/** `onSignIn`: the sheet's email-code sign-in (the browser approval stays for openmausbot://cloud and Sign in again). */
/** On a Team Cloud: its people and plan live on the Cloud page, where the person signs in with their own email. */
export function TeamPeopleCard({ team }: { team: { name: string; cloudPage?: string } }) {
  return <Card title={t("cloudAccount.teamPeopleTitle")}>
    <div data-cloud-plan="team" className="flex flex-col items-start gap-3">
      <p className="text-[13px] text-ink-secondary">{t("cloudAccount.teamPeopleBody", { team: team.name })}</p>
      {team.cloudPage && <a className="ui-button" href={team.cloudPage} target="_blank" rel="noreferrer">{t("cloudAccount.teamPeopleOpen")}</a>}
    </div>
  </Card>;
}

/** One MausBot account, shown as two pages: `account` (who is signed in, sign in and out) and `plan` (the plan, its Cloud
 * and cancelling it). */
export function CloudAccountSettings({ linkRequest = 0, cloudHome = false, teamHome, onConnectPhone, onAddCloud, onSignIn, part = "plan", advanced = true }: {
  linkRequest?: number; cloudHome?: boolean; teamHome?: { name: string; cloudPage?: string }; onConnectPhone?: () => void; onAddCloud?: () => void; onSignIn?: () => void;
  part?: "account" | "plan"; advanced?: boolean;
} = {}) {
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
  const { platform } = useDesktopCapabilities().capabilities.host;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [confirm, setConfirm] = useState(false);
  const [addingEmail, setAddingEmail] = useState(false);
  const [homeFailed, setHomeFailed] = useState(false), [phoneFailed] = useState(false);
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
  const openTeam = (teamId: string) => {
    if (!bridge?.openTeam) return;
    setHomeFailed(false);
    void perform(async () => {
      try { await bridge.openTeam!(teamId); } catch { setHomeFailed(true); }
      return bridge.state();
    });
  };
  useEffect(() => {
    if (!linkRequest) link.current.request = 0;
    if (!bridge || !linkRequest || !account || pending.current) return;
    if (link.current.request !== linkRequest) link.current = { request: linkRequest, arrived: true, connected: false };
    if (account.status === "signed-out" && account.message === "restoring") return;
    const action = cloudLinkAction(account, link.current);
    link.current.arrived = false;
    if (action === "sign-in") void perform(() => bridge.begin());
    if (action === "connect") { link.current.connected = true; connectHome(); }
  }, [bridge, linkRequest, account, busy]);
  const [moveNotice] = useCloudSendNotice(bridge ? window.ogb?.cloudSendPage : undefined);
  const move = moveNotice?.move ? moveLine(moveNotice.move, "local") : null;
  const moving = move && move.kind !== "done" ? move.text : null;
  const offer = useCloudOffer(Boolean(account) && buyOfferAllowed(cloudPlanView(account)), account?.offer);
  const renewal: CloudRenewalActions | null = bridge?.cancelPlan && bridge.keepPlan ? { cancel: survey => bridge.cancelPlan!(survey), keep: () => bridge.keepPlan!() } : null;
  if (!bridge) {
    const plan = window.ogb?.remoteClient?.active || !cloudHome ? undefined : window.ogb?.cloudPlan;
    if (part === "account") return null;
    return cloudHome && teamHome ? null
      : plan ? <CloudPlanOnCloud bridge={plan} onConnectPhone={onConnectPhone} /> : <p className="px-4 text-[13px] text-ink-secondary">{t("cloudAccount.desktopOnly")}</p>;
  }
  const view = cloudPlanView(account);
  const signed = account && ["connected", "unavailable", "reauth-required"].includes(account.status);
  const message = accountMessage(account, view, platform);
  const line = cloudPlanLine(view);
  const onTeamPlan = teamPlan(account), team = planTeam(account);
  const setUp: CloudMachine | undefined = view.kind === "paid" ? { status: "provisioning" } : undefined;
  const machine: CloudMachine | undefined = onTeamPlan ? team?.machine ?? setUp : account?.status === "connected" ? account.machine ?? setUp : undefined;
  const enrollment = account?.status === "connecting" ? account.enrollment : undefined;
  const moneyBack = moneyBackLine(offer);
  const signedOut = view.kind === "signed-out" || view.kind === "removed";
  const startLabel = t(offerTrialDays(offer) !== null ? "cloudIntro.start" : "cloudAccount.upgrade");
  const errorLine = error && <p role="alert" className="px-4 text-[12px] leading-4 text-danger">{t("cloudAccount.actionFailed")}</p>;

  if (part === "account") {
    return <>
      <SettingsGroup label={t("settings.account.mausbot", { app: productName() })} block="mausbot-account">
        <SettingsRows>
          {(!account || view.kind === "unknown") && <SettingRow title={t("cloudAccount.loading")}>{!account && <button type="button" disabled={busy} className="ui-button" onClick={() => void perform(() => bridge.state())}>{t("organization.refresh")}</button>}</SettingRow>}
          {signedOut && <SettingRow title={t("settings.account.signInTitle", { app: productName() })} subtitle={t("settings.account.signInBody")} message={message && <p role="status">{message}</p>}>
            <button type="button" disabled={busy} className="ui-button ui-button-primary" data-account-sign-in="" onClick={() => onSignIn ? onSignIn() : void perform(() => bridge.begin())}>{t("settings.account.signIn")}</button>
          </SettingRow>}
          {account?.status === "connecting" && <SettingRow title={t("cloudAccount.browser")} subtitle={enrollment ? `${t("cloudAccount.codeCheck")} ${t("cloudAccount.codeUntil", { time: time(enrollment.expiresAt) })}` : undefined}
            message={enrollment && <code data-cloud-code dir="ltr" className="select-all text-[20px] font-medium leading-7 tracking-[0.08em] text-ink">{enrollment.userCode}</code>}>
            <button type="button" disabled={busy} className="ui-button" onClick={() => void perform(() => bridge.reopen())}>{t("organization.reopen")}</button>
            <button type="button" disabled={busy} className="settings-quiet cursor-pointer" onClick={() => void perform(() => bridge.cancel())}>{t("organization.cancel")}</button>
          </SettingRow>}
          {signed && <SettingRow title={account.account?.email ?? t("settings.account.signedIn")} subtitle={message ? <p role="status">{message}</p> : t("settings.account.signedIn")}>
            {view.kind === "reauth"
              ? <button type="button" disabled={busy} className="ui-button" onClick={() => void perform(() => bridge.signInAgain())}>{t("cloudAccount.signInAgain")}</button>
              : advanced && <button type="button" disabled={busy} className="settings-quiet cursor-pointer" onClick={() => void perform(() => bridge.refresh())}>{t("organization.refresh")}</button>}
          </SettingRow>}
        </SettingsRows>
        {signed && view.kind === "free" && !confirm && <p className="px-4 text-[12px] leading-4 text-ink-secondary">{t(window.ogb?.accounts ? "cloudAccount.otherEmailOrTeam" : "cloudAccount.otherEmail")}{" "}
          <button type="button" data-cloud-other-email disabled={busy} className="cursor-pointer text-accent-text hover:underline" onClick={() => (window.ogb?.accounts ? setAddingEmail(true) : setConfirm(true))}>{t(window.ogb?.accounts ? "cloudAccount.addOtherEmail" : "cloudAccount.useOtherEmail")}</button></p>}
        {errorLine}
      </SettingsGroup>
      {addingEmail && <AccountsSheet adding="" onClose={() => setAddingEmail(false)} />}
      {signed && <div data-settings-block="sign-out" className="flex flex-col gap-2"><SettingsRows>
        <SettingRow title={t("settings.account.signOut", { app: productName() })} subtitle={confirm ? t("settings.account.signOutHelp") : undefined}>
          {confirm ? <>
            <button type="button" autoFocus disabled={busy} className="ui-button" onClick={() => setConfirm(false)}>{t("cloudAccount.keep")}</button>
            <button type="button" disabled={busy} className="ui-button ui-button-danger" data-account-sign-out-confirm="" onClick={() => void perform(() => bridge.signOut())}>{t("settings.account.signOutShort")}</button>
          </> : <button type="button" disabled={busy} data-danger="" className="settings-quiet cursor-pointer" onClick={() => setConfirm(true)}>{t("settings.account.signOutShort")}</button>}
        </SettingRow>
      </SettingsRows></div>}
    </>;
  }

  const primary = signedOut || (view.kind === "free" && buyOfferAllowed(view))
    ? onAddCloud && buyOfferAllowed(view) && <button type="button" disabled={busy} className="ui-button ui-button-primary" data-plan-add="" onClick={onAddCloud}>{startLabel}</button>
    : view.kind === "reauth"
      ? <button type="button" disabled={busy} className="ui-button ui-button-primary" onClick={() => void perform(() => bridge.signInAgain())}>{t("cloudAccount.signInAgain")}</button>
      : signed && <button type="button" disabled={busy} className="ui-button ui-button-primary" onClick={() => void perform(() => bridge.openDashboard())}>{view.kind === "free" ? t("cloudAccount.dashboard") : dashboardLabel(account, view)}</button>;
  return <>
    <SettingsGroup label={t("settings.simple.billing.plan")} block="plan" footnote={moneyBack}>
      <SettingsRows>
        {(!account || view.kind === "unknown") && <SettingRow title={t("cloudAccount.loading")}>{null}</SettingRow>}
        {view.kind === "signed-out" && <SettingRow title={t("cloudAccount.free")} subtitle={t("settings.plan.offer")}>{primary}</SettingRow>}
        {signed && <SettingRow title={line ?? t("settings.simple.billing.plan")}
          subtitle={view.kind === "paid" && view.checking ? t("cloudAccount.checking") : message ?? undefined}
          message={<>{account.staging && <StagingMark className="mb-1" />}{account.status === "connected" ? trialLines(account.trial, account.credit) : null}</>}>{primary}</SettingRow>}
        <ProCompareRow />
        {signedOut && <SettingsLinkRow title={t("settings.plan.haveOne")} onClick={() => onSignIn ? onSignIn() : void perform(() => bridge.begin())} />}
        {machine && (onTeamPlan
          ? cloudHomeCard({ machine, busy, failed: homeFailed, onConnect: () => { if (team) openTeam(team.id); }, team: { name: team?.name ?? null } })
          : cloudHomeCard({ machine, busy, failed: homeFailed, onConnect: connectHome, trial: Boolean(account?.trial), waking: account?.waking === true, moving }))}
        {signed && account.status === "connected" && account.renewal && <div className="px-4 py-3"><CloudCancelPlan renewal={account.renewal} actions={renewal} /></div>}
      </SettingsRows>
      {errorLine}
    </SettingsGroup>
    {phoneFailed && <p role="alert" className="px-4 text-[12px] text-danger">{t("cloudPhone.failed")}</p>}
  </>;
}
