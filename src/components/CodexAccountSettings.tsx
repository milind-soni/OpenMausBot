import { useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { ConfirmDialog } from "./ConfirmDialog";

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
    <div className="mt-2 space-y-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex min-w-0 items-center gap-1.5 break-words text-success">
          <Check size={13} className="shrink-0" />
          {t("engineSetup.device.connectedAccount")}
          {email && <span className="text-ink-secondary">· {email}</span>}
        </span>
        <button type="button" onClick={() => void check()} disabled={busy !== null} className="flex items-center gap-1 text-ink-secondary hover:text-ink disabled:opacity-50">
          <RefreshCw size={12} className={cn(busy === "check" && "animate-spin")} />{t("engines.account.check")}
        </button>
      </div>
      {canSignOut && (
        <details className="rounded-lg border border-hairline/40 px-3 py-2">
          <summary className="cursor-pointer text-ink-secondary hover:text-ink">{t("engines.account.manage")}</summary>
          <div className="mt-3 space-y-2">
            <p className="leading-relaxed text-ink-secondary">{t("engineSetup.device.signOutHint")}</p>
            {assigned > 0 && <p className="leading-relaxed text-warning">{t("engineSetup.device.signOutAssigned", { count: String(assigned) })}</p>}
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
        body={t("engineSetup.device.signOutHint")}
        confirmLabel={t("engineSetup.device.signOut")}
        onCancel={() => setConfirm(false)}
        onConfirm={() => void signOut()}
      />
    </div>
  );
}
