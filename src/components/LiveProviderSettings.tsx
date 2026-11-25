import { useState } from "react";

import { t } from "@/lib/i18n";
import { api, useStore } from "@/state/store";
import type { LiveProvider, LiveSettings } from "../../shared/wire";
import { Select } from "./Select";
import { KEY_FIELD } from "./keys/KeyRow";

type ProviderPatch = Partial<Pick<LiveSettings, "provider" | "azureEndpoint" | "azureDeployment" | "customEndpoint" | "customModel">>;

const FIELD = KEY_FIELD;

/** `locked` holds the provider and endpoint while a key save is pending; `onSaving` reports a pending change to them. */
export function LiveProviderSettings({ locked = false, onSaving }: { locked?: boolean; onSaving?: (saving: boolean) => void } = {}) {
  const { state, dispatch } = useStore();
  const live: LiveSettings = state.config?.live ?? { configured: false, voice: "", readTypedReplies: true, idleMinutes: 5 };
  const provider: LiveProvider = live.provider ?? "openai";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (patch: ProviderPatch) => {
    if (locked) return;
    setSaving(true);
    onSaving?.(true);
    setError(null);
    try {
      const body = await api<{ live: LiveSettings }>("/api/live/settings", { method: "PATCH", body: JSON.stringify(patch) });
      if (state.config) dispatch({ type: "configStatus", config: { ...state.config, live: body.live } });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
      onSaving?.(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium leading-[18px] text-ink">{t("call.live.provider")}</span>
        <Select
          size="sm"
          value={provider}
          disabled={saving || locked}
          onChange={(event) => void save({ provider: event.target.value as LiveProvider })}
        >
          <option value="openai">{t("call.live.provider.openai")}</option>
          <option value="azure">{t("call.live.provider.azure")}</option>
          <option value="fish">{t("call.live.provider.fish")}</option>
          <option value="gemini">{t("call.live.provider.gemini")}</option>
          <option value="elevenlabs">{t("call.live.provider.elevenlabs")}</option>
          <option value="custom">{t("call.live.provider.custom")}</option>
        </Select>
      </label>
      {(provider === "azure" || provider === "custom") && (
        <EndpointForm key={provider} custom={provider === "custom"} live={live} disabled={saving || locked} save={save} />
      )}
      {provider === "fish" && <div className="text-[12px] leading-4 text-ink-secondary">{t("call.live.fishHint")}</div>}
      {provider === "gemini" && <div className="text-[12px] leading-4 text-ink-secondary">{t("call.live.geminiHint")}</div>}
      {provider === "elevenlabs" && <div className="text-[12px] leading-4 text-ink-secondary">{t("call.live.elevenLabsHint")}</div>}
      {error && <div className="text-[12px] text-danger">{error}</div>}
    </div>
  );
}

/** The address and model name of an Azure resource, or of a custom OpenAI-compatible endpoint. */
function EndpointForm({ custom, live, disabled, save }: { custom: boolean; live: LiveSettings; disabled: boolean; save: (patch: ProviderPatch) => Promise<void> }) {
  const savedEndpoint = (custom ? live.customEndpoint : live.azureEndpoint) ?? "";
  const savedModel = (custom ? live.customModel : live.azureDeployment) ?? "";
  const [endpoint, setEndpoint] = useState(savedEndpoint);
  const [model, setModel] = useState(savedModel);
  const changed = endpoint.trim() !== savedEndpoint || model.trim() !== savedModel;

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save(custom ? { customEndpoint: endpoint.trim(), customModel: model.trim() } : { azureEndpoint: endpoint.trim(), azureDeployment: model.trim() });
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium leading-[18px] text-ink">{t(custom ? "call.live.customEndpoint" : "call.live.azureEndpoint")}</span>
        <input
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={endpoint}
          placeholder={custom ? "https://gateway.example.com/v1" : "https://my-resource.openai.azure.com"}
          onChange={(event) => setEndpoint(event.target.value)}
          className={FIELD}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium leading-[18px] text-ink">{t(custom ? "call.live.customModel" : "call.live.azureDeployment")}</span>
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={model}
          placeholder="gpt-live-1"
          onChange={(event) => setModel(event.target.value)}
          className={FIELD}
        />
      </label>
      <div className="text-[12px] leading-4 text-ink-secondary">{t(custom ? "call.live.customHint" : "call.live.azureHint")}</div>
      {changed && (
        <button
          type="submit"
          disabled={disabled}
          className="ui-button ui-button-md self-end rounded-full"
        >
          {t("common.save")}
        </button>
      )}
    </form>
  );
}
