// The engine instances a fresh install starts with, and the ones an existing product fleet gains.
// instanceConfigs (config.ts) copies every entry before it changes one.
import type { InstanceConfigMap } from "./contracts.ts";

export const OPENAI_API_INSTANCE = "openai";
export const OPENROUTER_API_INSTANCE = "openrouter";
export const XAI_API_INSTANCE = "xaiApi";
export const CLAUDE_API_INSTANCE = "claudeApi";
export const API_KEY_FLEET: InstanceConfigMap = {
  [OPENAI_API_INSTANCE]: {
    driver: "openai-compat", displayName: "OpenAI", access: "api", icon: { kind: "preset", preset: "openai" },
    config: { url: "https://api.openai.com/v1", apiKeyEnv: "OMB_OPENAI_API_KEY", catalog: "openai" },
  },
  [CLAUDE_API_INSTANCE]: {
    driver: "claudeAgent", displayName: "Claude (API key)", access: "api", icon: { kind: "preset", preset: "anthropic" },
    config: { requireApiKey: true },
  },
  [XAI_API_INSTANCE]: { driver: "grok", displayName: "xAI", access: "api", icon: { kind: "preset", preset: "xai" } },
  [OPENROUTER_API_INSTANCE]: {
    driver: "openai-compat", displayName: "OpenRouter", access: "api", icon: { kind: "preset", preset: "openrouter" },
    config: { url: "https://openrouter.ai/api/v1", apiKeyEnv: "OMB_OPENROUTER_API_KEY" },
  },
};

// Google retired Gemini CLI for the free/Pro/Ultra tiers on 2026-06-18; enterprise licences restore it with
// `{"instances": {"gemini": {"driver": "geminiAgent"}}}`.
export const DEFAULT_FLEET: InstanceConfigMap = {
  grok: { driver: "grokAgent" },
  kimi: { driver: "kimiAgent" },
  droid: { driver: "droidAgent" },
  cursor: { driver: "cursorAgent" },
  githubCopilot: { driver: "copilotAgent" },
  claude: { driver: "claudeAgent" },
  codex: { driver: "codex" },
  chatgpt: { driver: "codex", displayName: "ChatGPT plan", config: { authMode: "chatgpt-plan" } },
  antigravity: { driver: "antigravityAgent" },
  opencodeGo: { driver: "opencodeGo" },
  openaiCompat: { driver: "openai-compat" },
  mistral: { driver: "mistral" },
  cerebras: { driver: "cerebras" },
  groq: { driver: "groq" },
  meta: { driver: "meta" },
  deepseek: { driver: "deepseekAgent" },
  museCode: { driver: "museCode" },
  ...API_KEY_FLEET,
  qwen: { driver: "qwenAgent" },
  hermes: { driver: "hermesAgent" },
  cline: { driver: "clineAgent" },
  pi: { driver: "piAgent" },
};

const CUSTOM_ONLY = {
  qwen: { driver: "qwenAgent" },
  hermes: { driver: "hermesAgent" },
  cline: { driver: "clineAgent" },
  pi: { driver: "piAgent" },
} as const;

/** Added to a saved fleet that holds a product engine (claude, grok or codex), when it lacks them. */
export const PRODUCT_FLEET_ADDITIONS = {
  chatgpt: { driver: "codex", displayName: "ChatGPT plan", config: { authMode: "chatgpt-plan" } },
  cursor: { driver: "cursorAgent" },
  githubCopilot: { driver: "copilotAgent" },
  openaiCompat: { driver: "openai-compat" },
  mistral: { driver: "mistral" },
  cerebras: { driver: "cerebras" },
  groq: { driver: "groq" },
  meta: { driver: "meta" },
  deepseek: { driver: "deepseekAgent" },
  museCode: { driver: "museCode" },
  ...API_KEY_FLEET,
  ...CUSTOM_ONLY,
} as const;
