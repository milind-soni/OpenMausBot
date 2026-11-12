import { useState } from "react";

import { t } from "@/lib/i18n";
import { qwenVoicesForModel, QWEN_VOICE_SOURCES } from "@/lib/qwen-voices";
import { api, useStore } from "@/state/store";
import type { LiveProvider, LiveSettings } from "../../shared/wire";
import { Select } from "./Select";
import { KEY_FIELD } from "./keys/KeyRow";

type ProviderPatch = Partial<Pick<LiveSettings, "provider" | "azureEndpoint" | "azureDeployment" | "qwenRegion" | "qwenWorkspace" | "qwenModel" | "qwenVoice">>;

const FIELD = KEY_FIELD;

export function LiveProviderSettings() {
  const { state, dispatch } = useStore();
  const live: LiveSettings = state.config?.live ?? { configured: false, voice: "", readTypedReplies: true, idleMinutes: 5 };
  const provider: LiveProvider = live.provider ?? "openai";
  const [endpoint, setEndpoint] = useState(live.azureEndpoint ?? "");
  const [deployment, setDeployment] = useState(live.azureDeployment ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const azureChanged = endpoint.trim() !== (live.azureEndpoint ?? "") || deployment.trim() !== (live.azureDeployment ?? "");

  const save = async (patch: ProviderPatch): Promise<LiveSettings | undefined> => {
    setSaving(true);
    setError(null);
    try {
      const body = await api<{ live: LiveSettings }>("/api/live/settings", { method: "PATCH", body: JSON.stringify(patch) });
      if (state.config) dispatch({ type: "configStatus", config: { ...state.config, live: body.live } });
      return body.live;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium leading-[18px] text-ink">{t("call.live.provider")}</span>
        <Select
          size="sm"
          value={provider}
          disabled={saving}
          onChange={(event) => void save({ provider: event.target.value as LiveProvider })}
        >
          <option value="openai">{t("call.live.provider.openai")}</option>
          <option value="azure">{t("call.live.provider.azure")}</option>
          <option value="qwen">{t("call.live.provider.qwen")}</option>
        </Select>
      </label>
      {provider === "azure" && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save({ azureEndpoint: endpoint.trim(), azureDeployment: deployment.trim() });
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium leading-[18px] text-ink">{t("call.live.azureEndpoint")}</span>
            <input
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={endpoint}
              placeholder="https://my-resource.openai.azure.com"
              onChange={(event) => setEndpoint(event.target.value)}
              className={FIELD}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium leading-[18px] text-ink">{t("call.live.azureDeployment")}</span>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={deployment}
              placeholder="gpt-live-1"
              onChange={(event) => setDeployment(event.target.value)}
              className={FIELD}
            />
          </label>
          <div className="text-[12px] leading-4 text-ink-secondary">{t("call.live.azureHint")}</div>
          {azureChanged && (
            <button
              type="submit"
              disabled={saving}
              className="ui-button ui-button-md self-end rounded-full"
            >
              {t("common.save")}
            </button>
          )}
        </form>
      )}
      {provider === "qwen" && <QwenProviderFields live={live} saving={saving} save={save} />}
      {error && <div className="text-[12px] text-danger">{error}</div>}
    </div>
  );
}

function QwenProviderFields({ live, saving, save }: { live: LiveSettings; saving: boolean; save(patch: ProviderPatch): Promise<LiveSettings | undefined> }) {
  const [draft, setDraft] = useState<Partial<Pick<LiveSettings, "qwenRegion" | "qwenWorkspace" | "qwenModel" | "qwenVoice">>>({});
  const region = draft.qwenRegion ?? live.qwenRegion ?? "cn-beijing";
  const workspace = draft.qwenWorkspace ?? live.qwenWorkspace ?? "";
  const model = draft.qwenModel ?? live.qwenModel ?? "qwen-audio-3.1-realtime-flash";
  const voice = draft.qwenVoice ?? (live.qwenVoice || "longanqian_v3.1");
  const [custom, setCustom] = useState(false);
  const voices = qwenVoicesForModel(model);
  const showCustom = custom || !voices.some((option) => option.id === voice);
  return <form data-qwen-live-settings className="flex flex-col gap-2" onSubmit={(event) => {
    event.preventDefault();
    const trimmedVoice = voice.trim();
    if (saving || !trimmedVoice) return;
    void save({ provider: "qwen", qwenRegion: region, qwenWorkspace: workspace.trim(), qwenModel: model, qwenVoice: trimmedVoice }).then((saved) => {
      if (!saved) return;
      setDraft({});
      setCustom(false);
    });
  }}>
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-ink-secondary">{t("call.live.qwen.region")}</span>
      <Select value={region} disabled={saving} aria-label={t("call.live.qwen.region")} onChange={(event) => setDraft((current) => ({ ...current, qwenRegion: event.target.value as typeof region }))}>
        <option value="cn-beijing">{t("call.live.qwen.region.beijing")}</option>
        <option value="ap-southeast-1">{t("call.live.qwen.region.singapore")}</option>
      </Select>
    </label>
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-ink-secondary">{t("call.live.qwen.workspace")}</span>
      <input className={FIELD} value={workspace} disabled={saving} autoComplete="off" spellCheck={false} maxLength={63}
        aria-label={t("call.live.qwen.workspace")} onChange={(event) => setDraft((current) => ({ ...current, qwenWorkspace: event.target.value }))} />
    </label>
    <div className="text-[12px] text-ink-tertiary">{t("call.live.qwen.workspaceHint")}</div>
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-ink-secondary">{t("call.live.qwen.model")}</span>
      <Select value={model} disabled={saving} aria-label={t("call.live.qwen.model")} onChange={(event) => setDraft((current) => ({ ...current, qwenModel: event.target.value as typeof model }))}>
        <option value="qwen-audio-3.1-realtime-flash">Qwen Audio 3.1 Realtime Flash</option>
        <option value="qwen-audio-3.1-realtime-plus">Qwen Audio 3.1 Realtime Plus</option>
      </Select>
    </label>
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-ink-secondary">{t("call.live.qwen.voice")}</span>
      <Select value={showCustom ? "custom" : voice} disabled={saving} aria-label={t("call.live.qwen.voice")} onChange={(event) => {
        const id = event.target.value;
        setCustom(id === "custom");
        setDraft((current) => ({ ...current, qwenVoice: id === "custom" ? voice : id }));
      }}>
        {voices.map((option) => <option key={option.id} value={option.id}>
          {option.name} · {option.gender ? `${option.gender} · ` : ""}{option.description} ({option.id})
        </option>)}
        <option value="custom">{t("call.live.qwen.voiceCustom")}</option>
      </Select>
    </label>
    {showCustom && <>
      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-ink-secondary">{t("call.live.qwen.voiceCustomId")}</span>
        <input className={FIELD} value={voice} disabled={saving} autoComplete="off" spellCheck={false} maxLength={80} required
          aria-label={t("call.live.qwen.voiceCustomId")} onChange={(event) => {
            setCustom(true);
            setDraft((current) => ({ ...current, qwenVoice: event.target.value }));
          }} />
      </label>
      <div className="text-[12px] text-ink-tertiary">{t("call.live.qwen.voiceCustomHint")}</div>
    </>}
    <div className="text-[12px] text-ink-tertiary">{t("call.live.qwen.voiceHint")}</div>
    <a className="text-[12px] text-accent hover:underline" href={QWEN_VOICE_SOURCES.catalog} target="_blank" rel="noreferrer">{t("call.live.qwen.voiceSource")}</a>
    <div className="text-[12px] text-warning">{t("call.live.qwen.limited")}</div>
    <div className="text-[12px] text-ink-tertiary">{t("call.live.qwen.cost")}</div>
    <button type="submit" disabled={saving || !voice.trim()} className="ui-button ui-button-primary self-start">{t("common.save")}</button>
  </form>;
}
