import { useEffect, useRef, useState, type ReactNode } from "react";
import { Download, Loader2, Upload } from "lucide-react";
import type { WorkspaceBackupSummary } from "../../shared/workspace-backup";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { applyWorkspaceClientState, collectWorkspaceClientState, WORKSPACE_RESTORE_MARKER } from "@/lib/workspace-backup-client";
import { Card } from "./SettingsPrimitives";

type BackupStatus = { busy: boolean; pendingRestore?: boolean; lastRestoreId?: string };
const inputClass = "w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[14px] text-ink disabled:opacity-50";
const buttonClass = "inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-40";
const validPassword = (value: string) => value.length >= 12 && value.length <= 1024;

export function WorkspaceBackupSummaryView({ summary }: { summary: WorkspaceBackupSummary }) {
  return <div className="rounded-lg border border-hairline/50 bg-inset p-3">
    <h3 className="text-[14px] font-medium text-ink">{t("backup.preview")}</h3>
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
      <dt className="text-ink-secondary">{t("backup.date")}</dt><dd className="break-words text-ink">{new Date(summary.createdAt).toLocaleString()}</dd>
      <dt className="text-ink-secondary">{t("backup.version")}</dt><dd className="text-ink">{summary.appVersion}</dd>
      <dt className="text-ink-secondary">{t("backup.bots")}</dt><dd className="text-ink">{summary.bots}</dd>
      <dt className="text-ink-secondary">{t("backup.groups")}</dt><dd className="text-ink">{summary.groups}</dd>
      <dt className="text-ink-secondary">{t("backup.threads")}</dt><dd className="text-ink">{summary.threads}</dd>
      <dt className="text-ink-secondary">{t("backup.messages")}</dt><dd className="text-ink">{summary.messages}</dd>
      <dt className="text-ink-secondary">{t("backup.files")}</dt><dd className="text-ink">{summary.files}</dd>
      <dt className="text-ink-secondary">{t("backup.bytes")}</dt><dd className="text-ink">{summary.bytes.toLocaleString()}</dd>
    </dl>
    {summary.warnings.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-4 text-[12px] text-warning">{summary.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    {summary.exclusions.length > 0 && <div className="mt-3 text-[12px] text-ink-secondary"><p className="font-medium">{t("backup.exclusions")}</p><ul className="mt-1 list-disc space-y-1 pl-4">{summary.exclusions.map((exclusion, index) => <li key={index}>{exclusion}</li>)}</ul></div>}
  </div>;
}

export function WorkspaceBackupSettings() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState<"export" | "preview" | "restore" | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [exportPassword, setExportPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploadedId, setUploadedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; summary: WorkspaceBackupSummary } | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [download, setDownload] = useState<{ url: string; filename: string } | null>(null);

  const refresh = async () => {
    try {
      const result: BackupStatus = await api("/api/workspace-backup/status");
      if (alive.current) { setStatus(result); setError(null); }
    } catch (cause) {
      if (alive.current) { setStatus(null); setError(cause instanceof Error ? cause.message : String(cause)); }
    }
  };
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; };
  }, []);

  const perform = async (operation: NonNullable<typeof busy>, work: () => Promise<void>) => {
    if (lock.current || !status || status.busy || status.pendingRestore) return;
    lock.current = true;
    setBusy(operation);
    setError(null);
    try { await work(); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { lock.current = false; if (alive.current) setBusy(null); }
  };

  const exportBackup = () => perform("export", async () => {
    if (!validPassword(exportPassword) || exportPassword !== confirmPassword) return;
    const result: { id: string; filename: string } = await api("/api/workspace-backup/export", {
      method: "POST", body: JSON.stringify({ password: exportPassword, clientState: collectWorkspaceClientState() }),
    });
    if (alive.current) { setExportPassword(""); setConfirmPassword(""); }
    // Native download streams large archives without buffering them in the
    // renderer. Same-origin cookies/desktop headers preserve owner access.
    if (!alive.current) return;
    const url = `/api/workspace-backup/download/${encodeURIComponent(result.id)}`;
    setDownload({ url, filename: result.filename });
    const link = document.createElement("a");
    link.href = url;
    link.download = result.filename;
    document.body.append(link);
    link.click();
    link.remove();
  });

  const previewBackup = () => perform("preview", async () => {
    if (!file || !importPassword) return;
    setPreview(null);
    setConfirmation("");
    let id = uploadedId;
    if (!id) {
      const result: { id: string } = await api("/api/workspace-backup/upload", {
        method: "POST", headers: { "content-type": "application/octet-stream" }, body: file,
      });
      id = result.id;
      if (alive.current) setUploadedId(id);
    }
    const result: { id: string; summary: WorkspaceBackupSummary } = await api("/api/workspace-backup/preview", {
      method: "POST", body: JSON.stringify({ id, password: importPassword }),
    }).catch((cause: unknown) => {
      if (cause instanceof Error && "status" in cause && cause.status === 404 && alive.current) setUploadedId(null);
      throw cause;
    });
    if (alive.current) { setPreview({ id: result.id, summary: result.summary }); setUploadedId(null); setImportPassword(""); }
  });

  const restoreBackup = () => perform("restore", async () => {
    if (!preview || confirmation !== "REPLACE") return;
    // This stage ID is also the restore ID. Persist it before the request so
    // a lost response still lets this browser recover its own drafts at boot.
    localStorage.setItem(WORKSPACE_RESTORE_MARKER, preview.id);
    try {
      await api("/api/workspace-backup/restore", {
        method: "POST", body: JSON.stringify({ id: preview.id, confirmation: "REPLACE" }),
      });
    } catch (cause) {
      if (cause instanceof Error && "status" in cause && cause.status === 404 && alive.current) {
        setPreview(null); setUploadedId(null); setConfirmation("");
      }
      throw cause;
    }
    if (alive.current) { setStatus({ busy: false, pendingRestore: true }); setPreview(null); setConfirmation(""); }
  });

  const disabled = busy !== null || !status || status.busy || Boolean(status.pendingRestore);
  return <div className="flex flex-col gap-4">
    <p className="text-[13px] leading-relaxed text-ink-secondary">{t("backup.scope")}</p>
    <p className="text-[13px] leading-relaxed text-ink-secondary">{t("backup.excluded")}</p>
    <p className="text-[13px] leading-relaxed text-ink-secondary">{t("backup.privacy")}</p>
    {error && <p role="alert" className="break-words text-[13px] text-danger">{error}</p>}
    {status?.pendingRestore ? <div role="status" className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-[13px] text-ink">{t("backup.restart")}</div> : <>
      {(!status || status.busy) && <div role="status" className="flex items-center gap-3 text-[13px] text-ink-secondary"><span>{status?.busy ? t("backup.serverBusy") : t("backup.checkStatus")}</span><button type="button" onClick={() => void refresh()} className="underline">{t("connectors.action.retry")}</button></div>}
      <Card title={t("backup.export")} subtitle={t("backup.passwordHint")}>
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void exportBackup(); }}>
          <label className="text-[13px] text-ink">{t("backup.exportPassword")}<input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required disabled={disabled} value={exportPassword} onChange={(event) => setExportPassword(event.target.value)} className={`${inputClass} mt-1`} /></label>
          <label className="text-[13px] text-ink">{t("backup.confirmPassword")}<input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required disabled={disabled} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className={`${inputClass} mt-1`} /></label>
          <button type="submit" disabled={disabled || !validPassword(exportPassword) || exportPassword !== confirmPassword} className={buttonClass}>{busy === "export" ? <Loader2 aria-hidden="true" size={15} className="animate-spin" /> : <Download aria-hidden="true" size={15} />}{busy === "export" ? t("backup.exporting") : t("backup.export")}</button>
          {download && <a href={download.url} download={download.filename} className="break-all text-[13px] text-accent-text underline">{t("backup.downloadAgain", { filename: download.filename })}</a>}
        </form>
      </Card>
      <Card title={t("backup.import")} subtitle={t("backup.importHint")}>
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void previewBackup(); }}>
          <label className="text-[13px] text-ink">{t("backup.file")}<input type="file" accept=".ombbackup" disabled={disabled} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setUploadedId(null); setPreview(null); setConfirmation(""); setImportPassword(""); setError(null); }} className="mt-1 block w-full min-w-0 rounded-lg border border-hairline/50 bg-inset p-2 text-[13px] text-ink file:mr-3 file:rounded file:border-0 file:bg-control file:px-2 file:py-1 file:text-ink disabled:opacity-50" /></label>
          {!preview && <><label className="text-[13px] text-ink">{t("backup.importPassword")}<input type="password" autoComplete="off" maxLength={1024} required disabled={disabled || !file} value={importPassword} onChange={(event) => setImportPassword(event.target.value)} className={`${inputClass} mt-1`} /></label><button type="submit" disabled={disabled || !file || !importPassword} className={buttonClass}>{busy === "preview" ? <Loader2 aria-hidden="true" size={15} className="animate-spin" /> : <Upload aria-hidden="true" size={15} />}{busy === "preview" ? t("backup.validating") : t("backup.validate")}</button></>}
        </form>
        {preview && <div className="mt-4 flex flex-col gap-3">
          <WorkspaceBackupSummaryView summary={preview.summary} />
          <p className="text-[13px] leading-relaxed text-danger">{t("backup.replaceWarning")}</p>
          <p className="text-[13px] leading-relaxed text-danger">{t("backup.trustWarning")}</p>
          <label className="text-[13px] text-ink">{t("backup.confirmReplace")}<input value={confirmation} autoComplete="off" spellCheck={false} disabled={disabled} onChange={(event) => setConfirmation(event.target.value)} className={`${inputClass} mt-1`} /></label>
          <button type="button" disabled={disabled || confirmation !== "REPLACE"} onClick={() => void restoreBackup()} className="rounded-lg bg-danger px-3 py-2 text-[13px] font-medium text-danger-ink disabled:opacity-40">{busy === "restore" ? t("backup.restoring") : t("backup.replace")}</button>
        </div>}
      </Card>
    </>}
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
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!restoreId) return;
    let alive = true;
    setError(null);
    void (async () => {
      const status: BackupStatus = await api("/api/workspace-backup/status");
      if (!alive) return;
      if (status.pendingRestore) { setRestartRequired(true); return; }
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
      // Re-enter normal bootstrap so expired sessions can reach sign-in.
      window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-app p-6 text-ink">
    <p className="max-w-lg text-[14px]">{restartRequired ? t("backup.restart") : t("backup.recovering")}</p>
    {error && <p role="alert" className="max-w-lg break-words text-[13px] text-danger">{error}</p>}
    {(error || restartRequired) && <button type="button" className={buttonClass} onClick={() => { setRestartRequired(false); setAttempt((value) => value + 1); }}>{t("connectors.action.retry")}</button>}
    {error && <>
      <p className="max-w-lg text-[13px] text-ink-secondary">{t("backup.skipDraftsHint")}</p>
      <button type="button" className="rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] font-medium text-ink" onClick={continueWithoutDrafts}>{t("backup.skipDrafts")}</button>
    </>}
  </main>;
}
