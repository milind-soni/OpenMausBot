import { z } from "zod";
import type { LiveEndpoint } from "./live-call.ts";

export const QWEN_MODEL = "qwen-audio-3.1-realtime-flash";
export const QWEN_VOICE = "longanqian_v3.1";
export const QWEN_NEEDS_KEY = "Qwen Live needs its own key for the selected region and workspace. Add it in Call settings.";
export const qwenRegionSchema = z.enum(["cn-beijing", "ap-southeast-1"]);
export const qwenWorkspaceSchema = z.string().trim().max(63).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)?$/);
export const qwenModelSchema = z.enum([QWEN_MODEL, "qwen-audio-3.1-realtime-plus"]);
export const qwenVoiceSchema = z.string().trim().min(1).max(80).regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/);
export const qwenConfigSchema = z.object({
  enabled: z.boolean().optional(),
  key: z.string().max(4096).optional(),
  keyFor: z.string().max(300).optional(),
  region: qwenRegionSchema.optional(),
  workspace: qwenWorkspaceSchema.optional(),
  model: qwenModelSchema.optional(),
  voice: qwenVoiceSchema.optional(),
}).strict();
export type QwenLiveConfig = z.infer<typeof qwenConfigSchema>;

export function qwenLiveEndpoint(qwen: QwenLiveConfig | undefined): LiveEndpoint | null {
  const checked = qwenConfigSchema.safeParse(qwen ?? {});
  if (!checked.success) return null;
  const { region = "cn-beijing", workspace = "", model = QWEN_MODEL } = checked.data;
  const host = workspace ? `${workspace}.${region}.maas.aliyuncs.com`
    : region === "cn-beijing" ? "dashscope.aliyuncs.com" : "dashscope-intl.aliyuncs.com";
  return { provider: "qwen", apiBase: `wss://${host}/api-ws/v1/realtime`, model };
}

export function qwenKeyTarget(qwen: QwenLiveConfig | undefined): string | null {
  const endpoint = qwenLiveEndpoint(qwen);
  return endpoint ? `qwen:${new URL(endpoint.apiBase).host}` : null;
}

export function usableQwenKey(qwen: QwenLiveConfig | undefined): string | undefined {
  const key = qwen?.key?.trim();
  return key && qwen?.keyFor === qwenKeyTarget(qwen) ? key : undefined;
}

export function qwenSavePatch(current: QwenLiveConfig | undefined, patch: QwenLiveConfig): QwenLiveConfig {
  const { keyFor: _untrusted, ...asked } = patch;
  const next = { ...current, ...asked };
  const target = qwenKeyTarget(next);
  if (!target) throw Object.assign(new Error("Invalid Qwen Live target."), { status: 400 });
  if (asked.key?.trim()) return { ...next, key: asked.key.trim(), keyFor: target };
  return asked.key !== undefined || target !== qwenKeyTarget(current)
    ? { ...next, key: "", keyFor: "nowhere" } : { ...next, keyFor: current?.keyFor };
}
