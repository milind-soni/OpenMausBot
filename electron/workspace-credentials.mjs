import fs from "node:fs";

export const WORKSPACE_CREDENTIALS = [
  { section: "openai", field: "key", name: "openaiApiKey", env: "OMB_OPENAI_API_KEY" },
  { section: "anthropic", field: "key", name: "anthropicApiKey", env: "OMB_ANTHROPIC_API_KEY" },
  { section: "openrouter", field: "key", name: "openrouterApiKey", env: "OMB_OPENROUTER_API_KEY" },
  { section: "mistral", field: "key", name: "mistralApiKey", env: "MISTRAL_API_KEY" },
  { section: "cerebras", field: "key", name: "cerebrasApiKey", env: "CEREBRAS_API_KEY" },
  { section: "groq", field: "key", name: "groqApiKey", env: "OMB_GROQ_API_KEY" },
  { section: "greenference", field: "key", name: "greenferenceApiKey", env: "OMB_GREENFERENCE_API_KEY" },
  { section: "modelgo", field: "key", name: "modelgoApiKey", env: "OMB_MODELGO_API_KEY" },
  { section: "meta", field: "key", name: "metaApiKey", env: "OMB_META_API_KEY" },
  { section: "deepseek", field: "key", name: "deepseekApiKey", env: "OMB_DEEPSEEK_API_KEY" },
  { section: "openaiCompat", field: "key", name: "openaiCompatApiKey", env: "OPENAI_COMPAT_API_KEY" },
  { section: "xai", field: "key", name: "xaiApiKey", env: "XAI_API_KEY" },
  { section: "box", field: "token", name: "boxToken", env: "BOX_TOKEN" },
  { section: "tts", field: "key", name: "ttsKey", env: "OMB_TTS_KEY" },
  { section: "tts", field: "fishKey", name: "fishAudioKey", env: "OMB_FISH_AUDIO_API_KEY" },
  { section: "tts", field: "geminiKey", name: "geminiTtsKey", env: "OMB_GEMINI_API_KEY" },
  { section: "decider", field: "key", name: "jevApiKey", env: "OMB_JEV_API_KEY" },
  { section: "decider", field: "openrouterKey", name: "openrouterDeciderKey", env: "OMB_OPENROUTER_DECIDER_KEY" },
  { section: "decider", field: "workersAiToken", name: "workersAiToken", env: "OMB_WORKERS_AI_TOKEN" },
  { section: "imageGen", field: "key", name: "openaiImageApiKey", env: "OMB_OPENAI_IMAGE_KEY" },
  { section: "imageGen", field: "customApiKey", name: "customImageApiKey", env: "OMB_CUSTOM_IMAGE_KEY" },
  { section: "imageGen", field: "geminiKey", name: "geminiImageApiKey", env: "OMB_GEMINI_IMAGE_KEY" },
  { section: "live", field: "key", name: "openaiLiveKey", env: "OMB_OPENAI_LIVE_KEY" },
  { section: "live", subsection: "qwen", field: "key", name: "qwenLiveKey", env: "OMB_QWEN_LIVE_KEY" },
  { section: "treg", field: "key", name: "tregApiKey", env: "OMB_TREG_KEY" },
  { section: "postiz", field: "key", name: "postizApiKey", env: "OMB_POSTIZ_API_KEY" },
  { section: "opencodeGo", field: "apiKey", name: "opencodeGoApiKey", env: "OPENCODE_API_KEY" },
];

/** Moves plaintext secrets into the store and deletes the field. "" never drops a stored secret: every packaged
 * credential save writes an empty tombstone to config.json. The caller persists credentials before config. */
export function migrateWorkspaceCredentials(config, credentials) {
  const nextConfig = structuredClone(config ?? {});
  const nextCredentials = { ...credentials };
  let configChanged = false;
  let credentialsChanged = false;
  for (const { section, subsection, field, name } of WORKSPACE_CREDENTIALS) {
    const home = subsection ? nextConfig?.[section]?.[subsection] : nextConfig?.[section];
    if (!home || typeof home !== "object" || Array.isArray(home)) continue;
    if (!Object.hasOwn(home, field)) continue;
    const value = home[field];
    if (typeof value !== "string") continue;
    const secret = value.trim();
    if (secret && nextCredentials[name] !== secret) {
      nextCredentials[name] = secret;
      credentialsChanged = true;
    }
    delete home[field];
    configChanged = true;
  }
  return { config: nextConfig, credentials: nextCredentials, configChanged, credentialsChanged };
}

/** Security: the encrypted write comes first, so a store that cannot save leaves every plaintext key in config.json and the app working. */
export async function migrateWorkspaceConfigFile({ configPath, credentials, save, log }) {
  let current = credentials;
  try {
    const migrated = migrateWorkspaceCredentials(JSON.parse(fs.readFileSync(configPath, "utf8")), current);
    if (migrated.credentialsChanged) await save(migrated.credentials);
    current = migrated.credentials;
    if (migrated.configChanged) {
      const temporary = `${configPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(migrated.config, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, configPath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") log(`credential migration failed: ${error?.message ?? error}`);
  }
  return current;
}

export function workspaceCredentialEnv(credentials) {
  const env = {};
  for (const { name, env: envName } of WORKSPACE_CREDENTIALS) {
    const value = credentials?.[name];
    if (typeof value === "string" && value) env[envName] = value;
  }
  return env;
}
