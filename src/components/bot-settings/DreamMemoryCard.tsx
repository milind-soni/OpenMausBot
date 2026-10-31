import { useEffect, useRef, useState } from "react";
import { activeLocale, t } from "@/lib/i18n";
import { localizedRelativeTime } from "@/lib/memory";
import { api, ApiError } from "@/state/store";
import { Select } from "../Select";

interface DreamResult {
  at: number;
  conversations: number;
  learned: unknown[];
  outdated: unknown[];
  ideas: string[];
  note?: string;
}
interface Backup { id: string; at: number }
const buttonCls = "rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50";

export function DreamMemoryResult({ report }: { report: DreamResult }) {
  return <div className="mt-2 text-[13px] text-ink-secondary" role="status">
    <time dateTime={new Date(report.at).toISOString()}>{localizedRelativeTime(report.at, activeLocale())}</time>
    <p>{t("memory.dream.result", { chats: report.conversations, learned: report.learned.length, outdated: report.outdated.length, ideas: report.ideas.length })}</p>
    {report.note && <p>{report.note}</p>}
  </div>;
}

export function DreamMemoryCard({ botId, enabled, onChange }: { botId: string; enabled: boolean; onChange: () => Promise<void> }) {
  const [last, setLast] = useState<DreamResult>();
  const [backups, setBackups] = useState<Backup[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<{ id: string; hash: string }>();
  const alive = useRef(true);
  const endpoint = `/api/bots/${botId}/memory`;
  const refresh = async () => {
    const [status, saved] = await Promise.all([api<{ lastDream?: DreamResult }>(`${endpoint}/upkeep`), api<{ backups: Backup[] }>(`${endpoint}/dream/backups`)]);
    if (!alive.current) return;
    setLast(status.lastDream);
    setBackups(saved.backups);
  };
  useEffect(() => {
    alive.current = true;
    void refresh().catch(() => { if (alive.current) setError(t("memory.dream.failed")); });
    return () => { alive.current = false; };
  }, [botId]);
  const act = async (restore: boolean, expectedHash?: string) => {
    setBusy(true);
    setError("");
    const id = confirmation?.id || selected || backups[0]?.id;
    try {
      await api(`${endpoint}/dream${restore ? "/restore" : ""}`, { method: "POST", timeoutMs: 200_000, ...(restore ? { body: JSON.stringify({ id, expectedHash }) } : {}) });
      if (!alive.current) return;
      setConfirmation(undefined);
      await refresh();
      if (alive.current) await onChange();
    } catch (e) {
      if (!alive.current) return;
      const details = e instanceof ApiError ? e.body as { code?: string; currentHash?: string } : undefined;
      if (restore && details?.code === "changed" && details.currentHash && id) setConfirmation({ id, hash: details.currentHash });
      else setError(t(details?.code === "busy" ? "memory.dream.busy" : details?.code === "paused" ? "memory.dream.paused" : "memory.dream.failed"));
    } finally { if (alive.current) setBusy(false); }
  };
  return <section className="rounded-xl border border-hairline bg-card p-4">
    <h3 className="text-[15px] font-medium text-ink">{t("memory.dream.title")}</h3>
    <p className="mt-1 text-[13px] text-ink-secondary">{t("memory.dream.help")}</p>
    {last && <DreamMemoryResult report={last} />}
    {error && <p role="alert">{error}</p>}
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button type="button" className={buttonCls} disabled={busy || !enabled} onClick={() => void act(false)}>{t(busy ? "memory.dream.working" : "memory.dream.now")}</button>
      {backups.length > 0 && <>
        <Select size="sm" aria-label={t("memory.dream.backup")} value={selected} disabled={busy} onChange={(e) => { setSelected(e.target.value); setConfirmation(undefined); }}>
          <option value="">{t("memory.dream.newest")}</option>
          {backups.map((backup) => <option key={backup.id} value={backup.id}>{new Date(backup.at).toLocaleString(activeLocale())}</option>)}
        </Select>
        <button type="button" className={buttonCls} disabled={busy} onClick={() => void act(true)}>{t("memory.dream.restore")}</button>
      </>}
    </div>
    {confirmation && <div role="alert" className="mt-3 text-[13px] text-ink">
      <p>{t("memory.dream.changed")}</p>
      <button type="button" className={buttonCls} disabled={busy} onClick={() => void act(true, confirmation.hash)}>{t("memory.dream.confirm")}</button>
      <button type="button" className={buttonCls} disabled={busy} onClick={() => setConfirmation(undefined)}>{t("common.cancel")}</button>
    </div>}
  </section>;
}
