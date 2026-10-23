/** The server's default instances by id, with their driver kinds, plus `gemini`, which an enterprise licence restores. */
export const BUILT_IN_INSTANCE_DRIVERS: Readonly<Record<string, string>> = {
  grok: "grokAgent", kimi: "kimiAgent", droid: "droidAgent", cursor: "cursorAgent", claude: "claudeAgent", codex: "codex",
  chatgpt: "codex", antigravity: "antigravityAgent", opencodeGo: "opencodeGo", openaiCompat: "openai-compat",
  mistral: "mistral", cerebras: "cerebras", groq: "groq", meta: "meta", museCode: "museCode", deepseek: "deepseekAgent", openai: "openai-compat",
  claudeApi: "claudeAgent", xaiApi: "grok", openrouter: "openai-compat", qwen: "qwenAgent", hermes: "hermesAgent",
  cline: "clineAgent", pi: "piAgent", gemini: "geminiAgent",
};
