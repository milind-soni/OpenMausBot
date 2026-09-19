const ENV_NAME = "OPENMAUS_OPENAI_CONNECTION_KEYS";

type ConnectionKey = { key: string; url: string };

function normalizedUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { return new URL(value.trim()).href.replace(/\/+$/u, ""); } catch { return undefined; }
}

function readKeys(env: NodeJS.ProcessEnv): Record<string, ConnectionKey> {
  const raw = env[ENV_NAME];
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([id, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const key = value.key;
      const url = normalizedUrl(value.url);
      return typeof key === "string" && key && url ? [[id, { key, url }]] : [];
    }));
  } catch {
    // Do not include the malformed environment value in diagnostics.
    return {};
  }
}

/** A crash between the encrypted-store and config writes must never send a
 * credential to the previous (or next) connection's endpoint. */
export function readOpenAIConnectionKey(instanceId: string, url: unknown, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const keys = readKeys(env);
  const entry = Object.hasOwn(keys, instanceId) ? keys[instanceId] : undefined;
  return entry?.url === normalizedUrl(url) ? entry?.key : undefined;
}

export function setOpenAIConnectionKey(instanceId: string, key: string, url: unknown, env: NodeJS.ProcessEnv = process.env): void {
  const endpoint = normalizedUrl(url);
  if (!endpoint) throw new Error("A valid API URL is required to store this credential");
  const keys = { ...readKeys(env), [instanceId]: { key, url: endpoint } };
  env[ENV_NAME] = JSON.stringify(keys);
}

export function removeOpenAIConnectionKey(instanceId: string, env: NodeJS.ProcessEnv = process.env): void {
  const keys = readKeys(env);
  delete keys[instanceId];
  if (Object.keys(keys).length) env[ENV_NAME] = JSON.stringify(keys);
  else delete env[ENV_NAME];
}
