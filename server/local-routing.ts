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
  // Explicit "This computer" is offered on every desktop platform the
  // bundled cua-driver serves — macOS, Linux (beta), and Windows (the
  // driver ships in the app's resources and launches as a standalone
  // daemon or embedded host).
  if (requested === "local") return hostPlatform === "darwin" || hostPlatform === "linux" || hostPlatform === "win32";
  // Auto remains conservative: macOS only, preserving the established
  // behavior where Auto may quietly reach the host computer.
  return requested === undefined && hostPlatform === "darwin";
}
