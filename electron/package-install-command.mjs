import { existsSync } from "node:fs";
import { join } from "node:path";

// Never installs the package itself: stock Ubuntu 24.04 hands a .deb to App Center, which may not install a local one.

/** Resolved the way electron-updater resolves its installer: resources/package-type first, then the APPIMAGE env. */
export function linuxPackageType({
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  appImage = process.env.APPIMAGE,
  readMarker,
} = {}) {
  if (platform !== "linux") return null;
  if (typeof resourcesPath !== "string" || resourcesPath.length === 0) {
    return appImage ? "AppImage" : null;
  }
  try {
    const declared = readMarker(join(resourcesPath, "package-type"));
    if (declared) return declared.trim() || null;
  } catch {
  }
  return appImage ? "AppImage" : null;
}

const BUILDERS = {
  // apt-get, never `dpkg -i`: only apt-get resolves dependencies, and Ubuntu satisfies ours through virtual Provides.
  deb: (file) => `sudo apt-get install -y ${file}`,
  rpm: (file) => `sudo rpm -Uvh ${file}`,
  pacman: (file) => `sudo pacman -U ${file}`,
};

export const HAND_OFF_PACKAGE_TYPES = Object.freeze(Object.keys(BUILDERS));

export function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function stagedInstallFile(files, exists = existsSync) {
  return files?.find((file) => typeof file === "string" && file.length > 0 && exists(file));
}

export function packageInstallCommand(packageType, file) {
  const build = Object.hasOwn(BUILDERS, packageType) ? BUILDERS[packageType] : undefined;
  if (!build) throw new Error(`No install command for package type ${JSON.stringify(packageType)}`);
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("The downloaded package is no longer available. Try the update again.");
  }
  return build(shellQuote(file));
}
