import { existsSync } from "node:fs";
import { join } from "node:path";

// The command a Linux user pastes to finish an update.
//
// Astra is installed from the releases repository by hand, not from a
// store, so there is no package handler worth delegating to — a stock Ubuntu
// 24.04 registers App Center for .deb and may not install a local one at all.
// The app therefore never installs the package itself; it downloads it,
// verifies it, and hands over this exact line.

/** Which Linux artifact is running. electron-updater resolves its installer
 * the same way — resources/package-type first, APPIMAGE env as the fallback —
 * so mirroring it keeps the card's promise and the updater's behaviour in
 * step. `deps` is injected so the routing can be tested without a package.
 *
 * A marker present in BOTH artifacts would silently route the AppImage to the
 * hand-off; scripts/verify-linux-package.mjs guards the packaging side. */
export function linuxPackageType({
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  appImage = process.env.APPIMAGE,
  readMarker,
} = {}) {
  if (platform !== "linux") return null;
  // Electron always defines resourcesPath; without it there is no marker to
  // read, and joining undefined would throw into the catch below and reach the
  // same answer by accident. Say so instead.
  if (typeof resourcesPath !== "string" || resourcesPath.length === 0) {
    return appImage ? "AppImage" : null;
  }
  try {
    const declared = readMarker(join(resourcesPath, "package-type"));
    if (declared) return declared.trim() || null;
  } catch {
    // An unreadable marker is not worth failing the updater over — fall
    // through to the AppImage probe and treat the build as portable.
  }
  return appImage ? "AppImage" : null;
}

const BUILDERS = {
  // apt-get, never `dpkg -i`: only apt-get resolves dependencies, and Ubuntu
  // satisfies ours through virtual Provides (libgtk-3-0 → libgtk-3-0t64).
  deb: (file) => `sudo apt-get install -y ${file}`,
  rpm: (file) => `sudo rpm -Uvh ${file}`,
  pacman: (file) => `sudo pacman -U ${file}`,
};

export const HAND_OFF_PACKAGE_TYPES = Object.freeze(Object.keys(BUILDERS));

/** Single-quote for the shell the user pastes into. The path is
 * electron-updater's cache under $HOME, so it can carry anything a directory
 * name can — an apostrophe included. */
export function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The first staged path that still exists. A vanished download must not
 * become a command that installs nothing. `exists` is injected so the
 * filter can be tested without touching the disk layout of a real update. */
export function stagedInstallFile(files, exists = existsSync) {
  return files?.find((file) => typeof file === "string" && file.length > 0 && exists(file));
}

/** Throws for a package type with no builder, so a new target cannot reach
 * the banner with a command we never wrote. */
export function packageInstallCommand(packageType, file) {
  const build = Object.hasOwn(BUILDERS, packageType) ? BUILDERS[packageType] : undefined;
  if (!build) throw new Error(`No install command for package type ${JSON.stringify(packageType)}`);
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("The downloaded package is no longer available. Download it again.");
  }
  return build(shellQuote(file));
}
