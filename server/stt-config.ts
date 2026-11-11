import { z } from "zod";
import { isEndpointStt, STT_PRESETS, STT_PROVIDERS, type SttConfig, type SttStatus } from "../shared/stt.ts";
import type { AppConfig } from "./config.ts";

function validBaseUrl(value: string): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** `baseUrl` is an OpenAI-compatible API root; one without a path gets `/v1`. `key` is required only by the OpenAI and Groq presets; no chat credential is reused. */
export const sttConfigSchema = z.object({
  provider: z.enum(STT_PROVIDERS).optional(),
  baseUrl: z.string().trim().max(2048).refine(validBaseUrl, "Use an http:// or https:// API base URL without credentials, query or fragment.").optional(),
  model: z.string().trim().max(200).optional(),
  key: z.string().trim().max(4096).optional(),
  keyFor: z.string().max(2056).optional(),
});

export function sttBaseUrl(config: SttConfig | undefined): string {
  const root = (config?.baseUrl?.trim() || STT_PRESETS.openai.baseUrl).replace(/\/+$/, "");
  return URL.parse(root)?.pathname === "/" ? `${root}/v1` : root;
}

function sttKeyTarget(config: SttConfig | undefined): string {
  return sttBaseUrl(config);
}

export function sttSavePatch(current: SttConfig | undefined, patch: SttConfig): SttConfig {
  const { keyFor: _fromRequest, ...asked } = patch;
  const target = sttKeyTarget({ ...current, ...asked });
  if (asked.key?.trim()) return { ...asked, keyFor: target };
  return target !== sttKeyTarget(current) || asked.key !== undefined ? { ...asked, key: "", keyFor: "nowhere" } : asked;
}

const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/** Security: a key travels only over https, or plain http to this computer. */
export function sttKeySendable(config: SttConfig | undefined): boolean {
  const url = URL.parse(sttBaseUrl(config));
  return url?.protocol === "https:" || (url?.protocol === "http:" && LOOPBACK_HOST.test(url.hostname));
}

export const STT_INSECURE_KEY_ERROR = "A key can only be sent to an https:// address or a server on this computer.";

export function usableSttKey(config: SttConfig | undefined): string | undefined {
  const target = config?.keyFor ?? sttKeyTarget(config);
  return target === sttKeyTarget(config) && sttKeySendable(config) ? config?.key?.trim() || undefined : undefined;
}

export function sttConfigWithEnv(config: SttConfig | undefined, env: NodeJS.ProcessEnv = process.env): SttConfig {
  return { ...config, ...(env.OMB_STT_API_KEY !== undefined ? { key: env.OMB_STT_API_KEY } : {}) };
}

const KEYED_ROOTS = new Set<string>([STT_PRESETS.openai.baseUrl, STT_PRESETS.groq.baseUrl]);

export function sttNeedsKey(cfg: SttConfig | undefined): boolean {
  return KEYED_ROOTS.has(sttBaseUrl(cfg));
}

export function sttStatus(cfg: Pick<AppConfig, "stt" | "tts">): SttStatus {
  const provider = cfg.stt?.provider ?? "auto";
  const keyConfigured = Boolean(usableSttKey(cfg.stt));
  const baseUrl = sttBaseUrl(cfg.stt);
  const model = cfg.stt?.model?.trim() ?? "";
  const endpointReady = Boolean(model) && (keyConfigured || !sttNeedsKey(cfg.stt));
  return {
    provider, baseUrl, model, keyConfigured,
    configured: isEndpointStt(provider) ? endpointReady : Boolean(cfg.tts?.fishKey?.trim()),
    ...(isEndpointStt(provider) && cfg.stt?.key?.trim() && !keyConfigured ? { keyIgnored: true as const } : {}),
  };
}
