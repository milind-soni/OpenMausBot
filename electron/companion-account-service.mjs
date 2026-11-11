import {
  ControlPlaneError,
  normalizeAccountEmail,
  normalizeControlPlaneURL,
} from "./control-plane-client.mjs";
import {
  MANAGED_COMPANION_ENDPOINT_FIELD,
  MANAGED_COMPANION_RELEASE_AT_FIELD,
  managedCompanionTunnelAccess,
  normalizeManagedCompanionEndpoint,
  withManagedCompanionTunnelAccess,
  withoutManagedCompanionTunnelAccess,
} from "./managed-companion-tunnel.mjs";
import { MANAGED_ENDPOINT_PHONES_UNUSED } from "./companion-endpoint-need.mjs";
import { FRIENDLY_MESSAGES, friendlyCompanionAccountError } from "./companion-account-messages.mjs";
export { friendlyCompanionAccountError };

export { managedEndpointNeed, PHONE_UNUSED_RELEASE_MS } from "./companion-endpoint-need.mjs";

export const DEFAULT_COMPANION_CONTROL_PLANE_URL = "https://accounts.openmausbot.com";

export const COMPANION_CLIENT_INSTANCE_FIELD = "companionClientInstanceId";
export const COMPANION_ACCOUNT_TOKEN_FIELD = "companionAccountToken";
export const COMPANION_ACCOUNT_USER_ID_FIELD = "companionAccountUserId";
export const COMPANION_ACCOUNT_EMAIL_FIELD = "companionAccountEmail";
export const COMPANION_INSTALLATION_ID_FIELD = "companionInstallationId";
export const COMPANION_INSTALLATION_CREDENTIAL_FIELD = "companionInstallationCredential";
export const COMPANION_INSTALLATION_EXPIRY_FIELD = "companionInstallationCredentialExpiresAt";
export const COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD = "companionAccountCleanupPending";
export const COMPANION_ENDPOINT_RELEASE_PENDING_FIELD = "companionEndpointReleasePending";
/** The address was given back while phones were paired but unused; the control plane keeps its hostname. */
export const COMPANION_ENDPOINT_PAUSED_FIELD = "companionEndpointPaused";
/** The control plane ended this computer's secure address for old phone apps: phones connect through the relay only. */
export const COMPANION_TUNNEL_RETIRED_FIELD = "companionTunnelRetired";
/** The control plane holds no address for this computer although an old phone would use one (ended for old phone
 * apps, or every account full): the watchdog keeps asking, so the address returns when the relay is switched off
 * or room frees up. */
export const COMPANION_TUNNEL_WAITING_FIELD = "companionTunnelWaiting";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID = UUID;
const INSTALLATION_CREDENTIAL = /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const DEFAULT_HEALTH_CACHE_MS = 30_000;
const DEFAULT_AUTO_RETRY_BASE_MS = 10 * 60_000;
const DEFAULT_AUTO_RETRY_MAX_MS = 6 * 60 * 60_000;
const DEFAULT_ENDPOINT_CHECK_INTERVAL_MS = 15 * 60_000;
const DEFAULT_FIRST_ENDPOINT_CHECK_MS = 2 * 60_000;
// The hour covers installing the phone app after the QR shows; the random spread keeps release waves inside Cloudflare's API budget.
const DEFAULT_RELEASE_GRACE_MS = 60 * 60_000;
const DEFAULT_RELEASE_JITTER_MS = 3 * 60 * 60_000;
const REQUEST_WINDOW_MS = 60 * 60_000;

const AUTO_RETRY_CODES = new Set([
  "endpoint_capacity",
  "endpoint_rate_limited",
  "endpoint_unavailable",
  "endpoint_busy",
  "network_unavailable",
  "control_plane_unavailable",
  "internal_error",
  "rate_limited",
  "credential_rotation_rate_limited",
]);

const ENDPOINT_NEEDS_RECONCILE = new Set(["deleting", "deleted", "error"]);

/** "ready" too: the connector verifies its route once, so after a long sleep it can report ready for a reclaimed tunnel. */
const WATCHDOG_CHECK_STATES = new Set(["starting", "ready", "retrying", "error"]);

const CONNECTOR_FAILING_STATES = new Set(["retrying", "error"]);

const defaultSetTimer = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref?.();
  return timer;
};

const ownString = (document, field) =>
  typeof document?.[field] === "string" ? document[field] : "";

/** Development must name an exact origin so an OTP or bearer never reaches an accidental host; an invalid override disables the feature. */
export function resolveCompanionControlPlaneURL({
  isPackaged,
  environment = process.env,
} = {}) {
  if (Object.hasOwn(environment, "OMB_CONTROL_PLANE_URL")) {
    return normalizeControlPlaneURL(environment.OMB_CONTROL_PLANE_URL);
  }
  return isPackaged ? DEFAULT_COMPANION_CONTROL_PLANE_URL : "";
}

