// Workspace credentials the desktop shell keeps OS-encrypted (credentials.bin
// via safeStorage) instead of leaving in plaintext config.json — the same
// treatment the Composio project key already gets in main.mjs. Pure functions:
// main.mjs owns the fs and safeStorage plumbing, so the migration decisions
// stay testable without an Electron runtime.
//
// One row per secret: the config.json home it migrates OUT of, the
// credentials.bin field it lives in, and the env var the spawned server
// prefers over the file (server/config.ts loadConfig).
export const WORKSPACE_CREDENTIALS = [
  { section: "xai", field: "key", name: "xaiApiKey", env: "XAI_API_KEY" },
  { section: "box", field: "token", name: "boxToken", env: "BOX_TOKEN" },
  { section: "tts", field: "key", name: "ttsKey", env: "OMB_TTS_KEY" },
  { section: "tts", field: "fishKey", name: "fishAudioKey", env: "OMB_FISH_AUDIO_API_KEY" },
  { section: "imageGen", field: "key", name: "openaiImageApiKey", env: "OMB_OPENAI_IMAGE_KEY" },
  { section: "imageGen", field: "customApiKey", name: "customImageApiKey", env: "OMB_CUSTOM_IMAGE_KEY" },
  { section: "opencodeGo", field: "apiKey", name: "opencodeGoApiKey", env: "OPENCODE_API_KEY" },
];

/** One boot-time sweep of config.json: move every plaintext workspace secret
 * into the encrypted store and DELETE the plaintext field.
 *
 * Deleting (never blanking) keeps the meaning of what remains unambiguous:
 *   - non-empty value  → newest user intent: overwrite the stored secret
 *   - "" or absent     → no plaintext information; the store stays authoritative
 *
 * "" must never drop a stored secret. The packaged app's external-secret
 * save path writes an empty tombstone into config.json on EVERY credential
 * commit (the real value goes to credentials.bin first), so reading "" as
 * "the user cleared this" deleted freshly saved keys at the next boot.
 * Clearing runs through the desktop shell's credential:set handler, which
 * removes the entry from the store directly before persisting the same
 * tombstone — so there is no "" case in which the store should lose data.
 * Running twice is a no-op, and nothing is lost if a boot dies between the
 * two writes — the caller persists credentials BEFORE rewriting config, so
 * the worst case re-runs the same overwrite.
 *
 * Inputs are treated as immutable; the changed flags tell the caller which
 * file(s) actually need rewriting. Non-string junk in a field is left for
 * the server's schema to reject rather than silently destroyed here. */
export function migrateWorkspaceCredentials(config, credentials) {
  const nextConfig = structuredClone(config ?? {});
  const nextCredentials = { ...credentials };
  let configChanged = false;
  let credentialsChanged = false;
  for (const { section, field, name } of WORKSPACE_CREDENTIALS) {
    const home = nextConfig?.[section];
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
  // Explicit authentication owns its credential. Legacy instances can still
  // inherit a global URL/key, so leave them intact until a connection edit.
  for (const [instanceId, instance] of Object.entries(nextConfig.instances ?? {})) {
    if (instance?.driver !== "openai-compat" || !instance.config || typeof instance.config !== "object") continue;
    if (instance.config.auth === "none") {
      const keys = openAIConnectionKeys(nextCredentials);
      if (Object.hasOwn(keys, instanceId)) {
        delete keys[instanceId];
        nextCredentials.openaiConnectionKeys = keys;
        credentialsChanged = true;
      }
      if (typeof instance.config.key === "string") {
        delete instance.config.key;
        configChanged = true;
      }
      continue;
    }
    if (instance.config.auth !== "bearer") continue;
    const value = instance.config.key;
    if (typeof value !== "string") continue;
    const secret = value.trim();
    if (secret) {
      const url = normalizeOpenAIConnectionUrl(instance.config.url);
      if (!url) continue;
      const keys = openAIConnectionKeys(nextCredentials);
      if (keys[instanceId]?.key !== secret || keys[instanceId]?.url !== url) {
        nextCredentials.openaiConnectionKeys = { ...keys, [instanceId]: { key: secret, url } };
        credentialsChanged = true;
      }
      instance.config.secretStorage = "external";
    }
    if (instance.config.secretStorage === "external") {
      delete instance.config.key;
      configChanged = true;
    }
  }
  return { config: nextConfig, credentials: nextCredentials, configChanged, credentialsChanged };
}

export function openAIConnectionKeys(credentials) {
  const keys = credentials?.openaiConnectionKeys;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) return {};
  return Object.fromEntries(Object.entries(keys).flatMap(([id, value]) => {
    const url = normalizeOpenAIConnectionUrl(value?.url);
    return typeof value?.key === "string" && value.key && url ? [[id, { key: value.key, url }]] : [];
  }));
}

export function normalizeOpenAIConnectionUrl(value) {
  if (typeof value !== "string") return undefined;
  try { return new URL(value.trim()).href.replace(/\/+$/u, ""); } catch { return undefined; }
}

/** Undefined preserves a stored credential; an empty value explicitly clears it. */
export function withOpenAIConnectionKey(credentials, instanceId, key, url) {
  const keys = openAIConnectionKeys(credentials);
  if (key === undefined) return { ...credentials };
  if (key) {
    const endpoint = normalizeOpenAIConnectionUrl(url);
    if (!endpoint) throw new Error("A valid API URL is required to store this credential");
    keys[instanceId] = { key, url: endpoint };
  }
  else delete keys[instanceId];
  return { ...credentials, openaiConnectionKeys: keys };
}

/** Env for the spawned server: one var per stored secret, nothing else.
 * The server treats each var as authoritative over its config.json field. */
export function workspaceCredentialEnv(credentials) {
  const env = {};
  for (const { name, env: envName } of WORKSPACE_CREDENTIALS) {
    const value = credentials?.[name];
    if (typeof value === "string" && value) env[envName] = value;
  }
  const keys = openAIConnectionKeys(credentials);
  if (Object.keys(keys).length) env.OPENMAUS_OPENAI_CONNECTION_KEYS = JSON.stringify(keys);
  return env;
}
