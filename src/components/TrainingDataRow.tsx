// Settings → General → Training data (docs/training-data.md): off, kept on this computer, or also shared with the
// MausBot team to train a model that runs on the laptop. Sharing is confirmed once, after saying what goes and what
// never does. Hidden where nothing may be recorded (a Team Cloud, a hosted workspace).
import { useEffect, useState } from "react";
import { Download, Trash2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { trainingDataMode, type TrainingDataMode } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { Card } from "./SettingsPrimitives";

export interface TrainingDataSummary {
  mode: TrainingDataMode;
  steps: number;
  turns: number;
  bytes: number;
  available: boolean;
  upload: { shareSince: string | null; sentTurns: number; refusedTurns: number; lastSentAt: string | null; lastError: string | null };
}

const MODES = [
  { value: "off", label: "trainingData.off" },
  { value: "local", label: "trainingData.local" },
  { value: "share", label: "trainingData.share" },
] as const;

const quiet = "inline-flex items-center gap-1.5 rounded-lg border border-hairline/50 px-3 py-1.5 text-[13px] text-ink hover:bg-raised disabled:opacity-40";
const megabytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0);

export function TrainingDataRow({ simple = false }: { simple?: boolean }) {
  const { state, dispatch } = useStore();
  const mode = trainingDataMode(state.config);
  const [summary, setSummary] = useState<TrainingDataSummary | null>(null);
  const [confirmShare, setConfirmShare] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = () => api<TrainingDataSummary>("/api/training-data", { timeoutMs: 10_000 }).then(setSummary).catch(() => setSummary(null));
  useEffect(() => { void refresh(); }, [mode]);
  if (summary && !summary.available) return null;

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("trainingData.error"));
    } finally {
      setBusy(false);
    }
  };
  const choose = (next: TrainingDataMode) => {
    if (next === mode) return;
    if (next === "share" && !confirmShare) { setConfirmShare(true); return; }
    void run(async () => {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ features: { trainingData: next } }) });
      dispatch({ type: "configStatus", config });
      setConfirmShare(false);
    });
  };
  const exportFile = () => void run(async () => {
    const res = await fetch("/api/training-data.jsonl");
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = "mausbot-training-data.jsonl";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
  const deleteAll = () => void run(async () => {
    await api("/api/training-data", { method: "DELETE" });
    setConfirmDelete(false);
    await refresh();
  });

  const body = (
      <div data-training-data className="flex flex-col gap-3">
        <div className="inline-flex self-start rounded-xl bg-inset p-1" role="radiogroup" aria-label={t("trainingData.title")}>
          {MODES.map((option) => (
            <button key={option.value} type="button" role="radio" aria-checked={mode === option.value} disabled={busy} data-training-mode={option.value}
              onClick={() => choose(option.value)}
              className={cn("rounded-lg px-3 py-1.5 text-[13px] transition-colors disabled:opacity-50",
                mode === option.value ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink")}>
              {t(option.label)}
            </button>
          ))}
        </div>
        <p className="text-[12px] leading-relaxed text-ink-secondary">{t(`trainingData.${mode}Detail`)}</p>

        {confirmShare && (
          <div role="group" aria-label={t("trainingData.shareConfirmTitle")} data-training-share-confirm className="rounded-xl border border-hairline/50 bg-inset p-3 text-[13px] text-ink">
            <p className="font-medium">{t("trainingData.shareConfirmTitle")}</p>
            <p className="mt-1 leading-relaxed text-ink-secondary">{t("trainingData.shareWhat")}</p>
            <p className="mt-1 leading-relaxed text-ink-secondary">{t("trainingData.shareNever")}</p>
            <div className="mt-3 flex gap-2">
              <button type="button" className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40" disabled={busy}
                data-training-share-yes onClick={() => choose("share")}>{t("trainingData.shareYes")}</button>
              <button type="button" className={quiet} disabled={busy} onClick={() => setConfirmShare(false)}>{t("common.cancel")}</button>
            </div>
          </div>
        )}

        {summary && summary.steps > 0 && (
          <p className="text-[12px] text-ink-secondary" data-training-summary>
            {t("trainingData.kept", { turns: summary.turns, steps: summary.steps, size: megabytes(summary.bytes) })}
            {mode === "share" && summary.upload.sentTurns > 0 ? ` ${t("trainingData.sent", { turns: summary.upload.sentTurns })}` : ""}
          </p>
        )}
        {mode === "share" && summary?.upload.lastError && <p className="text-[12px] text-warning">{t("trainingData.uploadError", { error: summary.upload.lastError })}</p>}

        <div className="flex flex-wrap gap-2">
          <button type="button" className={quiet} disabled={busy || !summary?.steps} onClick={exportFile} data-training-export>
            <Download size={14} />{t("trainingData.export")}
          </button>
          {confirmDelete
            ? <button type="button" className={cn(quiet, "text-danger")} disabled={busy} onClick={deleteAll} data-training-delete-yes>
              <Trash2 size={14} />{t("trainingData.deleteConfirm")}
            </button>
            : <button type="button" className={quiet} disabled={busy || !summary?.steps} onClick={() => setConfirmDelete(true)} data-training-delete>
              <Trash2 size={14} />{t("trainingData.delete")}
            </button>}
        </div>
        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      </div>
  );
  // Simple mode's page gives the group its title; the row says what it is for.
  return simple
    ? <div className="flex flex-col gap-2 px-4 py-3"><p className="text-[13px] leading-relaxed text-ink-secondary">{t("trainingData.subtitle")}</p>{body}</div>
    : <Card title={t("trainingData.title")} subtitle={t("trainingData.subtitle")}>{body}</Card>;
}
