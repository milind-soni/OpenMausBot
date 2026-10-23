// Security: every value a product event carries is a count, a boolean, or a word from one of these lists. A key, a name,
// an id, a URL or any other string the person or a server chose becomes "other" before it can reach track().
import { BOT_ROLES } from "@/lib/bot-roles";
import { BUILT_IN_INSTANCE_DRIVERS } from "@/lib/built-in-instances";
import { CURATED_CONNECTOR_SLUGS } from "../../shared/connector-curated";
import type { CredentialTargetId } from "../../shared/credential-request";

export type PropValue = string | number | boolean | readonly string[];
export type EventProps = Record<string, PropValue>;

export function allow<const T extends string>(value: unknown, list: readonly T[]): T | "other" {
  return typeof value === "string" && new Set<string>(list).has(value) ? value as T : "other";
}

export const KEY_PROVIDER = [
  "anthropic", "openai", "openrouter", "openai_compat", "xai", "mistral", "cerebras", "groq", "meta", "boat", "composio",
  "opencode_go", "custom_endpoint", "elevenlabs", "fish_audio", "jev", "openrouter_decider", "openai_image", "custom_image",
  "openai_live", "onepassword", "treg", "deepseek",
] as const;
export type KeyProvider = (typeof KEY_PROVIDER)[number];

export const SECTION_PROVIDER = {
  composio: "composio", box: "boat", opencodeGo: "opencode_go", anthropic: "anthropic", openai: "openai",
  openrouter: "openrouter", openaiCompat: "openai_compat", xai: "xai", mistral: "mistral", cerebras: "cerebras",
  groq: "groq", meta: "meta", treg: "treg", deepseek: "deepseek",
} as const satisfies Record<string, KeyProvider>;

const CREDENTIAL_PROVIDER = new Map<string, KeyProvider>(Object.entries({
  boxToken: "boat", xaiApiKey: "xai", opencodeGoApiKey: "opencode_go", ttsKey: "elevenlabs", fishAudioKey: "fish_audio",
  openaiImageApiKey: "openai_image", onePasswordToken: "onepassword",
} satisfies Record<CredentialTargetId, KeyProvider>));

export function credentialProvider(target: unknown): KeyProvider | "other" {
  return (typeof target === "string" && CREDENTIAL_PROVIDER.get(target)) || "other";
}

export const ENGINE = [
  "claude", "codex", "gemini", "cursor", "opencode", "qwen", "hermes", "cline", "custom_acp", "pi", "openai_compat", "grok",
  "grok_api", "kimi", "droid", "antigravity", "minimax", "mistral", "cerebras", "groq", "meta", "muse_code", "deepseek",
] as const;
export type Engine = (typeof ENGINE)[number];

const ENGINE_BY_DRIVER = new Map<string, Engine>(Object.entries({
  claudeAgent: "claude", codex: "codex", geminiAgent: "gemini", cursorAgent: "cursor", opencodeGo: "opencode",
  qwenAgent: "qwen", hermesAgent: "hermes", clineAgent: "cline", customAcp: "custom_acp", piAgent: "pi",
  "openai-compat": "openai_compat", grokAgent: "grok", grok: "grok_api", kimiAgent: "kimi", droidAgent: "droid",
  antigravityAgent: "antigravity", minimax: "minimax", mistral: "mistral", cerebras: "cerebras", groq: "groq",
  meta: "meta", museCode: "muse_code", deepseekAgent: "deepseek",
} satisfies Record<string, Engine>));

export function engineForDriver(driverKind: unknown): Engine | "other" {
  return (typeof driverKind === "string" && ENGINE_BY_DRIVER.get(driverKind)) || "other";
}

const BUILT_IN_DRIVER = new Map(Object.entries(BUILT_IN_INSTANCE_DRIVERS));

/** Never the instance id: added accounts carry a random id, and config.json lets people name instances. */
export function engineSlug(
  instances: ReadonlyArray<{ instanceId: string; driverKind: string }>,
  instanceId: unknown,
): Engine | "other" {
  if (typeof instanceId !== "string") return "other";
  const instance = instances.find((candidate) => candidate.instanceId === instanceId);
  return engineForDriver(instance ? instance.driverKind : BUILT_IN_DRIVER.get(instanceId));
}

export const APP: readonly string[] = CURATED_CONNECTOR_SLUGS;
export const BOT_TEMPLATE: readonly string[] = BOT_ROLES.map((role) => role.id);
export const CLOUD_TIER = ["starter", "personal", "pro", "max"] as const;

export const KEY_VIA = ["settings", "computer_panel", "chat_request", "apps"] as const;
export type KeyVia = (typeof KEY_VIA)[number];
export const KEY_RESULT = ["ok", "rejected", "unverified", "error"] as const;
export type KeyResult = (typeof KEY_RESULT)[number];
export const SIGN_IN_ENGINE = ["claude", "codex", "grok"] as const;
export const SIGN_IN_METHOD = ["code", "device_code", "browser"] as const;
export type SignInMethod = (typeof SIGN_IN_METHOD)[number];
export const BOT_SOURCE = ["blank", "template", "preset"] as const;
export type BotSource = (typeof BOT_SOURCE)[number];
export const CONNECTOR_RESULT = ["connected", "failed", "expired", "timed_out"] as const;
export type ConnectorResult = (typeof CONNECTOR_RESULT)[number];
export const CALL_MODE = ["turns", "live"] as const;
export const ROOM_MODE = ["chat", "goal"] as const;
export const CLOUD_COMPUTER_SOURCE = ["own_key", "included", "none"] as const;
export const VOICE = ["elevenlabs", "fish", "system", "chatterbox", "xai", "none"] as const;
export const DECIDER = ["jev", "openrouter", "off"] as const;
export const CONNECTORS_MODE = ["managed", "self_hosted", "unavailable"] as const;
export const LOCAL_VM_MODE = ["shared", "per_bot", "pool"] as const;
export const TRIAL_CREDIT = ["active", "used_up", "ended", "none"] as const;
export const CLOUD_PLAN = ["starter", "personal", "pro", "max", "other", "none", "unknown"] as const;
export const EDITION = ["oss", "enterprise"] as const;
export const PLATFORM = ["desktop", "browser"] as const;
