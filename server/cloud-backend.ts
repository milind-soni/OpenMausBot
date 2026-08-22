export const CLOUD_BACKEND_CHANGE_ERROR = "stop the active turn before changing the cloud backend";
export const VPS_ALIAS_CHANGE_ERROR = "stop the active VPS turn before changing the SSH config alias";

export function cloudBackendChangeError(botBusy: boolean, activeVpsThread: boolean): string | null {
  return botBusy || activeVpsThread ? CLOUD_BACKEND_CHANGE_ERROR : null;
}

export function vpsAliasChangeError(currentAlias: string | null, nextAlias: string | null, activeVpsThread: boolean): string | null {
  return activeVpsThread && currentAlias !== nextAlias ? VPS_ALIAS_CHANGE_ERROR : null;
}
