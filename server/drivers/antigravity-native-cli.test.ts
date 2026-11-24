import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";

import { distrustHomePrograms } from "../bot-box/program-trust.ts";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { antigravityRuntimesRoot } from "../engine-roots.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import {
  antigravityCliSessionMode,
  antigravityLaunchArgs,
  isValidAntigravityInitializeResult,
  prepareAntigravityProfile,
  validateAntigravityRuntime,
} from "./antigravity-acp.ts";
import { activeAntigravityCli, isAntigravityCliName } from "./antigravity-cli-install.ts";
import type { AntigravityCliReleaseAsset } from "./antigravity-cli-release.ts";
import { resolveAntigravityReleaseAsset } from "./antigravity-release.ts";
import { antigravityCliUpdate, installAntigravityRuntime, resolveAntigravityRuntime } from "./antigravity-runtime.ts";
import { antigravityManagedRuntime } from "../engine-updates-host.ts";
import { createEngineUpdater } from "../engine-updates.ts";
import { AntigravityDriver } from "./antigravity.ts";

// The opt-in, before any module reads it: this file tests the native CLI switched on.
vi.hoisted(() => { process.env.OMB_ANTIGRAVITY_NATIVE_CLI = "1"; });

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts");
const WINDOWS = process.platform === "win32";
const NAME = WINDOWS ? "agy.exe" : "antigravity";
const ORIGIN = "https://storage.googleapis.com/antigravity-public/antigravity-cli/";
const scratch: string[] = [];
const instances: ProviderInstance[] = [];

function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-cli-"));
  scratch.push(directory);
  return directory;
}

/** A release as Google's channel names it, with the bytes its address serves. */
async function release(version: string, members: Record<string, string | { link: string }> = { [NAME]: `#!/bin/sh\necho ${version}\n` }) {
  let bytes: Buffer;
  if (WINDOWS) bytes = Buffer.from(String(Object.values(members)[0]));
  else {
    const source = folder();
    for (const [name, content] of Object.entries(members)) {
      if (typeof content === "string") writeFileSync(join(source, name), content, { mode: 0o755 });
      else symlinkSync(content.link, join(source, name));
    }
    const archive = join(folder(), "cli.tar.gz");
    await tar.c({ gzip: true, file: archive, cwd: source, portable: true }, Object.keys(members));
    bytes = readFileSync(archive);
  }
  const asset: AntigravityCliReleaseAsset = {
    version, url: `${ORIGIN}${version}-1/fixture`, sha512: createHash("sha512").update(bytes).digest("hex"),
    executable: { name: NAME }, format: WINDOWS ? "executable" : "tar.gz",
  };
  return { asset, bytes };
}

function serving(files: Array<{ asset: AntigravityCliReleaseAsset; bytes: Buffer }>, finalUrl?: string) {
  const asked: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    asked.push(String(url));
    const file = files.find(({ asset }) => asset.url === String(url));
    if (!file) return new Response("missing", { status: 404 });
    const response = new Response(file.bytes);
    Object.defineProperty(response, "url", { value: finalUrl ?? String(url) });
    return response;
  }) as typeof fetch;
  return { fetchImpl, asked };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const instance of instances.splice(0)) await instance.dispose();
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

