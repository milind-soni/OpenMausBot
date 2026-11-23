// The native CLI is opt-in (OMB_ANTIGRAVITY_NATIVE_CLI=1). Off, the default, Antigravity behaves as before the CLI: the
// pinned 1.4.3 runtime is kept and run, Google's CLI channel is never asked, a CLI release is never started, the
// signed-in check reads acp_token.json, and the updater offers nothing new. On, a computer with the pinned runtime moves.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { resolveAntigravityReleaseAsset } from "./antigravity-release.ts";

const WINDOWS = process.platform === "win32";
const pinned = resolveAntigravityReleaseAsset();
const scratch: string[] = [];
const CLI_ID = "c".repeat(64);
const CHANNEL = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/";

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

function dataFolder(): string {
  const baseDir = mkdtempSync(join(tmpdir(), "omb-antigravity-opt-in-"));
  scratch.push(baseDir);
  return baseDir;
}

/** A data folder with the pinned release (sparse files of its sizes), and optionally an active CLI release and a CLI
 * sign-in beside the pinned one for one account. */
function computer(options: { pinned?: boolean; cli?: boolean; cliSignIn?: boolean } = {}) {
  const baseDir = dataFolder();
  const root = join(baseDir, "tools", "antigravity-acp", `${process.platform}-${process.arch}`);
  const pinnedDir = join(root, "versions", pinned!.sha256);
  if (options.pinned !== false) {
    mkdirSync(pinnedDir, { recursive: true });
    for (const file of [pinned!.executable, pinned!.harness]) {
      writeFileSync(join(pinnedDir, file.name), "");
      truncateSync(join(pinnedDir, file.name), file.bytes);
      chmodSync(join(pinnedDir, file.name), 0o755);
    }
    writeFileSync(join(pinnedDir, ".install-complete.json"), JSON.stringify({ sha256: pinned!.sha256, version: pinned!.version, executable: pinned!.executable, harness: pinned!.harness }));
  }
  const started = join(baseDir, "cli-started");
  if (options.cli) {
    const cliDir = join(root, "versions", CLI_ID);
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(cliDir, "antigravity"), `#!/bin/sh\ntouch ${JSON.stringify(started)}\necho 1.5.15\n`, { mode: 0o755 });
    writeFileSync(join(cliDir, ".install-complete.json"), JSON.stringify({ releaseId: CLI_ID, version: "1.5.15", executable: { name: "antigravity", bytes: statSync(join(cliDir, "antigravity")).size }, harness: null }));
    writeFileSync(join(root, "active.json"), JSON.stringify({ releaseId: CLI_ID }));
  }
  if (options.cliSignIn) {
    const profile = join(baseDir, "providers", "antigravity", "a".repeat(64), "antigravity-acp");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "antigravity-oauth-token"), "{}");
    writeFileSync(join(profile, "acp_token.json"), "{}");
  }
  return { baseDir, pinnedDir, started };
}

