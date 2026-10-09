import {
  ControlPlaneError,
  normalizeAccountEmail,
  normalizeControlPlaneURL,
} from "./control-plane-client.mjs";
import {
  managedCompanionTunnelAccess,
  withManagedCompanionTunnelAccess,
  withoutManagedCompanionTunnelAccess,
} from "./managed-companion-tunnel.mjs";

export const DEFAULT_COMPANION_CONTROL_PLANE_URL = "https://accounts.openmausbot.com";

export const COMPANION_CLIENT_INSTANCE_FIELD = "companionClientInstanceId";
export const COMPANION_ACCOUNT_TOKEN_FIELD = "companionAccountToken";
export const COMPANION_ACCOUNT_USER_ID_FIELD = "companionAccountUserId";
export const COMPANION_ACCOUNT_EMAIL_FIELD = "companionAccountEmail";
export const COMPANION_INSTALLATION_ID_FIELD = "companionInstallationId";
export const COMPANION_INSTALLATION_CREDENTIAL_FIELD = "companionInstallationCredential";
export const COMPANION_INSTALLATION_EXPIRY_FIELD = "companionInstallationCredentialExpiresAt";
export const COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD = "companionAccountCleanupPending";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID = UUID;
const INSTALLATION_CREDENTIAL = /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const DEFAULT_HEALTH_CACHE_MS = 30_000;
const DEFAULT_AUTO_RETRY_BASE_MS = 10 * 60_000;
const DEFAULT_AUTO_RETRY_MAX_MS = 6 * 60 * 60_000;
const DEFAULT_ENDPOINT_CHECK_INTERVAL_MS = 15 * 60_000;
const DEFAULT_FIRST_ENDPOINT_CHECK_MS = 2 * 60_000;

/** Failures that clear up on their own: provider capacity, a transient
 * service or network problem, or a server-side rate limit. Anything that
 * needs the user (expired sign-in, computer limit) is never retried. */
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

/** Server endpoint states that mean this computer's saved connector token no
 * longer has a working route behind it (or that its last reconcile failed),
 * so the next reconcile must run instead of trusting the saved address. */
const ENDPOINT_NEEDS_RECONCILE = new Set(["deleting", "deleted", "error"]);

/** Connector states in which the watchdog asks the control plane whether the
 * saved endpoint still exists. "ready" is included on purpose: the connector
 * verifies its public route once, so after a long sleep it can still say
 * "ready" for a tunnel the server reclaimed meanwhile. "unavailable" (no
 * connector binary) and "stopped" are left alone. */
const WATCHDOG_CHECK_STATES = new Set(["starting", "ready", "retrying", "error"]);

const defaultSetTimer = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref?.();
  return timer;
};

const ownString = (document, field) =>
  typeof document?.[field] === "string" ? document[field] : "";

/** Packaged builds have a safe hosted default. Development must opt into an
 * exact HTTPS origin (or HTTP loopback Worker) so a contributor never sends
 * an OTP or bearer to an accidental host. An explicitly invalid override
 * disables the feature instead of silently falling back to production. */
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
  ]) {
    delete next[field];
  }
  // The UUID identifies this installation, not an account. Keeping it across
  // sign-outs lets a same-account recovery adopt the existing server record
  // rather than manufacturing a new computer every time.
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

const FRIENDLY_MESSAGES = Object.freeze({
  invalid_email: "Enter a valid email address.",
  invalid_request: "The secure connection request was not accepted. Check the details and try again.",
  invalid_otp: "That code is not valid. Check the email and try again.",
  otp_expired: "That code expired. Email yourself a new one.",
  unauthorized: "Your sign-in expired. Email yourself a new code to reconnect.",
  forbidden: "The secure connection request was not allowed. Try signing in again.",
  signed_out: "Your sign-in expired. Email yourself a new code to reconnect.",
  network_unavailable: "OpenMausBot could not reach its secure connection service. Check your internet and try again.",
  rate_limited: "Too many attempts were made. Wait a little, then try again.",
  credential_rotation_rate_limited: "This computer was reconnected too often. Wait a little, then try again.",
  installation_limit_reached: "This account has reached its computer limit. Remove an old computer and try again.",
  installation_exists: "This computer is already connected. Try again to recover it.",
  endpoint_busy: "The secure connection is still being prepared. Try again in a moment.",
  endpoint_rate_limited: "The secure connection service is busy right now. Local Wi-Fi and Tailscale pairing still work; try again in {wait}.",
  endpoint_capacity: "Secure HTTPS links are temporarily full. Pair on this Wi-Fi or with Tailscale for now; we'll retry automatically.",
  endpoint_unavailable: "The secure connection service could not finish setup. Local Wi-Fi and Tailscale pairing still work. If this keeps happening, contact support with the error reference.",
  endpoint_cleanup_pending: "The secure connection is still being removed. Try signing out again shortly.",
  control_plane_unavailable: "Secure access is not available right now. Local pairing still works.",
  internal_error: "The secure connection service had a problem. Local pairing still works; try again.",
  invalid_response: "The secure connection service returned an unexpected response. Try again.",
  request_failed: "The secure connection request could not be completed. Local pairing still works; try again.",
});

