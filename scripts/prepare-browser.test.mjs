import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserBundlePaths, browserBundleSpec, CHROME_VERSION, SUPPORTED_BROWSER_TARGETS } from "../server/browser-bundle-release.ts";
import { resolveAgentBrowserReleaseAsset } from "../server/browser-engine-release.ts";
import { BROWSER_LICENSE_FILES, browserExtractionCommand, bundleInventory, parsePrepareBrowserArgs, releaseBytes, stageBrowserTarget, targetsForPreparation, verifyAssetBytes, verifyBrowserBundle, verifyBundleInventory } from "./prepare-browser.mjs";

const fixtures = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "omb-browser-prepare-test-")); fixtures.push(root); return root; }
afterEach(() => { vi.unstubAllGlobals(); for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("pinned desktop browser preparation", () => {
  it("pins the exact headless vendor archives for only shipped targets", () => {
    expect(CHROME_VERSION).toBe("153.0.8010.47");
    expect(SUPPORTED_BROWSER_TARGETS).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
    const pins = {
      "darwin-arm64": [98668949, "6d28839675b6f22dbd7ba8775dbdabcae7a5be37b482380b27b12f05b748b955"],
      "darwin-x64": [103712919, "aa178547f9751fbcf413e0f57915ddb72e83064d4d1c4a29dc1719b169f9cc2f"],
      "linux-arm64": [120245582, "af0931a58d6bab688112d5ca1f7abd6d95c0b8a296ef34637f272795787774d7"],
      "linux-x64": [119695587, "7728775cf4a35464cd81c8eea2d44d6d32ccc0bd1edfa75aea7f32d146963d63"],
      "win32-x64": [120466147, "9f405cfaf7bc08bf9e046e653cd3086c0faa1d4e25907de857f7e7f093a20122"],
    };
    for (const target of SUPPORTED_BROWSER_TARGETS) {
      const spec = browserBundleSpec(target);
      expect([spec.chrome.bytes, spec.chrome.sha256]).toEqual(pins[target]);
      expect(spec.chrome.url).toMatch(/^https:\/\/storage.googleapis.com\/chrome-for-testing-public\/153\.0\.8010\.47\/[^/]+\/chrome-headless-shell-[^/]+\.zip$/);
      const [platform, arch] = target.split("-");
      const engine = resolveAgentBrowserReleaseAsset(platform, arch);
      expect(spec.engine).toMatchObject({ bytes: engine.bytes, sha256: engine.sha256, asset: engine.asset });
      expect(spec.chrome.license).toMatch(/LICENSE\.headless_shell$/);
    }
  });

  it("chooses host targets and rejects unsupported/cross-directory inputs", () => {
    expect(targetsForPreparation({ platform: "darwin", arch: "arm64" })).toEqual(["darwin-arm64", "darwin-x64"]);
    expect(targetsForPreparation({ platform: "darwin", arch: "arm64", current: true })).toEqual(["darwin-arm64"]);
    expect(targetsForPreparation({ platform: "win32", arch: "x64" })).toEqual(["win32-x64"]);
    expect(targetsForPreparation({ target: "linux-x64" })).toEqual(["linux-x64"]);
    expect(targetsForPreparation({ platform: "linux", arch: "arm64" })).toEqual(["linux-arm64"]);
    for (const target of ["win32-arm64", "../darwin-arm64", "freebsd-x64"]) expect(() => browserBundleSpec(target)).toThrow(/Unsupported/);
    expect(() => targetsForPreparation({ platform: "win32", arch: "arm64" })).toThrow(/Unsupported/);
  });

  it("has stable resource-relative paths on every platform", () => {
    const root = join("app", "resources", "browser-engine");
    for (const target of SUPPORTED_BROWSER_TARGETS) {
      const spec = browserBundleSpec(target);
      const paths = browserBundlePaths(root, target);
      expect(paths.engine).toBe(join(root, target.startsWith("win32") ? "agent-browser.exe" : "agent-browser"));
      expect(paths.chrome).toBe(join(root, spec.chrome.executable));
      expect(paths.manifest).toBe(join(root, "manifest.json"));
    }
  });

  it("accepts only explicit and unambiguous CLI modes", () => {
    const host = { platform: "linux", arch: "x64" };
    expect(parsePrepareBrowserArgs(["--current"], host)).toEqual({ current: true });
    expect(parsePrepareBrowserArgs(["--target", "linux-x64"], host)).toEqual({ current: false, target: "linux-x64" });
    for (const args of [["--all"], ["--current", "--current"], ["--current", "--target", "linux-x64"], ["--target"], ["--target", "../../tmp"]]) expect(() => parsePrepareBrowserArgs(args, host)).toThrow();
  });

  it("uses Windows' ZIP-capable system tar instead of Git Bash's GNU tar", () => {
    expect(browserExtractionCommand("a.zip", "out", { platform: "win32", systemRoot: "D:\\Windows" })).toEqual({ file: "D:\\Windows\\System32\\tar.exe", args: ["-xf", "a.zip", "-C", "out"] });
    expect(browserExtractionCommand("a.zip", "out", { platform: "darwin" })).toEqual({ file: "unzip", args: ["-q", "a.zip", "-d", "out"] });
  });

  it("repairs a tampered cache by re-downloading and fails closed on a bad download", async () => {
    const root = fixture();
    const bytes = Buffer.from("reviewed fixture");
    const asset = { asset: "fixture.zip", url: "https://invalid.example/fixture", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    writeFileSync(join(root, asset.asset), bytes);
    const fetch = vi.fn(async () => new Response(bytes)); vi.stubGlobal("fetch", fetch);
    await expect(releaseBytes(asset, root)).resolves.toEqual(bytes);
    expect(fetch).not.toHaveBeenCalled();
    writeFileSync(join(root, asset.asset), Buffer.alloc(bytes.length));
    // Same-size tampering is a cache miss, never a dead end: the pinned
    // download repairs the entry.
    await expect(releaseBytes(asset, root)).resolves.toEqual(bytes);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(root, asset.asset))).toEqual(bytes);
    writeFileSync(join(root, asset.asset), Buffer.alloc(bytes.length));
    fetch.mockResolvedValueOnce(new Response(Buffer.alloc(bytes.length)));
    await expect(releaseBytes(asset, root)).rejects.toThrow(/SHA-256/);
    expect(() => verifyAssetBytes(bytes.subarray(1), asset)).toThrow(/size/);
  });

  it("detects modified, missing and unexpected resource files", () => {
    const root = fixture();
    mkdirSync(join(root, "chrome"));
    writeFileSync(join(root, "chrome", "resource.pak"), "fixture");
    const inventory = bundleInventory(root);
    expect(() => verifyBundleInventory(root, inventory)).not.toThrow();
    writeFileSync(join(root, "chrome", "resource.pak"), "changed");
    expect(() => verifyBundleInventory(root, inventory)).toThrow(/modified/);
    rmSync(join(root, "chrome", "resource.pak"));
    expect(() => verifyBundleInventory(root, inventory)).toThrow(/incomplete/);
    writeFileSync(join(root, "extra"), "unexpected");
    expect(() => verifyBundleInventory(root, inventory)).toThrow(/modified/);
  });

  it.skipIf(process.platform === "win32")("preserves internal symlinks but rejects escaping vendor paths", () => {
    const root = fixture();
    writeFileSync(join(root, "library"), "contents");
    symlinkSync("library", join(root, "current"));
    expect(bundleInventory(root)).toContainEqual({ path: "current", kind: "symlink", target: "library" });
    symlinkSync("..", join(root, "escape"));
    expect(() => bundleInventory(root)).toThrow(/escapes/);
  });

  it("rejects incomplete and incompatible manifests", () => {
    const root = fixture();
    expect(() => verifyBrowserBundle(root, "darwin-arm64")).toThrow();
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ ...browserBundleSpec("linux-x64"), files: [] }));
    expect(() => verifyBrowserBundle(root, "darwin-arm64")).toThrow(/pinned release/);
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ ...browserBundleSpec("darwin-arm64"), files: [] }));
    expect(() => verifyBrowserBundle(root, "darwin-arm64")).toThrow();
  });

  it("keeps an earlier complete stage untouched when cached inputs are invalid", async () => {
    const root = fixture();
    const destination = join(root, "dist-native", "browser", "linux-x64");
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "existing"), "previous complete bundle");
    const cache = join(root, "cache"); mkdirSync(cache);
    const spec = browserBundleSpec("linux-x64");
    writeFileSync(join(cache, spec.engine.asset), "bad");
    writeFileSync(join(cache, spec.chrome.asset), "bad");
    // Invalid cache entries are deleted and re-downloaded; a download that
    // also fails verification keeps the failure local to this run.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad")));
    await expect(stageBrowserTarget(root, "linux-x64", { cacheDirectory: cache })).rejects.toThrow(/verification/);
    expect(readFileSync(join(destination, "existing"), "utf8")).toBe("previous complete bundle");
  });

  it("ships exact upstream engine and embedded axe notices, not the dashboard license", () => {
    for (const name of BROWSER_LICENSE_FILES) expect(readFileSync(new URL(`../third_party/browser/${name}`, import.meta.url)).length).toBeGreaterThan(100);
    expect(readFileSync(new URL("../third_party/browser/agent-browser-LICENSE.txt", import.meta.url), "utf8")).toContain("Apache License");
  });
});
