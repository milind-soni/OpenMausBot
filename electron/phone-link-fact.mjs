// How many paired phones have an older MausBot app that lost its way in when the control plane ended this computer's
// secure link ("retired"); 0 when it was not ended. Told to the local server when it changes and when a server starts.
import { deviceCounts } from "./companion-e2e.mjs";

/** @param {{ retired: () => boolean, server: () => { postMessage(message: unknown): void } | null, log: (line: string) => void }} options */
export function createPhoneLinkFact({ retired, server, log }) {
  let devices = null;
  let sent = null;
  const count = () => {
    try {
      return retired() && devices ? deviceCounts(devices).legacy : 0;
    } catch {
      return 0;
    }
  };
  const send = () => {
    const proc = server();
    if (!proc) return;
    const olderPhoneApps = count();
    if (sent?.proc === proc && sent.olderPhoneApps === olderPhoneApps) return;
    try {
      proc.postMessage({ type: "openmausbot:phone-link", olderPhoneApps });
      sent = { proc, olderPhoneApps };
    } catch (error) {
      log(`phone link fact sync failed: ${error?.message ?? error}`);
    }
  };
  return {
    /** A state that errored or could not read its devices tells nothing. */
    observe(state) {
      if (state && typeof state === "object" && !state.error && state.devicesUnreadable !== true && Array.isArray(state.devices)) devices = state;
      send();
    },
    serverStarted() {
      sent = null;
      send();
    },
  };
}
