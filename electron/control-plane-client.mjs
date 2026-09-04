const INSTALLATION_CREDENTIAL =
  /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const INSTALLATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOT_SHARE_ID = /^[A-Za-z0-9_-]{21}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BOT_PACKAGE_MAX_BYTES = 1_000_000;

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

export class ControlPlaneError extends Error {
  constructor(code, status = 0, requestId = "") {
    super(code);
    this.name = "ControlPlaneError";
    this.code = code;
    this.status = status;
    this.requestId = REQUEST_ID.test(requestId) ? requestId : "";
  }
}

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

/** Production accepts HTTPS only. A loopback HTTP origin remains available
 * for an explicitly configured development Worker. Paths, credentials, and
 * query strings are rejected so every request stays under the audited API. */
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

function safeInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum ? value : null;
}

function boundedText(value, maximum) {
  const input = stringValue(value);
  return input !== null && input.length >= 1 && input.length <= maximum ? input : null;
}

function validatedBotShare(value, origin) {
  const share = plainObject(value);
  const id = stringValue(share?.id);
  const visibility = share?.visibility;
  const activeVersion = safeInteger(share?.activeVersion, 1);
  const name = boundedText(share?.name, 100);
  const summary = boundedText(share?.summary, 2_000);
  const sha256 = stringValue(share?.sha256);
  const byteSize = safeInteger(share?.byteSize, 1);
  const createdAt = safeInteger(share?.createdAt);
  const updatedAt = safeInteger(share?.updatedAt);
  const versionCreatedAt = safeInteger(share?.versionCreatedAt);
  if (
    id === null || !BOT_SHARE_ID.test(id) ||
    !["unlisted", "private"].includes(visibility) ||
    activeVersion === null || !name || !summary ||
    sha256 === null || !SHA256.test(sha256) ||
    byteSize === null || byteSize > BOT_PACKAGE_MAX_BYTES ||
    createdAt === null || updatedAt === null || versionCreatedAt === null ||
    share?.shareUrl !== `${origin}/s/${id}` ||
    share?.packageUrl !== `${origin}/v1/bot-shares/${id}/package`
  ) return null;
  return {
    id, visibility, activeVersion, name, summary, sha256, byteSize,
    createdAt, updatedAt, versionCreatedAt,
    shareUrl: share.shareUrl, packageUrl: share.packageUrl,
  };
}

