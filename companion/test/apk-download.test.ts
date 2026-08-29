import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ANDROID_APK_PATH, serveAndroidApk } from "../src/apk-download.ts";

const dirs: string[] = [];

async function listen(apkPath: string | undefined) {
  const server = createServer((request, response) => {
    if (!serveAndroidApk(request, response, apkPath)) {
      response.writeHead(418).end("next handler");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("signed Android APK download", () => {
  it("serves only the bounded APK route with safe download headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-apk-"));
    dirs.push(dir);
    const file = join(dir, "chief.apk");
    writeFileSync(file, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const { server, origin } = await listen(file);
    try {
      const response = await fetch(`${origin}${ANDROID_APK_PATH}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/vnd.android.package-archive");
      expect(response.headers.get("content-disposition")).toContain("OpenMaus-Chief.apk");
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0x50, 0x4b, 0x03, 0x04]);
      expect((await fetch(`${origin}/api/config`)).status).toBe(418);
    } finally {
      server.close();
    }
  });

  it("fails closed when this build has no APK", async () => {
    const { server, origin } = await listen(undefined);
    try {
      expect((await fetch(`${origin}${ANDROID_APK_PATH}`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("supports browser HEAD probes without returning a JSON API response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-apk-head-"));
    dirs.push(dir);
    const file = join(dir, "chief.apk");
    writeFileSync(file, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const { server, origin } = await listen(file);
    try {
      const response = await fetch(`${origin}${ANDROID_APK_PATH}?source=phone`, { method: "HEAD" });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/vnd.android.package-archive");
      expect(response.headers.get("content-length")).toBe("4");
      expect(await response.text()).toBe("");
    } finally {
      server.close();
    }
  });

  it("does not treat a neighboring path or mutation as an APK download", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-apk-path-"));
    dirs.push(dir);
    const file = join(dir, "chief.apk");
    writeFileSync(file, Buffer.from([0x50]));
    const { server, origin } = await listen(file);
    try {
      expect((await fetch(`${origin}${ANDROID_APK_PATH}/manifest.json`)).status).toBe(418);
      expect((await fetch(`${origin}${ANDROID_APK_PATH}`, { method: "POST" })).status).toBe(405);
    } finally {
      server.close();
    }
  });
});
