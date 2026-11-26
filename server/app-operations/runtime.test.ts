// Fetching the app runtime: pinned, verified before it is unpacked, never left half-written or unverified.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { ensureRuntime, releaseUrl, runtimePlatform, RuntimeUnavailable, WORKERD_ASSETS, WORKERD_VERSION, type RuntimeAsset, type RuntimePlatform } from "./runtime.ts";

const BINARY = Buffer.from("#!/bin/sh\necho workerd\n");
const PACKED = gzipSync(BINARY);
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const asset = (overrides: Partial<RuntimeAsset> = {}): Record<RuntimePlatform, RuntimeAsset> => {
  const one: RuntimeAsset = { name: "workerd-test.gz", sha256: sha(PACKED), binarySha256: sha(BINARY), executable: "workerd", ...overrides };
  return { "darwin-arm64": one, "darwin-x64": one, "linux-x64": one, "linux-arm64": one, "win32-x64": one };
};

function serve(body: Uint8Array, status = 200) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    return { ok: status === 200, status, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer };
  };
  return { fetch, urls };
}

describe("ensureRuntime", () => {
  it("names a pinned asset for each supported desktop and server platform", () => {
    expect(runtimePlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(runtimePlatform("win32", "x64")).toBe("win32-x64");
    expect(runtimePlatform("win32", "arm64")).toBeNull();
    for (const each of Object.values(WORKERD_ASSETS)) expect(each.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(releaseUrl(WORKERD_VERSION, WORKERD_ASSETS["linux-arm64"])).toBe(`https://github.com/cloudflare/workerd/releases/download/v${WORKERD_VERSION}/workerd-linux-arm64.gz`);
  });

  it("downloads once, verifies, unpacks, marks executable and reuses", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ao-rt-"));
    const server = serve(PACKED);
    const [a, b] = await Promise.all([1, 2].map(() => ensureRuntime({ dataDir, fetch: server.fetch, platform: "linux-x64", assets: asset(), version: "1.0.0" })));
    expect(a).toBe(b);
    expect(a).toBe(join(dataDir, "runtimes", "workerd", "1.0.0", "workerd"));
    expect(readFileSync(a!)).toEqual(BINARY);
    if (process.platform !== "win32") expect(statSync(a!).mode & 0o111).not.toBe(0);
    expect(server.urls).toHaveLength(1);
    await ensureRuntime({ dataDir, fetch: server.fetch, platform: "linux-x64", assets: asset(), version: "1.0.0" });
    expect(server.urls).toHaveLength(1);
    expect(readdirSync(join(dataDir, "runtimes", "workerd", "1.0.0"))).toEqual(["workerd"]);
  });

  it("refuses a download that does not match its checksum and leaves nothing behind", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ao-rt-"));
    const tampered = gzipSync(Buffer.from("#!/bin/sh\necho evil\n"));
    await expect(ensureRuntime({ dataDir, fetch: serve(tampered).fetch, platform: "linux-x64", assets: asset(), version: "1.0.0" })).rejects.toThrow(RuntimeUnavailable);
    expect(existsSync(join(dataDir, "runtimes", "workerd", "1.0.0", "workerd"))).toBe(false);
    await expect(ensureRuntime({ dataDir, fetch: serve(PACKED, 404).fetch, platform: "linux-x64", assets: asset(), version: "1.0.0" })).rejects.toThrow(/HTTP 404/);
    await expect(ensureRuntime({ dataDir, fetch: serve(PACKED).fetch, platform: "linux-x64", assets: asset({ binarySha256: "0".repeat(64) }), version: "1.0.0" })).rejects.toThrow(/unpacked/);
    await expect(ensureRuntime({ dataDir, fetch: serve(PACKED).fetch, platform: null, version: "1.0.0" })).rejects.toThrow(/do not run on/);
  });

  it("replaces a binary that changed on disk since it was verified", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ao-rt-"));
    const server = serve(PACKED);
    const path = await ensureRuntime({ dataDir, fetch: server.fetch, platform: "linux-x64", assets: asset(), version: "1.0.0" });
    writeFileSync(path, "tampered");
    await ensureRuntime({ dataDir, fetch: server.fetch, platform: "linux-x64", assets: asset(), version: "1.0.0" });
    expect(readFileSync(path)).toEqual(BINARY);
    expect(server.urls).toHaveLength(2);
  });
});
