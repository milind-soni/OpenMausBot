import { useState } from "react";

import { t } from "@/lib/i18n";
import { api, useStore } from "@/state/store";
import type { LiveProvider, LiveSettings } from "../../shared/wire";
import { Select } from "./Select";
import { KEY_FIELD } from "./keys/KeyRow";

type ProviderPatch = Partial<Pick<LiveSettings, "provider" | "azureEndpoint" | "azureDeployment">>;

const FIELD = KEY_FIELD;

/** `locked` holds the provider and Azure endpoint while a key save is pending; `onSaving` reports a pending change to them. */
export function LiveProviderSettings({ locked = false, onSaving }: { locked?: boolean; onSaving?: (saving: boolean) => void } = {}) {
  const { state, dispatch } = useStore();
  const live: LiveSettings = state.config?.live ?? { configured: false, voice: "", readTypedReplies: true, idleMinutes: 5 };
  const provider: LiveProvider = live.provider ?? "openai";
  const [endpoint, setEndpoint] = useState(live.azureEndpoint ?? "");
  const [deployment, setDeployment] = useState(live.azureDeployment ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const azureChanged = endpoint.trim() !== (live.azureEndpoint ?? "") || deployment.trim() !== (live.azureDeployment ?? "");

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
              disabled={saving || locked}
              className="ui-button ui-button-md self-end rounded-full"
            >
              {t("common.save")}
            </button>
          )}
        </form>
      )}
      {provider === "fish" && <div className="text-[12px] leading-4 text-ink-secondary">{t("call.live.fishHint")}</div>}
      {error && <div className="text-[12px] text-danger">{error}</div>}
    </div>
  );
}
