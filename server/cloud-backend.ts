export const CLOUD_BACKEND_CHANGE_ERROR = "stop the active turn before changing the cloud backend";
export const BOAT_ACCOUNT_RESOURCES_ERROR =
  "remove this installation's cloud computers before changing or clearing the Boat account";
export const VPS_ALIAS_RESOURCES_ERROR =
  "remove this installation's VPS computers before changing or clearing the SSH config alias";

export const VPS_BOT_ALIAS_RESOURCES_ERROR =
  "remove this bot's VPS computer before changing its SSH config alias (Settings → Desktops & browser → Desktops)";
export const VPS_BOT_ALIAS_CHANGE_ERROR = "stop the active turn before changing this bot's VPS SSH alias";
export const VPS_BOT_ALIAS_LIFECYCLE_ERROR = "wait for VPS computer actions to finish before changing this bot's SSH alias";

/** A server that cannot answer never keeps a bot on it or keeps it alive: what may be left there, and how to remove it. */
export function vpsLeftBehindNotice(done: "Moved" | "Deleted", alias: string, containerName: string): string {
  return `${done}. ${alias} could not be reached, so this bot's computer there, if it is still there, was left as it is. ` +
    `When ${alias} is back, remove it with: docker -H ssh://${alias} rm -f ${containerName}`;
}

/** What an unreachable old default alias may still run for this installation, and how to find and remove it. */
export function vpsAliasLeftBehindNotice(done: "Saved" | "Removed", alias: string, environmentFilter: string | null, managedFilter: string): string {
  return `${done}. ${alias} could not be reached, so this installation's computers there, if any are still there, were left as they are. ` +
    (environmentFilter
      ? `When ${alias} is back, list them with: docker -H ssh://${alias} ps -a --filter ${environmentFilter} ` +
        `and remove any you no longer need with: docker -H ssh://${alias} rm -f <name>. `
      : `This installation's ID could not be read, so no filter lists only its computers on ${alias}. `) +
    `Computers made by older versions have no installation label: docker -H ssh://${alias} ps -a --filter ${managedFilter} lists every managed one, ` +
    `so remove one of those only when you have its exact name from this installation, such as the one in a bot's move or delete notice. ` +
    `A name that only starts with openmausbot-vps- does not prove it is this installation's: if you have nothing more, leave it.`;
}

/** Why a bot that gets its cloud computer from Boat can't have one while a self-hosted VPS is saved but not chosen for it. */
export function vpsNotChosenReason(botName: string, vpsAlias: string | null): string | null {
  return vpsAlias ? `${botName}'s cloud computer comes from Boat, which is not available here. The self-hosted VPS ${vpsAlias} is set up ` +
    `but not chosen for ${botName}: ask the person to choose Self-hosted VPS as the cloud backend in ${botName}'s Bot settings, ` +
    `Access section, then select cloud again.` : null;
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
