import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";

export const ANDROID_APK_PATH = "/downloads/OpenMaus-Chief.apk";
const MAX_APK_BYTES = 200 * 1024 * 1024;

/** Serve the signed companion APK as a public, content-only download.
 * The file contains no workspace state or credentials. Every other companion
 * route still passes through the normal pairing and capability checks. */
export function serveAndroidApk(
  request: IncomingMessage,
  response: ServerResponse,
  apkPath: string | undefined,
): boolean {
  const url = new URL(request.url ?? "/", "http://companion.invalid");
  if (url.pathname !== ANDROID_APK_PATH) return false;

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    response.end("method not allowed");
    return true;
  }

  if (!apkPath) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Android app is not bundled in this build");
    return true;
  }

  try {
    const info = statSync(apkPath);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_APK_BYTES) throw new Error("invalid apk");
    response.writeHead(200, {
      "content-type": "application/vnd.android.package-archive",
      "content-length": String(info.size),
      "content-disposition": `attachment; filename="${basename(ANDROID_APK_PATH)}"`,
      "cache-control": "no-cache, no-store, must-revalidate",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") {
      response.end();
    } else {
      const stream = createReadStream(apkPath);
      // The file can disappear between statSync and open (for example while
      // an app is being upgraded). Do not let that race become an uncaught
      // stream error in the long-lived companion process.
      stream.once("error", () => response.destroy());
      stream.pipe(response);
    }
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Android app is not bundled in this build");
  }
  return true;
}
