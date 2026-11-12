import type { LiveKeySource, LiveSettings, LiveSettingsPatch } from "../shared/wire.ts";
import { saveConfig, syncCredentialEnv, type AppConfig } from "./config.ts";
import { azureLiveEndpoint, LIVE_NEEDS_AZURE, LIVE_NEEDS_KEY, openAiLiveEndpoint, type LiveEndpoint } from "./live-call.ts";
import { liveSavePatch, usableLiveKey, type LiveConfig as LiveConfigSection } from "./live-config.ts";
import { QWEN_MODEL, QWEN_NEEDS_KEY, QWEN_VOICE, qwenLiveEndpoint, usableQwenKey } from "./qwen-live-config.ts";

export const LIVE_IDLE_MINUTES_DEFAULT = 5;

type LiveConfig = Pick<AppConfig, "live" | "openai">;

/** A saved Live key goes only to the provider and host it was saved for (`usableLiveKey`), and the OpenAI API key only ever to OpenAI. */
export function liveCallKey(cfg: LiveConfig): { key: string; source: LiveKeySource } | null {
  if (cfg.live?.qwen?.enabled) {
    const key = usableQwenKey(cfg.live.qwen);
    return key ? { key, source: "live" } : null;
  }
  const live = usableLiveKey(cfg.live);
  if (live) return { key: live, source: "live" };
  if (cfg.live?.provider === "azure") return null;
  const openai = cfg.openai?.key?.trim();
  return openai ? { key: openai, source: "openai" } : null;
}

/** null when Azure is chosen but its endpoint or deployment is missing or not valid. */
export function liveCallEndpoint(cfg: LiveConfig, env: NodeJS.ProcessEnv = process.env): LiveEndpoint | null {
  if (cfg.live?.qwen?.enabled) return qwenLiveEndpoint(cfg.live.qwen);
  return cfg.live?.provider === "azure"
    ? azureLiveEndpoint(cfg.live.azureEndpoint, cfg.live.azureDeployment)
    : openAiLiveEndpoint(env);
}

export function liveSetupProblem(cfg: LiveConfig): string | null {
  if (cfg.live?.qwen?.enabled) return liveCallKey(cfg) && liveCallEndpoint(cfg) ? null : QWEN_NEEDS_KEY;
  const azure = cfg.live?.provider === "azure";
  if (!liveCallKey(cfg)) return azure ? LIVE_NEEDS_AZURE : LIVE_NEEDS_KEY;
  return liveCallEndpoint(cfg) ? null : LIVE_NEEDS_AZURE;
}

/** The environment follows the save, as for PUT /api/config: loadConfig prefers it over the file. */
export function liveSettingsSavePatch(current: LiveConfigSection | undefined, patch: LiveSettingsPatch): LiveConfigSection {
  const { provider, qwenRegion, qwenWorkspace, qwenModel, qwenVoice, ...native } = patch;
  const qwen = {
    ...(provider !== undefined ? { enabled: provider === "qwen" } : {}),
    ...(qwenRegion !== undefined ? { region: qwenRegion } : {}),
    ...(qwenWorkspace !== undefined ? { workspace: qwenWorkspace } : {}),
    ...(qwenModel !== undefined ? { model: qwenModel } : {}),
    ...(qwenVoice !== undefined ? { voice: qwenVoice } : {}),
  };
  return liveSavePatch(current, { ...native,
    ...(provider && provider !== "qwen" ? { provider } : {}),
    ...(Object.keys(qwen).length ? { qwen } : {}),
  });
}

export function saveLiveSettings(cfg: Pick<AppConfig, "live">, patch: LiveSettingsPatch): void {
  const live = liveSettingsSavePatch(cfg.live, patch);
  saveConfig({ live });
  syncCredentialEnv({ live });
}

/** What a call start reads, once: its key, endpoint and provider all come from this one reading. */
export function liveCallSettings(cfg: AppConfig) {
  return { key: liveCallKey(cfg)?.key ?? "", endpoint: liveCallEndpoint(cfg), setupProblem: liveSetupProblem(cfg), ...liveSettingsFor(cfg) };
}

/** A caller without the admin scope learns which service calls use, not which Azure resource. */
export function liveSettingsForClient({ azureEndpoint: _endpoint, azureDeployment: _deployment, ...settings }: LiveSettings): LiveSettings {
  return settings;
}

export function liveSettingsFor(cfg: AppConfig): LiveSettings {
  const minutes = cfg.live?.idleMinutes;
  const key = liveCallKey(cfg);
  const azure = cfg.live?.provider === "azure";
  return {
    configured: liveSetupProblem(cfg) === null,
    ...(key ? { keySource: key.source } : {}),
    ...(cfg.live?.qwen?.enabled ? { provider: "qwen" as const } : azure ? { provider: "azure" as const } : {}),
    ...(cfg.live?.qwen ? {
      qwenRegion: cfg.live.qwen.region ?? "cn-beijing", qwenWorkspace: cfg.live.qwen.workspace ?? "",
      qwenModel: cfg.live.qwen.model ?? QWEN_MODEL, qwenVoice: cfg.live.qwen.voice ?? QWEN_VOICE,
      qwenKeyConfigured: Boolean(usableQwenKey(cfg.live.qwen)),
    } : {}),
    ...(cfg.live?.azureEndpoint ? { azureEndpoint: cfg.live.azureEndpoint } : {}),
    ...(cfg.live?.azureDeployment ? { azureDeployment: cfg.live.azureDeployment } : {}),
    voice: cfg.live?.voice ?? "",
    readTypedReplies: cfg.live?.readTypedReplies ?? true,
    idleMinutes: Number.isInteger(minutes) && minutes! >= 1 && minutes! <= 60 ? minutes! : LIVE_IDLE_MINUTES_DEFAULT,
  };
}
