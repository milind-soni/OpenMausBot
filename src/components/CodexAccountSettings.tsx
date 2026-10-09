import { useState } from "react";
import { Check, Loader2, Plus, RefreshCw } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { ConfirmDialog } from "./ConfirmDialog";
import { ChatGptPlanStatus } from "./ChatGptPlanStatus";

export function AddProviderAccount({ antigravityInstanceId }: { antigravityInstanceId?: string } = {}) {
  const antigravity = antigravityInstanceId !== undefined;
  const label = t(antigravity ? "engineSetup.antigravity.addAccount" : "engineSetup.chatgpt.addAccount");
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (saving || !displayName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const { instances } = await api(`/api/instances/${antigravity ? "antigravity" : "chatgpt"}-accounts`, { method: "POST", body: JSON.stringify({ displayName: displayName.trim(), ...(antigravity ? { sourceInstanceId: antigravityInstanceId } : {}) }) });
      dispatch({ type: "instances", instances });
      setOpen(false);
      setDisplayName("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };

  if (!open) return <button type="button" onClick={() => setOpen(true)} className="flex min-h-8 w-fit items-center gap-1.5 rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] font-medium text-ink-secondary outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">
    <Plus size={13} />{label}
  </button>;
  return <form className="min-w-0 space-y-3 rounded-xl bg-inset p-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label className="flex flex-col gap-1 text-[12px] text-ink-secondary">
      {t("engines.account.name")}
      <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={t("engines.account.namePlaceholder")} maxLength={80} required disabled={saving} className="rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-50" />
    </label>
    <p className="text-[12px] text-ink-secondary">{t(antigravity ? "engineSetup.antigravity.addAccountHint" : "engineSetup.chatgpt.addAccountHint")}</p>
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    <div className="flex justify-end gap-2">
      <button type="button" onClick={() => setOpen(false)} disabled={saving} className="rounded-lg px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-raised/50 disabled:opacity-50">{t("common.cancel")}</button>
      <button type="submit" disabled={saving || !displayName.trim()} className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50">{saving && <Loader2 size={13} className="animate-spin" />}{label}</button>
    </div>
  </form>;
}

/** Settings → Engines → Codex once ChatGPT is connected: whose account the
 * bots run on, a status check, and a sign-out so a different person can
 * connect their own account from the browser. Mirrors the Claude account
 * panel; sign-in itself stays on the setup card. */
export function CodexAccountSettings({ instance }: { instance: InstanceInfo }) {
  const { state, dispatch, refreshInstances } = useStore();
  const [busy, setBusy] = useState<"check" | "signOut" | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const email = instance.snapshot.account?.email;
  const canSignOut = instance.authentication?.signOut === true;
  const plan = instance.snapshot.chatgptPlan === true;
  const signOutHint = t(plan ? "engineSetup.chatgpt.signOutHint" : "engineSetup.device.signOutHint");
  const assigned = state.bots.filter((bot) => bot.modelSelection.instanceId === instance.instanceId).length;

  const check = async () => {
    if (busy) return;
    setBusy("check");
    setError(null);
    try { await refreshInstances(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };

  const signOut = async () => {
    setConfirm(false);
    if (busy || !canSignOut) return;
    setBusy("signOut");
    setError(null);
    try {
      const { instances } = await api(`/api/instances/${encodeURIComponent(instance.instanceId)}/auth/sign-out`, { method: "POST" });
      // Use the confirmed result: a second catalog request could fail and
      // otherwise leave the signed-out account displayed as connected.
      dispatch({ type: "instances", instances });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3 text-[12px]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-44">
          <span className="flex items-center gap-1.5 font-medium text-success">
            <Check size={13} className="shrink-0" />
            {t(plan ? "engineSetup.chatgpt.connectedAccount" : "engineSetup.device.connectedAccount")}
          </span>
          {email && <p className="mt-1 break-words text-ink-secondary">{email}</p>}
        </div>
        <button type="button" onClick={() => void check()} disabled={busy !== null} className="flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-ink-secondary outline-none hover:bg-control hover:text-ink focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50">
          <RefreshCw size={12} className={cn(busy === "check" && "animate-spin")} />{t("engines.account.check")}
        </button>
      </div>
      {plan && <ChatGptPlanStatus key={instance.instanceId} instanceId={instance.instanceId} />}
      {canSignOut && (
        <details>
          <summary className="cursor-pointer rounded-md py-1 font-medium text-ink-secondary outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">{t("engines.account.manage")}</summary>
          <div className="mt-3 space-y-2 rounded-xl bg-inset p-4">
            <p className="leading-relaxed text-ink-secondary">{signOutHint}</p>
            {assigned > 0 && <p className="leading-relaxed text-warning">{t(plan ? "engineSetup.chatgpt.signOutAssigned" : "engineSetup.device.signOutAssigned", { count: String(assigned) })}</p>}
            <button type="button" onClick={() => setConfirm(true)} disabled={busy !== null} className="text-danger hover:underline disabled:no-underline disabled:opacity-50">
              {busy === "signOut" ? t("engineSetup.device.signingOut") : t("engineSetup.device.signOut")}
            </button>
          </div>
        </details>
      )}
      {error && <p role="alert" className="text-danger">{error}</p>}
      <ConfirmDialog
        open={confirm}
        title={t("engineSetup.device.signOutTitle")}
        body={signOutHint}
        confirmLabel={t("engineSetup.device.signOut")}
        onCancel={() => setConfirm(false)}
        onConfirm={() => void signOut()}
      />
    </div>
  );
}
