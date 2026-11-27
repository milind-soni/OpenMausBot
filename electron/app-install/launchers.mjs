// The text of each launcher: a macOS bundle's Info.plist and executable, a Linux desktop entry, and the options of a
// Windows shortcut. Every one names the app's id, which is how the installer recognises a launcher as its own.
import { launcherLink, launcherBundleId, validAppId, validBundleId, windowsAppUserModelId, HOST_BUNDLE_ID } from "./names.mjs";

export const MAC_ID_KEY = "OpenMausBotLocalApp";
export const LINUX_ID_KEY = "X-OpenMausBot-LocalApp";
export const MAC_EXECUTABLE = "launcher";
export const MAC_ICON = "AppIcon";

const xml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

/**
 * LSUIElement is true: the launcher is a shell script that hands the link to MausBot and exits at once, so it never
 * shows a Dock tile or menu bar of its own; the window that opens is MausBot's and sits under MausBot's Dock tile.
 */
export function macInfoPlist({ id, name, hostBundleId = HOST_BUNDLE_ID, icon = true }) {
  if (!validAppId(id)) throw new Error("invalid app id");
  const entries = [
    ["CFBundleDevelopmentRegion", "en"],
    ["CFBundleDisplayName", name],
    ["CFBundleExecutable", MAC_EXECUTABLE],
    ...(icon ? [["CFBundleIconFile", MAC_ICON]] : []),
    ["CFBundleIdentifier", launcherBundleId(id, hostBundleId)],
    ["CFBundleInfoDictionaryVersion", "6.0"],
    ["CFBundleName", name],
    ["CFBundlePackageType", "APPL"],
    ["CFBundleShortVersionString", "1.0"],
    ["CFBundleVersion", "1"],
    [MAC_ID_KEY, id],
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...entries.map(([key, value]) => `  <key>${key}</key>\n  <string>${xml(value)}</string>`),
    "  <key>LSUIElement</key>\n  <true/>",
    "  <key>NSHighResolutionCapable</key>\n  <true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** The id a launcher's Info.plist names, or null. */
export function macPlistAppId(text) {
  const match = new RegExp(`<key>${MAC_ID_KEY}</key>\\s*<string>([A-Za-z0-9_-]+)</string>`).exec(String(text));
  return match ? match[1] : null;
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

/**
 * `open -b` finds MausBot by bundle id wherever it is installed and starts it when it is not running, so the launcher
 * outlives updates and moves; plain `open` falls back to whichever app handles the link.
 */
export function macLauncherScript({ id, hostBundleId = HOST_BUNDLE_ID }) {
  const link = shellQuote(launcherLink(id));
  const host = shellQuote(validBundleId(hostBundleId) ? hostBundleId : HOST_BUNDLE_ID);
  return `#!/bin/sh\n/usr/bin/open -b ${host} ${link} 2>/dev/null || exec /usr/bin/open ${link}\n`;
}

const desktopString = (value) => String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r");
/** Desktop Entry Exec: each argument in double quotes with ", `, $ and \ escaped, % doubled, then the value's own
 * backslashes escaped like any string value of the file. */
const execArgument = (value) => `"${String(value).replace(/["`$\\]/g, (c) => `\\${c}`)}"`.replace(/%/g, "%%");

export function desktopEntry({ id, name, executable, iconPath }) {
  if (typeof executable !== "string" || !executable) throw new Error("no executable");
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    `Name=${desktopString(name)}`,
    `Exec=${desktopString(`${execArgument(executable)} ${execArgument(launcherLink(id))}`)}`,
    ...(iconPath ? [`Icon=${desktopString(iconPath)}`] : []),
    "Terminal=false",
    "Categories=Utility;",
    `${LINUX_ID_KEY}=${id}`,
    "",
  ].join("\n");
}

export function desktopEntryAppId(text) {
  const match = new RegExp(`^${LINUX_ID_KEY}=([A-Za-z0-9_-]+)$`, "m").exec(String(text));
  return match ? match[1] : null;
}

/** Options for Electron's `shell.writeShortcutLink`: MausBot's own executable with the link as its one argument, which
 * reaches the running app through `second-instance` or a new one through `process.argv`. */
export function windowsShortcut({ id, name, executable, iconPath }) {
  if (typeof executable !== "string" || !executable) throw new Error("no executable");
  return {
    target: executable,
    args: launcherLink(id),
    description: name,
    ...(iconPath ? { icon: iconPath, iconIndex: 0 } : {}),
    appUserModelId: windowsAppUserModelId(id),
  };
}

/** For the app's own window (`BrowserWindow.setAppDetails` on Windows): a taskbar button of its own, with the app's
 * icon, that relaunches the app rather than MausBot. */
export function windowsWindowDetails({ id, name, executable, iconPath }) {
  return {
    appId: windowsAppUserModelId(id),
    ...(iconPath ? { appIconPath: iconPath, appIconIndex: 0 } : {}),
    relaunchCommand: `"${executable}" ${launcherLink(id)}`,
    relaunchDisplayName: name,
  };
}
