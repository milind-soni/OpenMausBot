import { useEffect, useRef, useState } from "react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudMachine } from "../../electron/cloud-home.mjs";
import { t } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";

const MACHINE_TEXT = {
  provisioning: "cloudHome.provisioning",
  ready: "cloudHome.ready",
  stopped: "cloudHome.stopped",
  "payment-problem": "cloudHome.paymentProblem",
  failed: "cloudHome.failed",
} as const;

/** The person's Cloud machine: where it stands, and one way in. Status and
 * address come only from the verified native snapshot; the pairing code
 * never reaches this page. A render helper (no hooks), part of the card. */
function cloudHomeCard({ machine, busy, failed, onConnect }: { machine: CloudMachine; busy: boolean; failed: boolean; onConnect: () => void }) {
  const connectable = machine.status === "ready";
  return <Card title={t("cloudHome.title")}>
    <div data-cloud-home={machine.status} className="flex flex-col items-start gap-3">
      <p role="status" className={machine.status === "ready" ? "text-[14px] text-ink" : "text-[13px] text-ink-secondary"}>{t(MACHINE_TEXT[machine.status])}</p>
      {connectable && <>
        <button type="button" disabled={busy} className="ui-button" onClick={onConnect}>{t("cloudHome.connect")}</button>
        <p className="text-[12px] text-ink-secondary">{t("cloudHome.connectHelp")}</p>
      </>}
      {failed && <p role="alert" className="text-[13px] text-danger">{t("cloudHome.connectFailed")}</p>}
    </div>
  </Card>;
}

/** The public native snapshot carries no credential and cannot activate Pro. */
export function CloudAccountSettings() {
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudAccount;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [confirm, setConfirm] = useState(false);
  const [homeFailed, setHomeFailed] = useState(false);
  const generation = useRef(0), revision = useRef(0), pending = useRef(false);
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
  if (!bridge) return <p className="text-[13px] text-ink-secondary">{t("cloudAccount.desktopOnly")}</p>;
  const signed = account && ["connected", "unavailable", "reauth-required"].includes(account.status);
  // Status comes only from the server-verified native snapshot; checkout never sets it.
  const activePro = account?.status === "connected" && account.entitlement?.plan === "pro" && account.entitlement.status === "active";
  const message = account?.message === "signout-local-only" ? t("cloudAccount.signoutLocalOnly")
    : account?.message === "signout-storage-failed" || account?.message === "restore-failed" ? t("cloudAccount.storageFailed")
      : account?.status === "reauth-required" ? t("cloudAccount.reauth")
        : account?.status === "unavailable" ? t("cloudAccount.unavailable")
          : account?.message ? t("cloudAccount.signinFailed") : null;
  return <>
    <p className="text-[13px] leading-relaxed text-ink-secondary">{t("cloudAccount.optional")}</p>
    <Card title={t("settings.section.cloudAccount")} subtitle={t("cloudAccount.separate")}>
      {!account && <p role="status" className="text-[13px] text-ink-secondary">{t("cloudAccount.loading")}</p>}
      {message && <p role="status" className="mb-3 text-[13px] text-ink-secondary">{message}</p>}
      {account?.status === "signed-out" && <button type="button" disabled={busy} className="ui-button" onClick={() => void perform(() => bridge.begin())}>{t("cloudAccount.signIn")}</button>}
      {account?.status === "connecting" && <div className="flex flex-col items-start gap-3">
        <p role="status" className="text-[13px] text-ink-secondary">{t("cloudAccount.browser")}</p>
        {account.enrollment && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">{t("organization.securityDetails")}</summary>
          <p className="mt-2">{t("organization.securityDetailsHelp")}</p><code dir="ltr" className="mt-2 block select-all text-base tracking-widest">{account.enrollment.userCode}</code></details>}
        <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} className="ui-button" onClick={() => void perform(() => bridge.reopen())}>{t("organization.reopen")}</button>
          <button type="button" disabled={busy} className="ui-button" onClick={() => void perform(() => bridge.cancel())}>{t("organization.cancel")}</button></div>
      </div>}
      {signed && <div className="flex flex-col gap-3">
        {account.account && <p className="break-all text-[14px] text-ink">{account.account.email}</p>}
        {account.status === "connected" && <p role="status" className="text-[15px] font-medium text-ink">{activePro ? t("cloudAccount.pro") : t("cloudAccount.free")}</p>}
        <p className="text-[13px] text-ink-secondary">{t("cloudAccount.purchaseHelp")}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} className="ui-button" onClick={() => void perform(() => bridge.openDashboard())}>{activePro ? t("cloudAccount.manage") : t("cloudAccount.upgrade")}</button>
          <button type="button" disabled={busy} className="ui-button" onClick={() => void perform(() => bridge.refresh())}>{t("organization.refresh")}</button>
          {!confirm && <button type="button" disabled={busy} className="ui-button" onClick={() => setConfirm(true)}>{t("cloudAccount.signOut")}</button>}
        </div>
        {confirm && <div role="group" aria-label={t("cloudAccount.signoutTitle")} className="rounded-lg border border-hairline/40 p-3">
          <p className="text-[13px] text-ink-secondary">{t("cloudAccount.signoutHelp")}</p><div className="mt-3 flex flex-wrap gap-2">
            <button type="button" autoFocus disabled={busy} className="ui-button" onClick={() => setConfirm(false)}>{t("cloudAccount.keep")}</button>
            <button type="button" disabled={busy} className="ui-button text-danger" onClick={() => void perform(() => bridge.signOut())}>{t("cloudAccount.signOut")}</button>
          </div></div>}
      </div>}
      {error && <p role="alert" className="mt-3 text-[13px] text-danger">{t("cloudAccount.actionFailed")}</p>}
      {!account && <button type="button" disabled={busy} className="ui-button mt-3" onClick={() => void perform(() => bridge.state())}>{t("organization.refresh")}</button>}
    </Card>
    {account?.status === "connected" && account.machine && cloudHomeCard({ machine: account.machine, busy, failed: homeFailed,
      onConnect: () => { setHomeFailed(false); void perform(async () => {
        try { return await bridge.connectHome(); } catch { setHomeFailed(true); return bridge.state(); }
      }); } })}
  </>;
}
