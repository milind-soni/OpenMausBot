import { useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";

export function ThreadConcurrencySettings() {
  const { state, dispatch } = useStore();
  const confirmed = state.config?.threads?.maxConcurrentPerBot ?? 3;
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const save = async (limit: number) => {
    if (saving.current || limit === confirmed) return;
    saving.current = true;
    setPending(limit);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ threads: { maxConcurrentPerBot: limit } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.threads.error"));
    } finally {
      saving.current = false;
      setPending(null);
    }
  };
  return (
    <Card title={t("settings.threads.title")} subtitle={t("settings.threads.subtitle")}>
      <label htmlFor="thread-concurrency" className="block text-[13px] font-medium text-ink">{t("settings.threads.label")}</label>
      <select id="thread-concurrency" value={pending ?? confirmed} disabled={pending !== null}
        aria-describedby="thread-concurrency-help"
        onChange={(event) => void save(Number(event.target.value))}
        className="mt-2 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink disabled:opacity-50">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((limit) => <option key={limit} value={limit}>{limit}</option>)}
      </select>
      <p id="thread-concurrency-help" className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("settings.threads.help")}</p>
      {pending !== null && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{t("settings.threads.saving")}</p>}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}
