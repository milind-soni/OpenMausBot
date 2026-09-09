export const CLOUD_BACKEND_CHANGE_ERROR = "stop the active turn before changing the cloud backend";
export const VPS_ALIAS_CHANGE_ERROR = "stop the active VPS turn before changing the SSH config alias";
export const BOX_ACCOUNT_RESOURCES_ERROR =
  "remove this installation's cloud computers before changing or clearing the Box account";
export const VPS_ALIAS_RESOURCES_ERROR =
  "remove this installation's VPS computers before changing or clearing the SSH config alias";

export function cloudBackendChangeError(botBusy: boolean, activeVpsThread: boolean): string | null {
  return botBusy || activeVpsThread ? CLOUD_BACKEND_CHANGE_ERROR : null;
}

export function vpsAliasChangeError(currentAlias: string | null, nextAlias: string | null, activeVpsThread: boolean): string | null {
  return activeVpsThread && currentAlias !== nextAlias ? VPS_ALIAS_CHANGE_ERROR : null;
}

export interface CloudResourceIdentity {
  boxId: string;
  name: string;
}

/** An old Box account may be detached only when it owns no local resources.
 * Token rotation is safe when the replacement credential proves access to
 * the exact same provider identities. */
export function boxAccountResourceChangeError(
  current: CloudResourceIdentity[],
  replacement: CloudResourceIdentity[] | null,
): string | null {
  if (current.length === 0) return null;
  if (!replacement || replacement.length !== current.length) return BOX_ACCOUNT_RESOURCES_ERROR;
  const identities = (rows: CloudResourceIdentity[]) => rows
    .map(({ boxId, name }) => `${boxId}\u0000${name}`)
    .sort();
  const currentIdentities = identities(current);
  const replacementIdentities = identities(replacement);
  return currentIdentities.every((identity, index) => identity === replacementIdentities[index])
    ? null
    : BOX_ACCOUNT_RESOURCES_ERROR;
}

export function vpsAliasResourceChangeError(instanceCount: number): string | null {
  return instanceCount > 0 ? VPS_ALIAS_RESOURCES_ERROR : null;
}
