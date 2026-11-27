// Which runtime an Antigravity account runs. Its CLI path decides: `antigravity` the native CLI,
// `agy_acp_server` the pinned (Classic) runtime. With neither, a computer that has the pinned runtime keeps it, nothing
// is moved or removed, and a new install takes the CLI. OMB_ANTIGRAVITY_NATIVE_CLI=1 gives such an account the
// CLI even where the pinned runtime is installed; an account set to a runtime keeps it, and nothing is removed.
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

describe.skipIf(!pinned || WINDOWS)("by default, a computer that has the pinned runtime", () => {
  it("is not switched by OMB_ANTIGRAVITY_NATIVE_CLI unless it is exactly 1", async () => {
    expect((await import("./antigravity-cli-install.ts")).ANTIGRAVITY_CLI_FIRST).toBe(false);
    for (const value of ["0", "true", "yes", ""]) {
      vi.stubEnv("OMB_ANTIGRAVITY_NATIVE_CLI", value);
      vi.resetModules();
      expect((await import("./antigravity-cli-install.ts")).ANTIGRAVITY_CLI_FIRST, value).toBe(false);
    }
  });

  it("keeps running it for an account that names no runtime, even beside a CLI release and a CLI sign-in, and the updater offers no move", async () => {
    const runtime = await import("./antigravity-runtime.ts");
    const { baseDir, pinnedDir, started } = computer({ cli: true, cliSignIn: true });
    for (const cli of ["agy", undefined, "agy_acp_server"]) {
      await expect(runtime.resolveAntigravityRuntime(cli, { PATH: "" }, baseDir), String(cli)).resolves.toMatchObject({ version: pinned!.version, source: "managed" });
    }
    const latest = vi.fn(latestRelease);
    expect(await runtime.antigravityCliUpdate({ baseDir, now: Date.now() + 1e9, latest, configuredClis: ["agy"] })).toBeNull();
    expect(latest).not.toHaveBeenCalled();
    expect(await runtime.antigravityOlderRuntime(baseDir)).toBeNull();
    expect(existsSync(pinnedDir)).toBe(true);
    expect(existsSync(started)).toBe(false);
  });

  it("runs the CLI for an account set to it, and updates the CLI for it", async () => {
    const runtime = await import("./antigravity-runtime.ts");
    const { baseDir, pinnedDir } = computer({ cli: true });
    await expect(runtime.resolveAntigravityRuntime("antigravity", { PATH: "" }, baseDir)).resolves.toMatchObject({ version: "1.5.15", harnessPath: null });
    const newer = async () => ({ ...(await latestRelease()), version: "1.5.16" });
    expect(await runtime.antigravityCliUpdate({ baseDir, now: Date.now() + 2e9, latest: newer, configuredClis: ["antigravity"] })).toBe("1.5.15");
    expect(existsSync(pinnedDir)).toBe(true);
  });

  it("is reused by an install for an account that names no runtime, and Google's CLI channel is not asked", async () => {
    const runtime = await import("./antigravity-runtime.ts");
    const existing = computer();
    const reuse = recordingFetch();
    await expect(runtime.installAntigravityRuntime({ baseDir: existing.baseDir, fetchImpl: reuse.fetchImpl })).resolves.toMatchObject({ version: pinned!.version });
    expect(reuse.asked).toEqual([]);
  });

  it("reads an account's sign-in from acp_token.json and starts the runtime with the environment it had", async () => {
    const acp = await import("./antigravity-acp.ts");
    const profile = await acp.prepareAntigravityProfile({
      instanceId: "classic", baseDir: dataFolder(), runtime: { executablePath: "/r/agy_acp_server.par", harnessPath: "/r/localharness_external", source: "managed", version: pinned!.version },
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
});

describe.skipIf(!pinned || WINDOWS)("a new install", () => {
  it("keeps an account that names no runtime on the CLI once an account set to the Classic runtime installs it beside it", async () => {
    const runtime = await import("./antigravity-runtime.ts");
    const { baseDir } = computer({ cli: true });
    // What installing the CLI on a computer with no pinned runtime leaves behind (antigravity-native-cli.test.ts).
    writeFileSync(join(baseDir, "tools", "antigravity-acp", `${process.platform}-${process.arch}`, "cli-first.json"), "{}\n");
    for (const cli of ["agy", undefined]) {
      await expect(runtime.resolveAntigravityRuntime(cli, { PATH: "" }, baseDir), String(cli)).resolves.toMatchObject({ version: "1.5.15", harnessPath: null });
    }
    await expect(runtime.resolveAntigravityRuntime("agy_acp_server", { PATH: "" }, baseDir)).resolves.toMatchObject({ version: pinned!.version, source: "managed" });
    const newer = async () => ({ ...(await latestRelease()), version: "1.5.16" });
    expect(await runtime.antigravityCliUpdate({ baseDir, now: Date.now() + 3e9, latest: newer, configuredClis: ["agy_acp_server"] })).toBe("1.5.15");
  });

  it("takes the CLI from Google's channel for an account that names no runtime, and the pinned runtime for one set to it", async () => {
    const runtime = await import("./antigravity-runtime.ts");
    const fresh = recordingFetch();
    await expect(runtime.installAntigravityRuntime({ baseDir: dataFolder(), fetchImpl: fresh.fetchImpl })).rejects.toThrow();
    expect(fresh.asked.some((url) => url.startsWith(CHANNEL))).toBe(true);
    const classic = recordingFetch();
    await expect(runtime.installAntigravityRuntime({ baseDir: dataFolder(), fetchImpl: classic.fetchImpl, nativeByDefault: false })).rejects.toThrow("Google download failed (404).");
    expect(classic.asked).toEqual([pinned!.url]);
    await expect(runtime.resolveAntigravityRuntime(undefined, { PATH: "" }, dataFolder())).rejects.toThrow("The Google Antigravity CLI is not installed yet.");
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
  });

  it("runs the CLI once it is installed for an account that names no runtime, keeps an account set to the pinned runtime on it, and removes nothing", async () => {
    const runtime = await optedIn();
    const { baseDir, pinnedDir } = computer({ cli: true, cliSignIn: true });
    for (const cli of ["agy", undefined]) {
      await expect(runtime.resolveAntigravityRuntime(cli, { PATH: "" }, baseDir), String(cli)).resolves.toMatchObject({ version: "1.5.15", harnessPath: null });
    }
    await expect(runtime.resolveAntigravityRuntime("agy_acp_server", { PATH: "" }, baseDir)).resolves.toMatchObject({ version: pinned!.version, source: "managed" });
    expect(existsSync(pinnedDir)).toBe(true);
  });
});