const latestRelease = async () => ({ version: "1.5.15", url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.15-1/x", sha512: "0".repeat(128), executable: { name: "antigravity" }, format: "tar.gz" as const });

/** Every address asked, each answered 404. */
function recordingFetch() {
  const asked: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
  return { asked, fetchImpl };
}

describe.skipIf(!pinned || WINDOWS)("with the native CLI off (the default), Antigravity behaves as before it", () => {
  it("is off unless OMB_ANTIGRAVITY_NATIVE_CLI is exactly 1", async () => {
    expect((await import("./antigravity-cli-install.ts")).ANTIGRAVITY_NATIVE_CLI).toBe(false);
    for (const value of ["0", "true", "yes", ""]) {
      vi.stubEnv("OMB_ANTIGRAVITY_NATIVE_CLI", value);
      vi.resetModules();
      expect((await import("./antigravity-cli-install.ts")).ANTIGRAVITY_NATIVE_CLI, value).toBe(false);
    }
  });

  it("keeps a computer on the pinned runtime, even beside a CLI release, never starts the CLI, and the updater offers nothing new", async () => {
    const runtime = await import("./antigravity-runtime.ts");
    const { baseDir, pinnedDir, started } = computer({ cli: true, cliSignIn: true });
    for (const cli of ["agy", undefined]) {
      await expect(runtime.resolveAntigravityRuntime(cli, { PATH: "" }, baseDir)).resolves.toMatchObject({ version: pinned!.version, source: "managed" });
    }
    // `antigravity` is no alias for the CLI when off: a custom name looked up on PATH, as on main.
    await expect(runtime.resolveAntigravityRuntime("antigravity", { PATH: "" }, baseDir)).rejects.toThrow("sibling is missing.");
    const latest = vi.fn(latestRelease);
    expect(await runtime.antigravityCliUpdate({ baseDir, now: Date.now() + 1e9, latest })).toBeNull();
    expect(latest).not.toHaveBeenCalled();
    // The updater's own question, as main asks it: is an older pinned release installed? No.
    expect(await runtime.antigravityOlderRuntime(baseDir)).toBeNull();
    expect(await runtime.retirePinnedAntigravityRuntime({ baseDir, inUse: () => false })).toEqual([]);
    expect(existsSync(pinnedDir)).toBe(true);
    expect(existsSync(started)).toBe(false);
  });

  it("never asks Google's CLI channel: an install over the pinned runtime reuses it, and a fresh install downloads the pinned runtime", async () => {
    const runtime = await import("./antigravity-runtime.ts");
    const existing = computer();
    const reuse = recordingFetch();
    await expect(runtime.installAntigravityRuntime({ baseDir: existing.baseDir, fetchImpl: reuse.fetchImpl })).resolves.toMatchObject({ version: pinned!.version });
    expect(reuse.asked).toEqual([]);
    const fresh = recordingFetch();
    await expect(runtime.installAntigravityRuntime({ baseDir: dataFolder(), fetchImpl: fresh.fetchImpl })).rejects.toThrow("Google download failed (404).");
    expect(fresh.asked).toEqual([pinned!.url]);
    expect(fresh.asked.some((url) => url.startsWith(CHANNEL))).toBe(false);
    expect(runtime.isAntigravityNativeAlias("antigravity")).toBe(false);
  });

  it("does not start a custom program named antigravity, and says what it said before", async () => {
    const runtime = await import("./antigravity-runtime.ts");
    const directory = dataFolder(), started = join(directory, "started"), program = join(directory, "antigravity");
    writeFileSync(program, `#!/bin/sh\ntouch ${JSON.stringify(started)}\necho 1.5.15\n`, { mode: 0o755 });
    await expect(runtime.resolveAntigravityRuntime(program, { PATH: "" }, dataFolder()))
      .rejects.toThrow(/^The custom Antigravity ACP executable or its localharness_external sibling is missing\.$/u);
    expect(existsSync(started)).toBe(false);
  });

  it("reads the signed-in state from acp_token.json and starts the runtime with the environment it had", async () => {
    const acp = await import("./antigravity-acp.ts");
    const profile = await acp.prepareAntigravityProfile({
      instanceId: "off", baseDir: dataFolder(), runtime: { executablePath: "/r/agy_acp_server.par", harnessPath: "/r/localharness_external", source: "managed", version: pinned!.version },
      baseEnv: { PATH: "/usr/bin", SSH_CONNECTION: "203.0.113.9 52144 10.0.0.2 22" },
    });
    expect(profile.tokenPath).toBe(join(profile.directory, "antigravity-acp", "acp_token.json"));
    expect(profile.environment.AGY_CLI_DISABLE_AUTO_UPDATE).toBeUndefined();
    expect(profile.environment.SSH_CONNECTION).toBe("203.0.113.9 52144 10.0.0.2 22");
    expect(profile.environment.ANTIGRAVITY_HARNESS_PATH).toBe("/r/localharness_external");
    // A CLI sign-in file beside it does not count; the pinned runtime's own does.
    writeFileSync(join(profile.directory, "antigravity-acp", "antigravity-oauth-token"), "{\"token\":{}}");
    expect(await acp.antigravityProfileAuthenticated(profile)).toBe(false);
    writeFileSync(profile.tokenPath, "{\"refresh_token\":\"r\"}");
    expect(await acp.antigravityProfileAuthenticated(profile)).toBe(true);
  });

  it("offers the pinned install card with its download size, as before", async () => {
    const { AntigravityDriver } = await import("./antigravity.ts");
    expect(AntigravityDriver.install?.managed).toEqual({ label: "Install official Antigravity", downloadBytes: pinned!.archiveBytes });
  });
});

describe.skipIf(!pinned || WINDOWS)("with OMB_ANTIGRAVITY_NATIVE_CLI=1", () => {
  async function optedIn() {
    vi.stubEnv("OMB_ANTIGRAVITY_NATIVE_CLI", "1");
    vi.resetModules();
    return import("./antigravity-runtime.ts");
  }

  it("keeps running the pinned runtime until the CLI is installed, and the updater offers the move from its version", async () => {
    const runtime = await optedIn();
    const { baseDir } = computer();
    await expect(runtime.resolveAntigravityRuntime("agy", { PATH: "" }, baseDir)).resolves.toMatchObject({ version: pinned!.version });
    expect(await runtime.antigravityCliUpdate({ baseDir, now: Date.now() + 1e9, latest: latestRelease })).toBe(pinned!.version);
    expect(await runtime.retirePinnedAntigravityRuntime({ baseDir, inUse: () => false })).toEqual([]);
  });

  it("runs the CLI once it is installed, and removes the pinned runtime only after an account signed in on it", async () => {
    const runtime = await optedIn();
    const before = computer({ cli: true });
    await expect(runtime.resolveAntigravityRuntime("agy", { PATH: "" }, before.baseDir)).resolves.toMatchObject({ version: "1.5.15", harnessPath: null });
    expect(await runtime.retirePinnedAntigravityRuntime({ baseDir: before.baseDir, inUse: () => false })).toEqual([]);
    const after = computer({ cli: true, cliSignIn: true });
    expect(await runtime.retirePinnedAntigravityRuntime({ baseDir: after.baseDir, inUse: () => false })).toEqual([pinned!.sha256]);
  });
});
