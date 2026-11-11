import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { type CloudRenewalActions } from "./CloudCancelPlan";
import { SignOutConfirm } from "./settings/SignOutConfirm";
import { CancelPlanRow, KeepPlanButton, endedLine, planLayout, planTitle, renewalLine } from "./settings/plan-parts";
import type { UpgradeUi } from "./CloudUsageMeter";
import type { CloudUsage } from "../../electron/cloud-home.mjs";
import { StagingMark } from "./cloud-buy/parts";
import { CloudSetupSteps } from "./CloudSetupSteps";
import { useCloudSendNotice } from "./CloudSendStrip";
import { OpenFilesButton } from "./OpenFilesButton";
import { useDesktopCapabilities } from "./DesktopCapabilities";

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
  if (connectable && !moving) {
    // A Cloud that can open is one link row: its state as the value, the row the way in.
    return <div data-cloud-home={machine.status} data-cloud-team={team ? true : undefined} data-cloud-waking={waking ? true : undefined} className="contents">
      <SettingsLinkRow title={label} subtitle={team?.name ? t("cloudHome.team.ready", { name: team.name }) : t("settings.plan.cloudReadyLine")}
        value={t(waking ? "settings.plan.cloudWaking" : "settings.plan.cloudReady")} external onClick={() => { if (!busy) onConnect(); }} data={{ "data-plan-open-cloud": "" }} />
      {failed && <p role="alert" className="px-4 pb-3 text-[12px] leading-4 text-danger">{t("cloudHome.connectFailed")}</p>}
    </div>;
  }
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

