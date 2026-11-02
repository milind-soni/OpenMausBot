import type { LiveKeySource, LiveSettings } from "../shared/wire.ts";
import type { AppConfig } from "./config.ts";
import { azureLiveEndpoint, LIVE_NEEDS_AZURE, LIVE_NEEDS_KEY, openAiLiveEndpoint, type LiveEndpoint } from "./live-call.ts";

export const LIVE_IDLE_MINUTES_DEFAULT = 5;

type LiveConfig = Pick<AppConfig, "live" | "openai">;

/** An Azure resource key is never stood in for by the OpenAI API key, nor the other way round. */
export function liveCallKey(cfg: LiveConfig): { key: string; source: LiveKeySource } | null {
  const live = cfg.live?.key?.trim();
  if (live) return { key: live, source: "live" };
  if (cfg.live?.provider === "azure") return null;
  const openai = cfg.openai?.key?.trim();
  return openai ? { key: openai, source: "openai" } : null;
}

/** null when Azure is chosen but its endpoint or deployment is missing or not valid. */
export function liveCallEndpoint(cfg: LiveConfig, env: NodeJS.ProcessEnv = process.env): LiveEndpoint | null {
  return cfg.live?.provider === "azure"
    ? azureLiveEndpoint(cfg.live.azureEndpoint, cfg.live.azureDeployment)
    : openAiLiveEndpoint(env);
}

export function liveSetupProblem(cfg: LiveConfig): string | null {
  const azure = cfg.live?.provider === "azure";
  if (!liveCallKey(cfg)) return azure ? LIVE_NEEDS_AZURE : LIVE_NEEDS_KEY;
  return liveCallEndpoint(cfg) ? null : LIVE_NEEDS_AZURE;
}

export function liveSettingsFor(cfg: AppConfig): LiveSettings {
  const minutes = cfg.live?.idleMinutes;
  const key = liveCallKey(cfg);
  const azure = cfg.live?.provider === "azure";
  return {
    configured: liveSetupProblem(cfg) === null,
    ...(key ? { keySource: key.source } : {}),
    ...(azure ? { provider: "azure" as const } : {}),
    ...(cfg.live?.azureEndpoint ? { azureEndpoint: cfg.live.azureEndpoint } : {}),
    ...(cfg.live?.azureDeployment ? { azureDeployment: cfg.live.azureDeployment } : {}),
    voice: cfg.live?.voice ?? "",
    readTypedReplies: cfg.live?.readTypedReplies ?? true,
    idleMinutes: Number.isInteger(minutes) && minutes! >= 1 && minutes! <= 60 ? minutes! : LIVE_IDLE_MINUTES_DEFAULT,
  };
}
