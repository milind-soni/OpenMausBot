const INSTALLATION_CREDENTIAL =
  /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const INSTALLATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const stringValue = (value) => (typeof value === "string" ? value : null);

const isPlainRecord = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const constructor = value.constructor;
    if (constructor === undefined || typeof constructor !== "function") return true;
    const prototype = constructor.prototype;
    return (
      typeof prototype === "object" &&
      prototype !== null &&
      Object.prototype.hasOwnProperty.call(prototype, "isPrototypeOf")
    );
  } catch {
    return false;
  }
};

const plainObject = (value) => {
  if (!isPlainRecord(value)) return null;
  const record = {};
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue;
      if (typeof key !== "string") return null;
      if (key === "__proto__") continue;
      record[key] = value[key];
    }
  } catch {
    return null;
  }
  return record;
};

const validClientInstance = (value) => {
  const input = stringValue(value);
  return input !== null && CLIENT_INSTANCE.test(input);
};

const boundedSecret = (value, maximum = 8_192) =>
  typeof value === "string" &&
  value.length >= 20 &&
  value.length <= maximum &&
  /^\S+$/.test(value)
    ? value
    : null;

const reportableAppVersion = (value) => {
  const version = stringValue(value)?.trim() ?? "";
  if (version.length < 1 || version.length > 64) return null;
  for (const character of version) {
    const point = character.codePointAt(0);
    if (point < 32 || point === 127) return null;
  }
  return version;
};

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

/** What `409 relay_capable` may say about the tunnel this computer goes without: old phone apps no longer get one
 * ("retired"), or every account is at its limit ("full"). */
const RELAY_ONLY_REASONS = new Set(["retired", "full"]);

export class ControlPlaneError extends Error {
  constructor(code, status = 0, requestId = "", retryAfterMs = 0, tunnel = null) {
    super(code);
    this.name = "ControlPlaneError";
    this.code = code;
    this.tunnel = code === "relay_capable" && RELAY_ONLY_REASONS.has(tunnel) ? tunnel : null;
    this.status = status;
    this.requestId = REQUEST_ID.test(requestId) ? requestId : "";
    this.retryAfterMs =
      Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0
        ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)
        : 0;
  }
}

/** Only the delay-seconds form is accepted; an HTTP date is ignored. */
function retryAfterMilliseconds(value) {
  const input = stringValue(value)?.trim() ?? "";
  if (!/^[0-9]{1,6}$/.test(input)) return 0;
  return Math.min(Number(input) * 1_000, MAX_RETRY_AFTER_MS);
}

const ENDPOINT_STATUSES = new Set([
  "pending",
  "provisioning",
  "ready",
  "deleting",
  "deleted",
  "error",
]);

function statusErrorCode(status) {
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 405) return "method_not_allowed";
  if (status === 409) return "conflict";
  if (status === 413) return "request_too_large";
  if (status === 415) return "unsupported_media_type";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "control_plane_unavailable";
  return "request_failed";
}

/** HTTPS only, or loopback HTTP for a configured dev Worker; no path, credentials or query, so every request stays under the audited API. */
export function normalizeControlPlaneURL(value) {
  const input = stringValue(value)?.trim() ?? "";
  if (!input) return "";
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return "";
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    return "";
  }
  return parsed.origin;
}