export function companionAccountCleanupPending(credentials) {
  return credentials?.[COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD] === true;
}

function storedAccount(credentials) {
  const email = normalizeAccountEmail(ownString(credentials, COMPANION_ACCOUNT_EMAIL_FIELD));
  const userId = ownString(credentials, COMPANION_ACCOUNT_USER_ID_FIELD);
  if (!email || !userId || userId.length > 256) return null;
  return {
    email,
    userId,
    accountToken: ownString(credentials, COMPANION_ACCOUNT_TOKEN_FIELD),
    installationId: INSTALLATION_ID.test(ownString(credentials, COMPANION_INSTALLATION_ID_FIELD))
      ? credentials[COMPANION_INSTALLATION_ID_FIELD]
      : "",
    installationCredential: INSTALLATION_CREDENTIAL.test(
      ownString(credentials, COMPANION_INSTALLATION_CREDENTIAL_FIELD),
    )
      ? credentials[COMPANION_INSTALLATION_CREDENTIAL_FIELD]
      : "",
  };
}

function withoutCompanionAccount(credentials) {
  const next = withoutManagedCompanionTunnelAccess(credentials);
  for (const field of [
    COMPANION_ACCOUNT_TOKEN_FIELD,
    COMPANION_ACCOUNT_USER_ID_FIELD,
    COMPANION_ACCOUNT_EMAIL_FIELD,
    COMPANION_INSTALLATION_ID_FIELD,
    COMPANION_INSTALLATION_CREDENTIAL_FIELD,
    COMPANION_INSTALLATION_EXPIRY_FIELD,
    COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD,
    COMPANION_ENDPOINT_RELEASE_PENDING_FIELD,
    COMPANION_ENDPOINT_PAUSED_FIELD,
    COMPANION_TUNNEL_RETIRED_FIELD,
    COMPANION_TUNNEL_WAITING_FIELD,
  ]) {
    delete next[field];
  }
  // The installation UUID survives sign-out so a same-account recovery adopts the existing server record.
  return next;
}