describe("installing the native CLI from Google's channel", () => {
  it("verifies, unpacks, checks and activates a release, then reuses it without another download", async () => {
    const baseDir = folder();
    const one = await release("1.5.7");
    const { fetchImpl, asked } = serving([one]);
    const validate = vi.fn(async () => {});
    const installed = await installAntigravityRuntime({ baseDir, fetchImpl, validate, native: true, cliRelease: one.asset });
    expect(installed).toMatchObject({ harnessPath: null, source: "managed", version: "1.5.7" });
    expect(installed.executablePath.endsWith(join(one.asset.sha512.slice(0, 64), NAME))).toBe(true);
    if (!WINDOWS) expect(readFileSync(installed.executablePath, "utf8")).toBe("#!/bin/sh\necho 1.5.7\n");
    expect(validate).toHaveBeenCalledWith(expect.objectContaining({ harnessPath: null, version: "1.5.7" }), "1.5.7");
    const root = join(antigravityRuntimesRoot(baseDir), `${process.platform}-${process.arch}`);
    expect(await activeAntigravityCli(root)).toEqual(installed);
    expect(readdirSync(join(root, "versions")).filter((name) => name.startsWith(".install-"))).toEqual([]);
    // The first runtime on this computer: accounts that name none keep the CLI even once the pinned one is installed beside it.
    expect(existsSync(join(root, "cli-first.json"))).toBe(true);

    await expect(resolveAntigravityRuntime("antigravity", { PATH: "" }, baseDir)).resolves.toEqual(installed);
    await expect(resolveAntigravityRuntime("agy", { PATH: "" }, baseDir, { nativeByDefault: true })).resolves.toEqual(installed);
    await expect(resolveAntigravityRuntime(undefined, { PATH: "" }, baseDir, { nativeByDefault: true })).resolves.toEqual(installed);

    await installAntigravityRuntime({ baseDir, fetchImpl, validate, native: true, cliRelease: one.asset });
    expect(asked).toEqual([one.asset.url]);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("moves to a newer release, removes the one it replaced, and never moves back to an older one", async () => {
    const baseDir = folder();
    const [older, newer] = [await release("1.5.6"), await release("1.5.8")];
    const { fetchImpl, asked } = serving([older, newer]);
    const first = await installAntigravityRuntime({ baseDir, fetchImpl, cliRelease: older.asset, native: true });
    const second = await installAntigravityRuntime({ baseDir, fetchImpl, cliRelease: newer.asset, native: true });
    expect(second.version).toBe("1.5.8");
    // Pruned once the newer one is active and nothing runs the older one (T3 Code 68ea2220c12).
    expect(existsSync(dirname(first.executablePath))).toBe(false);
    if (!WINDOWS) {
      // Published releases are read-only.
      expect(statSync(dirname(second.executablePath)).mode & 0o777).toBe(0o555);
      expect(statSync(second.executablePath).mode & 0o777).toBe(0o555);
    }
    await expect(resolveAntigravityRuntime("antigravity", { PATH: "" }, baseDir)).resolves.toMatchObject({ version: "1.5.8" });
    expect((await installAntigravityRuntime({ baseDir, fetchImpl, cliRelease: older.asset, native: true })).version).toBe("1.5.8");
    expect(asked).toEqual([older.asset.url, newer.asset.url]);
  });

  it("installs nothing when the bytes do not match the channel's checksum, or come from somewhere else", async () => {
    const baseDir = folder();
    const one = await release("1.5.7");
    const wrong = { asset: one.asset, bytes: Buffer.concat([one.bytes, Buffer.from("x")]) };
    await expect(installAntigravityRuntime({ baseDir, fetchImpl: serving([wrong]).fetchImpl, native: true, cliRelease: one.asset }))
      .rejects.toThrow("failed its size or checksum check. Nothing was installed.");
    await expect(installAntigravityRuntime({ baseDir, fetchImpl: serving([one], "https://storage.googleapis.com/another-bucket/cli").fetchImpl, native: true, cliRelease: one.asset }))
      .rejects.toThrow("redirected away from Google's release folder");
    await expect(installAntigravityRuntime({ baseDir, fetchImpl: serving([]).fetchImpl, native: true, cliRelease: one.asset })).rejects.toThrow("Google download failed (404).");
    await expect(installAntigravityRuntime({ baseDir, native: true, cliRelease: null })).rejects.toThrow("Could not find a native Antigravity CLI release.");
    await expect(resolveAntigravityRuntime("antigravity", { PATH: "" }, baseDir)).rejects.toThrow(/^The Google Antigravity CLI is not installed yet\. Install it here\.$/u);
    const root = join(antigravityRuntimesRoot(baseDir), `${process.platform}-${process.arch}`);
    expect(existsSync(join(root, "active.json"))).toBe(false);
    expect(readdirSync(join(root, "versions"))).toEqual([]);
  });

  it("leaves the release that was running in place when the new one does not start", async () => {
    const baseDir = folder();
    const [older, newer] = [await release("1.5.6"), await release("1.5.8")];
    const { fetchImpl } = serving([older, newer]);
    await installAntigravityRuntime({ baseDir, fetchImpl, cliRelease: older.asset, native: true });
    const validate = vi.fn(async () => { throw new Error("The download did not identify as the expected Google Antigravity ACP release."); });
    await expect(installAntigravityRuntime({ baseDir, fetchImpl, validate, cliRelease: newer.asset, native: true })).rejects.toThrow("did not identify");
    await expect(resolveAntigravityRuntime("antigravity", { PATH: "" }, baseDir)).resolves.toMatchObject({ version: "1.5.6" });
  });

  it.skipIf(WINDOWS).each([
    ["a second file", { antigravity: "#!/bin/sh\n", extra: "more" }],
    ["another name", { "agy-other": "#!/bin/sh\n" }],
    ["a link", { antigravity: { link: "/bin/sh" } }],
  ] as Array<[string, Record<string, string | { link: string }>]>)("refuses an archive that holds %s", async (_name, members) => {
    const baseDir = folder();
    const bad = await release("1.5.7", members);
    await expect(installAntigravityRuntime({ baseDir, fetchImpl: serving([bad]).fetchImpl, native: true, cliRelease: bad.asset }))
      .rejects.toThrow("The Antigravity archive must contain one regular executable.");
  });

  it("moves a computer that has one of the pinned runtime's releases to the native CLI", async () => {
    const pinned = resolveAntigravityReleaseAsset();
    if (!pinned) return;
    const baseDir = folder();
    const earlier = "f".repeat(64);
    const directory = join(antigravityRuntimesRoot(baseDir), `${process.platform}-${process.arch}`, "versions", earlier);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, ".install-complete.json"), JSON.stringify({ sha256: earlier, version: "1.1.1" }));
    const one = await release("1.5.7");
    const { fetchImpl, asked } = serving([one]);
    // The updater offers the move while the pinned release is what is installed.
    expect(await antigravityCliUpdate({ baseDir, now: 1, latest: async () => one.asset })).toBe("1.1.1");
    await expect(installAntigravityRuntime({ baseDir, fetchImpl, cliRelease: one.asset })).resolves.toMatchObject({ harnessPath: null, version: "1.5.7" });
    expect(asked).toEqual([one.asset.url]);
    await expect(resolveAntigravityRuntime("agy", { PATH: "" }, baseDir)).resolves.toMatchObject({ harnessPath: null, version: "1.5.7" });
    expect(await antigravityCliUpdate({ baseDir, now: 2, latest: async () => one.asset })).toBeNull();
  });

  it("falls back to the pinned runtime when a new install cannot get the native CLI", async () => {
    const pinned = resolveAntigravityReleaseAsset();
    if (!pinned) return;
    const baseDir = folder();
    const one = await release("1.5.7");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchImpl, asked } = serving([]);
    await expect(installAntigravityRuntime({ baseDir, fetchImpl, cliRelease: one.asset, nativeByDefault: true })).rejects.toThrow("Google download failed (404).");
    expect(asked).toEqual([one.asset.url, pinned.url]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("using the pinned runtime instead"));
    warn.mockRestore();
  });

  it("offers an update while the CLI in use is older than the channel's, asking the channel at most once an hour", async () => {
    const baseDir = folder();
    const [current, newer] = [await release("1.5.7"), await release("1.5.8")];
    await installAntigravityRuntime({ baseDir, fetchImpl: serving([current]).fetchImpl, cliRelease: current.asset, native: true });
    const latest = vi.fn(async () => newer.asset);
    const hour = 60 * 60 * 1000, start = Date.now() + 10 * hour;
    expect(await antigravityCliUpdate({ baseDir, now: start, latest, asset: null, nativeByDefault: true })).toBe("1.5.7");
    // The engine was busy: the next look, minutes later, still finds the update without asking again.
    expect(await antigravityCliUpdate({ baseDir, now: start + 5 * 60_000, latest, asset: null, nativeByDefault: true })).toBe("1.5.7");
    expect(await antigravityCliUpdate({ baseDir, now: start + hour - 1, latest, asset: null, nativeByDefault: true })).toBe("1.5.7");
    expect(latest).toHaveBeenCalledTimes(1);
    expect(await antigravityCliUpdate({ baseDir, now: start + hour, latest: async () => current.asset, asset: null, nativeByDefault: true })).toBeNull();
    // A channel that did not answer is asked again on the next look.
    const silent = vi.fn(async () => null);
    expect(await antigravityCliUpdate({ baseDir, now: start + 2 * hour, latest: silent, asset: null, nativeByDefault: true })).toBeNull();
    expect(await antigravityCliUpdate({ baseDir, now: start + 2 * hour + 1, latest, asset: null, nativeByDefault: true })).toBe("1.5.7");
    expect(await antigravityCliUpdate({ baseDir: folder(), now: start + 4 * hour, latest, asset: null, nativeByDefault: true })).toBeNull();
  });

  it.skipIf(!resolveAntigravityReleaseAsset() || WINDOWS)("with the switch on, runs and updates the CLI where the pinned runtime is also installed, and leaves the pinned one for an account set to it", async () => {
    const pinned = resolveAntigravityReleaseAsset()!;
    const baseDir = folder();
    const [current, newer] = [await release("1.5.7"), await release("1.5.8")];
    await installAntigravityRuntime({ baseDir, fetchImpl: serving([current]).fetchImpl, cliRelease: current.asset, native: true });
    // The pinned release, whole: sparse files of the pinned sizes.
    const directory = join(antigravityRuntimesRoot(baseDir), `${process.platform}-${process.arch}`, "versions", pinned.sha256);
    mkdirSync(directory, { recursive: true });
    for (const file of [pinned.executable, pinned.harness]) {
      writeFileSync(join(directory, file.name), "");
      truncateSync(join(directory, file.name), file.bytes);
      chmodSync(join(directory, file.name), 0o755);
    }
    writeFileSync(join(directory, ".install-complete.json"), JSON.stringify({ sha256: pinned.sha256, version: pinned.version, executable: pinned.executable, harness: pinned.harness }));
    await expect(resolveAntigravityRuntime("agy", { PATH: "" }, baseDir)).resolves.toMatchObject({ version: "1.5.7" });
    await expect(resolveAntigravityRuntime(undefined, { PATH: "" }, baseDir)).resolves.toMatchObject({ version: "1.5.7" });
    await expect(resolveAntigravityRuntime("antigravity", { PATH: "" }, baseDir)).resolves.toMatchObject({ version: "1.5.7" });
    const latest = async () => newer.asset, at = Date.now() + 100 * 60 * 60 * 1000;
    expect(await antigravityCliUpdate({ baseDir, now: at, latest })).toBe("1.5.7");
    // Nothing removes the pinned runtime: an account set to the Classic runtime keeps running it.
    expect(existsSync(directory)).toBe(true);
    await expect(resolveAntigravityRuntime("agy_acp_server", { PATH: "" }, baseDir)).resolves.toMatchObject({ version: pinned.version, harnessPath: expect.any(String) });
    await expect(resolveAntigravityRuntime("agy", { PATH: "" }, baseDir)).resolves.toMatchObject({ version: "1.5.7" });
  });

  it("installs a release again when its folder is there but its files are damaged, and clears staging folders an old install left", async () => {
    const baseDir = folder();
    const one = await release("1.5.7");
    const { fetchImpl, asked } = serving([one]);
    const installed = await installAntigravityRuntime({ baseDir, fetchImpl, cliRelease: one.asset, native: true });
    const versions = dirname(dirname(installed.executablePath));
    const stale = join(versions, ".install-stale"), recent = join(versions, ".install-recent");
    for (const path of [stale, recent]) mkdirSync(path);
    utimesSync(stale, new Date(Date.now() - 2 * 60 * 60_000), new Date(Date.now() - 2 * 60 * 60_000));
    // Opened up first: a release is published read-only.
    const open = () => { if (!WINDOWS) { chmodSync(dirname(installed.executablePath), 0o755); if (existsSync(installed.executablePath)) chmodSync(installed.executablePath, 0o755); } };
    for (const damage of [() => rmSync(installed.executablePath), () => rmSync(join(dirname(installed.executablePath), ".install-complete.json")), () => writeFileSync(installed.executablePath, "cut short")]) {
      open();
      damage();
      await expect(resolveAntigravityRuntime("antigravity", { PATH: "" }, baseDir)).rejects.toThrow(/not installed/u);
      await expect(installAntigravityRuntime({ baseDir, fetchImpl, cliRelease: one.asset, native: true })).resolves.toEqual(installed);
      await expect(resolveAntigravityRuntime("antigravity", { PATH: "" }, baseDir)).resolves.toEqual(installed);
    }
    expect(asked).toHaveLength(4);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("fails, and keeps the release in use, when a newer one cannot be installed over a CLI already here", async () => {
    const baseDir = folder();
    const [current, newer] = [await release("1.5.7"), await release("1.5.8")];
    await installAntigravityRuntime({ baseDir, fetchImpl: serving([current]).fetchImpl, cliRelease: current.asset, native: true });
    await expect(installAntigravityRuntime({ baseDir, fetchImpl: serving([]).fetchImpl, cliRelease: newer.asset, native: true })).rejects.toThrow("Google download failed (404).");
    await expect(installAntigravityRuntime({ baseDir, cliRelease: null, native: true })).rejects.toThrow("Could not find a native Antigravity CLI release.");
    await expect(resolveAntigravityRuntime("antigravity", { PATH: "" }, baseDir)).resolves.toMatchObject({ version: "1.5.7" });
  });

  it("gives a native install asked for during a pinned one its own result", async () => {
    const pinned = resolveAntigravityReleaseAsset();
    if (!pinned) return;
    const baseDir = folder();
    const one = await release("1.5.7");
    let release404: () => void = () => {};
    const held = new Promise<void>((done) => { release404 = done; });
    const { fetchImpl } = serving([one]);
    const slow = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === pinned.url) { await held; return new Response("missing", { status: 404 }); }
      return fetchImpl(url, init);
    }) as typeof fetch;
    const pinnedInstall = installAntigravityRuntime({ baseDir, fetchImpl: slow, asset: pinned });
    pinnedInstall.catch(() => {});
    const nativeInstall = installAntigravityRuntime({ baseDir, fetchImpl: slow, cliRelease: one.asset, native: true });
    expect(nativeInstall).not.toBe(pinnedInstall);
    await expect(nativeInstall).resolves.toMatchObject({ harnessPath: null, version: "1.5.7" });
    release404();
    await expect(pinnedInstall).rejects.toThrow("Google download failed (404).");
  });
});

