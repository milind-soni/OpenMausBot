import environments from "./environments.cjs";
import { withoutDesktopCompanionAccess } from "./desktop-companion-client.mjs";

export const ORGANIZATION_DEEP_LINK = "openmausbot://organization";
const RESTART_FIELD = "desktopOrganizationSettingsPending";

// This is an action, not a router: never accept a destination or credential.
export const isOrganizationDeepLink = value => value === ORGANIZATION_DEEP_LINK;
export function takeOrganizationDeepLink(argv) {
  let found = false;
  // Relaunch uses process.argv again. Consume only this one-shot action,
  // leaving flags and unrelated protocol links untouched.
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

/** Main-process action shared by the native menu and the fixed protocol link.
 * Persistence/navigation are injected so the actual transition is testable
 * without opening a user's profile or signing in to a real organisation. */
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
      if (identity(readState()) !== beforeIdentity) throw new Error("The selected workspace changed. Choose organisation sign-in again.");
      if (companion) {
        // Removing the companion credential and remembering the destination
        // must be one durable write, before a restart can begin.
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
      // Document loading is not React readiness. Keep the intent until the
      // local Organisation panel acknowledges its actual mount.
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
