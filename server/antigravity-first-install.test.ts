// The engine updater's first install of Google's Antigravity CLI on a computer with no Antigravity runtime at all: only
// when the server is opted in (OMB_ANTIGRAVITY_NATIVE_CLI=1) or Antigravity is in use here, from Google's channel with
// the card install's checks, and never on a computer that has the Classic runtime.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AntigravityCliReleaseAsset } from "./drivers/antigravity-cli-release.ts";
import { resolveAntigravityReleaseAsset } from "./drivers/antigravity-release.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const WINDOWS = process.platform === "win32";
const pinned = resolveAntigravityReleaseAsset();
const ORIGIN = "https://storage.googleapis.com/antigravity-public/antigravity-cli/";
const scratch: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-first-"));
  scratch.push(directory);
  return directory;
}

/** A CLI release as Google's channel names it, and a fetch that serves only its bytes. */
async function channel(version = "1.5.8") {
  const source = folder();
  writeFileSync(join(source, "antigravity"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  const archive = join(folder(), "cli.tar.gz");
  await tar.c({ gzip: true, file: archive, cwd: source, portable: true }, ["antigravity"]);
  const bytes = readFileSync(archive);
  const asset: AntigravityCliReleaseAsset = {
    version, url: `${ORIGIN}${version}-1/fixture`, sha512: createHash("sha512").update(bytes).digest("hex"),
    executable: { name: "antigravity" }, format: "tar.gz",
  };
  const asked: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    asked.push(String(url));
    if (String(url) !== asset.url) return new Response("missing", { status: 404 });
    const response = new Response(bytes);
    Object.defineProperty(response, "url", { value: String(url) });
    return response;
  }) as typeof fetch;
  return { asset, fetchImpl, asked };
}

/** A data folder with the Classic (pinned) runtime installed and one account signed in on it. */
function classicComputer() {
  const baseDir = folder();
  const pinnedDir = join(baseDir, "tools", "antigravity-acp", `${process.platform}-${process.arch}`, "versions", pinned!.sha256);
  mkdirSync(pinnedDir, { recursive: true });
  for (const file of [pinned!.executable, pinned!.harness]) {
    writeFileSync(join(pinnedDir, file.name), "");
    truncateSync(join(pinnedDir, file.name), file.bytes);
    chmodSync(join(pinnedDir, file.name), 0o755);
  }
  writeFileSync(join(pinnedDir, ".install-complete.json"), JSON.stringify({ sha256: pinned!.sha256, version: pinned!.version, executable: pinned!.executable, harness: pinned!.harness }));
  const token = join(baseDir, "providers", "antigravity", "acp_token.json");
  mkdirSync(join(token, ".."), { recursive: true });
  writeFileSync(token, "{}");
  return { baseDir, pinnedDir, token };
}

async function updaterFor(baseDir: string, served: Awaited<ReturnType<typeof channel>>, options: { wanted?: boolean; cliFirst?: boolean } = {}) {
  const { antigravityManagedRuntime } = await import("./engine-updates-host.ts");
  const { createEngineUpdater } = await import("./engine-updates.ts");
  const lines: string[] = [];
  let changed = 0;
  const managed = antigravityManagedRuntime(() => [], {
    baseDir, fetchImpl: served.fetchImpl, cliRelease: served.asset, latest: async () => served.asset, validate: async () => {},
    wanted: () => options.wanted === true, changed: () => { changed += 1; }, env: { PATH: "" },
    ...(options.cliFirst === undefined ? {} : { cliFirst: options.cliFirst }),
  });
  const updater = createEngineUpdater({
    plans: [{ driverKind: "antigravityAgent", name: "Antigravity", pin: { target: pinned?.version ?? "1.4.3", minimum: pinned?.version ?? "1.4.3" }, managed }],
    baseDir, statePath: join(folder(), "state.json"), turnRunning: () => false, log: (line) => lines.push(line), liveCommands: () => [],
    steps: { sweep: async () => {}, npmVersion: () => null, standaloneVersion: () => null },
  });
  return { updater, managed, lines, changed: () => changed };
}

