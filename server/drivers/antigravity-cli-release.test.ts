// Adapted from pingdotgg/t3code@b732621b51, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified:
//   - apps/server/src/provider/antigravityCliRelease.test.ts (the manifest
//     fixture, the table of platforms and the refused manifests).
import { describe, expect, it } from "vitest";

import { ANTIGRAVITY_CLI_MANIFEST_BASE, antigravityCliTarget, hostUsesMusl, latestAntigravityCliRelease, parseAntigravityCliRelease } from "./antigravity-cli-release.ts";

const manifest = {
  version: "1.5.7",
  url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.7-123/darwin-arm/cli_mac_arm64.tar.gz",
  sha512: "a".repeat(128),
};

describe("Antigravity CLI release manifests", () => {
  it.each([
    ["darwin", "arm64", false, "darwin_arm64", "darwin-arm/cli_mac_arm64.tar.gz"],
    ["darwin", "x64", false, "darwin_amd64", "darwin-x64/cli_mac_x64.tar.gz"],
    ["linux", "arm64", false, "linux_arm64", "linux-arm/cli_linux_arm64.tar.gz"],
    ["linux", "x64", false, "linux_amd64", "linux-x64/cli_linux_x64.tar.gz"],
    ["linux", "arm64", true, "linux_arm64_musl", "linux-arm-musl/cli_linux_arm64_musl.tar.gz"],
    ["linux", "x64", true, "linux_amd64_musl", "linux-x64-musl/cli_linux_x64_musl.tar.gz"],
    ["win32", "arm64", false, "windows_arm64", "windows-arm/cli_windows_arm64.exe"],
    ["win32", "x64", false, "windows_amd64", "windows-x64/cli_windows_x64.exe"],
  ] as const)("selects Google's %s-%s release (musl %s)", (platform, arch, musl, target, file) => {
    expect(antigravityCliTarget(platform, arch, musl)).toBe(target);
    expect(parseAntigravityCliRelease(
      { ...manifest, url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.7-123/${file}` },
      platform, arch, musl,
    )).toMatchObject({
      version: "1.5.7",
      format: platform === "win32" ? "executable" : "tar.gz",
      executable: { name: platform === "win32" ? "agy.exe" : "antigravity" },
    });
  });

  it.each([
    { sha512: "invalid" },
    { version: "1.4.5" },
    { version: "1.5" },
    { url: manifest.url.replace("https:", "http:") },
    { url: manifest.url.replace("storage.googleapis.com", "storage.googleapis.com.evil.test") },
    { url: manifest.url.replace("antigravity-public", "another-bucket") },
    { url: manifest.url.replace("darwin-arm", "linux-arm") },
    { url: `${manifest.url}?redirect=elsewhere` },
    { url: manifest.url.replace("1.5.7-123", "1.5.6-123") },
  ])("rejects invalid or mismatched release metadata: %j", (change) => {
    expect(parseAntigravityCliRelease({ ...manifest, ...change }, "darwin", "arm64")).toBeNull();
  });

  it("has no release for a platform Google does not build for, or for anything that is no manifest", () => {
    expect(antigravityCliTarget("freebsd", "x64")).toBeNull();
    expect(antigravityCliTarget("linux", "ia32")).toBeNull();
    expect(parseAntigravityCliRelease(manifest, "freebsd", "x64")).toBeNull();
    for (const value of [null, "text", 7, []]) expect(parseAntigravityCliRelease(value, "darwin", "arm64")).toBeNull();
    expect(parseAntigravityCliRelease({ ...manifest, sha512: "A".repeat(128) }, "darwin", "arm64")?.sha512).toBe("a".repeat(128));
  });

  it("reads musl from the host's loader", () => {
    expect(hostUsesMusl("linux", "x64", (path) => path === "/lib/libc.musl-x86_64.so.1")).toBe(true);
    expect(hostUsesMusl("linux", "arm64", (path) => path === "/lib/libc.musl-aarch64.so.1")).toBe(true);
    expect(hostUsesMusl("linux", "arm64", (path) => path === "/lib/libc.musl-x86_64.so.1")).toBe(false);
    expect(hostUsesMusl("darwin", "arm64", () => true)).toBe(false);
  });

  it("asks the channel for this platform's manifest, and takes nothing it cannot check", async () => {
    const asked: string[] = [];
    const answering = (body: unknown, status = 200) => (async (url: string | URL | Request, init?: RequestInit) => {
      asked.push(String(url));
      expect(init?.redirect).toBe("error");
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }) as typeof fetch;
    const musl = { ...manifest, url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.7-123/linux-x64-musl/cli_linux_x64_musl.tar.gz" };
    expect(await latestAntigravityCliRelease({ fetchImpl: answering(musl), platform: "linux", arch: "x64", musl: true })).toMatchObject({ version: "1.5.7" });
    expect(asked).toEqual([`${ANTIGRAVITY_CLI_MANIFEST_BASE}/linux_amd64_musl.json`]);
    expect(await latestAntigravityCliRelease({ fetchImpl: answering(musl), platform: "linux", arch: "x64", musl: false })).toBeNull();
    expect(await latestAntigravityCliRelease({ fetchImpl: answering(manifest, 503), platform: "darwin", arch: "arm64" })).toBeNull();
    expect(await latestAntigravityCliRelease({ fetchImpl: answering("not json"), platform: "darwin", arch: "arm64" })).toBeNull();
    expect(await latestAntigravityCliRelease({ fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch, platform: "darwin", arch: "arm64" })).toBeNull();
    const before = asked.length;
    expect(await latestAntigravityCliRelease({ fetchImpl: answering(manifest), platform: "freebsd", arch: "x64" })).toBeNull();
    expect(asked).toHaveLength(before);
  });
});
