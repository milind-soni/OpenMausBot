// openmausbot://cloud: "Open in the app" on the person's Cloud page
// (docs/cloud-pro.md). Like openmausbot://organization it is an action, not a
// router: it never carries an address, code or credential. Main answers it by
// opening Settings → OMB Cloud, which signs in or connects from there.
export const CLOUD_DEEP_LINK = "openmausbot://cloud";

export const isCloudDeepLink = value => value === CLOUD_DEEP_LINK;
export function takeCloudDeepLink(argv) {
  let found = false;
  // Relaunch uses process.argv again. Consume only this one-shot action,
  // leaving flags and unrelated protocol links untouched.
  for (let index = argv.length - 1; index >= 0; index--) {
    if (!isCloudDeepLink(argv[index])) continue;
    argv.splice(index, 1);
    found = true;
  }
  return found;
}

/** Holds at most one pending link until main can navigate, then hands it to
 * `open` once. A cold start (launch argv, or a macOS open-url before ready),
 * a second instance and a running app's open-url all end up here. */
export function createCloudEntry({ reveal, open }) {
  let pending = false, ready = false;
  async function deliver() {
    if (!ready || !pending) return false;
    pending = false;
    try { return await open(); } catch { return false; }
  }
  function request() {
    pending = true;
    reveal();
    void deliver();
    return true;
  }
  return {
    /** This process's own launch arguments: remembered, not yet delivered. */
    fromLaunch(argv) {
      if (takeCloudDeepLink(argv)) pending = true;
      return pending;
    },
    /** A second instance's arguments. */
    fromArgs: argv => takeCloudDeepLink(argv) && request(),
    /** macOS open-url. False leaves the URL to the other link handlers. */
    fromUrl: url => isCloudDeepLink(url) && request(),
    /** Main can navigate: deliver a link that arrived before now. */
    ready() {
      ready = true;
      return deliver();
    },
  };
}
