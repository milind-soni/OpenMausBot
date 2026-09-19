// Extracted from electron/main.mjs: the encrypted credential store
// (credentials.bin via safeStorage), the boot-time migration of plaintext
// config.json secrets, and the shared serialized credential state. Owns the
// secureCredentials/secureCredentialState live bindings; main.mjs and the
// companion machinery import them read-only.
import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { slog } from "./crash-log.mjs";
import { readSecureCredentials } from "../secure-credentials.mjs";
import { migrateWorkspaceCredentials } from "../workspace-credentials.mjs";
import { normalizeManagedComposioBrokerUrl } from "../managed-composio.mjs";
import { createSecureCredentialState } from "../secure-credential-state.mjs";

const DEFAULT_COMPOSIO_BROKER_URL = "https://openmausbot-composio.milindsoni201.workers.dev";
export let secureCredentials = {};
export let secureCredentialState = null;

export function desktopDataDir() {
  // Match the historical desktop fallback for an unset or empty override,
  // then pass this exact resolved path to the utility child. server/config.ts
  // intentionally treats an empty OMB_DATA_DIR differently, so inheriting it
  // without normalization would lease one directory and write another.
  return process.env.OMB_DATA_DIR || path.join(app.getPath("home"), ".openmausbot");
}

const CREDENTIALS_FILE = path.join(app.getPath("userData"), "credentials.bin");

/** Set once per launch: true when the store could not be READ, which is not
 * the same as the user having saved nothing. Everything downstream — the
 * server's view of "configured", and whether we may register a fresh
 * installation — keys off this rather than off an empty object. */
export let credentialStoreUnavailable = false;

async function loadSecureCredentials() {
  const result = await readSecureCredentials({
    exists: () => fs.existsSync(CREDENTIALS_FILE),
    isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    readFile: () => fs.readFileSync(CREDENTIALS_FILE),
    decrypt: (buffer) => safeStorage.decryptStringAsync(buffer),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  credentialStoreUnavailable = result.status === "unavailable";
  if (credentialStoreUnavailable) {
    // Deliberately loud. A silent {} here is what made a keychain hiccup
    // look like "your connected apps are gone".
    slog(`credential store unreadable after retries (${result.error}); saved keys are not loaded this launch`);
  }
  return result.credentials;
}

async function saveSecureCredentials(credentials) {
  // A failed read means we do not know what the existing encrypted document
  // contains. Never derive a replacement from that incomplete view: boot
  // migrations must leave plaintext in place so a later launch can retry.
  if (credentialStoreUnavailable) {
    throw new Error("The operating-system credential store could not be read this launch");
  }
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("The operating-system credential store is unavailable");
  }
  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true });
  const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(credentials));
  const temporary = `${CREDENTIALS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
  fs.renameSync(temporary, CREDENTIALS_FILE);
}

async function secureComposioConfig() {
  const dataDir = desktopDataDir();
  const configPath = path.join(dataDir, "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!config?.composio || typeof config.composio !== "object") return;
    let changed = false;
    const apiKey = config?.composio?.apiKey;
    if (typeof apiKey === "string" && apiKey.trim().startsWith("ak_")) {
      if (!secureCredentials.composioApiKey) {
        secureCredentials.composioApiKey = apiKey.trim();
        await saveSecureCredentials(secureCredentials);
      }
      config.composio.apiKey = "";
      changed = true;
    } else if (typeof apiKey === "string" && apiKey.trim()) {
      config.composio.apiKey = "";
      changed = true;
    }
    // These were the old Connect credential and endpoint. They are no longer
    // read; remove them during the upgrade so an unused secret is not left in
    // plaintext indefinitely.
    for (const field of ["key", "url"]) {
      if (Object.hasOwn(config.composio, field)) {
        delete config.composio[field];
        changed = true;
      }
    }
    if (!changed) return;
    const temporary = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } catch (error) {
    if (error?.code !== "ENOENT") slog(`credential migration failed: ${error?.message ?? error}`);
  }
}

// The remaining workspace credentials (xai/box/voice/OpenCode keys) get
// the same at-rest treatment as the Composio key above. New packaged-app
// saves go straight through credential:set below; this boot-time sweep also
// migrates plaintext left by older versions or direct development clients.
// See workspace-credentials.mjs for the exact rules.
async function secureWorkspaceConfig() {
  const dataDir = desktopDataDir();
  const configPath = path.join(dataDir, "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const migrated = migrateWorkspaceCredentials(config, secureCredentials);
    // credentials.bin first: if the OS store cannot take the secrets, the
    // plaintext stays put and the next boot retries — losing the only copy
    // is the one unacceptable outcome
    if (migrated.credentialsChanged) await saveSecureCredentials(migrated.credentials);
    secureCredentials = migrated.credentials;
    if (!migrated.configChanged) return;
    const temporary = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(migrated.config, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } catch (error) {
    if (error?.code !== "ENOENT") slog(`credential migration failed: ${error?.message ?? error}`);
  }
}

export function composioBrokerUrl() {
  const configured = process.env.OMB_COMPOSIO_BROKER_URL?.trim();
  return normalizeManagedComposioBrokerUrl(
    configured || (app.isPackaged ? DEFAULT_COMPOSIO_BROKER_URL : ""),
  );
}

/** The one serialized credential mutation hook. Account onboarding and every
 * other runtime credential writer share this state, so persisting a tunnel
 * token can never overwrite an API key saved at the same time (or vice
 * versa). */
export async function updateSecureCredentialDocument(derive, afterPersist) {
  if (!secureCredentialState) throw new Error("Secure credentials are not ready");
  try {
    return await secureCredentialState.update(derive, afterPersist);
  } finally {
    secureCredentials = secureCredentialState.read();
  }
}

export async function initializeSecureCredentialStore() {
  secureCredentials = await loadSecureCredentials();
  // The AssemblyAI key only fed the removed Teach a skill recorder, and its
  // set/clear handler went with it; drop the orphaned secret rather than
  // keep a third-party key at rest with no way to remove it.
  if (secureCredentials && Object.hasOwn(secureCredentials, "assemblyAiApiKey") && !credentialStoreUnavailable) {
    try {
      const { assemblyAiApiKey: _removed, ...rest } = secureCredentials;
      await saveSecureCredentials(rest);
      secureCredentials = rest;
    } catch (error) {
      slog(`orphaned AssemblyAI key not removed: ${error?.message ?? error}`);
    }
  }
  if (app.isPackaged) {
    await secureComposioConfig();
    await secureWorkspaceConfig();
  }
  // Boot migrations above are deliberately sequential. From this point on,
  // every account/API-key writer must use the shared serialized state.
  // An unreadable store must not become a WRITE of an empty document.
  secureCredentialState = createSecureCredentialState(secureCredentials, saveSecureCredentials, {
    writable: !credentialStoreUnavailable,
  });
  secureCredentials = secureCredentialState.read();
}