export function normalizeAccountEmail(value) {
  const input = stringValue(value);
  const email = input !== null && input.length <= 254 ? input.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

function validatedUser(value) {
  const user = plainObject(value);
  const email = normalizeAccountEmail(user?.email);
  const idInput = stringValue(user?.id);
  const id = idInput !== null && idInput.length >= 1 && idInput.length <= 256
    ? idInput
    : null;
  if (!email || !id) return null;
  return { id, email };
}

function validatedInstallation(value) {
  const installation = plainObject(value);
  const id = stringValue(installation?.id);
  const clientInstanceId = stringValue(installation?.clientInstanceId);
  if (
    id === null ||
    !INSTALLATION_ID.test(id) ||
    clientInstanceId === null ||
    !validClientInstance(clientInstanceId)
  ) {
    return null;
  }
  return {
    id,
    clientInstanceId,
    name: stringValue(installation.name) ?? "This computer",
    platform: installation.platform,
    appVersion: stringValue(installation.appVersion),
  };
}

function validatedEndpoint(value) {
  const endpoint = plainObject(value);
  const endpointURL = stringValue(endpoint?.url);
  if (endpointURL === null) return null;
  let url;
  try {
    url = new URL(endpointURL);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return { url: url.origin };
}

export function createControlPlaneClient({
  baseURL,
  fetchImpl = globalThis.fetch,
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  timeoutMs = 15_000,
  healthTimeoutMs = 3_000,
}) {
  const origin = normalizeControlPlaneURL(baseURL);
  if (!origin) throw new ControlPlaneError("control_plane_unavailable");

  const request = async (
    path,
    { method = "GET", token, body, allowEmpty = false, deadlineMs = timeoutMs } = {},
  ) => {
    const headers = new Headers({ accept: "application/json" });
    if (token) headers.set("authorization", `Bearer ${token}`);
    // Node's fetch sends `Sec-Fetch-Mode: cors`, which Better Auth 1.7 treats as a browser request needing a trusted Origin.
    // Send the validated origin to Better Auth routes only, rather than weakening the server's CSRF checks.
    if (path.startsWith("/api/auth/")) headers.set("origin", origin);
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }
    let response;
    try {
      const init = {
        method,
        headers,
        redirect: "error",
        signal: timeoutSignal(deadlineMs),
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      response = await fetchImpl(`${origin}${path}`, init);
    } catch {
      throw new ControlPlaneError("network_unavailable");
    }

    let payload = null;
    if (response.status !== 204) {
      payload = await response.json().catch(() => null);
    }
    if (!response.ok) {
      const rawCode = stringValue(plainObject(payload)?.error);
      const code = rawCode !== null && /^[a-z0-9_]{1,64}$/.test(rawCode)
        ? rawCode
        : null;
      throw new ControlPlaneError(
        code ?? statusErrorCode(response.status),
        response.status,
        response.headers.get("x-request-id") ?? "",
        retryAfterMilliseconds(response.headers.get("retry-after")),
        stringValue(plainObject(payload)?.tunnel),
      );
    }
    if (!allowEmpty && !plainObject(payload)) {
      throw new ControlPlaneError("invalid_response", response.status);
    }
    return { response, payload };
  };

  const accountInstallations = async (accountToken) => {
    if (!boundedSecret(accountToken)) throw new ControlPlaneError("signed_out", 401);
    const { payload } = await request("/v1/installations", { token: accountToken });
    if (!Array.isArray(payload.installations)) {
      throw new ControlPlaneError("invalid_response");
    }
    const installations = payload.installations.map(validatedInstallation);
    if (installations.some((installation) => !installation)) {
      throw new ControlPlaneError("invalid_response");
    }
    return installations;
  };

  return {
    origin,

    async health() {
      const { payload } = await request("/healthz", {
        deadlineMs: Math.min(timeoutMs, healthTimeoutMs),
      });
      if (
        payload.ok !== true ||
        payload.service !== "openmausbot-control-plane"
      ) {
        throw new ControlPlaneError("control_plane_unavailable");
      }
      return true;
    },

    async requestOTP(rawEmail) {
      const email = normalizeAccountEmail(rawEmail);
      if (!email) throw new ControlPlaneError("invalid_email");
      await request("/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        body: { email, type: "sign-in" },
      });
      // The server answers known and unknown addresses alike; keep that enumeration-safe contract.
      return { email };
    },

    async verifyOTP(rawEmail, rawOTP) {
      const email = normalizeAccountEmail(rawEmail);
      const otpInput = stringValue(rawOTP);
      const otp = otpInput !== null && otpInput.length <= 32
        ? otpInput.replaceAll(/\s|-/g, "")
        : "";
      if (!email) throw new ControlPlaneError("invalid_email");
      if (!/^\d{8}$/.test(otp)) throw new ControlPlaneError("invalid_otp");
      const { response, payload } = await request("/api/auth/sign-in/email-otp", {
        method: "POST",
        body: { email, otp, name: email.split("@", 1)[0] },
      });
      // Better Auth's JSON carries its raw database token; only the signed bearer from this header may cross our API boundary.
      const accountToken = boundedSecret(response.headers.get("set-auth-token"));
      const user = validatedUser(payload.user);
      if (!accountToken || !user || user.email !== email) {
        throw new ControlPlaneError("invalid_response", response.status);
      }
      return { accountToken, user };
    },

    async me(accountToken) {
      if (!boundedSecret(accountToken)) throw new ControlPlaneError("signed_out", 401);
      const { payload } = await request("/v1/me", { token: accountToken });
      const user = validatedUser(payload.user);
      if (!user) throw new ControlPlaneError("invalid_response");
      return user;
    },

    async listInstallations(accountToken) {
      return accountInstallations(accountToken);
    },

    async ensureInstallation({ accountToken, currentCredential, clientInstanceId, name, platform, appVersion }) {
      if (
        !validClientInstance(clientInstanceId)
      ) {
        throw new ControlPlaneError("invalid_client_identity");
      }

      if (
        typeof currentCredential === "string" &&
        INSTALLATION_CREDENTIAL.test(currentCredential)
      ) {
        try {
          const { payload } = await request("/v1/installations/self", { token: currentCredential });
          const installation = validatedInstallation(payload.installation);
          if (installation?.clientInstanceId === clientInstanceId) {
            return {
              installation,
              credential: currentCredential,
              credentialExpiresAt:
                Number.isSafeInteger(payload.credentialExpiresAt) ? payload.credentialExpiresAt : null,
            };
          }
        } catch (error) {
          // A transient outage must not rotate a usable identity; only a definitive 401 falls through to recovery.
          if (!(error instanceof ControlPlaneError) || error.status !== 401) throw error;
        }
      }

      if (!boundedSecret(accountToken)) throw new ControlPlaneError("signed_out", 401);
      const installations = await accountInstallations(accountToken);
      const existing = installations.find((item) => item.clientInstanceId === clientInstanceId);
      const result = existing
        ? await request(`/v1/installations/${encodeURIComponent(existing.id)}/credentials/rotate`, {
            method: "POST",
            token: accountToken,
          })
        : await request("/v1/installations", {
            method: "POST",
            token: accountToken,
            body: { clientInstanceId, name, platform, appVersion },
          });
      const installation = existing ?? validatedInstallation(result.payload.installation);
      const credential = stringValue(result.payload.credential);
      if (!installation || credential === null || !INSTALLATION_CREDENTIAL.test(credential)) {
        throw new ControlPlaneError("invalid_response");
      }
      return {
        installation,
        credential,
        credentialExpiresAt:
          Number.isSafeInteger(result.payload.credentialExpiresAt)
            ? result.payload.credentialExpiresAt
            : null,
      };
    },

    /** `legacyDevices`: paired phones that can't use the encrypted connection; a relay-capable desktop with none gets
     * `409 relay_capable` instead of a new tunnel. The error's `tunnel` is "retired" when old phone apps no longer
     * get one and "full" when every account is at its limit; otherwise null. */
    async ensureEndpoint(installationCredential, { appVersion, legacyDevices } = {}) {
      if (
        typeof installationCredential !== "string" ||
        !INSTALLATION_CREDENTIAL.test(installationCredential)
      ) {
        throw new ControlPlaneError("signed_out", 401);
      }
      const version = reportableAppVersion(appVersion);
      const legacy = Number.isSafeInteger(legacyDevices) && legacyDevices >= 0 && legacyDevices <= 100 ? legacyDevices : null;
      const body = { ...(version === null ? {} : { appVersion: version }), ...(legacy === null ? {} : { legacyDevices: legacy }) };
      const { payload } = await request("/v1/installations/self/endpoint", {
        method: "POST",
        token: installationCredential,
        ...(Object.keys(body).length ? { body } : {}),
      });
      const endpoint = validatedEndpoint(payload.endpoint);
      const connectorToken = boundedSecret(payload.connectorToken, 16_384);
      if (!endpoint || !connectorToken) throw new ControlPlaneError("invalid_response");
      return { endpoint, connectorToken };
    },

    /** MausBot Relay: `{token, hostId, nodes, expiresAt, refreshAfter}`, or `relay_unavailable` (503) while this
     * computer is outside the rollout. */
    async relayToken(installationCredential, { appVersion, devices }) {
      if (typeof installationCredential !== "string" || !INSTALLATION_CREDENTIAL.test(installationCredential)) {
        throw new ControlPlaneError("signed_out", 401);
      }
      const version = reportableAppVersion(appVersion);
      if (version === null) throw new ControlPlaneError("invalid_request");
      const { payload } = await request("/v1/installations/self/relay-token", {
        method: "POST",
        token: installationCredential,
        body: { appVersion: version, devices: { e2e: devices.e2e, legacy: devices.legacy } },
      });
      return payload;
    },

    /** Never returns or requests a connector token. */
    async getEndpoint(installationCredential) {
      if (
        typeof installationCredential !== "string" ||
        !INSTALLATION_CREDENTIAL.test(installationCredential)
      ) {
        throw new ControlPlaneError("signed_out", 401);
      }
      const { payload } = await request("/v1/installations/self/endpoint", {
        token: installationCredential,
      });
      if (payload.endpoint === null) return null;
      const endpoint = validatedEndpoint(payload.endpoint);
      if (!endpoint) throw new ControlPlaneError("invalid_response");
      const status = stringValue(plainObject(payload.endpoint)?.status);
      return {
        url: endpoint.url,
        status: status !== null && ENDPOINT_STATUSES.has(status) ? status : "unknown",
      };
    },

    async deleteEndpoint(installationCredential) {
      if (
        typeof installationCredential !== "string" ||
        !INSTALLATION_CREDENTIAL.test(installationCredential)
      ) {
        throw new ControlPlaneError("signed_out", 401);
      }
      await request("/v1/installations/self/endpoint", {
        method: "DELETE",
        token: installationCredential,
        allowEmpty: true,
      });
    },

    async revokeInstallation(accountToken, installationId) {
      if (
        !boundedSecret(accountToken) ||
        typeof installationId !== "string" ||
        !INSTALLATION_ID.test(installationId)
      ) {
        throw new ControlPlaneError("signed_out", 401);
      }
      await request(`/v1/installations/${encodeURIComponent(installationId)}`, {
        method: "DELETE",
        token: accountToken,
        allowEmpty: true,
      });
    },

    async signOut(accountToken) {
      if (!boundedSecret(accountToken)) return;
      await request("/api/auth/sign-out", {
        method: "POST",
        token: accountToken,
      });
    },
  };
}
