import { useEffect, useRef, useState } from "react";
import { FolderPlus, X } from "lucide-react";
import { Card } from "./SettingsPrimitives";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { sharedComputersEnabled } from "@/lib/feature-flags";
import { LendingActivityList } from "./LendingActivity";

/** Grants are edited locally and confirmed by a native dialog, never by the hosted page. */
export function ComputerSharingSettings({ workspace, onClose }: { workspace: { id: string; name: string; origin: string }; onClose: () => void }) {
  // `state` below is this grant's desktop status; appState is the workspace
  // config, which says whether this server offers computer sharing at all.
  const { state: appState } = useStore();
  const offered = sharedComputersEnabled(appState.config);
  const bridge = offered ? window.ogb?.computerSharing : undefined;
  const [state, setState] = useState<DesktopComputerSharing | null>(null);
  const [folders, setFolders] = useState<DesktopSharedFolder[]>([]);
  const [terminal, setTerminal] = useState(false);
  const [computer, setComputer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [activity, setActivity] = useState<DesktopLendingActivity[] | null>(null);
  const mounted = useRef(false);
  const pending = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const apply = (next: DesktopComputerSharing) => {
    setState(next); setFolders(next.folders); setTerminal(next.terminal); setComputer(next.computer);
  };
  useEffect(() => {
    mounted.current = true;
    panel.current?.scrollIntoView({ block: "start" });
    void bridge?.state(workspace.id).then(next => { if (mounted.current) apply(next); })
      .catch(() => { if (mounted.current) setError(t("computerSharing.loadError")); });
    // Connection status and the activity log change independently of an
    // unsaved permissions draft.
    const refresh = () => {
      void bridge?.state(workspace.id).then(next => { if (mounted.current) setState(next); }).catch(() => {});
      void bridge?.activity?.(workspace.id).then(next => { if (mounted.current) setActivity(next); }).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [bridge, workspace.id]);
  const perform = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (failure) { if (mounted.current) setError(String((failure as Error)?.message ?? failure).replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "")); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  if (!bridge) return null;
  return <div ref={panel}><Card title={t("computerSharing.title", { name: workspace.name })} subtitle={workspace.origin}>
    <div className="flex flex-col gap-4 text-[13px]">
      <div className="flex items-center justify-between gap-2">
        <p role="status" className="text-ink-secondary">{!state ? t("computerSharing.loadingAccess") : !state.enabled ? t("computerSharing.notShared") : state.connected ? t("computerSharing.sharingWhileOpen") : t("computerSharing.waitingWorkspace")}</p>
        <button type="button" aria-label={t("computerSharing.close")} onClick={onClose} className="rounded p-1 text-ink-secondary hover:bg-control"><X size={16} /></button>
      </div>
      <p className="text-ink-secondary">{t("computerSharing.intro")}</p>
      <fieldset disabled={busy || !state} className="flex flex-col gap-3 disabled:opacity-50">
        <legend className="mb-2 font-medium text-ink">{t("computerSharing.sharedFolders")}</legend>
        {folders.length === 0 && <p className="text-[12px] text-ink-secondary">{t("computerSharing.noFolders")}</p>}
        {folders.map(folder => <div key={folder.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-hairline/40 p-3">
          <div className="min-w-0 flex-1"><p className="font-medium text-ink">{folder.name}</p><p className="break-all text-[12px] text-ink-secondary">{folder.path}</p></div>
          <label className="flex items-center gap-2 text-[12px] text-ink-secondary"><input type="checkbox" checked={folder.write} onChange={event => setFolders(current => current.map(entry => entry.id === folder.id ? { ...entry, write: event.target.checked } : entry))} />{t("computerSharing.allowEdits")}</label>
          <button type="button" aria-label={`Remove ${folder.name}`} onClick={() => setFolders(current => current.filter(entry => entry.id !== folder.id))} className="rounded p-1 text-ink-secondary hover:bg-control"><X size={14} /></button>
        </div>)}
        <button type="button" disabled={folders.length >= 20} onClick={() => void perform(async () => {
          const folder = await bridge.chooseFolder();
          if (mounted.current && folder) setFolders(current => current.some(entry => entry.path === folder.path) ? current : [...current, folder]);
        })} className="flex w-fit items-center gap-2 rounded-lg border border-hairline/40 px-3 py-2 text-ink hover:bg-control"><FolderPlus size={14} />{t("computerSharing.chooseFolder")}</button>
        <p className="text-[12px] text-ink-secondary">{t("computerSharing.smallFilesNote")}</p>
      </fieldset>
      <fieldset disabled={busy || !state} className="flex flex-col gap-3 border-t border-hairline/40 pt-3 disabled:opacity-50">
        <legend className="font-medium text-ink">{t("computerSharing.broaderAccess")}</legend>
        <label className="flex items-start gap-2"><input className="mt-1" type="checkbox" checked={terminal} onChange={event => setTerminal(event.target.checked)} /><span className="text-ink">{t("computerSharing.unrestrictedTerminal")}<span className="mt-1 block text-[12px] text-ink-secondary">{t("computerSharing.unrestrictedTerminalHint")}</span></span></label>
        <label className="flex items-start gap-2"><input className="mt-1" type="checkbox" checked={computer} onChange={event => setComputer(event.target.checked)} /><span className="text-ink">{t("computerSharing.computerControl")}<span className="mt-1 block text-[12px] text-ink-secondary">{t("computerSharing.computerControlHint")}</span></span></label>
      </fieldset>
      {(error || state?.error) && <p role="alert" className="text-[12px] text-danger">{error || state?.error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || !state || (!folders.length && !terminal && !computer)} onClick={() => void perform(async () => {
          const next = await bridge.save(workspace.id, { folders, terminal, computer });
          if (mounted.current && next) apply(next);
        })} className="rounded-lg bg-accent px-3 py-2 font-medium text-accent-ink disabled:opacity-50">{state?.enabled ? t("computerSharing.saveAccess") : t("computerSharing.shareSelected")}</button>
        {state?.enabled && <button type="button" disabled={busy} onClick={() => void perform(async () => {
          const next = await bridge.revoke(workspace.id); if (mounted.current) apply(next);
        })} className="rounded-lg border border-hairline/40 px-3 py-2 text-danger disabled:opacity-50">{t("computerSharing.stopSharing")}</button>}
      </div>
      {state?.enabled && <p className="text-[12px] text-ink-secondary">{t("computerSharing.stoppingNote")}</p>}
      <div className="border-t border-hairline/40 pt-3"><LendingActivityList entries={activity} /></div>
    </div>
  </Card></div>;
}