describe("which CLI an instance that names none runs", () => {
  it("is the native CLI when no pinned runtime is installed to go first, and with the default off only for the path that asks for it", async () => {
    const baseDir = folder();
    const one = await release("1.5.7");
    const installed = await installAntigravityRuntime({ baseDir, fetchImpl: serving([one]).fetchImpl, native: true, cliRelease: one.asset });
    for (const cli of ["agy", undefined]) {
      await expect(resolveAntigravityRuntime(cli, { PATH: "" }, baseDir)).resolves.toEqual(installed);
      await expect(resolveAntigravityRuntime(cli, { PATH: "" }, baseDir, { nativeByDefault: false })).rejects.toThrow();
      await expect(resolveAntigravityRuntime(cli, { PATH: "" }, baseDir, { nativeByDefault: false })).rejects.not.toMatchObject({ message: expect.stringContaining("Antigravity CLI is not installed") });
    }
    await expect(resolveAntigravityRuntime("antigravity", { PATH: "" }, baseDir, { nativeByDefault: false })).resolves.toEqual(installed);
    for (const pinned of ["agy_acp_server", "AGY_ACP_SERVER"]) {
      await expect(resolveAntigravityRuntime(pinned, { PATH: "" }, baseDir)).rejects.not.toMatchObject({ message: expect.stringContaining("custom Antigravity ACP executable") });
      await expect(resolveAntigravityRuntime(pinned, { PATH: "" }, baseDir)).rejects.toThrow();
    }
  });

  it.skipIf(!resolveAntigravityReleaseAsset())("installs the native CLI on a new computer, and with the default off only the pinned runtime unless the path asks for the CLI", async () => {
    const pinned = resolveAntigravityReleaseAsset()!;
    const one = await release("1.5.7");
    const fresh = serving([one]);
    await installAntigravityRuntime({ baseDir: folder(), fetchImpl: fresh.fetchImpl, cliRelease: one.asset });
    expect(fresh.asked).toEqual([one.asset.url]);
    const off = serving([one]);
    await expect(installAntigravityRuntime({ baseDir: folder(), fetchImpl: off.fetchImpl, cliRelease: one.asset, nativeByDefault: false })).rejects.toThrow("Google download failed (404).");
    expect(off.asked).toEqual([pinned.url]);
    const asked = serving([one]);
    await installAntigravityRuntime({ baseDir: folder(), fetchImpl: asked.fetchImpl, cliRelease: one.asset, native: true, nativeByDefault: false });
    expect(asked.asked).toEqual([one.asset.url]);
  });

  it("updates the native CLI where it is the default, and with the default off only for a path that asks for it", async () => {
    const baseDir = folder();
    const [current, newer] = [await release("1.5.7"), await release("1.5.8")];
    await installAntigravityRuntime({ baseDir, fetchImpl: serving([current]).fetchImpl, cliRelease: current.asset, native: true });
    const latest = async () => newer.asset, at = Date.now() + 100 * 60 * 60 * 1000;
    expect(await antigravityCliUpdate({ baseDir, now: at, latest, asset: null, configuredClis: ["agy"] })).toBe("1.5.7");
    expect(await antigravityCliUpdate({ baseDir, now: at, latest, asset: null, configuredClis: ["agy"], nativeByDefault: false })).toBeNull();
    expect(await antigravityCliUpdate({ baseDir, now: at, latest, asset: null, nativeByDefault: false })).toBeNull();
    expect(await antigravityCliUpdate({ baseDir, now: at, latest, asset: null, configuredClis: ["agy", "antigravity"], nativeByDefault: false })).toBe("1.5.7");
  });

});

