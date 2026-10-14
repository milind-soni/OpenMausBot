// Only the installation credential and the relay origin cross to the server; nothing else of the account.
import {
  COMPANION_INSTALLATION_CREDENTIAL_FIELD,
  companionAccountCleanupPending,
} from "./companion-account-service.mjs";

export const PHONE_PUSH_RELAY_MESSAGE = "openmausbot:phone-push-relay";
const INSTALLATION_CREDENTIAL = /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

export function phonePushRelayMessage(credentials, controlPlane) {
  const credential = credentials?.[COMPANION_INSTALLATION_CREDENTIAL_FIELD];
  const usable = typeof controlPlane === "string" && controlPlane !== ""
    && typeof credential === "string" && INSTALLATION_CREDENTIAL.test(credential)
    && !companionAccountCleanupPending(credentials);
  return { type: PHONE_PUSH_RELAY_MESSAGE, access: usable ? { controlPlane, credential } : null };
}

export function createPhonePushRelaySync() {
  let last = "";
  return {
    sync(message, post) {
      const serialized = JSON.stringify(message);
      if (serialized === last) return false;
      if (!post(message)) return false;
      last = serialized;
      return true;
    },
    reset() {
      last = "";
    },
  };
}

export function createPhonePushRelay({ controlPlane, credentials, server, log }) {
  const relaySync = createPhonePushRelaySync();
  const sync = () => relaySync.sync(phonePushRelayMessage(credentials(), controlPlane()), (message) => {
    const proc = server();
    if (!proc) return false;
    try {
      proc.postMessage(message);
      return true;
    } catch (error) {
      log(`phone push relay sync failed: ${error?.message ?? error}`);
      return false;
    }
  });
  return {
    sync,
    serverStarted() {
      relaySync.reset();
      sync();
    },
  };
}
