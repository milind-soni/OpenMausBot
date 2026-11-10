import { useState } from "react";

import { t } from "@/lib/i18n";
import { api, useStore } from "@/state/store";
import type { LiveProvider, LiveSettings } from "../../shared/wire";
import { Select } from "./Select";

type ProviderPatch = Partial<Pick<LiveSettings, "provider" | "azureEndpoint" | "azureDeployment">>;

const FIELD = "w-full rounded-lg border border-hairline bg-inset px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent/60";

export function LiveProviderSettings() {
  const { state, dispatch } = useStore();
  const live: LiveSettings = state.config?.live ?? { configured: false, voice: "", readTypedReplies: true, idleMinutes: 5 };
  const provider: LiveProvider = live.provider ?? "openai";
  const [endpoint, setEndpoint] = useState(live.azureEndpoint ?? "");
  const [deployment, setDeployment] = useState(live.azureDeployment ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const azureChanged = endpoint.trim() !== (live.azureEndpoint ?? "") || deployment.trim() !== (live.azureDeployment ?? "");

  const save = async (patch: ProviderPatch) => {
    setSaving(true);
    setError(null);
    try {
      const body = await api<{ live: LiveSettings }>("/api/live/settings", { method: "PATCH", body: JSON.stringify(patch) });
      if (state.config) dispatch({ type: "configStatus", config: { ...state.config, live: body.live } });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center justify-between gap-2">
        <span className="text-[13px] text-ink-secondary">{t("call.live.provider")}</span>
        <Select
          size="sm"
          value={provider}
          disabled={saving}
          onChange={(event) => void save({ provider: event.target.value as LiveProvider })}
        >
          <option value="openai">{t("call.live.provider.openai")}</option>
          <option value="azure">{t("call.live.provider.azure")}</option>
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
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-ink-secondary">{t("call.live.azureEndpoint")}</span>
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
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-ink-secondary">{t("call.live.azureDeployment")}</span>
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
          <div className="text-[12px] text-ink-tertiary">{t("call.live.azureHint")}</div>
          {azureChanged && (
            <button
              type="submit"
              disabled={saving}
              className="self-start rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              {t("common.save")}
            </button>
          )}
        </form>
      )}
      {error && <div className="text-[12px] text-danger">{error}</div>}
    </div>
  );
}
