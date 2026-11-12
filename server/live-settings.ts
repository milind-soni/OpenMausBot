import type { LiveKeySource, LiveSettings } from "../shared/wire.ts";
import { saveConfig, syncCredentialEnv, type AppConfig } from "./config.ts";
import { azureLiveEndpoint, LIVE_NEEDS_AZURE, LIVE_NEEDS_FISH, LIVE_NEEDS_KEY, openAiLiveEndpoint, type LiveEndpoint } from "./live-call.ts";
import { liveSavePatch, usableLiveKey, type LiveConfig as LiveConfigSection } from "./live-config.ts";
import { fishLiveEndpoint } from "./live-fish.ts";

export const LIVE_IDLE_MINUTES_DEFAULT = 5;

type LiveConfig = Pick<AppConfig, "live" | "openai">;

/** A saved Live key goes only to the provider and host it was saved for (`usableLiveKey`), and the OpenAI API key only ever to OpenAI. */
export function liveCallKey(cfg: LiveConfig): { key: string; source: LiveKeySource } | null {
  const live = usableLiveKey(cfg.live);
  if (live) return { key: live, source: "live" };
  if (cfg.live?.provider === "azure" || cfg.live?.provider === "fish") return null;
  const openai = cfg.openai?.key?.trim();
  return openai ? { key: openai, source: "openai" } : null;
}

/** null when Azure is chosen but its endpoint or deployment is missing or not valid, or Fish Audio without a valid agent id. */
export function liveCallEndpoint(cfg: LiveConfig, env: NodeJS.ProcessEnv = process.env): LiveEndpoint | null {
  if (cfg.live?.provider === "azure") return azureLiveEndpoint(cfg.live.azureEndpoint, cfg.live.azureDeployment);
  if (cfg.live?.provider === "fish") return fishLiveEndpoint(cfg.live.fishAgentId, env);
  return openAiLiveEndpoint(env);
}

export function liveSetupProblem(cfg: LiveConfig): string | null {
  const provider = cfg.live?.provider;
  const missing = provider === "azure" ? LIVE_NEEDS_AZURE : provider === "fish" ? LIVE_NEEDS_FISH : LIVE_NEEDS_KEY;
  if (!liveCallKey(cfg)) return missing;
  return liveCallEndpoint(cfg) ? null : missing;
}

/** The environment follows the save, as for PUT /api/config: loadConfig prefers it over the file. */
export function saveLiveSettings(cfg: Pick<AppConfig, "live">, patch: LiveConfigSection): void {
  const live = liveSavePatch(cfg.live, patch);
  saveConfig({ live });
  syncCredentialEnv({ live });
}

/** What a call start reads, once: its key, endpoint and provider all come from this one reading. */
export function liveCallSettings(cfg: AppConfig) {
  return { key: liveCallKey(cfg)?.key ?? "", endpoint: liveCallEndpoint(cfg), setupProblem: liveSetupProblem(cfg), ...liveSettingsFor(cfg) };
}

/** A caller without the admin scope learns which service calls use, not which Azure resource or Fish agent. */
export function liveSettingsForClient({ azureEndpoint: _endpoint, azureDeployment: _deployment, fishAgentId: _agent, ...settings }: LiveSettings): LiveSettings {
  return settings;
}

export function liveSettingsFor(cfg: AppConfig): LiveSettings {
  const minutes = cfg.live?.idleMinutes;
  const key = liveCallKey(cfg);
  const provider = cfg.live?.provider;
  return {
    configured: liveSetupProblem(cfg) === null,
    ...(key ? { keySource: key.source } : {}),
    ...(provider === "azure" || provider === "fish" ? { provider } : {}),
    ...(cfg.live?.azureEndpoint ? { azureEndpoint: cfg.live.azureEndpoint } : {}),
    ...(cfg.live?.azureDeployment ? { azureDeployment: cfg.live.azureDeployment } : {}),
    ...(cfg.live?.fishAgentId ? { fishAgentId: cfg.live.fishAgentId } : {}),
    voice: cfg.live?.voice ?? "",
    readTypedReplies: cfg.live?.readTypedReplies ?? true,
    idleMinutes: Number.isInteger(minutes) && minutes! >= 1 && minutes! <= 60 ? minutes! : LIVE_IDLE_MINUTES_DEFAULT,
  };
}
