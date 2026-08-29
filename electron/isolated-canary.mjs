/** Keep a side-by-side packaged canary from mutating global or hosted state. */
export function desktopLaunchPolicy(env = {}, identity = {}) {
  const isolated =
    env.OMB_ISOLATED_CANARY === "1"
    || /^\d+\.\d+\.\d+-autorag-canary\.\d+$/.test(identity.appVersion ?? "");
  return {
    isolated,
    companionIpc: !isolated,
    companionAccountIpc: !isolated,
    registerProtocol: !isolated,
    restoreCompanion: !isolated,
    restoreHostedAccount: !isolated,
    registerHostedApps: !isolated,
    updater: !isolated,
  };
}

/** Resolve a canary-only Electron profile and server state tree. */
export function isolatedCanaryDataPaths(env = {}, pathApi, defaults = {}) {
  const explicit = env.OMB_ISOLATED_CANARY_DATA_ROOT?.trim();
  const version = String(defaults.appVersion ?? "unknown")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_") || "unknown";
  const raw = explicit || (
    defaults.tempRoot
      ? pathApi?.join(defaults.tempRoot, "OpenMausBot-Isolated-Canary", version)
      : ""
  );
  if (!raw || !pathApi?.isAbsolute(raw)) {
    throw new Error("OMB_ISOLATED_CANARY_DATA_ROOT must be an absolute canary-only directory");
  }
  const root = pathApi.resolve(raw);
  if (pathApi.parse(root).root === root) {
    throw new Error("OMB_ISOLATED_CANARY_DATA_ROOT cannot be a filesystem root");
  }
  return {
    root,
    userData: pathApi.join(root, "electron-user-data"),
    serverData: pathApi.join(root, "server-data"),
  };
}

const isolatedCompanionState = () => ({
  enabled: false,
  keepAwake: false,
  port: 0,
  devices: [],
  connectedDeviceIds: [],
  pairing: null,
  error: "Phone access is disabled in this isolated canary.",
});

const isolatedCompanionAccountState = () => ({
  available: false,
  status: "signed-out",
  message: "Secure phone access is disabled in this isolated canary.",
});

/**
 * Register inert renderer bridges for a packaged canary.
 *
 * PhoneSetupFlow probes both state channels when it mounts. Keeping the
 * channels present avoids renderer errors while guaranteeing that neither a
 * state read nor a mutation can construct the production account client,
 * probe accounts.openmausbot.com, start the companion, or alter its settings.
 */
export function registerIsolatedCompanionIpc(ipc) {
  for (const channel of [
    "companion:state",
    "companion:start",
    "companion:stop",
    "companion:keep-awake",
    "companion:pairing",
    "companion:cloud-desktop",
    "companion:revoke",
  ]) {
    ipc.handle(channel, isolatedCompanionState);
  }
  for (const channel of [
    "companion-account:state",
    "companion-account:request-code",
    "companion-account:verify-code",
    "companion-account:retry",
    "companion-account:sign-out",
  ]) {
    ipc.handle(channel, isolatedCompanionAccountState);
  }
}