describe("the updater with an agy instance and an antigravity instance on one machine", () => {
  it.skipIf(!resolveAntigravityReleaseAsset() || WINDOWS)("installs each runtime from its own channel and reports the version that really replaced the old one", async () => {
    const pinned = resolveAntigravityReleaseAsset()!;
    const baseDir = folder();
    const [current, newer] = [await release("1.5.7"), await release("1.5.8")];
    await installAntigravityRuntime({ baseDir, fetchImpl: serving([current]).fetchImpl, cliRelease: current.asset, native: true });
    // A pinned release an earlier app version left (older than the pinned one), whole enough to count as installed.
    const earlier = "f".repeat(64);
    const directory = join(antigravityRuntimesRoot(baseDir), `${process.platform}-${process.arch}`, "versions", earlier);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, ".install-complete.json"), JSON.stringify({ sha256: earlier, version: "1.1.1" }));

    const { fetchImpl, asked } = serving([newer]);
    const lines: string[] = [];
    const managed = antigravityManagedRuntime(() => ["agy", "antigravity"], { baseDir, fetchImpl, cliRelease: newer.asset, latest: async () => newer.asset, validate: async () => {} });
    const updater = createEngineUpdater({
      plans: [{ driverKind: "antigravityAgent", name: "Antigravity", pin: { target: pinned.version, minimum: pinned.version }, managed }],
      baseDir, statePath: join(folder(), "state.json"), turnRunning: () => false, log: (line) => lines.push(line), liveCommands: () => [],
      steps: { sweep: async () => {}, npmVersion: () => null, standaloneVersion: () => null },
    });
    await updater.check();
    // The native CLI moved on, and the pinned runtime was asked of its own channel, not of the CLI's.
    expect(asked).toEqual([newer.asset.url, pinned.url]);
    expect(lines[0]).toBe("Engine update: Antigravity 1.5.7 → 1.5.8");
    // The fake channel serves no pinned archive, so that update fails on its own and is retried, the CLI's kept.
    expect(lines[1]).toMatch(/^Engine update: Antigravity stays on 1\.1\.1; .+ could not be installed/u);
    await expect(resolveAntigravityRuntime("antigravity", { PATH: "" }, baseDir)).resolves.toMatchObject({ version: "1.5.8" });
    expect(updater.shown("antigravityAgent").autoUpdated?.version).toBe("1.5.8");
  }, 60_000);

});