/** "45 seconds", "3 minutes", or "a few minutes" when the server gave no hint. */
function retryWait(retryAfterMs) {
  const seconds = Math.ceil((retryAfterMs ?? 0) / 1_000);
  if (!(seconds > 0)) return "a few minutes";
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}

export function friendlyCompanionAccountError(error) {
  const code = error instanceof ControlPlaneError ? error.code : "";
  const message = (FRIENDLY_MESSAGES[code] ?? FRIENDLY_MESSAGES.request_failed)
    .replace("{wait}", () => retryWait(error.retryAfterMs));
  const reference = error instanceof ControlPlaneError && error.requestId
    ? ` Reference: ${error.requestId}.`
    : "";
  return `${message}${reference}`;
}

function publicState({ available, status, email, endpoint, message }) {
  const state = { available: Boolean(available), status };
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

/** Authenticated hosted-Companion orchestration, with all Electron, storage,
 * and network mechanisms injected. Nothing returned by this service can
 * contain an account bearer, installation credential, connector token, or a
 * Cloudflare resource identifier. */
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
  // Background recovery is opt-in: the desktop app enables it, one-shot CLI
  // commands do not. When on, retryable setup failures are retried with
  // backoff, and a saved address whose server endpoint was removed (idle
  // reclaim) is re-provisioned without a new sign-in.
  autoRecover = false,
  setTimer = defaultSetTimer,
  clearTimer = clearTimeout,
  random = Math.random,
  autoRetryBaseMs = DEFAULT_AUTO_RETRY_BASE_MS,
  autoRetryMaxMs = DEFAULT_AUTO_RETRY_MAX_MS,
  endpointCheckIntervalMs = DEFAULT_ENDPOINT_CHECK_INTERVAL_MS,
  firstEndpointCheckMs = DEFAULT_FIRST_ENDPOINT_CHECK_MS,
  // One line per failed setup step, for server.log and the bug-report bundle.
  // The phase message is replaced by every retry, so without this a support
  // reference shown once is gone. Only the code, HTTP status, request id and
  // retry delay are written: never an email, token, credential or address.
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

  // Assigned below; scheduled retries go through the same serialized path
  // as the Retry button.
  let retryFromTimer = () => Promise.resolve();

  /** Exponential backoff with jitter, never sooner than the server asked. */
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
    if (!healthy) {
      return publicState({
        available,
        status: account ? "error" : "signed-out",
        email: account?.email,
        endpoint: persistedAccess?.endpoint,
        message: FRIENDLY_MESSAGES.control_plane_unavailable,
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
    if (phase) return publicState({ available, ...phase });
    if (!account) return publicState({ available, status: "signed-out" });
    const access = persistedAccess;
    if (!access) {
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

  /** Returns true only when the installation was revoked (which schedules
   * endpoint cleanup) and it is safe to forget its local retry credentials. */
  const cleanupCurrentAccount = async ({ markPending = true } = {}) => {
    const document = credentials();
    const account = storedAccount(document);
    if (!account) {
      await clearAfterCleanup();
      return true;
    }
    if (markPending && !companionAccountCleanupPending(document)) await markCleanupPending();
    await stopManagedEndpoint();

    // Deleting first gives immediate feedback. Revocation remains mandatory:
    // it invalidates the installation credential and gives the server a
    // durable cleanup path even if the direct delete failed halfway through.
    if (account.installationCredential) {
      try {
        await client.deleteEndpoint(account.installationCredential);
      } catch {
        // Revocation below is the authoritative cleanup schedule.
      }
    }
    if (!account.accountToken) {
      throw new ControlPlaneError("signed_out", 401);
    }

    // A request can create an installation (and even its endpoint) while its
    // response is lost, leaving no local ID or connector material. The stable
    // computer UUID is therefore the cleanup authority: list the account's
    // active installations and revoke every matching record before forgetting
    // the bearer. Revocation marks the owner row and durably schedules the
    // server-side endpoint sweep.
    const clientInstanceId = ownString(document, COMPANION_CLIENT_INSTANCE_FIELD);
    if (!UUID.test(clientInstanceId)) {
      throw new ControlPlaneError("invalid_client_identity");
    }

    // The known ID is a fast path. Its result is not trusted on its own: the
    // authoritative list below also catches a response-lost duplicate.
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
      // The installation and connector have already been revoked. A stale
      // Better Auth session expires server-side and must not block local
      // sign-out or retain its bearer on disk.
    }
    await clearAfterCleanup();
    return true;
  };

  const provision = async ({ accountToken, user }) => {
    const clientInstanceId = await ensureClientIdentity();
    const before = credentials();
    const previous = storedAccount(before);
    const installation = await client.ensureInstallation({
      accountToken,
      currentCredential:
        previous?.userId === user.id ? previous.installationCredential : "",
      clientInstanceId,
      name: identity.name,
      platform: identity.platform,
      appVersion: identity.appVersion,
    });
    // Retain the verified installation before provisioning the hosted route.
    // Otherwise a service failure makes each Retry recover by rotating the
    // credential, eventually rate-limiting an otherwise valid installation.
    try {
      await updateCredentials((document) => withInstallationCredentials(document, installation));
    } catch (error) {
      // Do not leave a newly discovered installation consuming account quota
      // when its recovery credential cannot be saved. Keep an established
      // installation only when its saved credential is still usable.
      if (previous?.installationId !== installation.installation.id ||
          previous?.installationCredential !== installation.credential) {
        await client.revokeInstallation(accountToken, installation.installation.id).catch(() => {});
      }
      throw error;
    }
    const endpoint = await client.ensureEndpoint(installation.credential);
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
      // Persistence failed after remote allocation. Best effort cleanup avoids
      // an invisible tunnel; no secret is ever written to a log or exception.
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
      // Logging never changes the outcome of a setup step.
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
        // The user supplied a fresh bearer to finish an interrupted sign-out.
        // Keep that intent and retry revocation; do not silently turn the
        // sign-out action into a new endpoint provisioning operation.
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

  const retry = () => serialize(retryWork);
  retryFromTimer = retry;

  /** Re-provision only on a definitive server answer that the saved address
   * has no working endpoint behind it. A network or service failure keeps
   * the saved address and its connector exactly as they are. Returns the
   * reconcile result, or null when nothing needed doing. */
  const reconcileIfEndpointGone = async () => {
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
      // A rejected installation credential (it expires after 90 days) is a
      // definitive answer too: the saved address can no longer be repaired
      // with it. Retry recovers through the account session, or shows the
      // "sign-in expired" state so the person is asked to sign in.
      if (error instanceof ControlPlaneError && error.status === 401) return retryWork();
      return null;
    }
    if (endpoint && endpoint.url === access.endpoint && !ENDPOINT_NEEDS_RECONCILE.has(endpoint.status)) {
      return null;
    }
    return retryWork();
  };

  /** While the companion is on, ask the control plane (cheaply, no provider
   * calls) every interval whether the endpoint still exists. This is how a
   * computer whose idle tunnel was reclaimed recovers on its own: after
   * Remote access is turned back on, and also when the app kept running
   * through a long sleep and its connector still reports the old "ready". */
  const watchdogTick = () => {
    watchdogTimer = null;
    if (disposed) return;
    watchdogTimer = setTimer(watchdogTick, endpointCheckIntervalMs);
    if (!companionIsOn() || autoRetryTimer !== null) return;
    // A sign-in only the person can renew; asking again changes nothing.
    if (phase?.status === "signed-out") return;
    const connection = managedConnectionState?.() ?? {};
    if (!WATCHDOG_CHECK_STATES.has(connection.status)) return;
    // Skip only a check that ran recently (restore's launch check, say). A
    // full-interval comparison would also skip the regular tick whenever the
    // previous check landed a few milliseconds after its own tick.
    if (lastEndpointCheck !== null && now() - lastEndpointCheck < endpointCheckIntervalMs / 2) return;
    void serialize(reconcileIfEndpointGone).catch(() => {});
  };

  const startWatchdog = () => {
    if (!autoRecover || disposed || !configured || watchdogTimer !== null) return;
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
      // Local access must stop even when the hosted control plane is down.
      // cleanupCurrentAccount first persists durable cleanup intent and stops
      // the connector, then attempts remote deletion/revocation with the
      // retained credentials. A failed remote step is retryable; a health
      // preflight here would leave paired-phone access live after Sign out.
      await cleanupCurrentAccount();
      // Successful owner-scoped reconciliation is stronger evidence than a
      // separate health probe and keeps the signed-out setup card available.
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
    const account = storedAccount(credentials());
    if (account && !managedCompanionTunnelAccess(credentials())) return retryWork();
    // Only when Remote access is on this launch: checking in otherwise would
    // mark an unused tunnel as recently seen and keep it from being reclaimed.
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
    signOut,
    restore,
    dispose,
  });
}
