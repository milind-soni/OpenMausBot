import environments from "./environments.cjs";
import { withoutDesktopCompanionAccess } from "./desktop-companion-client.mjs";

export const ORGANIZATION_DEEP_LINK = "openmausbot://organization";
const RESTART_FIELD = "desktopOrganizationSettingsPending";

// This is an action, not a router: never accept a destination or credential.
export const isOrganizationDeepLink = value => value === ORGANIZATION_DEEP_LINK;
export function takeOrganizationDeepLink(argv) {
  let found = false;
  // Relaunch reuses process.argv: consume only this one-shot action, leaving flags and other links untouched.
  for (let index = argv.length - 1; index >= 0; index--) {
    if (!isOrganizationDeepLink(argv[index])) continue;
    argv.splice(index, 1);
    found = true;
  }
  return found;
}
export const organizationRestartIntent = credentials => credentials?.[RESTART_FIELD] === true;
export const withOrganizationRestartIntent = credentials => ({
  ...withoutDesktopCompanionAccess(credentials), [RESTART_FIELD]: true,
});
export function withoutOrganizationRestartIntent(credentials) {
  const next = { ...credentials };
  delete next[RESTART_FIELD];
  return next;
}

export function createOrganizationEntry({ readState, confirm, saveEnvironments, disconnectAndRemember, clearRestartIntent, openLocalSettings, relaunch }) {
  let pending = null;
  let restarting = false;
  const identity = state => JSON.stringify([
    state.environments.activeId,
    state.remoteAccess?.endpoint ?? null,
    state.remoteAccess?.deviceId ?? null,
  ]);

  async function enter() {
    const before = readState();
    const beforeIdentity = identity(before);
    const remote = environments.activeEnvironment(before.environments);
    if (before.remoteAccess || remote) {
      const companion = before.remoteAccess;
      const accepted = await confirm({
        kind: companion ? "companion" : "hosted",
        name: companion?.serverName ?? remote.name,
        origin: companion?.endpoint ?? remote.origin,
      });
      if (!accepted) return false;
      if (identity(readState()) !== beforeIdentity) throw new Error("The selected server changed. Choose organization sign-in again.");
      if (companion) {
          // Removing the companion credential and remembering the destination is one durable write, before any restart.
        await disconnectAndRemember(companion);
        restarting = true;
        relaunch();
        return true;
      }
      await saveEnvironments(environments.withActive(readState().environments, environments.LOCAL_ID));
    }
    await openLocalSettings();
    return true;
  }

  return {
    request() {
      if (restarting) return Promise.resolve(true);
      if (!pending) pending = enter().finally(() => { pending = null; });
      return pending;
    },
    async restore() {
      const state = readState();
      if (!state.restartIntent || state.remoteAccess) return false;
      await saveEnvironments(environments.withActive(state.environments, environments.LOCAL_ID));
        // Document loading is not React readiness: keep the intent until the Organisation panel acknowledges its mount.
      await openLocalSettings();
      return true;
    },
    async settingsOpened() {
      const state = readState();
      if (!state.restartIntent || state.remoteAccess || environments.activeEnvironment(state.environments)) return false;
      await clearRestartIntent();
      return true;
    },
  };
}
