// Marks a file from My Cloud the way a browser marks a download, so Windows and macOS warn before opening or running it:
// Windows' Mark of the Web (the Zone.Identifier stream, Internet zone) and macOS's quarantine flag.
import { execFile } from "node:child_process";
import fs from "node:fs";

export function createDownloadMarker({ platform = process.platform, run = execFile, write = fs.writeFileSync, now = Date.now } = {}) {
  return async function markDownloaded(file) {
    try {
      if (platform === "win32") write(`${file}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=about:internet\r\n");
      else if (platform === "darwin") {
        const flag = `0081;${Math.floor(now() / 1000).toString(16)};OpenMausBot;`;
        await new Promise((resolve) => run("/usr/bin/xattr", ["-w", "com.apple.quarantine", flag, file], () => resolve()));
      }
    } catch {}
  };
}
