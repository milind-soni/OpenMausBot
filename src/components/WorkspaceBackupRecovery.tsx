import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { applyWorkspaceClientState, WORKSPACE_RESTORE_MARKER } from "@/lib/workspace-backup-client";

export type BackupStatus = { busy: boolean; pendingRestore?: boolean; restarts?: boolean; lastRestoreId?: string };
const buttonClass = "cursor-pointer inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-40";

/** A renderer reload cannot apply a restore; the owning server must restart. A server that restarts itself (My Cloud)
 * is waited for, then the page carries on as after a reload. */
export function WorkspaceBackupRestartNotice({ onRetry, serverRestarts = false }: { onRetry?: () => void; serverRestarts?: boolean } = {}) {
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState(false);
  const [slow, setSlow] = useState(false);
  const lock = useRef(false);
  const retry = useRef(onRetry);
  retry.current = onRetry;
  useEffect(() => {
    if (!serverRestarts) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    // A restored workspace may not know this browser's session: a reload shows sign-in.
    const check = () => api("/api/workspace-backup/status", { timeoutMs: 10_000 }).then((status: BackupStatus) => status.pendingRestore === false ? "installed" : "wait",
      (cause: unknown) => cause instanceof Error && "status" in cause && cause.status === 401 ? "signedOut" : "wait").then((state) => {
      if (!alive) return;
      if (state === "wait") timer = setTimeout(check, 3_000);
      else if (state === "installed" && retry.current) retry.current();
      else window.location.reload();
    });
    timer = setTimeout(check, 3_000);
    // Keeps waiting (and keeps the restore marker), but says so when the restart takes much longer than usual.
    const slowTimer = setTimeout(() => { if (alive) setSlow(true); }, 180_000);
    return () => { alive = false; clearTimeout(timer); clearTimeout(slowTimer); };
  }, [serverRestarts]);
  if (serverRestarts) return <div role="status" className="flex max-w-lg items-center gap-3 text-[14px]">
    <Loader2 aria-hidden="true" size={15} className="shrink-0 animate-spin" />
    <div className="flex flex-col gap-2"><p>{t("backup.serverRestarting")}</p>{slow && <p>{t("backup.serverRestartSlow")}</p>}</div>
  </div>;
  const relaunch = typeof window !== "undefined" && !window.ogb?.remoteClient?.active ? window.ogb?.relaunch : undefined;
  const restart = async () => {
    if (!relaunch || lock.current || restarting) return;
    lock.current = true; setRestarting(true); setError(false);
    try {
      if (!await relaunch()) throw new Error("Restart unavailable");
    } catch {
      lock.current = false; setRestarting(false); setError(true);
    }
  };
  return <div role="status" className="flex max-w-lg flex-col gap-4 text-[14px]">
    <p>{t(relaunch ? "backup.restartDesktop" : "backup.restart")}</p>
    {relaunch && <button type="button" className={`${buttonClass} self-start`} disabled={restarting} onClick={() => void restart()}>{restarting ? t("settings.updates.restartingShort") : t("backup.restartAction")}</button>}
    {!relaunch && onRetry && <button type="button" className={`${buttonClass} self-start`} onClick={onRetry}>{t("connectors.action.retry")}</button>}
    {error && <p role="alert" className="text-[13px] text-danger">{t("backup.restartFailed")}</p>}
  </div>;
}

function pendingRestoreId(): string | null {
  try { return localStorage.getItem(WORKSPACE_RESTORE_MARKER); } catch { return null; }
}

/** Do not mount stale composer caches before the initiating browser recovers. */
export function WorkspaceBackupRecovery({ children }: { children: ReactNode }) {
  const [restoreId] = useState(pendingRestoreId);
  const [ready, setReady] = useState(!restoreId);
  const [error, setError] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [serverRestarts, setServerRestarts] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!restoreId) return;
    let alive = true;
    setError(null);
    void (async () => {
      const status: BackupStatus = await api("/api/workspace-backup/status");
      if (!alive) return;
      if (status.pendingRestore) { setServerRestarts(status.restarts === true); setRestartRequired(true); return; }
      if (status.lastRestoreId !== restoreId) {
        localStorage.removeItem(WORKSPACE_RESTORE_MARKER);
        setReady(true);
        return;
      }
      const result = await api("/api/workspace-backup/client-state", { method: "POST", body: JSON.stringify({ restoreId }) });
      if (!alive) return;
      applyWorkspaceClientState(result.clientState);
      localStorage.removeItem(WORKSPACE_RESTORE_MARKER);
      window.location.reload();
    })().catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { alive = false; };
  }, [restoreId, attempt]);
  if (ready) return children;
  const continueWithoutDrafts = () => {
    try {
      localStorage.removeItem(WORKSPACE_RESTORE_MARKER);
      window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-app p-6 text-ink">
    {restartRequired ? <WorkspaceBackupRestartNotice serverRestarts={serverRestarts} onRetry={() => { setRestartRequired(false); setAttempt((value) => value + 1); }} /> : <p className="max-w-lg text-[14px]">{t("backup.recovering")}</p>}
    {error && <p role="alert" className="max-w-lg break-words text-[13px] text-danger">{error}</p>}
    {error && <button type="button" className={buttonClass} onClick={() => { setRestartRequired(false); setAttempt((value) => value + 1); }}>{t("connectors.action.retry")}</button>}
    {error && <>
      <p className="max-w-lg text-[13px] text-ink-secondary">{t("backup.skipDraftsHint")}</p>
      <button type="button" className="cursor-pointer rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] font-medium text-ink" onClick={continueWithoutDrafts}>{t("backup.skipDrafts")}</button>
    </>}
  </main>;
}
