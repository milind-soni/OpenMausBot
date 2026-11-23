// A computer that has the pinned 1.4.3 runtime: the move to the native CLI, and the switch that rolls it back.
import { chmodSync, mkdirSync, mkdtempSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { resolveAntigravityReleaseAsset } from "./antigravity-release.ts";

const WINDOWS = process.platform === "win32";
const pinned = resolveAntigravityReleaseAsset();
const scratch: string[] = [];
const CLI_ID = "c".repeat(64);

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

/** A data folder with the pinned release (sparse files of its sizes), and optionally an active CLI release and a CLI
 * sign-in for one account. */
function computer(options: { cli?: boolean; cliSignIn?: boolean } = {}) {
  const baseDir = mkdtempSync(join(tmpdir(), "omb-antigravity-rollback-"));
  scratch.push(baseDir);
  const root = join(baseDir, "tools", "antigravity-acp", `${process.platform}-${process.arch}`);
  const pinnedDir = join(root, "versions", pinned!.sha256);
  mkdirSync(pinnedDir, { recursive: true });
  for (const file of [pinned!.executable, pinned!.harness]) {
    writeFileSync(join(pinnedDir, file.name), "");
    truncateSync(join(pinnedDir, file.name), file.bytes);
    chmodSync(join(pinnedDir, file.name), 0o755);
  }
  writeFileSync(join(pinnedDir, ".install-complete.json"), JSON.stringify({ sha256: pinned!.sha256, version: pinned!.version, executable: pinned!.executable, harness: pinned!.harness }));
  if (options.cli) {
    const cliDir = join(root, "versions", CLI_ID);
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(cliDir, "antigravity"), "#!/bin/sh\necho 1.5.15\n", { mode: 0o755 });
    writeFileSync(join(cliDir, ".install-complete.json"), JSON.stringify({ releaseId: CLI_ID, version: "1.5.15", executable: { name: "antigravity", bytes: statSync(join(cliDir, "antigravity")).size }, harness: null }));
    writeFileSync(join(root, "active.json"), JSON.stringify({ releaseId: CLI_ID }));
  }
  if (options.cliSignIn) {
    const profile = join(baseDir, "providers", "antigravity", "a".repeat(64), "antigravity-acp");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "antigravity-oauth-token"), "{}");
    writeFileSync(join(profile, "acp_token.json"), "{}");
  }
  return { baseDir, pinnedDir };
}

const latest = async () => ({ version: "1.5.15", url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.15-1/x", sha512: "0".repeat(128), executable: { name: "antigravity" }, format: "tar.gz" as const });

describe.skipIf(!pinned || WINDOWS)("a computer that has the pinned runtime", () => {
  it("keeps running it until the CLI is installed, and the updater offers the move from its version", async () => {
    const runtime = await import("./antigravity-runtime.ts");
    const { baseDir } = computer();
    await expect(runtime.resolveAntigravityRuntime("agy", { PATH: "" }, baseDir)).resolves.toMatchObject({ version: pinned!.version, source: "managed" });
    expect(await runtime.antigravityCliUpdate({ baseDir, now: Date.now() + 1e9, latest })).toBe(pinned!.version);
    // Nothing is removed while the CLI is not there.
    expect(await runtime.retirePinnedAntigravityRuntime({ baseDir, inUse: () => false })).toEqual([]);
  });

  it("runs the pinned runtime again, offers no CLI update and removes nothing behind OMB_ANTIGRAVITY_PINNED_RUNTIME=1", async () => {
    vi.stubEnv("OMB_ANTIGRAVITY_PINNED_RUNTIME", "1");
    vi.resetModules();
    const runtime = await import("./antigravity-runtime.ts");
    const install = await import("./antigravity-cli-install.ts");
    expect(install.ANTIGRAVITY_NATIVE_CLI).toBe(false);
    const { baseDir, pinnedDir } = computer({ cli: true, cliSignIn: true });
    await expect(runtime.resolveAntigravityRuntime("agy", { PATH: "" }, baseDir)).resolves.toMatchObject({ version: pinned!.version });
    await expect(runtime.resolveAntigravityRuntime(undefined, { PATH: "" }, baseDir)).resolves.toMatchObject({ version: pinned!.version });
    expect(await runtime.antigravityCliUpdate({ baseDir, now: Date.now() + 2e9, latest })).toBeNull();
    expect(await runtime.retirePinnedAntigravityRuntime({ baseDir, inUse: () => false })).toEqual([]);
    expect(statSync(pinnedDir).isDirectory()).toBe(true);
  });

  it("without the switch, runs the CLI once it is installed", async () => {
    const runtime = await import("./antigravity-runtime.ts");
    const { baseDir } = computer({ cli: true });
    await expect(runtime.resolveAntigravityRuntime("agy", { PATH: "" }, baseDir)).resolves.toMatchObject({ version: "1.5.15", harnessPath: null });
  });
});
