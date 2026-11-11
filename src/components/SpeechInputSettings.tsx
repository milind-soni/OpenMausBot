import { useEffect, useId, useRef, useState } from "react";
import { isEndpointStt, STT_PRESETS, STT_PROVIDERS, type SttProvider } from "../../shared/stt";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { AdminOnly } from "./AdminOnly";
import { Select } from "./Select";
import { SettingRow } from "./SettingsPrimitives";

const FIELD_CLASS = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus-visible:outline-focus";

export function SpeechInputSettings() {
  return <AdminOnly><SpeechInputForm /></AdminOnly>;
}

function SpeechInputForm() {
  const { state, dispatch } = useStore();
  const saved = state.config?.stt;
  const [provider, setProvider] = useState<SttProvider>(saved?.provider ?? "auto");
  const [baseUrl, setBaseUrl] = useState<string>(saved?.baseUrl ?? STT_PRESETS.openai.baseUrl);
  const [model, setModel] = useState(saved?.model ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const catalogRequest = useRef<AbortController | null>(null);
  const modelListId = useId();
  const [key, setKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setProvider(saved?.provider ?? "auto");
    setBaseUrl(saved?.baseUrl ?? STT_PRESETS.openai.baseUrl);
    setModel(saved?.model ?? "");
    setKey("");
    setRemoveKey(false);
  }, [saved?.provider, saved?.baseUrl, saved?.model, saved?.keyConfigured]);

  useEffect(() => {
    catalogRequest.current?.abort();
    setModels([]);
    setModelError(null);
    setLoadingModels(false);
    return () => catalogRequest.current?.abort();
  }, [provider, baseUrl, key, removeKey]);

  const loadModels = async () => {
    catalogRequest.current?.abort();
    const request = new AbortController();
    catalogRequest.current = request;
    setLoadingModels(true);
    setModelError(null);
    try {
      const result = await api<{ models: string[] }>("/api/tts/models", {
        method: "POST", signal: request.signal,
        body: JSON.stringify({ stt: { provider, baseUrl: baseUrl.trim(), ...(key.trim() ? { key: key.trim() } : removeKey ? { key: "" } : {}) } }),
      });
      if (request.signal.aborted) return;
      setModels(result.models);
      if (!result.models.length) setModelError(t("stt.noModels"));
      else setModel((current) => current.trim() ? current : result.models[0]);
    } catch (error) {
      if (!request.signal.aborted) setModelError(error instanceof Error ? error.message : t("stt.modelsFailed"));
    } finally {
      if (!request.signal.aborted) setLoadingModels(false);
    }
  };

  const choosePreset = (name: string) => {
    setKey("");
    if (name === "openai" || name === "groq") {
      setBaseUrl(STT_PRESETS[name].baseUrl);
      setModel("");
    }
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    const nextKey = key.trim() || (removeKey ? "" : undefined);
    const desktopKeySave = window.ogb?.setCredential && !window.ogb.remoteClient?.active ? window.ogb.setCredential : undefined;
    try {
      const target = { provider, baseUrl: baseUrl.trim(), model: model.trim() };
      const config = desktopKeySave && nextKey !== undefined
        ? await desktopKeySave("sttKey", nextKey, target)
        : await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ stt: { ...target, ...(nextKey !== undefined ? { key: nextKey } : {}) } }) });
      dispatch({ type: "configStatus", config });
      setKey("");
      setRemoveKey(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("stt.saveFailed"));
    } finally { setSaving(false); }
  };
  const preset = baseUrl === STT_PRESETS.openai.baseUrl ? "openai" : baseUrl === STT_PRESETS.groq.baseUrl ? "groq" : "custom";
  const savedKeyMatches = saved?.keyConfigured && provider === saved.provider && baseUrl.replace(/\/+$/, "") === saved.baseUrl;
  const savedKeyUsable = savedKeyMatches && !removeKey;
  return (
    <SettingRow title={t("stt.title")} subtitle={t("stt.description")} children={null} message={
      <fieldset disabled={saving} className="mt-2 grid gap-3 text-[13px]">
        <label className="grid gap-1">{t("stt.provider")}
          <Select value={provider} onChange={(event) => {
            const next = STT_PROVIDERS.find((name) => name === event.target.value);
            if (next) setProvider(next);
            if (next === "gemini") {
              setBaseUrl(STT_PRESETS.google.baseUrl);
              setModel("");
            } else if (next === "openai" && provider === "gemini") {
              setBaseUrl(STT_PRESETS.openai.baseUrl);
              setModel("");
            }
            setKey("");
            setRemoveKey(false);
          }}>
            <option value="auto">{t("stt.automatic")}</option>
            <option value="fish">Fish Audio</option>
            <option value="gemini">Google (Gemini)</option>
            <option value="openai">{t("stt.compatible")}</option>
          </Select>
        </label>
        {isEndpointStt(provider) && <>
          {provider === "openai" && <label className="grid gap-1">{t("stt.preset")}
            <Select value={preset} onChange={(event) => {
              if (event.target.value === "custom") { setBaseUrl(""); setModel(""); }
              choosePreset(event.target.value);
            }}>
              <option value="openai">OpenAI</option><option value="groq">Groq</option><option value="custom">{t("stt.custom")}</option>
            </Select>
          </label>}
          <label className="grid gap-1">{t("stt.baseUrl")}
            <input className={FIELD_CLASS} type="url" value={baseUrl} placeholder="http://localhost:8000/v1"
              onChange={(event) => setBaseUrl(event.target.value)} />
          </label>
          <label className="grid gap-1">{t("stt.model")}
            <input className={FIELD_CLASS} value={model} list={modelListId} placeholder={t("stt.chooseModel")} onChange={(event) => setModel(event.target.value)} />
            <datalist id={modelListId}>{models.map((id) => <option key={id} value={id} />)}</datalist>
          </label>
          <div><button type="button" data-stt-load-models className="ui-button" disabled={loadingModels || !baseUrl.trim()} onClick={() => void loadModels()}>{t(loadingModels ? "stt.loadingModels" : "stt.loadModels")}</button></div>
          <p className="text-ink-secondary">{t("stt.modelsHint")}</p>
          {modelError && <p role="alert" className="text-danger">{modelError}</p>}
          <label className="grid gap-1">{t("stt.key")}
            <input className={FIELD_CLASS} type="password" autoComplete="off" value={key}
              placeholder={savedKeyUsable ? t("stt.keySaved") : provider === "gemini" ? t("stt.googleKey") : t("stt.keyOptional")}
              onChange={(event) => setKey(event.target.value)} />
          </label>
          {savedKeyMatches && <label className="flex items-center gap-2"><input type="checkbox" checked={removeKey} onChange={(event) => setRemoveKey(event.target.checked)} />{t("stt.removeKey")}</label>}
          <p className="text-ink-secondary">{t(provider === "gemini" ? "stt.googleHint" : "stt.endpointHint")}</p>
          {provider === "gemini" && <a href="https://aistudio.google.com/api-keys" target="_blank" rel="noreferrer" className="text-accent hover:underline">{t("stt.googleKey")}</a>}
        </>}
        {provider === "fish" && <p className="text-ink-secondary">{t("stt.fishHint")}</p>}
        {error && <p role="alert" className="text-danger">{error}</p>}
        <div><button type="button" data-stt-save className="ui-button" disabled={saving || (isEndpointStt(provider) && (!baseUrl.trim() || !model.trim()))} onClick={() => void save()}>{saving ? t("stt.saving") : t("stt.save")}</button></div>
      </fieldset>
    } />
  );
}
