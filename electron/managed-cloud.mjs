/** The MausBot Cloud service is upstream's: this app contacts it only when OMB_CLOUD_ACCOUNT=1 (or OMB_CLOUD_STAGING=1) is set. */
export function managedCloudConfigured(env = process.env) {
  return env?.OMB_CLOUD_ACCOUNT === "1" || env?.OMB_CLOUD_STAGING === "1";
}

/** The sign-in message and email sign-in outcome for a Cloud this app has not set up. */
export const CLOUD_NOT_SET_UP = "not-set-up";

export const cloudNotSetUpError = () => Object.assign(new Error("MausBot Cloud is not set up in this app."), { opaque: true, code: CLOUD_NOT_SET_UP });

const unconfiguredFetch = async () => { throw cloudNotSetUpError(); };

/** The fetch a Cloud account client gets by default: the real one only when the Cloud is configured. */
export function managedCloudFetch(env = process.env) {
  return managedCloudConfigured(env) ? globalThis.fetch : unconfiguredFetch;
}

export const cloudFetchConfigured = fetcher => fetcher !== unconfiguredFetch;