function validatedPackageMarkdown(value) {
  if (typeof value !== "string" || !value) return null;
  return new TextEncoder().encode(value).byteLength <= BOT_PACKAGE_MAX_BYTES ? value : null;
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
    { method = "GET", bearer, body, allowEmpty = false, deadlineMs = timeoutMs } = {},
  ) => {
    const headers = new Headers({ accept: "application/json" });
    if (bearer) headers.set("authorization", `Bearer ${bearer}`);
    // Node's fetch sends `Sec-Fetch-Mode: cors` even though Electron is a
    // native client. Better Auth 1.7 treats that Fetch Metadata as a
    // browser-shaped request and requires a trusted Origin. Our exact,
    // validated control-plane origin is already trusted by the Worker; send
    // it only to Better Auth routes instead of weakening server CSRF checks.
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
      );
    }
    if (!allowEmpty && !plainObject(payload)) {
      throw new ControlPlaneError("invalid_response", response.status);
    }
    return { response, payload };
  };

  const accountInstallations = async (accountToken) => {
    if (!boundedSecret(accountToken)) throw new ControlPlaneError("signed_out", 401);
    const { payload } = await request("/v1/installations", { bearer: accountToken });
    if (!Array.isArray(payload.installations)) {
      throw new ControlPlaneError("invalid_response");
    }
    const installations = payload.installations.map(validatedInstallation);
    if (installations.some((installation) => !installation)) {
      throw new ControlPlaneError("invalid_response");
    }
    return installations;
  };

  const accountTokenOrThrow = (accountToken) => {
    const bearer = boundedSecret(accountToken);
    if (!bearer || INSTALLATION_CREDENTIAL.test(bearer)) throw new ControlPlaneError("signed_out", 401);
    return bearer;
  };

  const shareFromPayload = (payload) => {
    const share = validatedBotShare(payload.share, origin);
    if (!share) throw new ControlPlaneError("invalid_response");
    return share;
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
      // The server deliberately gives the same result for known and unknown
      // addresses. Preserve that enumeration-safe contract in the UI.
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
      // Better Auth's response JSON includes its raw database token. The
      // signed bearer plugin intentionally publishes a different credential
      // in this header; only that signed value may cross our API boundary.
      const accountToken = boundedSecret(response.headers.get("set-auth-token"));
      const user = validatedUser(payload.user);
      if (!accountToken || !user || user.email !== email) {
        throw new ControlPlaneError("invalid_response", response.status);
      }
      return { accountToken, user };
    },

    async me(accountToken) {
      if (!boundedSecret(accountToken)) throw new ControlPlaneError("signed_out", 401);
      const { payload } = await request("/v1/me", { bearer: accountToken });
      const user = validatedUser(payload.user);
      if (!user) throw new ControlPlaneError("invalid_response");
      return user;
    },

    async listInstallations(accountToken) {
      return accountInstallations(accountToken);
    },

    async listBotShares(accountToken) {
      const { payload } = await request("/v1/bot-shares", { bearer: accountTokenOrThrow(accountToken) });
      if (!Array.isArray(payload.shares)) throw new ControlPlaneError("invalid_response");
      const shares = payload.shares.map((share) => validatedBotShare(share, origin));
      if (shares.some((share) => !share)) throw new ControlPlaneError("invalid_response");
      return shares;
    },

    async createBotShare(accountToken, { packageMarkdown, visibility = "unlisted" } = {}) {
      const markdown = validatedPackageMarkdown(packageMarkdown);
      if (!markdown || !["unlisted", "private"].includes(visibility)) {
        throw new ControlPlaneError("invalid_request", 400);
      }
      const { payload } = await request("/v1/bot-shares", {
        method: "POST", bearer: accountTokenOrThrow(accountToken),
        body: { packageMarkdown: markdown, visibility },
      });
      return shareFromPayload(payload);
    },

    async updateBotShare(accountToken, shareId, { packageMarkdown, expectedActiveVersion } = {}) {
      const markdown = validatedPackageMarkdown(packageMarkdown);
      if (!BOT_SHARE_ID.test(String(shareId)) || !markdown || !Number.isSafeInteger(expectedActiveVersion) || expectedActiveVersion < 1) {
        throw new ControlPlaneError("invalid_request", 400);
      }
      const { payload } = await request(`/v1/bot-shares/${shareId}/versions`, {
        method: "POST", bearer: accountTokenOrThrow(accountToken),
        body: { packageMarkdown: markdown, expectedActiveVersion },
      });
      return shareFromPayload(payload);
    },

    async setBotShareVisibility(accountToken, shareId, visibility) {
      if (!BOT_SHARE_ID.test(String(shareId)) || !["unlisted", "private"].includes(visibility)) {
        throw new ControlPlaneError("invalid_request", 400);
      }
      const { payload } = await request(`/v1/bot-shares/${shareId}/visibility`, {
        method: "POST", bearer: accountTokenOrThrow(accountToken), body: { visibility },
      });
      return shareFromPayload(payload);
    },

    async deleteBotShare(accountToken, shareId) {
      if (!BOT_SHARE_ID.test(String(shareId))) throw new ControlPlaneError("invalid_request", 400);
      await request(`/v1/bot-shares/${shareId}`, {
        method: "DELETE", bearer: accountTokenOrThrow(accountToken), allowEmpty: true,
      });
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
          const { payload } = await request("/v1/installations/self", { bearer: currentCredential });
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
          // A transient outage must not rotate a perfectly usable identity.
          // Only a definitive 401 falls through to account recovery.
          if (!(error instanceof ControlPlaneError) || error.status !== 401) throw error;
        }
      }

      if (!boundedSecret(accountToken)) throw new ControlPlaneError("signed_out", 401);
      const installations = await accountInstallations(accountToken);
      const existing = installations.find((item) => item.clientInstanceId === clientInstanceId);
      const result = existing
        ? await request(`/v1/installations/${encodeURIComponent(existing.id)}/credentials/rotate`, {
            method: "POST",
            bearer: accountToken,
          })
        : await request("/v1/installations", {
            method: "POST",
            bearer: accountToken,
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

    async ensureEndpoint(installationCredential) {
      if (
        typeof installationCredential !== "string" ||
        !INSTALLATION_CREDENTIAL.test(installationCredential)
      ) {
        throw new ControlPlaneError("signed_out", 401);
      }
      const { payload } = await request("/v1/installations/self/endpoint", {
        method: "POST",
        bearer: installationCredential,
      });
      const endpoint = validatedEndpoint(payload.endpoint);
      const connectorToken = boundedSecret(payload.connectorToken, 16_384);
      if (!endpoint || !connectorToken) throw new ControlPlaneError("invalid_response");
      return { endpoint, connectorToken };
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
        bearer: installationCredential,
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
        bearer: accountToken,
        allowEmpty: true,
      });
    },

    async signOut(accountToken) {
      if (!boundedSecret(accountToken)) return;
      await request("/api/auth/sign-out", {
        method: "POST",
        bearer: accountToken,
      });
    },
  };
}