function withInstallationCredentials(credentials, installation) {
  const next = {
    ...credentials,
    [COMPANION_INSTALLATION_ID_FIELD]: installation.installation.id,
    [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: installation.credential,
  };
  if (Number.isSafeInteger(installation.credentialExpiresAt)) {
    next[COMPANION_INSTALLATION_EXPIRY_FIELD] = installation.credentialExpiresAt;
  } else {
    delete next[COMPANION_INSTALLATION_EXPIRY_FIELD];
  }
  return next;
}

function withProvisionedAccount(credentials, { accountToken, user, installation, provision }) {
  const next = {
    ...withInstallationCredentials(withManagedCompanionTunnelAccess(credentials, provision), installation),
    [COMPANION_ACCOUNT_TOKEN_FIELD]: accountToken,
    [COMPANION_ACCOUNT_USER_ID_FIELD]: user.id,
    [COMPANION_ACCOUNT_EMAIL_FIELD]: user.email,
  };
  delete next[COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD];
  delete next[COMPANION_ENDPOINT_RELEASE_PENDING_FIELD];
  delete next[COMPANION_ENDPOINT_PAUSED_FIELD];
  delete next[COMPANION_TUNNEL_RETIRED_FIELD];
  delete next[COMPANION_TUNNEL_WAITING_FIELD];
  return next;
}

function withAuthenticatedAccount(
  credentials,
  { accountToken, user, clientInstanceId, preserveCleanupPending = false },
) {
  const next = {
    ...credentials,
    [COMPANION_ACCOUNT_TOKEN_FIELD]: accountToken,
    [COMPANION_ACCOUNT_USER_ID_FIELD]: user.id,
    [COMPANION_ACCOUNT_EMAIL_FIELD]: user.email,
  };
  if (!UUID.test(ownString(next, COMPANION_CLIENT_INSTANCE_FIELD))) {
    next[COMPANION_CLIENT_INSTANCE_FIELD] = clientInstanceId;
  }
  if (preserveCleanupPending) {
    next[COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD] = true;
  } else {
    delete next[COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD];
  }
  return next;
}

function publicState({ available, status, email, endpoint, message, paused, tunnelRetired }) {
  const state = { available: Boolean(available), status };
  if (paused === true) state.paused = true;
  if (tunnelRetired === true) state.tunnelRetired = true;
  const normalizedEmail = normalizeAccountEmail(email);
  if (normalizedEmail) state.email = normalizedEmail;
  const accessEndpoint = (() => {
    if (typeof endpoint !== "string") return "";
    try {
      const parsed = new URL(endpoint);
      return parsed.protocol === "https:" && parsed.pathname === "/" && !parsed.search && !parsed.hash
        ? parsed.origin
        : "";
    } catch {
      return "";
    }
  })();
  if (accessEndpoint) state.endpoint = accessEndpoint;
  const safeMessage = typeof message === "string" && message.length >= 1 && message.length <= 280
    ? message
    : null;
  if (safeMessage) state.message = safeMessage;
  return Object.freeze(state);
}

/** Nothing this service returns may contain an account bearer, installation credential, connector token or Cloudflare resource id. */
export function createCompanionAccountService({
  client,
  readCredentials,
  updateCredentials,
  identity,
  newClientInstanceId,
  activatePersistedEndpoint = async () => ({ status: "stopped", ready: false }),
  stopManagedEndpoint = async () => {},
  managedConnectionState = () => ({ status: "stopped", ready: false }),
  companionIsOn = () => false,
  now = Date.now,
  healthCacheMs = DEFAULT_HEALTH_CACHE_MS,
  autoRecover = false,
  setTimer = defaultSetTimer,
  clearTimer = clearTimeout,
  random = Math.random,
  autoRetryBaseMs = DEFAULT_AUTO_RETRY_BASE_MS,
  autoRetryMaxMs = DEFAULT_AUTO_RETRY_MAX_MS,
  endpointCheckIntervalMs = DEFAULT_ENDPOINT_CHECK_INTERVAL_MS,
  firstEndpointCheckMs = DEFAULT_FIRST_ENDPOINT_CHECK_MS,
  onDemand = false,
  managedEndpointNeeded = async () => null,
  /** MausBot Relay: `capable` makes a "no" need hold even right after sign-in; `legacyDevices` counts old phones. */
  relay = { capable: () => false, legacyDevices: async () => null },
  releaseGraceMs = DEFAULT_RELEASE_GRACE_MS,
  releaseJitterMs = DEFAULT_RELEASE_JITTER_MS,
  // Only the code, HTTP status, request id and retry delay: never an email, token, credential or address.
  log = () => {},
} = {}) {
  const configured = Boolean(client);
  let healthy = false;
  let lastHealthCheck = null;
  let healthProbe = null;
  let phase = null;
  let transition = Promise.resolve();
  let autoRetryTimer = null;
  let autoRetryAttempt = 0;
  let watchdogTimer = null;
  let lastEndpointCheck = null;
  let requestedAt = null;
  let disposed = false;

  const serialize = (work) => {
    const next = transition.then(work, work);
    transition = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  const credentials = () => readCredentials?.() ?? {};

  const cancelAutoRetry = () => {
    if (autoRetryTimer !== null) clearTimer(autoRetryTimer);
    autoRetryTimer = null;
  };

  const resetAutoRetry = () => {
    cancelAutoRetry();
    autoRetryAttempt = 0;
  };

  let retryFromTimer = () => Promise.resolve();

  const scheduleAutoRetry = (error) => {
    if (!autoRecover || disposed || !configured) return;
    if (!(error instanceof ControlPlaneError) || !AUTO_RETRY_CODES.has(error.code)) return;
    const document = credentials();
    if (!storedAccount(document) || companionAccountCleanupPending(document)) return;
    cancelAutoRetry();
    const backoff = Math.min(
      autoRetryMaxMs,
      autoRetryBaseMs * 2 ** Math.min(autoRetryAttempt, 20),
    );
    const jittered = Math.round(backoff * (0.8 + 0.4 * random()));
    const delay = Math.min(autoRetryMaxMs, Math.max(jittered, error.retryAfterMs ?? 0));
    autoRetryAttempt += 1;
    writeLog(`companion account: retrying ${error.code} in ${Math.round(delay / 1_000)}s (attempt ${autoRetryAttempt})`);
    autoRetryTimer = setTimer(() => {
      autoRetryTimer = null;
      void retryFromTimer().catch(() => {});
    }, delay);
  };

  const probeControlPlane = async ({ force = false } = {}) => {
    if (!configured) return false;
    const checkedAt = now();
    if (
      !force &&
      lastHealthCheck !== null &&
      checkedAt - lastHealthCheck < Math.max(0, healthCacheMs)
    ) {
      return healthy;
    }
    if (healthProbe) return healthProbe;
    healthProbe = (async () => {
      try {
        await client.health();
        healthy = true;
      } catch {
        healthy = false;
      }
      lastHealthCheck = now();
      return healthy;
    })().finally(() => {
      healthProbe = null;
    });
    return healthProbe;
  };

  const requireHealthyControlPlane = async () => {
    if (!(await probeControlPlane({ force: true }))) {
      throw new ControlPlaneError("control_plane_unavailable");
    }
  };

  const settledState = () => {
    if (!configured) {
      return publicState({
        available: false,
        status: "signed-out",
        message: FRIENDLY_MESSAGES.control_plane_unavailable,
      });
    }
    const document = credentials();
    const account = storedAccount(document);
    const persistedAccess = managedCompanionTunnelAccess(document);
    const available = healthy || Boolean(account);
    const paused = Boolean(account) && !persistedAccess && document[COMPANION_ENDPOINT_PAUSED_FIELD] === true;
    const tunnelRetired = Boolean(account) && !persistedAccess && document[COMPANION_TUNNEL_RETIRED_FIELD] === true;
    if (!healthy) {
      return publicState({
        available,
        status: account ? "error" : "signed-out",
        email: account?.email,
        endpoint: persistedAccess?.endpoint,
        message: FRIENDLY_MESSAGES.control_plane_unavailable,
        paused,
        tunnelRetired,
      });
    }
    if (
      phase &&
      ["connecting", "error"].includes(phase.status) &&
      account &&
      persistedAccess &&
      !companionAccountCleanupPending(document) &&
      managedConnectionState?.()?.ready === true
    ) {
      phase = null;
    }
    if (phase) return publicState({ available, ...phase, paused, tunnelRetired });
    if (!account) return publicState({ available, status: "signed-out" });
    const access = persistedAccess;
    if (!access) {
      if (onDemand) return publicState({ available, status: "ready", email: account.email, paused, tunnelRetired });
      return publicState({
        available,
        status: "error",
        email: account.email,
        message: "This computer still needs a secure address. Try again; local pairing continues to work.",
      });
    }
    const connection = managedConnectionState?.() ?? {};
    if (companionIsOn()) {
      if (["starting", "retrying"].includes(connection.status)) {
        return publicState({
          available,
          status: "connecting",
          email: account.email,
          endpoint: access.endpoint,
          message: "The secure connection is starting. Local pairing remains available.",
        });
      }
      if (["unavailable", "error"].includes(connection.status)) {
        return publicState({
          available,
          status: "error",
          email: account.email,
          endpoint: access.endpoint,
          message: "The secure connection needs attention. Local pairing still works.",
        });
      }
    }
    return publicState({
      available,
      status: "ready",
      email: account.email,
      endpoint: access.endpoint,
    });
  };

  const ensureClientIdentity = async () => {
    const existing = ownString(credentials(), COMPANION_CLIENT_INSTANCE_FIELD);
    if (UUID.test(existing)) return existing;
    const candidate = newClientInstanceId?.();
    if (!UUID.test(candidate ?? "")) throw new Error("A stable computer identity could not be created");
    await updateCredentials((document) => {
      if (UUID.test(ownString(document, COMPANION_CLIENT_INSTANCE_FIELD))) return document;
      return { ...document, [COMPANION_CLIENT_INSTANCE_FIELD]: candidate };
    });
    return ownString(credentials(), COMPANION_CLIENT_INSTANCE_FIELD);
  };

  const markCleanupPending = async () => {
    await updateCredentials((document) => ({
      ...document,
      [COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD]: true,
    }));
  };

  const clearAfterCleanup = async () => {
    await updateCredentials(withoutCompanionAccount);
    await stopManagedEndpoint();
    phase = null;
  };

  /** True only once revocation has scheduled endpoint cleanup, so the local retry credentials may be forgotten. */
  const cleanupCurrentAccount = async ({ markPending = true } = {}) => {
    const document = credentials();
    const account = storedAccount(document);
    if (!account) {
      await clearAfterCleanup();
      return true;
    }
    if (markPending && !companionAccountCleanupPending(document)) await markCleanupPending();
    await stopManagedEndpoint();

    // Delete first for immediate feedback; revocation below stays mandatory.
    if (account.installationCredential) {
      try {
        await client.deleteEndpoint(account.installationCredential);
      } catch {
      }
    }
    if (!account.accountToken) {
      throw new ControlPlaneError("signed_out", 401);
    }

    // A lost response can leave a server installation with no local ID, so revoke every record matching this computer's UUID before forgetting the bearer.
    const clientInstanceId = ownString(document, COMPANION_CLIENT_INSTANCE_FIELD);
    if (!UUID.test(clientInstanceId)) {
      throw new ControlPlaneError("invalid_client_identity");
    }

    if (account.installationId) {
      await client.revokeInstallation(account.accountToken, account.installationId).catch(() => {});
    }
    const installations = await client.listInstallations(account.accountToken);
    for (const installation of installations) {
      if (
        installation.clientInstanceId !== clientInstanceId &&
        installation.id !== account.installationId
      ) {
        continue;
      }
      try {
        await client.revokeInstallation(account.accountToken, installation.id);
      } catch (error) {
        if (!(error instanceof ControlPlaneError) || error.status !== 404) throw error;
      }
    }
    try {
      await client.signOut(account.accountToken);
    } catch {
    }
    await clearAfterCleanup();
    return true;
  };

  /** Finish a give-back the control plane left pending (on demand): until
   * that removal is done it creates no address for this installation. Once
   * its own sweep has done it, the DELETE is answered at once. If this one
   * fails too, the request that follows says why. */
  const finishPendingRelease = async () => {
    const document = credentials();
    const credential = storedAccount(document)?.installationCredential;
    if (document[COMPANION_ENDPOINT_RELEASE_PENDING_FIELD] !== true || !credential) return;
    try {
      await client.deleteEndpoint(credential);
    } catch {
      return;
    }
    await updateCredentials((current) => {
      const next = { ...current };
      delete next[COMPANION_ENDPOINT_RELEASE_PENDING_FIELD];
      return next;
    });
  };

  const provision = async ({ accountToken, user }) => {
    const clientInstanceId = await ensureClientIdentity();
    await finishPendingRelease();
    const before = credentials();
    const previous = storedAccount(before);
    const installation = await client.ensureInstallation({
      accountToken,
      currentCredential:
        previous?.userId === user.id ? previous.installationCredential : "",
      clientInstanceId,
      name: identity.name,
      platform: identity.platform,
      appVersion: identity.appVersion, ...(identity.kind ? { kind: identity.kind } : {}),
    });
    // Persist the verified installation before provisioning, or each Retry rotates the credential until rate-limited.
    try {
      await updateCredentials((document) => withInstallationCredentials(document, installation));
    } catch (error) {
      if (previous?.installationId !== installation.installation.id ||
          previous?.installationCredential !== installation.credential) {
        await client.revokeInstallation(accountToken, installation.installation.id).catch(() => {});
      }
      throw error;
    }
    const withoutTunnel = async () => {
      await updateCredentials((document) => withAuthenticatedAccount(document, { accountToken, user, clientInstanceId }));
      resetAutoRetry();
      return (phase = null), settledState();
    };
    if (onDemand && (await currentNeed()) === false) return withoutTunnel();
    let relayOnly = null;
    const endpoint = await client.ensureEndpoint(installation.credential, { appVersion: identity.appVersion, ...(identity.kind ? { kind: identity.kind } : {}), ...(await relay.legacyDevices().then((count) => (count === null ? {} : { legacyDevices: count }))) })
      .catch((error) => {
        if (error?.code !== "relay_capable") throw error;
        relayOnly = error.tunnel ?? "none";
        return null;
      });
    if (!endpoint) {
      // The control plane holds no tunnel for this computer any more: stop the connector and forget the address, so
      // nothing keeps dialling or advertising one that is gone. "retired" is remembered for the notice in Settings.
      if (managedCompanionTunnelAccess(credentials())) {
        await stopManagedEndpoint();
        await updateCredentials(withoutManagedCompanionTunnelAccess);
        writeLog(`companion account: the secure address ended (${relayOnly}); phones connect through the relay`);
      }
      await updateCredentials((document) => {
        const next = { ...document };
        if (relayOnly === "retired") next[COMPANION_TUNNEL_RETIRED_FIELD] = true;
        else delete next[COMPANION_TUNNEL_RETIRED_FIELD];
        // With the address forgotten nothing else would ask again: this keeps the watchdog asking.
        if (relayOnly === "retired" || relayOnly === "full") next[COMPANION_TUNNEL_WAITING_FIELD] = true;
        else delete next[COMPANION_TUNNEL_WAITING_FIELD];
        return next;
      });
      return withoutTunnel();
    }
    try {
      await updateCredentials((document) =>
        withProvisionedAccount(document, {
          accountToken,
          user,
          installation,
          provision: endpoint,
        }),
      );
    } catch (error) {
      // Best-effort cleanup avoids an invisible tunnel; no secret ever reaches a log or exception.
      await client.deleteEndpoint(installation.credential).catch(() => {});
      await client.revokeInstallation(accountToken, installation.installation.id).catch(() => {});
      throw error;
    }
    resetAutoRetry();
    const connection = await activatePersistedEndpoint();
    phase = null;
    if (
      companionIsOn() &&
      connection &&
      ["unavailable", "error"].includes(connection.status)
    ) {
      phase = {
        status: "error",
        email: user.email,
        endpoint: endpoint.endpoint.url,
        message: "The address is ready, but this app could not start its secure connection. Local pairing still works.",
      };
    }
    return settledState();
  };

  const writeLog = (line) => {
    try {
      log(line);
    } catch {
    }
  };

  const failAction = (
    error,
    { email, expiredSessionIsSignedOut = false, signedOut = false } = {},
  ) => {
    const message = friendlyCompanionAccountError(error);
    writeLog(
      error instanceof ControlPlaneError
        ? `companion account: setup failed code=${error.code} status=${error.status || "none"} ref=${error.requestId || "none"}`
        : "companion account: setup failed on this computer (not a control-plane answer)",
    );
    phase = {
      status:
        signedOut ||
        (expiredSessionIsSignedOut && error instanceof ControlPlaneError && error.status === 401)
          ? "signed-out"
          : "error",
      email,
      message,
    };
    return message;
  };

  const requestCode = (rawEmail) => serialize(async () => {
    if (!configured) throw new Error(FRIENDLY_MESSAGES.control_plane_unavailable);
    const email = normalizeAccountEmail(rawEmail);
    let requested;
    try {
      await requireHealthyControlPlane();
      requested = await client.requestOTP(email);
    } catch (error) {
      const message = failAction(error, { email, signedOut: true });
      throw new Error(message);
    }
    phase = {
      status: "signed-out",
      email: requested.email,
    };
    return settledState();
  });

  const verifyCode = (rawEmail, rawCode) => serialize(async () => {
    if (!configured) throw new Error(FRIENDLY_MESSAGES.control_plane_unavailable);
    requestedAt = now();
    const email = normalizeAccountEmail(rawEmail);
    phase = { status: "connecting", email };
    let verified;
    try {
      await requireHealthyControlPlane();
      verified = await client.verifyOTP(email, rawCode);
    } catch (error) {
      const message = failAction(error, { email, signedOut: true });
      throw new Error(message);
    }

    const previous = storedAccount(credentials());
    const refreshingPendingCleanup = Boolean(
      previous &&
      previous.userId === verified.user.id &&
      companionAccountCleanupPending(credentials()),
    );
    let authenticatedPersisted = false;
    try {
      if (previous && previous.userId !== verified.user.id) {
        await cleanupCurrentAccount();
      }
      const existingIdentity = ownString(credentials(), COMPANION_CLIENT_INSTANCE_FIELD);
      const clientInstanceId = UUID.test(existingIdentity)
        ? existingIdentity
        : newClientInstanceId?.();
      if (!UUID.test(clientInstanceId ?? "")) {
        throw new Error("A stable computer identity could not be created");
      }
      await updateCredentials((document) =>
        withAuthenticatedAccount(document, {
          ...verified,
          clientInstanceId,
          preserveCleanupPending: refreshingPendingCleanup,
        }),
      );
      authenticatedPersisted = true;
      if (refreshingPendingCleanup) {
        // Finish the interrupted sign-out; never turn it into a new endpoint provisioning.
        await cleanupCurrentAccount({ markPending: false });
        return settledState();
      }
      return await provision(verified);
    } catch (error) {
      if (!authenticatedPersisted) await client.signOut(verified.accountToken).catch(() => {});
      failAction(error, {
        email: authenticatedPersisted ? verified.user.email : previous?.email ?? email,
        expiredSessionIsSignedOut: authenticatedPersisted,
      });
      if (authenticatedPersisted) scheduleAutoRetry(error);
      return settledState();
    }
  });

  const retryWork = async () => {
    if (!configured) return settledState();
    const account = storedAccount(credentials());
    if (!account) {
      phase = null;
      return settledState();
    }
    if (companionAccountCleanupPending(credentials())) {
      phase = { status: "connecting", email: account.email };
      try {
        await requireHealthyControlPlane();
        await cleanupCurrentAccount({ markPending: false });
      } catch (error) {
        failAction(error, { email: account.email, expiredSessionIsSignedOut: true });
      }
      return settledState();
    }
    phase = { status: "connecting", email: account.email };
    try {
      await requireHealthyControlPlane();
      return await provision({
        accountToken: account.accountToken,
        user: { id: account.userId, email: account.email },
      });
    } catch (error) {
      failAction(error, { email: account.email, expiredSessionIsSignedOut: true });
      scheduleAutoRetry(error);
      return settledState();
    }
  };

  const retry = () => serialize(async () => {
    requestedAt = now();
    return retryWork();
  });

  /** Re-provisions only on a definitive "no endpoint" answer; a network or service failure keeps everything as is. */
  const reconcileIfEndpointGone = async ({ onGone = retryWork } = {}) => {
    const document = credentials();
    const account = storedAccount(document);
    const access = managedCompanionTunnelAccess(document);
    if (
      !account ||
      !access ||
      !account.installationCredential ||
      companionAccountCleanupPending(document) ||
      typeof client.getEndpoint !== "function"
    ) {
      return null;
    }
    lastEndpointCheck = now();
    let endpoint;
    try {
      endpoint = await client.getEndpoint(account.installationCredential);
    } catch (error) {
      if (error instanceof ControlPlaneError && error.status === 401) return onGone();
      return null;
    }
    if (endpoint && endpoint.url === access.endpoint && !ENDPOINT_NEEDS_RECONCILE.has(endpoint.status)) {
      return null;
    }
    return onGone();
  };

  const endpointCheckDue = () =>
    lastEndpointCheck === null || now() - lastEndpointCheck >= endpointCheckIntervalMs / 2;

  /** Only while Remote access is on: a check-in marks an unused tunnel as recently seen, which blocks its reclaim. */
  const recoveryDue = ({ atLaunch = false } = {}) => {
    if (!autoRecover || !companionIsOn()) return false;
    if (atLaunch) return true;
    if (autoRetryTimer !== null) return false;
    const connection = managedConnectionState?.() ?? {};
    return WATCHDOG_CHECK_STATES.has(connection.status) && endpointCheckDue();
  };

  const requestedRecently = () => requestedAt !== null && now() - requestedAt < REQUEST_WINDOW_MS;

  const savedAddress = (document) => normalizeManagedCompanionEndpoint(document[MANAGED_COMPANION_ENDPOINT_FIELD]);

  let phonesUnused = false;
  /** "unused" (paired phones, none seen for 30 days) reads as false and is remembered for the release. */
  const currentNeed = async () => {
    const answer = await Promise.resolve().then(() => managedEndpointNeeded()).catch(() => null);
    phonesUnused = answer === MANAGED_ENDPOINT_PHONES_UNUSED;
    const need = phonesUnused ? false : typeof answer === "boolean" ? answer : null;
    if (need === false && relay.capable()) return false;
    if (requestedRecently()) return (phonesUnused = false), true;
    return need;
  };

  const releaseScheduledAt = () => {
    const at = credentials()[MANAGED_COMPANION_RELEASE_AT_FIELD];
    return Number.isSafeInteger(at) && at > 0 ? at : null;
  };

  const cancelRelease = async () => {
    if (releaseScheduledAt() === null) return;
    await updateCredentials((document) => {
      const next = { ...document };
      delete next[MANAGED_COMPANION_RELEASE_AT_FIELD];
      return next;
    });
  };

  /** The connector stops and the address is withdrawn before the DELETE, so nothing can pair to an address being removed. */
  const releaseAddress = async () => {
    const need = await currentNeed();
    const pause = phonesUnused;
    if (need !== false) {
      if (need) await cancelRelease();
      return settledState();
    }
    const document = credentials();
    const account = storedAccount(document);
    if (
      !account?.installationCredential ||
      !managedCompanionTunnelAccess(document) ||
      companionAccountCleanupPending(document)
    ) {
      return settledState();
    }
    await stopManagedEndpoint();
    let removalPending = false;
    try {
      await client.deleteEndpoint(account.installationCredential);
    } catch (error) {
      removalPending = error instanceof ControlPlaneError && error.code === "endpoint_cleanup_pending";
      const handedOver = removalPending || (error instanceof ControlPlaneError && error.status === 401);
      if (!handedOver) {
        writeLog(
          error instanceof ControlPlaneError
            ? `companion account: could not give the secure address back code=${error.code} status=${error.status || "none"} ref=${error.requestId || "none"}`
            : "companion account: could not give the secure address back (not a control-plane answer)",
        );
        await activatePersistedEndpoint();
        return settledState();
      }
    }
    await updateCredentials((current) => ({
      ...withoutManagedCompanionTunnelAccess(current),
      ...(removalPending ? { [COMPANION_ENDPOINT_RELEASE_PENDING_FIELD]: true } : {}),
      ...(pause ? { [COMPANION_ENDPOINT_PAUSED_FIELD]: true } : {}),
    }));
    resetAutoRetry();
    phase = null;
    writeLog(pause
      ? "companion account: gave the secure address back; no paired phone was used in 30 days"
      : "companion account: gave the secure address back; no device needs it");
    return settledState();
  };

  const reviewAddress = async ({ atLaunch = false } = {}) => {
    const document = credentials();
    if (!storedAccount(document) || companionAccountCleanupPending(document)) return null;
    if (!managedCompanionTunnelAccess(document)) {
      // Waiting: the control plane ended the address or had no room. Asked again on every watchdog tick while an
      // old phone still needs it, as a desktop that kept its address does.
      const waiting = document[COMPANION_TUNNEL_WAITING_FIELD] === true;
      if ((!savedAddress(document) && !waiting) || autoRetryTimer !== null) return null;
      return (await currentNeed()) === true ? retryWork() : null;
    }
    const need = await currentNeed();
    if (need !== false) {
      if (need) await cancelRelease();
      if (need === null && atLaunch) return null;
      return recoveryDue({ atLaunch }) ? reconcileIfEndpointGone() : null;
    }
    const releaseAt = releaseScheduledAt();
    if (releaseAt !== null && now() >= releaseAt) return releaseAddress();
    const connection = managedConnectionState?.() ?? {};
    if (
      companionIsOn() &&
      CONNECTOR_FAILING_STATES.has(connection.status) &&
      (atLaunch || endpointCheckDue())
    ) {
      const released = await reconcileIfEndpointGone({ onGone: releaseAddress });
      if (released) return released;
    }
    if (releaseAt === null || releaseAt - now() > releaseGraceMs + releaseJitterMs) {
      const delay = releaseGraceMs + Math.round(random() * releaseJitterMs);
      await updateCredentials((current) => managedCompanionTunnelAccess(current)
        ? { ...current, [MANAGED_COMPANION_RELEASE_AT_FIELD]: now() + delay }
        : current);
      writeLog(`companion account: no device needs the secure address; giving it back in ${Math.round(delay / 60_000)} min`);
    }
    return null;
  };

  const retryIfWanted = async () => {
    if (requestedRecently()) return retryWork();
    if (savedAddress(credentials()) && (await currentNeed()) !== false) {
      return retryWork();
    }
    resetAutoRetry();
    if (phase?.status === "error") phase = null;
    writeLog("companion account: stopped retrying; no device needs a secure address");
    return settledState();
  };

  retryFromTimer = () => serialize(onDemand ? retryIfWanted : retryWork);

  const prepare = () => serialize(async () => {
    const document = credentials();
    if (
      !configured ||
      !companionIsOn() ||
      !storedAccount(document) ||
      companionAccountCleanupPending(document)
    ) {
      return settledState();
    }
    requestedAt = now();
    if (!managedCompanionTunnelAccess(document)) return retryWork();
    await cancelRelease();
    const connection = managedConnectionState?.() ?? {};
    if (["stopped", "unconfigured"].includes(connection.status)) {
      await activatePersistedEndpoint();
    } else if (CONNECTOR_FAILING_STATES.has(connection.status)) {
      const repaired = await reconcileIfEndpointGone();
      if (repaired) return repaired;
    }
    return settledState();
  });

  const watchdogTick = () => {
    watchdogTimer = null;
    if (disposed) return;
    watchdogTimer = setTimer(watchdogTick, endpointCheckIntervalMs);
    if (phase?.status === "signed-out") return;
    if (onDemand) {
      void serialize(() => reviewAddress()).catch(() => {});
      return;
    }
    if (recoveryDue()) void serialize(() => reconcileIfEndpointGone()).catch(() => {});
  };

  const startWatchdog = () => {
    if (!(autoRecover || onDemand) || disposed || !configured || watchdogTimer !== null) return;
    watchdogTimer = setTimer(watchdogTick, firstEndpointCheckMs);
  };

  const signOut = () => serialize(async () => {
    resetAutoRetry();
    if (!storedAccount(credentials())) {
      await clearAfterCleanup();
      return settledState();
    }
    const email = storedAccount(credentials())?.email;
    phase = { status: "connecting", email };
    try {
      // No health preflight: local access must stop on Sign out even when the control plane is down.
      await cleanupCurrentAccount();
      healthy = true;
      lastHealthCheck = now();
      return settledState();
    } catch (error) {
      failAction(error, { email });
      return settledState();
    }
  });

  const restore = () => serialize(async () => {
    if (!configured) return settledState();
    startWatchdog();
    if (!(await probeControlPlane({ force: true }))) return settledState();
    if (companionAccountCleanupPending(credentials())) return retryWork();
    await ensureClientIdentity();
    if (onDemand) {
      const reviewed = await reviewAddress({ atLaunch: true });
      if (reviewed) return reviewed;
      phase = null;
      return settledState();
    }
    const account = storedAccount(credentials());
    if (account && !managedCompanionTunnelAccess(credentials())) return retryWork();
    if (autoRecover && account && companionIsOn()) {
      const reconciled = await reconcileIfEndpointGone();
      if (reconciled) return reconciled;
    }
    phase = null;
    return settledState();
  });

  const dispose = () => {
    disposed = true;
    cancelAutoRetry();
    if (watchdogTimer !== null) clearTimer(watchdogTimer);
    watchdogTimer = null;
  };

  return Object.freeze({
    state: async () => {
      await probeControlPlane();
      return settledState();
    },
    requestCode,
    verifyCode,
    retry,
    prepare,
    signOut,
    restore,
    dispose,
  });
}
