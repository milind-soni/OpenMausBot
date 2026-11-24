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
  // dnf (then yum, zypper), never bare `rpm -Uvh`: rpm installs nothing when a dependency is missing and leaves
  // the package out of the package manager's own database, so the next update conflicts. The same commands as
  // electron-updater's RpmUpdater; the file rides as $0 so the quoted path survives the inner shell too.
  rpm: (file) =>
    `sudo sh -c 'if command -v dnf >/dev/null 2>&1; then exec dnf install --nogpgcheck -y "$0"; ` +
    `elif command -v yum >/dev/null 2>&1; then exec yum install --nogpgcheck -y "$0"; ` +
    `elif command -v zypper >/dev/null 2>&1; then exec zypper --non-interactive --no-refresh install --allow-unsigned-rpm -f "$0"; ` +
    `else exec rpm -Uvh --replacepkgs --replacefiles "$0"; fi' ${file}`,
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
