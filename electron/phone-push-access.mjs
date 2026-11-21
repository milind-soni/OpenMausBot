// Closed-app phone alerts: the server asks the push relay in the hosted control plane to wake a phone, as this
// installation (server/phone-push.ts). The installation credential lives in the OS-encrypted credential store, which
// only this main process reads, so main hands the server the control plane's origin and that credential over the
// utility process's private parent port: on every server start and whenever the stored document changes (sign-in,
// rotation, sign-out). Nothing else of the account crosses. Without a hosted sign-in the message says `access: null`.
import { COMPANION_INSTALLATION_CREDENTIAL_FIELD, companionAccountCleanupPending } from "./companion-account-service.mjs";

export const PHONE_PUSH_ACCESS_MESSAGE = "openmausbot:phone-push-access";
const INSTALLATION_CREDENTIAL = /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

/** The message for the server, from the credential document and the control plane's origin ("" when hosted access is
 * off in this build). */
export function phonePushAccessMessage(credentials, controlPlane) {
  const credential = credentials?.[COMPANION_INSTALLATION_CREDENTIAL_FIELD];
  const usable = typeof controlPlane === "string" && controlPlane !== ""
    && typeof credential === "string" && INSTALLATION_CREDENTIAL.test(credential)
    && !companionAccountCleanupPending(credentials);
  return { type: PHONE_PUSH_ACCESS_MESSAGE, access: usable ? { controlPlane, credential } : null };
}

/**
 * @param {{ server: () => { postMessage(message: object): void } | null, credentials: () => object | null,
 *   controlPlane: () => string, log: (line: string) => void }} options
 */
export function createPhonePushAccessSync({ server, credentials, controlPlane, log }) {
  let last = "";
  const sync = () => {
    const proc = server();
    if (!proc) return false;
    const message = phonePushAccessMessage(credentials(), controlPlane());
    const serialized = JSON.stringify(message);
    if (serialized === last) return false;
    try {
      proc.postMessage(message);
    } catch (error) {
      log(`phone push access sync failed: ${error?.message ?? error}`);
      return false;
    }
    last = serialized;
    return true;
  };
  return {
    sync,
    /** A new server child knows nothing yet. */
    serverStarted() {
      last = "";
      return sync();
    },
  };
}
