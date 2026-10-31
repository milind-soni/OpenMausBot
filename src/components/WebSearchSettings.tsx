import { useEffect, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";

export function WebSearchSettings() {
  const { state, dispatch } = useStore();
  const [url, setUrl] = useState(state.config?.webSearch?.searxngUrl ?? "");
  const [dirty, setDirty] = useState(false);
  const confirmedUrl = state.config?.webSearch?.searxngUrl ?? "";
  useEffect(() => { if (!dirty) setUrl(confirmedUrl); }, [confirmedUrl, dirty]);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (remove = false) => {
    setBusy(true); setError("");
    try {
      const config = await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ webSearch: {
        searxngUrl: url, ...(remove || key ? { braveApiKey: remove ? "" : key } : {}),
      } }) });
      setKey(""); setDirty(false); dispatch({ type: "configStatus", config });
    } catch { setError(t("settings.webSearch.error")); }
    finally { setBusy(false); }
  };
  return <section className="mt-4 flex flex-col gap-2">
    <h3 className="text-[13px] font-medium text-ink">{t("settings.webSearch.title")}</h3>
    <p className="text-[12px] text-ink-secondary">{t("settings.webSearch.help")} <a className="underline" href="https://api-dashboard.search.brave.com/terms-of-service" target="_blank" rel="noreferrer">{t("settings.webSearch.terms")}</a></p>
    <label className="text-[13px]">{t("settings.webSearch.url")}<input className="ml-2 rounded border border-hairline bg-inset p-2" value={url} disabled={busy} onChange={event => { setUrl(event.target.value); setDirty(true); }} /></label>
    <label className="text-[13px]">{t("settings.webSearch.key")}<input className="ml-2 rounded border border-hairline bg-inset p-2" type="password" autoComplete="new-password" value={key} disabled={busy} onChange={event => setKey(event.target.value)} /></label>
    <div className="flex gap-2"><button disabled={busy} onClick={() => void save()}>{t("settings.webSearch.save")}</button>
      {state.config?.webSearch?.braveConfigured && <button disabled={busy} onClick={() => void save(true)}>{t("settings.webSearch.remove")}</button>}</div>
    {error && <p role="alert" className="text-danger">{error}</p>}
  </section>;
}
