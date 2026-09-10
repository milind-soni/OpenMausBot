import { WORKSPACE_CREDENTIALS } from "./workspace-credentials.mjs";
import { normalizeManagedComposioBrokerUrl } from "./managed-composio.mjs";

export const WORKSPACE_BACKUP_REQUEST = "openmausbot:workspace-backup-credentials";
export const WORKSPACE_BACKUP_RESULT = `${WORKSPACE_BACKUP_REQUEST}:result`;
export const BACKUP_CREDENTIAL_FIELDS = [
  ...WORKSPACE_CREDENTIALS,
  { section: "composio", field: "apiKey", name: "composioApiKey", env: "COMPOSIO_API_KEY" },
  { section: "anthropic", field: "key", name: "anthropicApiKey", env: "OMB_ANTHROPIC_API_KEY" },
  { section: "openaiCompat", field: "key", name: "openaiCompatApiKey", env: "OPENAI_COMPAT_API_KEY" },
];
export const BACKUP_CREDENTIAL_NAMES = [...BACKUP_CREDENTIAL_FIELDS.map(({ name }) => name), "composioBrokerToken", "composioInstallationId", "composioBrokerUrl"];
// These two providers still use ordinary config saves in the desktop UI.
// Do not introduce a second, stale OS-store authority just for restores.
export const DESKTOP_BACKUP_CREDENTIAL_NAMES = BACKUP_CREDENTIAL_NAMES.filter((name) => !["anthropicApiKey", "openaiCompatApiKey"].includes(name));
const failure = "Workspace credentials could not be transferred securely. Quit and reopen the app, then try again.";

/** Only workspace secrets belong in the encrypted archive, never desktop
 * accounts, companion tokens, phone encryption identities or saved origins. */
export function workspaceBackupCredentials(value, strict = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(failure);
  if (strict && Object.keys(value).some((key) => !BACKUP_CREDENTIAL_NAMES.includes(key))) throw new Error(failure);
  const result = {};
  for (const name of BACKUP_CREDENTIAL_NAMES) {
    if (!Object.hasOwn(value, name)) continue;
    const secret = value[name];
    if (typeof secret !== "string" || Buffer.byteLength(secret) > 16_384) throw new Error(failure);
    result[name] = secret;
  }
  if (result.composioBrokerToken && !/^[0-9a-f]{64}$/.test(result.composioBrokerToken)) throw new Error(failure);
  if (result.composioBrokerUrl && !normalizeManagedComposioBrokerUrl(result.composioBrokerUrl)) throw new Error(failure);
  if (Buffer.byteLength(JSON.stringify(result)) > 131_072) throw new Error(failure);
  return result;
}

/** Empty values deliberately clear the old child's inherited secrets before
 * the restored config is loaded. The broker URL comes from this desktop. */
export function workspaceBackupEnvironment(credentials, brokerUrl) {
  // A partial import must never redirect the destination's existing token
  // to a newly supplied service. Endpoint + identity travel together.
  if (credentials.composioBrokerUrl && !Object.hasOwn(credentials, "composioBrokerToken")) throw new Error(failure);
  const env = Object.fromEntries(BACKUP_CREDENTIAL_FIELDS.filter(({ name }) => Object.hasOwn(credentials, name)).map(({ name, env }) => [env, credentials[name]]));
  if (Object.hasOwn(credentials, "composioBrokerToken")) {
    env.OMB_COMPOSIO_BROKER_TOKEN = credentials.composioBrokerToken;
    env.OMB_COMPOSIO_BROKER_URL = credentials.composioBrokerToken ? normalizeManagedComposioBrokerUrl(credentials.composioBrokerUrl || brokerUrl) : "";
  }
  if (credentials.composioBrokerToken && !env.OMB_COMPOSIO_BROKER_URL) throw new Error(failure);
  return env;
}

/** Private utility-process messages only; no ipcMain/renderer handler. The
 * shared credential queue keeps unrelated concurrent desktop saves intact. */
export function createWorkspaceBackupCredentialBridge({ isCurrent, available, read, update, brokerUrl, timeoutMs = 15_000 }) {
  let pending = 0;
  return (proc, message) => {
    if (message?.type !== WORKSPACE_BACKUP_REQUEST) return false;
    if (!isCurrent(proc) || typeof message.requestId !== "string" || !/^[\w-]{1,64}$/.test(message.requestId)) return true;
    const reply = (result) => {
      if (!isCurrent(proc)) throw new Error(failure);
      proc.postMessage({ type: WORKSPACE_BACKUP_RESULT, requestId: message.requestId, ...result });
    };
    if (pending >= 4) {
      try { reply({ ok: false, error: failure }); } catch {}
      return true;
    }
    pending += 1;
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (!available() || !isCurrent(proc) || Date.now() >= deadline) throw new Error(failure);
    };
    void (async () => {
      check();
      if (message.operation === "read") {
        const credentials = workspaceBackupCredentials(read());
        reply({ ok: true, credentials: { ...Object.fromEntries(DESKTOP_BACKUP_CREDENTIAL_NAMES.map((name) => [name, credentials[name] ?? ""])), composioBrokerUrl: brokerUrl() } });
      } else if (message.operation === "restore") {
        const credentials = workspaceBackupCredentials(message.credentials, true);
        const environment = workspaceBackupEnvironment(credentials, brokerUrl());
        await update((current) => {
          check();
          return { ...current, ...Object.fromEntries(Object.entries(credentials).filter(([name]) => DESKTOP_BACKUP_CREDENTIAL_NAMES.includes(name))) };
        }, () => {
          // state.update rolls the durable document back if the child has
          // gone away, the operation expired, or its private reply fails.
          check();
          reply({ ok: true, environment });
        });
      } else throw new Error(failure);
    })().catch(() => {
      // Never include a store exception: it can contain a secret or path.
      try { reply({ ok: false, error: failure }); } catch {}
    }).finally(() => { pending -= 1; });
    return true;
  };
}
