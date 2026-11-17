const HOSTS_WITH_LOCAL_CONTROL = new Set<NodeJS.Platform>(["darwin", "win32", "linux"]);
const HOSTS_WITH_AUTO_LOCAL = new Set<NodeJS.Platform>(["darwin", "win32"]);

/** Where a new bot works when nothing names a place. On the desktop app on a Mac or a Windows PC, with a model that can use
 * it: This computer, so a request for the person's own files or apps needs no switch first. Everywhere else (a Cloud,
 * a hosted workspace, a server, Linux, where This computer is the server or needs turning on): Auto, as before.
 * `desktopApp` holds only while the app has handed this server its computer's driver: without it every turn on This
 * computer would fail, and Auto picks This computer by itself once the driver is there. */
export function newBotWorksOn(input: { desktopApp: boolean; platform: NodeJS.Platform; providerSupportsLocal: boolean }): "local" | undefined {
  return input.desktopApp && shouldMountLocalComputer({ requested: undefined, hostPlatform: input.platform, providerSupportsLocal: input.providerSupportsLocal })
    ? "local" : undefined;
}

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
  return requested === undefined && HOSTS_WITH_AUTO_LOCAL.has(hostPlatform);
}
