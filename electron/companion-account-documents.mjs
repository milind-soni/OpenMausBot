// The account's fields in the secure credential document, and the pure reads and writes of them. Nothing here
// talks to the control plane or logs.
import { normalizeAccountEmail } from "./control-plane-client.mjs";
import {
  managedCompanionTunnelAccess,
  withManagedCompanionTunnelAccess,
  withoutManagedCompanionTunnelAccess,
} from "./managed-companion-tunnel.mjs";

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

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID = UUID;
const INSTALLATION_CREDENTIAL = /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
export const ownString = (document, field) =>
  typeof document?.[field] === "string" ? document[field] : "";

export function companionAccountCleanupPending(credentials) {
  return credentials?.[COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD] === true;
}
/** The control plane ended this signed-in computer's secure address for old phone apps ("retired"), and none came back. */ export const companionTunnelRetired = (credentials) => Boolean(storedAccount(credentials)) && !managedCompanionTunnelAccess(credentials) && credentials?.[COMPANION_TUNNEL_RETIRED_FIELD] === true;

export function storedAccount(credentials) {
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

export function withoutCompanionAccount(credentials) {
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

export function withInstallationCredentials(credentials, installation) {
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

export function withProvisionedAccount(credentials, { accountToken, user, installation, provision }) {
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

export function withAuthenticatedAccount(
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

export function publicState({ available, status, email, endpoint, message, paused, tunnelRetired }) {
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
