const TOKEN = /^[0-9a-f]{64}$/;

/** OpenMausBot's connected-apps service (cloudflare/composio-broker): the packaged desktop app and a Cloud home use it. */
export const DEFAULT_MANAGED_COMPOSIO_BROKER_URL = "https://openmausbot-composio.milindsoni201.workers.dev";

/** An explicit URL wins; otherwise the default, only for a shipped build, so development and tests never register. */
export function managedComposioBrokerUrl(configured, shipped) {
  const explicit = typeof configured === "string" ? configured.trim() : "";
  return normalizeManagedComposioBrokerUrl(explicit || (shipped ? DEFAULT_MANAGED_COMPOSIO_BROKER_URL : ""));
}

export function normalizeManagedComposioBrokerUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return "";
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return "";
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return "";
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export function managedComposioAccess(brokerUrl, credentials) {
  const url = normalizeManagedComposioBrokerUrl(brokerUrl);
  const token = credentials?.composioBrokerToken;
  if (!url || !TOKEN.test(token ?? "")) return null;
  return { url, token };
}

export function managedComposioChildEnvironment(brokerUrl, credentials, environment) {
  const next = { ...environment };
  delete next.OMB_COMPOSIO_BROKER_URL;
  delete next.OMB_COMPOSIO_BROKER_TOKEN;
  const access = managedComposioAccess(brokerUrl, credentials);
  if (access) {
    next.OMB_COMPOSIO_BROKER_URL = access.url;
    next.OMB_COMPOSIO_BROKER_TOKEN = access.token;
  }
  return next;
}

export async function ensureManagedComposioCredentials({
  brokerUrl,
  credentials,
  fetchImpl = globalThis.fetch,
  saveCredentials,
  log = () => {},
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  existingCredentialTimeoutMs = 8_000,
  registrationTimeoutMs = 15_000,
}) {
  const url = normalizeManagedComposioBrokerUrl(brokerUrl);
  if (!url) {
    if (brokerUrl) log("connected-apps broker URL rejected: HTTPS or a loopback HTTP URL is required");
    return credentials;
  }
  if (TOKEN.test(credentials.composioBrokerToken ?? "")) {
    try {
      const check = await fetchImpl(`${url}/v1/me`, {
        headers: { authorization: `Bearer ${credentials.composioBrokerToken}` },
        redirect: "error",
        signal: timeoutSignal(existingCredentialTimeoutMs),
      });
      if (check.ok) return credentials;
      // Only a definitive auth failure rotates the credential, so an outage never strands authorized accounts.
      if (check.status !== 401) return credentials;
      delete credentials.composioBrokerToken;
      delete credentials.composioInstallationId;
    } catch {
      return credentials;
    }
  }
  try {
    const response = await fetchImpl(`${url}/v1/installations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      redirect: "error",
      signal: timeoutSignal(registrationTimeoutMs),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    if (!TOKEN.test(body?.token ?? "") || typeof body?.installationId !== "string") {
      throw new Error("the connected-apps service returned invalid credentials");
    }
    credentials.composioBrokerToken = body.token;
    credentials.composioInstallationId = body.installationId;
    await saveCredentials(credentials);
    log("connected-apps installation registered");
  } catch (error) {
    log(`connected-apps registration failed: ${error?.message ?? error}`);
  }
  return credentials;
}