export function CloudPlanOnCloud({ bridge, usage = null, upgrade, extra }: { bridge: CloudPlanBridge; usage?: CloudUsage | null; upgrade?: UpgradeUi; extra?: ReactNode }) {
  const [plan, setPlan] = useState<CloudPlanSnapshot | null>(null), [failed, setFailed] = useState(false), [refused, setRefused] = useState(false);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let active = true;
    void bridge.state().then(next => { if (active) setPlan(next); }).catch(() => { if (active) setRefused(true); });
    return () => { active = false; };
  }, [bridge, reads]);
  const renewal: CloudRenewalActions | null = bridge.cancel && bridge.keep ? { cancel: survey => bridge.cancel!(survey), keep: () => bridge.keep!() } : null;
  if (refused) {
    return <SettingsGroup label={t("settings.simple.billing.plan")} block="plan"><SettingsRows>
      <div data-cloud-plan="elsewhere" className="contents"><SettingRow title={t("cloudAccount.onCloudNone")}>{null}</SettingRow></div>
    </SettingsRows></SettingsGroup>;
  }
  const label = cloudPlanLabel(plan?.tier);
  const cancelled = plan?.renewal?.cancelled === true;
  const title = plan?.status === "paid" ? planTitle(label, plan.renewal, trialRunning(plan.trial))
    : plan?.status === "attention" ? t("cloudAccount.inactive", { plan: plan.tier ? label : t("settings.simple.billing.plan") })
    : plan?.status === "checking" ? t("cloudAccount.lastPlan", { plan: label }) : plan?.status === "signin" && plan.tier ? t("cloudAccount.planName", { plan: label })
    : plan ? t(plan.home === true ? "cloudAccount.onCloudNoneHome" : "cloudAccount.onCloudNone") : t("cloudAccount.loading");
  const act = (action: () => Promise<void>) => { setFailed(false); void action().catch(() => setFailed(true)); };
  const primary = plan?.status === "signin" && bridge.signIn
    ? <button type="button" className="ui-button ui-button-primary" onClick={() => act(() => bridge.signIn!())}>{t("cloudAccount.signInAgain")}</button>
    : cancelled && renewal ? <KeepPlanButton actions={renewal} onChanged={() => setReads((count) => count + 1)} />
    : plan ? <button type="button" className="ui-button ui-button-primary" data-plan-manage="" onClick={() => act(() => bridge.manage())}>{(plan.trial && !plan.renewal?.cancelled && cloudTrialView(plan.trial).action?.label) || t("settings.plan.manage")}</button> : null;
  return <div data-cloud-plan={plan?.status ?? "loading"} className="contents">
    {planLayout({ title, primary, usage, upgrade, extra,
      subtitle: plan?.status === "signin" ? t("cloudAccount.onCloudSignIn") : cancelled && plan?.renewal ? endedLine(plan.renewal) : renewalLine(plan?.renewal),
      message: trialLines(plan?.trial, plan?.credit) || failed ? <>{trialLines(plan?.trial, plan?.credit)}{failed && <p role="alert" className="text-danger">{t("cloudAccount.actionFailed")}</p>}</> : undefined,
      cancel: plan?.renewal && renewal ? <CancelPlanRow renewal={plan.renewal} actions={renewal} onChanged={() => setReads((count) => count + 1)} /> : undefined })}
  </div>;
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
export function CloudAccountSettings({ linkRequest = 0, cloudHome = false, teamHome, onAddCloud, onSignIn, part = "plan", advanced = true, usage = null, upgrade, extra }: {
  linkRequest?: number; cloudHome?: boolean; teamHome?: { name: string; cloudPage?: string }; onAddCloud?: () => void; onSignIn?: () => void;
  part?: "account" | "plan" | "sign-out"; advanced?: boolean;
  /** Plan & billing's This week, from the plan bridge */
  usage?: CloudUsage | null; upgrade?: UpgradeUi;
  /** a row for the Plan card (Simple's What this place cost) */
  extra?: ReactNode;
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
    if (part !== "plan") return null;
    return cloudHome && teamHome ? null
      : plan ? <CloudPlanOnCloud bridge={plan} usage={usage} upgrade={upgrade} extra={extra} /> : <p className="px-4 text-[13px] text-ink-secondary">{t("cloudAccount.desktopOnly")}</p>;
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
      {confirm && <SignOutConfirm here={t("rail.thisComputer")} cloud={null} onConfirm={() => perform(() => bridge.signOut())} onClose={() => setConfirm(false)} />}
    </>;
  }
  if (part === "sign-out") {
    // The page's last row, after Organization and Emails: Sign out, with the one confirm every Sign out uses.
    return signed ? <div data-settings-block="sign-out" className="flex flex-col gap-2"><SettingsRows>
      <SettingRow title={t("settings.account.signOut", { app: productName() })}>
        <button type="button" disabled={busy} data-danger="" className="settings-quiet cursor-pointer" onClick={() => setConfirm(true)}>{t("settings.account.signOutShort")}</button>
      </SettingRow>
    </SettingsRows>
      {confirm && <SignOutConfirm here={t("rail.thisComputer")} cloud={view.kind === "paid" ? t("cloudSetup.myCloud") : null}
        onConfirm={() => perform(() => bridge.signOut())} onClose={() => setConfirm(false)} />}
    </div> : null;
  }

  const cancelled = account?.status === "connected" && account.renewal?.cancelled === true;
  const primary = signedOut || (view.kind === "free" && buyOfferAllowed(view))
    ? onAddCloud && buyOfferAllowed(view) && <button type="button" disabled={busy} className="ui-button ui-button-primary" data-plan-add="" onClick={onAddCloud}>{startLabel}</button>
    : view.kind === "reauth"
      ? <button type="button" disabled={busy} className="ui-button ui-button-primary" onClick={() => void perform(() => bridge.signInAgain())}>{t("cloudAccount.signInAgain")}</button>
      : cancelled && renewal ? <KeepPlanButton actions={renewal} onChanged={() => void perform(() => bridge.state())} />
      : signed && <button type="button" disabled={busy} className="ui-button ui-button-primary" data-plan-manage="" onClick={() => void perform(() => bridge.openDashboard())}>{view.kind === "free" ? t("cloudAccount.dashboard") : dashboardLabel(account, view)}</button>;
  const title = !account || view.kind === "unknown" ? t("cloudAccount.loading")
    : view.kind === "signed-out" ? t("cloudAccount.free")
    : view.kind === "paid" && account.status === "connected" ? planTitle(view.label, account.renewal, trialRunning(account.trial))
    : line ?? t("settings.simple.billing.plan");
  return <>
    {planLayout({ title, primary: primary || undefined, usage, upgrade, extra, footnote: moneyBack,
      subtitle: view.kind === "signed-out" ? t("settings.plan.offer") : cancelled && account?.status === "connected" && account.renewal ? endedLine(account.renewal)
        : view.kind === "paid" && view.checking ? t("cloudAccount.checking") : message ?? (account?.status === "connected" ? renewalLine(account.renewal) : undefined),
      // Only a trial or a staging account has a line here; an empty node would add height to the row.
      message: signed && (account.staging || (account.status === "connected" && trialLines(account.trial, account.credit)))
        ? <>{account.staging && <StagingMark className="mb-1" />}{account.status === "connected" ? trialLines(account.trial, account.credit) : null}</> : undefined,
      links: <>
        {signedOut && <SettingsLinkRow title={t("settings.plan.haveOne")} onClick={() => onSignIn ? onSignIn() : void perform(() => bridge.begin())} />}
        {machine && (onTeamPlan
          ? cloudHomeCard({ machine, busy, failed: homeFailed, onConnect: () => { if (team) openTeam(team.id); }, team: { name: team?.name ?? null } })
          : cloudHomeCard({ machine, busy, failed: homeFailed, onConnect: connectHome, trial: Boolean(account?.trial), waking: account?.waking === true, moving }))}
      </>,
      cancel: signed && account.status === "connected" && account.renewal && renewal ? <CancelPlanRow renewal={account.renewal} actions={renewal} onChanged={() => void perform(() => bridge.state())} /> : undefined })}
    {errorLine}
    {phoneFailed && <p role="alert" className="px-4 text-[12px] text-danger">{t("cloudPhone.failed")}</p>}
  </>;
}
