import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import type { WorkspaceBackupSummary } from "../../shared/workspace-backup";
import { api } from "@/state/store";
import { intlLocale, t } from "@/lib/i18n";
import { applyWorkspaceClientState, collectWorkspaceClientState, WORKSPACE_RESTORE_MARKER } from "@/lib/workspace-backup-client";
import { LearnMore, SETTINGS_INPUT, SettingRow, SettingsField, SettingsRows } from "./SettingsPrimitives";
import { SettingsDialog } from "./settings/SettingsDialog";

type BackupStatus = { busy: boolean; pendingRestore?: boolean; restarts?: boolean; lastRestoreId?: string };
const buttonClass = "cursor-pointer inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-40";
const validPassword = (value: string) => value.length >= 12 && value.length <= 1024;

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

export function WorkspaceBackupSummaryView({ summary }: { summary: WorkspaceBackupSummary }) {
  return <div className="rounded-[12px] border-[0.5px] border-(--settings-edge) bg-menu p-3">
    <h3 className="text-[14px] font-medium text-ink">{t("backup.preview")}</h3>
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
      <dt className="text-ink-secondary">{t("backup.date")}</dt><dd className="break-words text-ink">{new Date(summary.createdAt).toLocaleString(intlLocale())}</dd>
      <dt className="text-ink-secondary">{t("backup.version")}</dt><dd className="text-ink">{summary.appVersion}</dd>
      <dt className="text-ink-secondary">{t("backup.bots")}</dt><dd className="text-ink">{summary.bots}</dd>
      <dt className="text-ink-secondary">{t("backup.groups")}</dt><dd className="text-ink">{summary.groups}</dd>
      <dt className="text-ink-secondary">{t("backup.threads")}</dt><dd className="text-ink">{summary.threads}</dd>
      <dt className="text-ink-secondary">{t("backup.messages")}</dt><dd className="text-ink">{summary.messages}</dd>
      <dt className="text-ink-secondary">{t("backup.files")}</dt><dd className="text-ink">{summary.files}</dd>
      <dt className="text-ink-secondary">{t("backup.bytes")}</dt><dd className="text-ink">{summary.bytes.toLocaleString(intlLocale())}</dd>
    </dl>
    {summary.warnings.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-4 text-[12px] text-warning">{summary.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    {summary.exclusions.length > 0 && <div className="mt-3 text-[12px] text-ink-secondary"><p className="font-medium">{t("backup.exclusions")}</p><ul className="mt-1 list-disc space-y-1 pl-4">{summary.exclusions.map((exclusion, index) => <li key={index}>{exclusion}</li>)}</ul></div>}
  </div>;
}

type BackupRows = { exportRow: ReactNode; importRow: ReactNode };
const BOTH_ROWS = ({ exportRow, importRow }: BackupRows) => <SettingsRows>{exportRow}{importRow}</SettingsRows>;

/** `layout` places the two rows (a page with a section for each); one instance still owns their state and dialogs. */
export function WorkspaceBackupSettings({ layout = BOTH_ROWS }: { layout?: (rows: BackupRows) => ReactNode } = {}) {
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
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [more, setMore] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

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
    if (!alive.current) return;
    const url = `/api/workspace-backup/download/${encodeURIComponent(result.id)}`;
    setDownload({ url, filename: result.filename });
    const link = document.createElement("a");
    link.href = url;
    link.download = result.filename;
    document.body.append(link);
    link.click();
    link.remove();
    setExporting(false);
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
    // The stage ID is the restore ID: persist it before the request so a lost response still lets this browser recover
    // its drafts at boot.
    localStorage.setItem(WORKSPACE_RESTORE_MARKER, preview.id);
    let restarting = false;
    try {
      ({ restarting = false } = await api("/api/workspace-backup/restore", {
        method: "POST", body: JSON.stringify({ id: preview.id, confirmation: "REPLACE" }),
      }) as { restarting?: boolean });
    } catch (cause) {
      if (cause instanceof Error && "status" in cause && cause.status === 404 && alive.current) {
        setPreview(null); setUploadedId(null); setConfirmation("");
      }
      throw cause;
    }
    if (alive.current) { setStatus({ busy: false, pendingRestore: true, restarts: restarting }); setPreview(null); setConfirmation(""); }
  });

  const disabled = busy !== null || !status || status.busy || Boolean(status.pendingRestore);
  const closeExport = () => { setExporting(false); setExportPassword(""); setConfirmPassword(""); };
  const closeImport = () => { setImporting(false); setFile(null); setUploadedId(null); setPreview(null); setConfirmation(""); setImportPassword(""); };
  if (status?.pendingRestore) {
    return layout({ exportRow: null, importRow: <div className="px-4 py-3"><WorkspaceBackupRestartNotice serverRestarts={status.restarts === true} /></div> });
  }
  return <>
    {layout({
      exportRow: <SettingRow title={t("backup.export")} subtitle={<>{t("backup.exportShort")}{" "}<LearnMore onClick={() => setMore((open) => !open)} /></>}
        message={<>
          {more && <span data-backup-more="" className="flex flex-col gap-1"><span>{t("backup.scope")}</span><span>{t("backup.excluded")}</span><span>{t("backup.privacy")}</span></span>}
          {download && <a href={download.url} download={download.filename} className="break-all text-accent-text hover:underline">{t("backup.downloadAgain", { filename: download.filename })}</a>}
          {(!status || status.busy) && <span role="status">{status?.busy ? t("backup.serverBusy") : t("backup.checkStatus")}{" "}<button type="button" onClick={() => void refresh()} className="cursor-pointer text-accent-text hover:underline">{t("connectors.action.retry")}</button></span>}
          {error && <span role="alert" className="block break-words text-danger">{error}</span>}
        </>}>
        <button type="button" className="ui-button" disabled={disabled} data-backup-export="" onClick={() => setExporting(true)}>{t("backup.exportAction")}</button>
      </SettingRow>,
      importRow: <SettingRow title={t("backup.import")} subtitle={t("backup.importShort")}>
        <button type="button" className="ui-button" disabled={disabled} data-backup-import="" onClick={() => setImporting(true)}>{t("backup.chooseFile")}</button>
      </SettingRow>,
    })}
    {exporting && (
      <SettingsDialog title={t("backup.export")} onClose={closeExport}>
        <form id="backup-export" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void exportBackup(); }}>
          <p className="text-[13px] leading-[18px] text-ink-secondary">{t("backup.passwordHint")}</p>
          <SettingsField label={t("backup.exportPassword")}>
            <input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required disabled={disabled} value={exportPassword} onChange={(event) => setExportPassword(event.target.value)} className={SETTINGS_INPUT} />
          </SettingsField>
          <SettingsField label={t("backup.confirmPassword")}>
            <input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required disabled={disabled} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className={SETTINGS_INPUT} />
          </SettingsField>
          {error && <p role="alert" className="break-words text-[12px] leading-4 text-danger">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" className="ui-button" onClick={closeExport}>{t("common.cancel")}</button>
            <button type="submit" className="ui-button ui-button-primary gap-1.5" disabled={disabled || !validPassword(exportPassword) || exportPassword !== confirmPassword}>
              {busy === "export" && <Loader2 aria-hidden="true" size={14} className="animate-spin" />}{busy === "export" ? t("backup.exporting") : t("backup.exportAction")}
            </button>
          </div>
        </form>
      </SettingsDialog>
    )}
    {importing && (
      <SettingsDialog title={t("backup.import")} onClose={closeImport}>
        <form id="backup-import" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void previewBackup(); }}>
          <p className="text-[13px] leading-[18px] text-ink-secondary">{t("backup.importHint")}</p>
          <SettingsField label={t("backup.file")}>
            <span className="flex items-center gap-3">
              <input ref={fileInput} type="file" accept=".ombbackup" className="sr-only" tabIndex={-1} disabled={disabled}
                onChange={(event) => { setFile(event.target.files?.[0] ?? null); setUploadedId(null); setPreview(null); setConfirmation(""); setImportPassword(""); setError(null); }} />
              <button type="button" className="ui-button shrink-0" disabled={disabled} onClick={() => fileInput.current?.click()}>{t("backup.chooseFile")}</button>
              <span className="min-w-0 truncate text-[13px] leading-5 text-ink-secondary">{file?.name ?? t("backup.noFile")}</span>
            </span>
          </SettingsField>
          {!preview && (
            <SettingsField label={t("backup.importPassword")}>
              <input type="password" autoComplete="off" maxLength={1024} required disabled={disabled || !file} value={importPassword} onChange={(event) => setImportPassword(event.target.value)} className={SETTINGS_INPUT} />
            </SettingsField>
          )}
          {!preview && error && <p role="alert" className="break-words text-[12px] leading-4 text-danger">{error}</p>}
          {!preview && (
            <div className="flex items-center justify-end gap-2">
              <button type="button" className="ui-button" onClick={closeImport}>{t("common.cancel")}</button>
              <button type="submit" disabled={disabled || !file || !importPassword} className="ui-button ui-button-primary gap-1.5">
                {busy === "preview" && <Loader2 aria-hidden="true" size={14} className="animate-spin" />}{busy === "preview" ? t("backup.validating") : t("backup.validate")}
              </button>
            </div>
          )}
        </form>
        {preview && <>
          <WorkspaceBackupSummaryView summary={preview.summary} />
          <p className="text-[13px] leading-[18px] text-danger">{t("backup.replaceWarning")} {t("backup.trustWarning")}</p>
          <SettingsField label={t("backup.confirmReplace")}>
            <input value={confirmation} autoComplete="off" spellCheck={false} disabled={disabled} onChange={(event) => setConfirmation(event.target.value)} className={SETTINGS_INPUT} />
          </SettingsField>
          {error && <p role="alert" className="break-words text-[12px] leading-4 text-danger">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" className="ui-button" onClick={closeImport}>{t("common.cancel")}</button>
            <button type="button" disabled={disabled || confirmation !== "REPLACE"} onClick={() => void restoreBackup()}
              className="ui-button !bg-danger !text-danger-ink disabled:opacity-40">{busy === "restore" ? t("backup.restoring") : t("backup.replace")}</button>
          </div>
        </>}
      </SettingsDialog>
    )}
  </>;
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
