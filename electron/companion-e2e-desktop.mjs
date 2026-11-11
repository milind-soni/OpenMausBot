import { companionState, postCompanionMessage, setCompanionE2EHooks } from "./companion.mjs";
import { COMPANION_INSTALLATION_CREDENTIAL_FIELD, resolveCompanionControlPlaneURL } from "./companion-account-service.mjs";
import { createCompanionE2E } from "./companion-e2e.mjs";
export { deviceCounts } from "./companion-e2e.mjs";
import { createControlPlaneClient } from "./control-plane-client.mjs";

const signedOut = () => Promise.reject(Object.assign(new Error("signed out"), { code: "signed_out" }));

/** The desktop app's end-to-end connection, wired to its sidecar, its account and the power monitor. Dark in a
 * development build unless OMB_CONTROL_PLANE_URL names a control plane. */
export function createDesktopCompanionE2E({ isPackaged, appVersion, readCredentials, updateCredentials, powerMonitor, log, onState }) {
  let client = null;
  try {
    const baseURL = resolveCompanionControlPlaneURL({ isPackaged });
    client = baseURL ? createControlPlaneClient({ baseURL }) : null;
  } catch {
    client = null;
  }
  const e2e = createCompanionE2E({
    readCredentials,
    updateCredentials,
    fetchGrant: (devices) => {
      const credential = readCredentials()?.[COMPANION_INSTALLATION_CREDENTIAL_FIELD];
      return client && credential ? client.relayToken(credential, { appVersion, devices }) : signedOut();
    },
    companionState,
    post: postCompanionMessage,
    log,
    onState,
  });
  setCompanionE2EHooks({ initialMessage: () => e2e.message(), tokenRejected: e2e.tokenRejected, changed: () => void e2e.reconcile() });
  powerMonitor?.on("resume", () => e2e.resumed());
  return e2e;
}
