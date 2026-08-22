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
  { section: "imageGen", field: "key", name: "openaiImageApiKey", env: "OMB_OPENAI_IMAGE_KEY" },
  {
    section: "opencode",
    legacySections: ["opencodeGo"],
    field: "apiKey",
    // Keep the encrypted-store field name so upgrades retain the saved key.
    name: "opencodeGoApiKey",
    env: "OPENCODE_API_KEY",
  },
];

/** One boot-time sweep of config.json: move every plaintext workspace secret
 * into the encrypted store and DELETE the plaintext field.
 *
 * Deleting (never blanking) keeps "" meaningful. The server persists a
 * credential save by writing the field — a mid-session save lands as the new
 * value, a mid-session clear lands as "". So on the next boot:
 *   - non-empty value  → newest user intent: overwrite the stored secret
 *   - ""               → the user cleared it: drop the stored secret too
 *   - field absent     → already migrated: keep what the store holds
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
  for (const { section, legacySections = [], field, name } of WORKSPACE_CREDENTIALS) {
    // Legacy aliases run first so the current spelling wins if a file happens
    // to carry both after an interrupted upgrade.
    for (const configSection of [...legacySections, section]) {
      const home = nextConfig?.[configSection];
      if (!home || typeof home !== "object" || Array.isArray(home)) continue;
      if (!Object.hasOwn(home, field)) continue;
      const value = home[field];
      if (typeof value !== "string") continue;
      const secret = value.trim();
      if (secret) {
        if (nextCredentials[name] !== secret) {
          nextCredentials[name] = secret;
          credentialsChanged = true;
        }
      } else if (Object.hasOwn(nextCredentials, name)) {
        delete nextCredentials[name];
        credentialsChanged = true;
      }
      delete home[field];
      configChanged = true;
    }
  }
  return { config: nextConfig, credentials: nextCredentials, configChanged, credentialsChanged };
}

/** Env for the spawned server: one var per stored secret, nothing else.
 * The server treats each var as authoritative over its config.json field. */
export function workspaceCredentialEnv(credentials) {
  const env = {};
  for (const { name, env: envName } of WORKSPACE_CREDENTIALS) {
    const value = credentials?.[name];
    if (typeof value === "string" && value) env[envName] = value;
  }
  return env;
}