describe.skipIf(WINDOWS)("the engine updater on a computer with no Antigravity runtime", () => {
  it("installs Google's CLI in its pass when the server is opted in, as a first install rather than an update", async () => {
    vi.stubEnv("OMB_ANTIGRAVITY_NATIVE_CLI", "1");
    vi.resetModules();
    const baseDir = folder();
    const served = await channel();
    const { updater, lines, changed } = await updaterFor(baseDir, served);
    await updater.check();
    expect(served.asked).toEqual([served.asset.url]);
    expect(lines).toEqual(["Engine update: Antigravity 1.5.8 installed"]);
    expect(updater.shown("antigravityAgent")).toEqual({});
    expect(changed()).toBeGreaterThanOrEqual(2);
    const { resolveAntigravityRuntime } = await import("./drivers/antigravity-runtime.ts");
    await expect(resolveAntigravityRuntime(undefined, { PATH: "" }, baseDir)).resolves.toMatchObject({ version: "1.5.8", harnessPath: null });
    // The next pass finds it in place and asks the channel for nothing more than its manifest.
    served.asked.length = 0;
    await updater.check();
    expect(served.asked).toEqual([]);
  });

  it("downloads nothing when the server is not opted in and nobody here uses Antigravity", async () => {
    const baseDir = folder();
    const served = await channel();
    const { updater, managed, lines } = await updaterFor(baseDir, served, { cliFirst: false, wanted: false });
    expect(await managed.older()).toBeNull();
    await updater.check();
    expect(served.asked).toEqual([]);
    expect(lines).toEqual([]);
    expect(existsSync(join(baseDir, "tools", "antigravity-acp"))).toBe(false);
  });

  it("installs Google's CLI when an Antigravity account is in use here, with the server not opted in", async () => {
    const baseDir = folder();
    const served = await channel();
    const { updater, lines } = await updaterFor(baseDir, served, { cliFirst: false, wanted: true });
    await updater.check();
    expect(lines).toEqual(["Engine update: Antigravity 1.5.8 installed"]);
    const { resolveAntigravityRuntime } = await import("./drivers/antigravity-runtime.ts");
    await expect(resolveAntigravityRuntime(undefined, { PATH: "" }, baseDir)).resolves.toMatchObject({ version: "1.5.8" });
  });

  it("says Installing on the card while it runs, and lets the card's install wait for it instead of starting another", async () => {
    const baseDir = folder();
    const served = await channel();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slow = (async (url: string | URL | Request) => { await held; return served.fetchImpl(url); }) as typeof fetch;
    const { antigravityManagedRuntime } = await import("./engine-updates-host.ts");
    const runtime = await import("./drivers/antigravity-runtime.ts");
    const managed = antigravityManagedRuntime(() => [], { baseDir, fetchImpl: slow, cliRelease: served.asset, validate: async () => {}, wanted: () => true, cliFirst: false, env: { PATH: "" } });
    const updaterInstall = managed.install("native");
    await vi.waitFor(() => expect(runtime.antigravityInstallRunning(baseDir)).toBe(true));
    const cardInstall = runtime.installAntigravityRuntime({ baseDir, fetchImpl: served.fetchImpl, cliRelease: served.asset, validate: async () => {} });
    release();
    await expect(updaterInstall).resolves.toBe("1.5.8");
    await expect(cardInstall).resolves.toMatchObject({ version: "1.5.8" });
    expect(served.asked).toEqual([served.asset.url]);
    expect(runtime.antigravityInstallRunning(baseDir)).toBe(false);
  });
});

describe.skipIf(!pinned || WINDOWS)("the engine updater on a computer with the Classic runtime", () => {
  it("leaves a signed-in Classic account untouched, even with Antigravity in use", async () => {
    const { baseDir, pinnedDir, token } = classicComputer();
    const served = await channel();
    const { updater, managed, lines } = await updaterFor(baseDir, served, { cliFirst: false, wanted: true });
    expect(await managed.older()).toBeNull();
    await updater.check();
    expect(served.asked).toEqual([]);
    expect(lines).toEqual([]);
    expect(existsSync(token)).toBe(true);
    const { resolveAntigravityRuntime } = await import("./drivers/antigravity-runtime.ts");
    await expect(resolveAntigravityRuntime(undefined, { PATH: "" }, baseDir)).resolves.toMatchObject({ executablePath: join(pinnedDir, pinned!.executable.name), version: pinned!.version });
  });
});

describe("whether Antigravity is in use on a server", () => {
  it("does not count the account every home lists, and counts an added account, the CLI path, or a bot, task or default on it", async () => {
    const { antigravityInUse } = await import("./engine-updates-host.ts");
    const fleet = { claude: { driver: "claudeAgent" }, antigravity: { driver: "antigravityAgent" } };
    expect(antigravityInUse(fleet, [undefined, { instanceId: "claude" }])).toBe(false);
    expect(antigravityInUse({ ...fleet, antigravity: { driver: "antigravityAgent", config: { cli: "agy_acp_server" } } }, [])).toBe(false);
    expect(antigravityInUse({ ...fleet, antigravity: { driver: "antigravityAgent", config: { cli: "antigravity" } } }, [])).toBe(true);
    expect(antigravityInUse({ ...fleet, "antigravity-work": { driver: "antigravityAgent" } }, [])).toBe(true);
    expect(antigravityInUse(fleet, [{ instanceId: "antigravity" }])).toBe(true);
  });
});