describe("starting the native CLI", () => {
  it("launches through its acp subcommand with the profile folder, and without a harness", async () => {
    const directory = folder();
    expect(antigravityLaunchArgs({ harnessPath: null }, "/profile")).toEqual(["acp", "--gemini-dir", "/profile", "--app-data-dir", "antigravity-acp"]);
    expect(antigravityLaunchArgs({ harnessPath: "/runtime/localharness_external" }, "/profile", "linux")).toEqual(["--uid="]);
    expect(antigravityLaunchArgs({ harnessPath: "/runtime/localharness_external" }, "/profile", "darwin")).toEqual([]);
    const cli = await prepareAntigravityProfile({ instanceId: "cli", baseDir: directory, runtime: { executablePath: "/cli/antigravity", harnessPath: null, source: "managed", version: "1.5.7" } });
    expect("ANTIGRAVITY_HARNESS_PATH" in cli.environment).toBe(false);
    expect(cli.environment.GEMINI_HOME).toBe(cli.directory);
    const pair = await prepareAntigravityProfile({ instanceId: "pair", baseDir: directory, runtime: { executablePath: "/r/agy_acp_server.par", harnessPath: "/r/localharness_external", source: "managed", version: "1.4.3" } });
    expect(pair.environment.ANTIGRAVITY_HARNESS_PATH).toBe("/r/localharness_external");
  });

  it("knows the CLI by its names and by the name it gives itself", () => {
    for (const name of ["antigravity", "/usr/local/bin/antigravity", "C:\\Tools\\Antigravity.exe"]) expect(isAntigravityCliName(name)).toBe(true);
    for (const name of ["agy", "/opt/homebrew/bin/agy", "C:\\Tools\\agy.exe", "agy.cmd", "agy_acp_server.par", "antigravity-acp", "/antigravity/custom"]) expect(isAntigravityCliName(name)).toBe(false);
    const initialized = (name: string) => ({
      protocolVersion: 1, agentInfo: { name, version: "1.5.7" }, authMethods: [{ id: "oauth-personal" }],
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, auth: { logout: {} } },
    });
    expect(isValidAntigravityInitializeResult(initialized("Antigravity ACP Server"), "1.5.7", true)).toBe(true);
    expect(isValidAntigravityInitializeResult(initialized("antigravity-acp"), "1.5.7", true)).toBe(false);
    expect(isValidAntigravityInitializeResult(initialized("Antigravity ACP Server"), "1.5.7")).toBe(false);
    expect(isValidAntigravityInitializeResult(initialized("Antigravity ACP Server"), "1.5.8", true)).toBe(false);
  });

  it("stays in default where the pinned runtime would be in yolo or auto_edit", () => {
    expect(["yolo", "auto_edit", "default", "plan"].map(antigravityCliSessionMode)).toEqual(["default", "default", "default", "plan"]);
  });
});

