/** Hosts whose desktop the app can drive itself: macOS and Windows ship the
 * CUA driver and keep "This computer" selectable in the UI; Linux is a beta
 * behind an explicit per-bot choice. */
const HOSTS_WITH_LOCAL_CONTROL = new Set<NodeJS.Platform>(["darwin", "win32", "linux"]);
/** Hosts where Auto may land on the person's own desktop unasked. */
const HOSTS_WITH_AUTO_LOCAL = new Set<NodeJS.Platform>(["darwin", "win32"]);

export function shouldMountLocalComputer({
  requested,
  hostPlatform = process.platform,
  providerSupportsLocal,
}: {
  requested: "cloud" | "local" | "off" | undefined;
  hostPlatform?: NodeJS.Platform;
  providerSupportsLocal: boolean;
}): boolean {
  if (!providerSupportsLocal) return false;
  if (requested === "local") return HOSTS_WITH_LOCAL_CONTROL.has(hostPlatform);
  // Preserve the established macOS Auto behavior, which Windows shares.
  // Linux local control is a beta and can only be selected explicitly per bot.
  return requested === undefined && HOSTS_WITH_AUTO_LOCAL.has(hostPlatform);
}
