export const CLOUD_BACKEND_CHANGE_ERROR = "stop the active turn before changing the cloud backend";
export const BOAT_ACCOUNT_RESOURCES_ERROR =
  "remove this installation's cloud computers before changing or clearing the Boat account";
export const VPS_ALIAS_RESOURCES_ERROR =
  "remove this installation's VPS computers before changing or clearing the SSH config alias";

export const VPS_BOT_ALIAS_RESOURCES_ERROR =
  "remove this bot's VPS computer before changing its SSH config alias (Settings → Local VM → Self-hosted VPS computers)";
export const VPS_BOT_ALIAS_CHANGE_ERROR = "stop the active turn before changing this bot's VPS SSH alias";
export const VPS_BOT_ALIAS_LIFECYCLE_ERROR = "wait for VPS computer actions to finish before changing this bot's SSH alias";

/** A server that cannot answer never keeps a bot on it or keeps it alive: what may be left there, and how to remove it. */
export function vpsLeftBehindNotice(done: "Moved" | "Deleted", alias: string, containerName: string): string {
  return `${done}. ${alias} could not be reached, so this bot's computer there, if it is still there, was left as it is. ` +
    `When ${alias} is back, remove it with: docker -H ssh://${alias} rm -f ${containerName}`;
}

export function cloudBackendChangeError(botBusy: boolean, activeVpsThread: boolean): string | null {
  return botBusy || activeVpsThread ? CLOUD_BACKEND_CHANGE_ERROR : null;
}

export function vpsBotAliasChangeError(botBusy: boolean, activeVpsThread: boolean): string | null {
  return botBusy || activeVpsThread ? VPS_BOT_ALIAS_CHANGE_ERROR : null;
}

export interface CloudResourceIdentity {
  boxId: string;
  name: string;
}

/** An old Boat account detaches only when it owns no local resources; rotation needs proof of access to the same identities. */
export function boatAccountResourceChangeError(
  current: CloudResourceIdentity[],
  replacement: CloudResourceIdentity[] | null,
): string | null {
  if (current.length === 0) return null;
  if (!replacement || replacement.length !== current.length) return BOAT_ACCOUNT_RESOURCES_ERROR;
  const identities = (rows: CloudResourceIdentity[]) => rows
    .map(({ boxId, name }) => `${boxId}\u0000${name}`)
    .sort();
  const currentIdentities = identities(current);
  const replacementIdentities = identities(replacement);
  return currentIdentities.every((identity, index) => identity === replacementIdentities[index])
    ? null
    : BOAT_ACCOUNT_RESOURCES_ERROR;
}

export function vpsAliasResourceChangeError(instanceCount: number): string | null {
  return instanceCount > 0 ? VPS_ALIAS_RESOURCES_ERROR : null;
}