describe.skipIf(WINDOWS)("a native CLI set as the engine's own path", () => {
  /** A program named `antigravity` that answers as the fake runtime does. */
  function cli(): { directory: string; executable: string; dump: string } {
    const directory = folder();
    const executable = join(directory, "antigravity");
    writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_ACP)} "$@"\n`);
    chmodSync(executable, 0o755);
    return { directory, executable, dump: join(directory, "dump.json") };
  }

  async function create(instanceId: string, executable: string, environment: Record<string, string>) {
    ensureDirs();
    const instance = await AntigravityDriver.create({
      instanceId, displayName: "Antigravity", enabled: true, config: { cli: executable, fullAuto: false },
      environment: { FAKE_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_MODELS: "gemini-3.8-flash", FAKE_ACP_AGENT_NAME: "Antigravity ACP Server", FAKE_ACP_VERSION: "1.5.7", ...environment },
    });
    instances.push(instance);
    return instance;
  }

  it("is taken as the CLI only from 1.5.0 on, and a saved agy path is never started", async () => {
    const fake = cli();
    await expect(resolveAntigravityRuntime(fake.executable, { ...process.env, FAKE_ACP_VERSION: "1.5.7" }))
      .resolves.toEqual({ executablePath: fake.executable, harnessPath: null, source: "override", version: "1.5.7" });
    const old = cli();
    await expect(resolveAntigravityRuntime(old.executable, { ...process.env, FAKE_ACP_VERSION: "antigravity 1.4.9" }, folder()))
      .rejects.toThrow(/custom Antigravity ACP executable/u);
    const directory = folder(), started = join(directory, "started"), legacy = join(directory, "agy");
    writeFileSync(legacy, `#!/bin/sh\ntouch ${JSON.stringify(started)}\necho 1.5.7\n`);
    chmodSync(legacy, 0o755);
    await expect(resolveAntigravityRuntime(legacy, { PATH: "" }, folder())).rejects.toThrow();
    expect(existsSync(started)).toBe(false);
  });

  it("is asked its version without the server's, the workspace's or a provider's credentials", async () => {
    const directory = folder(), seen = join(directory, "env"), program = join(directory, "antigravity");
    writeFileSync(program, `#!/bin/sh\n/usr/bin/env > ${JSON.stringify(seen)}\necho 1.5.7\n`);
    chmodSync(program, 0o755);
    await expect(resolveAntigravityRuntime(program, { PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "provider-key", OMB_CLOUD_TOKEN: "control-plane", anthropic_api_key: "lower-provider", xai_api_key: "lower-workspace", KEEP_ME: "kept" }, folder()))
      .resolves.toMatchObject({ harnessPath: null, version: "1.5.7" });
    const env = readFileSync(seen, "utf8");
    expect(env).toContain("KEEP_ME=kept");
    expect(env).not.toMatch(/provider-key|control-plane|lower-provider|lower-workspace/u);
  });

  it("is not started for its version from a folder the bots can write", async () => {
    const directory = folder(), started = join(directory, "started"), program = join(directory, "antigravity");
    writeFileSync(program, `#!/bin/sh\ntouch ${JSON.stringify(started)}\necho 1.5.7\n`);
    chmodSync(program, 0o755);
    distrustHomePrograms(directory);
    try {
      await expect(resolveAntigravityRuntime(program, { PATH: "" }, folder())).rejects.toThrow("is in a folder the bots can write");
      expect(existsSync(started)).toBe(false);
    } finally {
      distrustHomePrograms(null);
    }
    await expect(resolveAntigravityRuntime(program, { PATH: "" }, folder())).resolves.toMatchObject({ harnessPath: null, version: "1.5.7" });
  });

  it("passes the check a download gets, by the name and version it reports", async () => {
    const fake = cli();
    vi.stubEnv("FAKE_ACP_AUTH_METHOD", "oauth-personal");
    vi.stubEnv("FAKE_ACP_AGENT_NAME", "Antigravity ACP Server");
    vi.stubEnv("FAKE_ACP_AGENT_VERSION", "1.5.7");
    const runtime = { executablePath: fake.executable, harnessPath: null, source: "managed" as const, version: "1.5.7" };
    await expect(validateAntigravityRuntime(runtime, "1.5.7")).resolves.toBeUndefined();
    await expect(validateAntigravityRuntime(runtime, "1.5.8")).rejects.toThrow("did not identify as the expected Google Antigravity ACP release");
  }, 60_000);

  it("runs a Full access turn in default mode, started through acp with our own client name", async () => {
    const fake = cli();
    const instance = await create("antigravity-cli-full", fake.executable, { FAKE_ACP_MODES: "default,plan", FAKE_ACP_DUMP: fake.dump });
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "cli-full", text: "hello", approvalMode: "full", cwd: fake.directory });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ ok: true });
    const prompts = readFileSync(`${fake.dump}.prompts.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(prompts.at(-1)).toMatchObject({ mode: "default" });
    const launch = JSON.parse(readFileSync(fake.dump, "utf8"));
    expect(launch.argv.slice(0, 2)).toEqual(["acp", "--gemini-dir"]);
    expect(launch.argv.slice(3)).toEqual(["--app-data-dir", "antigravity-acp"]);
    expect(launch.env.ANTIGRAVITY_HARNESS_PATH).toBeUndefined();
    expect(JSON.parse(readFileSync(`${fake.dump}.initialize.json`, "utf8")).clientInfo).toEqual({ name: "openmausbot", version: "0.0.0" });
  }, 90_000);

  it("fails closed when the CLI does not confirm default mode", async () => {
    const fake = cli();
    const instance = await create("antigravity-cli-unconfirmed", fake.executable, { FAKE_ACP_MODES: "default,plan", FAKE_ACP_EMPTY_MODE_ACK: "1" });
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "cli-unconfirmed", text: "hello", approvalMode: "full", cwd: fake.directory });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ ok: false });
    expect(recorder.events.some((event) => event.type === "runtime.error" && /did not apply default permission mode/u.test(event.message))).toBe(true);
  }, 90_000);

  it("fails closed when the CLI offers no mode at all", async () => {
    const fake = cli();
    const instance = await create("antigravity-cli-no-mode", fake.executable, {});
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "cli-no-mode", text: "hello", approvalMode: "full", cwd: fake.directory });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ ok: false });
    expect(recorder.events.some((event) => event.type === "runtime.error" && /did not report its permission mode/u.test(event.message))).toBe(true);
  }, 90_000);

  const RULES = "Rules. If the user sends /learn or asks you to save a procedure, use skill_manage.";
  const MEMORY = " Memory: likes /plan mode.";

  /** Turns on one thread, each returning the prompt the CLI received, with the thread's session/new and session/resume calls. */
  async function systemThread(name: string, environment: Record<string, string>) {
    const fake = cli();
    const rpc = join(fake.directory, "rpc.jsonl");
    const instance = await create(`antigravity-cli-${name}`, fake.executable, {
      FAKE_ACP_MODES: "default,plan", FAKE_ACP_DUMP: fake.dump, FAKE_ACP_DUMP_PROMPT: "1", FAKE_ACP_RPC_APPEND_FILE: rpc, ...environment,
    });
    const recorder = recordEvents(instance.adapter);
    let resumeCursor: string | undefined;
    const send = async (text: string, stable: string, volatile: string) => {
      const { turnId } = await instance.adapter.sendTurn({
        threadId: name, text, cwd: fake.directory, system: stable + volatile, systemStable: stable, systemVolatile: volatile, resumeCursor,
      });
      expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ ok: true });
      resumeCursor ??= (recorder.events.find((event) => event.type === "session.started") as { sessionId: string }).sessionId;
      return JSON.parse(readFileSync(`${fake.dump}.prompt.json`, "utf8")) as Array<{ type: string; text: string }>;
    };
    const setups = () => readFileSync(rpc, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; cwd: string; sessionId?: string; meta?: unknown })
      .filter((call) => call.cwd === realpathSync(fake.directory) && (call.method === "session/new" || call.method === "session/resume"));
    return { send, setups, sessionId: () => resumeCursor };
  }

  it("gives the session its system prompt where the CLI takes one, so no /word in it runs as a command", async () => {
    const thread = await systemThread("system-prompt", { FAKE_ACP_CAPABILITIES_META: JSON.stringify({ antigravity: { systemPrompt: { append: true } } }) });
    expect(await thread.send("/learn what we did", RULES, MEMORY)).toEqual([
      { type: "text", text: "/learn what we did" },
      { type: "text", text: expect.stringContaining(MEMORY.trim()) },
    ]);
    expect(thread.setups()).toEqual([expect.objectContaining({ method: "session/new", meta: { antigravity: { systemPrompt: { append: RULES } } } })]);

    expect(await thread.send("again", RULES, MEMORY)).toEqual([{ type: "text", text: "again" }]);
    expect(thread.setups()).toHaveLength(1);

    const revised = RULES + " Reply in French.";
    expect(await thread.send("third", revised, MEMORY)).toEqual([
      { type: "text", text: "third" },
      { type: "text", text: expect.stringContaining(MEMORY.trim()) },
    ]);
    expect(thread.setups().at(-1)).toEqual(expect.objectContaining({
      method: "session/resume", sessionId: thread.sessionId(), meta: { antigravity: { systemPrompt: { append: revised } } },
    }));
  }, 90_000);

  it("keeps the system prompt in the text for a CLI that does not say it takes one", async () => {
    const thread = await systemThread("system-in-text", {});
    const [first, ...rest] = await thread.send("hello", RULES, MEMORY);
    expect(first.text).toBe(`${RULES}${MEMORY}\n\nhello`);
    expect(rest).toEqual([]);
    expect(thread.setups()).toEqual([expect.not.objectContaining({ meta: expect.anything() })]);
  }, 90_000);

  /** One turn at `approvalMode` whose runtime asks about `toolCall`; a card that opens is denied. */
  async function asked(name: string, approvalMode: "edits" | "full", toolCall: (directory: string) => object, approvalNow?: "ask") {
    const fake = cli();
    const answer = join(fake.directory, "answer");
    const instance = await create(`antigravity-cli-${name}`, fake.executable, {
      FAKE_ACP_MODES: "default,plan", FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_ANSWER: answer,
      FAKE_ACP_PERMISSION_TOOL_CALL: JSON.stringify(toolCall(fake.directory)),
    });
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: name, text: "hello", approvalMode, cwd: fake.directory, ...(approvalNow ? { approvalModeNow: () => approvalNow } : {}) });
    const first = await recorder.until((event) => event.turnId === turnId && (event.type === "request.opened" || event.type === "turn.completed"));
    if (first.type === "request.opened") await instance.adapter.respondToRequest(name, (first as { requestId: string }).requestId, { behavior: "deny" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    const opened = recorder.events.find((event) => event.type === "request.opened") as { commandLine?: string } | undefined;
    return { card: opened !== undefined, commandLine: opened?.commandLine, answer: readFileSync(answer, "utf8") };
  }

  it("answers a file edit inside the turn's folder itself on Auto-accept edits", async () => {
    expect(await asked("edits-inside", "edits", (directory) => ({ kind: "edit", title: "Edit notes.md", locations: [{ path: join(directory, "notes.md") }] })))
      .toEqual({ card: false, commandLine: undefined, answer: "allow-once" });
    expect(await asked("edits-new-folder", "edits", (directory) => ({ kind: "edit", title: "Edit", locations: [{ path: join(directory, "new", "deep", "notes.md") }] })))
      .toMatchObject({ card: false, answer: "allow-once" });
  }, 90_000);

  it("asks about a file edit on a turn whose level was lowered to Ask after it began", async () => {
    expect(await asked("edits-lowered", "edits", (directory) => ({ kind: "edit", title: "Edit notes.md", locations: [{ path: join(directory, "notes.md") }] }), "ask"))
      .toMatchObject({ card: true, answer: "reject" });
  }, 90_000);

  it.each([
    ["a command", () => ({ kind: "execute", rawInput: { command: "echo hi" }, title: "echo hi" })],
    ["an edit that names a command", (directory: string) => ({ kind: "edit", rawInput: { CommandLine: "rm -rf ~" }, locations: [{ path: join(directory, "notes.md") }] })],
    ["an edit that names a command the other way", (directory: string) => ({ kind: "edit", rawInput: { command: "echo hi" }, locations: [{ path: join(directory, "notes.md") }] })],
    ["an edit outside the turn's folder", (directory: string) => ({ kind: "edit", locations: [{ path: join(directory, "..", "elsewhere.md") }] })],
    ["an edit of the folder next door", (directory: string) => ({ kind: "edit", locations: [{ path: `${directory}-other/notes.md` }] })],
    ["an edit with one place inside and one outside", (directory: string) => ({ kind: "edit", locations: [{ path: join(directory, "notes.md") }, { path: "/etc/hosts" }] })],
    ["an edit through a link that leaves the folder", (directory: string) => { symlinkSync(tmpdir(), join(directory, "out")); return { kind: "edit", locations: [{ path: join(directory, "out", "notes.md") }] }; }],
    ["an edit that gives no place", () => ({ kind: "edit", title: "Edit notes.md" })],
    ["an edit with a relative place", () => ({ kind: "edit", locations: [{ path: "notes.md" }] })],
  ] as Array<[string, (directory: string) => object]>)("still asks, on Auto-accept edits, about %s", async (name, toolCall) => {
    expect(await asked(`edits-${name.replaceAll(" ", "-")}`, "edits", toolCall)).toMatchObject({ card: true, answer: "reject" });
  }, 90_000);

  it("hands a command a request names as CommandLine to the never-list, whatever kind the request claims", async () => {
    expect(await asked("full-commandline", "full", () => ({ kind: "edit", rawInput: { CommandLine: "rm -rf ~" }, title: "Edit" })))
      .toMatchObject({ card: true, commandLine: "rm -rf ~" });
    expect(await asked("full-other-kind", "full", () => ({ kind: "other", rawInput: { CommandLine: "rm -rf ~" }, title: "Tool" })))
      .toMatchObject({ card: true, commandLine: "rm -rf ~" });
  }, 90_000);
});
