import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StandaloneRelease } from "./contracts.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { enginesBinDir, enginesPrefix, installNpmEngine, npmCopyVersion, npmModulesIn, npmPackageOf } from "./engine-install.ts";
import { acpHandshake } from "./engine-handshake.ts";
import { EngineInUse, updateNpmEngineStaged } from "./engine-npm-update.ts";
import { installStandaloneEngine, resetStandaloneStateForTests, standaloneCurrentVersion, standalonePlatformKey } from "./engine-standalone.ts";
import { createEngineUpdater, ENGINE_UPDATE_BUSY_RETRY_MS, ENGINE_UPDATE_EVERY_MS, ENGINE_UPDATE_START_DELAY_MS, enginePlans, type EnginePlan, type EngineUpdaterOptions } from "./engine-updates.ts";
import { ENGINE_VERSIONS, LATEST } from "./engine-versions.ts";
import { resetPathCacheForTests } from "./env-path.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { isNewerVersion } from "./update-check.ts";

// A stand-in npm that lays a global install out as npm does (lib/node_modules/<pkg> and a relative link in bin/). The
// command prints its version; FAKE_NPM_MODE makes the next install's command fail everywhere ("broken") or only once
// moved out of the prefix npm installed it into ("pinned"), as a package that wrote its install path down would.
const FAKE_NPM = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'view') { console.log(process.env.FAKE_NPM_LATEST); process.exit(0); }
const mode = process.env.FAKE_NPM_MODE || 'ok';
const prefix = realpathSync(args[args.indexOf('--prefix') + 1]);
const spec = args[args.length - 1];
const pkg = spec.slice(0, spec.lastIndexOf('@'));
const version = spec.slice(spec.lastIndexOf('@') + 1);
const dir = join(prefix, 'lib', 'node_modules', ...pkg.split('/'));
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version, bin: { fakebin: 'cli.js' } }));
const body = mode === 'broken' ? 'console.error("Error: Missing optional dependency"); process.exit(1);'
  : mode === 'pinned' ? 'if (!__dirname.startsWith(' + JSON.stringify(prefix) + ')) { console.error("Error: Cannot find module"); process.exit(1); } console.log(' + JSON.stringify(version) + ');'
  : 'console.log(' + JSON.stringify(version) + ');';
writeFileSync(join(dir, 'cli.js'), '#!/usr/bin/env node\\n' + body + '\\n', { mode: 0o755 });
mkdirSync(join(prefix, 'bin'), { recursive: true });
rmSync(join(prefix, 'bin', 'fakebin'), { force: true });
symlinkSync(join('..', 'lib', 'node_modules', ...pkg.split('/'), 'cli.js'), join(prefix, 'bin', 'fakebin'));
`;

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function noSteps(): EngineUpdaterOptions["steps"] {
  return {
    sweep: async () => {},
    npmVersion: () => null,
    standaloneVersion: () => null,
  };
}

describe("the version table", () => {
  it("pins every engine installable on this platform, at or above its minimum, and a standalone engine at its pinned build", () => {
    for (const driver of BUILT_IN_DRIVERS) {
      const installs = Boolean(npmPackageOf(driver.install) || driver.install?.standalone || driver.install?.managed);
      if (installs) expect(ENGINE_VERSIONS[driver.driverKind], driver.driverKind).toBeDefined();
    }
    for (const [kind, pin] of Object.entries(ENGINE_VERSIONS)) {
      expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === kind), kind).toBe(true);
      if (pin.target !== LATEST) expect(isNewerVersion(pin.minimum, pin.target), kind).toBe(false);
    }
    for (const plan of enginePlans(BUILT_IN_DRIVERS)) {
      if (plan.standalone) expect(plan.pin.target).toBe(plan.standalone.version);
    }
  });
});

describe("waking from a sleep", () => {
  afterEach(() => vi.useRealTimers());

  it("checks once the wall clock passes the next check, though the suspended timers did not", async () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 10, 7, 9);
    vi.setSystemTime(start);
    const scratch = mkdtempSync(join(tmpdir(), "omb-engine-updates-"));
    let passes = 0;
    const updater = createEngineUpdater({
      plans: [], baseDir: scratch, statePath: join(scratch, "state.json"), turnRunning: () => false,
      steps: { ...noSteps(), sweep: async () => { passes += 1; } },
    });
    const timer = updater.start();
    try {
      await vi.advanceTimersByTimeAsync(ENGINE_UPDATE_START_DELAY_MS + 60_000);
      expect(passes).toBe(1);
      expect(updater.dueAt()).toBeGreaterThan(Date.now() + ENGINE_UPDATE_EVERY_MS - 2 * 60_000);
      // A suspended machine: the wall clock moves on a day and more while no timer runs.
      vi.setSystemTime(Date.now() + ENGINE_UPDATE_EVERY_MS + 60 * 60_000);
      expect(passes).toBe(1);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(passes).toBe(2);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(passes).toBe(2);
    } finally {
      timer.stop();
      vi.useRealTimers();
      await removeTempDir(scratch);
    }
  });
});

describe.skipIf(process.platform === "win32")("updating the app's engine copies", () => {
  let scratch = "";
  let base = "";
  let originalPath: string | undefined;
  const lines: string[] = [];
  let turn = false;
  let live: string[][] = [];

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-engine-updates-"));
    base = join(scratch, "data");
    const fakePath = join(scratch, "fake-path");
    mkdirSync(fakePath);
    writeFileSync(join(fakePath, "npm"), FAKE_NPM, { mode: 0o755 });
    chmodSync(join(fakePath, "npm"), 0o755);
    symlinkSync(process.execPath, join(fakePath, "node"));
    originalPath = process.env.PATH;
    process.env.PATH = `${fakePath}:/usr/bin:/bin`;
    process.env.FAKE_NPM_LOG = join(scratch, "npm.jsonl");
    writeFileSync(process.env.FAKE_NPM_LOG, "");
    delete process.env.FAKE_NPM_MODE;
    resetPathCacheForTests();
    resetStandaloneStateForTests();
    lines.length = 0;
    turn = false;
    live = [];
  });
  afterEach(async () => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_NPM_LOG;
    delete process.env.FAKE_NPM_MODE;
    delete process.env.FAKE_NPM_LATEST;
    resetPathCacheForTests();
    resetStandaloneStateForTests();
    await removeTempDir(scratch);
  });

  const npmRuns = () => readFileSync(process.env.FAKE_NPM_LOG!, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  const installs = () => npmRuns().filter((args) => args[0] === "install");
  const plan = (pin: Partial<EnginePlan["pin"]> = {}, extra: Partial<EnginePlan> = {}): EnginePlan => ({
    driverKind: "fakeEngine", name: "Fake Engine", cli: "fakebin", npm: "fake-engine",
    pin: { target: "2.2.5", minimum: "1.19.4", ...pin }, ...extra,
  });
  const updater = (plans: EnginePlan[], extra: Partial<EngineUpdaterOptions> = {}) => createEngineUpdater({
    plans, baseDir: base, statePath: join(base, "providers", "engine-updates.json"),
    turnRunning: () => turn, liveCommands: () => live, log: (line) => lines.push(line),
    switchWait: { forMs: 0, everyMs: 1 }, ...extra,
  });
  const runsFakebin = () => readFileSync(join(npmModulesIn(enginesPrefix(base)), "fake-engine", "cli.js"), "utf8");
  const leftovers = () => readdirSync(join(base, "tools")).filter((name) => name.startsWith("."));

  it("moves an old copy up to the target beside it, and says so once on the engine's row", async () => {
    await installNpmEngine("fake-engine", { baseDir: base, cli: "fakebin", version: "1.19.4" });
    const updated = vi.fn();
    const engines = updater([plan()], { updated });
    await engines.check();

    expect(npmCopyVersion("fake-engine", base)).toBe("2.2.5");
    expect(runsFakebin()).toContain('"2.2.5"');
    expect(lstatSync(join(enginesBinDir(base), "fakebin")).isSymbolicLink()).toBe(true);
    expect(installs().at(-1)).toContain("fake-engine@2.2.5");
    expect(installs().at(-1)![installs().at(-1)!.indexOf("--prefix") + 1]).not.toBe(enginesPrefix(base));
    expect(leftovers()).toEqual([]);
    expect(lines).toEqual(["Engine update: Fake Engine 1.19.4 → 2.2.5"]);
    expect(updated).toHaveBeenCalledTimes(1);
    expect(engines.shown("fakeEngine")).toEqual({ autoUpdated: { version: "2.2.5", at: expect.any(Number) } });
    expect(engines.shown("other")).toEqual({});
  });

  it("does nothing to a copy already at its target, nor to an engine the app did not install", async () => {
    await installNpmEngine("fake-engine", { baseDir: base, cli: "fakebin", version: "2.2.5" });
    const before = installs().length;
    const updated = vi.fn();
    await updater([plan(), plan({}, { driverKind: "absent", npm: "not-installed" })], { updated }).check();
    expect(installs()).toHaveLength(before);
    expect(npmCopyVersion("not-installed", base)).toBeNull();
    expect(lines).toEqual([]);
    expect(updated).not.toHaveBeenCalled();
  });

  it("follows npm's newest for an engine that tracks it, and only when it is newer", async () => {
    await installNpmEngine("fake-engine", { baseDir: base, cli: "fakebin", version: "2.1.300" });
    process.env.FAKE_NPM_LATEST = "2.1.300";
    await updater([plan({ target: LATEST, minimum: "2.1.267" })]).check();
    expect(installs()).toHaveLength(1);
    process.env.FAKE_NPM_LATEST = "2.1.319";
    await updater([plan({ target: LATEST, minimum: "2.1.267" })]).check();
    expect(npmCopyVersion("fake-engine", base)).toBe("2.1.319");
  });

  it("waits while a turn runs or the engine's process is up, then updates once idle", async () => {
    await installNpmEngine("fake-engine", { baseDir: base, cli: "fakebin", version: "1.19.4" });
    const engines = updater([plan()]);
    turn = true;
    await engines.check();
    expect(npmCopyVersion("fake-engine", base)).toBe("1.19.4");
    expect(installs()).toHaveLength(1);
    expect(engines.dueAt()).toBeLessThanOrEqual(Date.now() + ENGINE_UPDATE_BUSY_RETRY_MS);

    turn = false;
    live = [["/usr/bin/env", "node", join(enginesBinDir(base), "fakebin"), "acp"]];
    await engines.check();
    expect(npmCopyVersion("fake-engine", base)).toBe("1.19.4");

    live = [];
    await engines.check();
    expect(npmCopyVersion("fake-engine", base)).toBe("2.2.5");
    expect(lines).toEqual(["Engine update: Fake Engine 1.19.4 → 2.2.5"]);
  });

  it("keeps the old copy when the new one does not start, and tries again later", async () => {
    await installNpmEngine("fake-engine", { baseDir: base, cli: "fakebin", version: "1.19.4" });
    process.env.FAKE_NPM_MODE = "broken";
    const engines = updater([plan()]);
    await engines.check();
    expect(npmCopyVersion("fake-engine", base)).toBe("1.19.4");
    expect(runsFakebin()).toContain('"1.19.4"');
    expect(leftovers()).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Engine update: Fake Engine stays on 1\.19\.4; 2\.2\.5 could not be installed \(.*Missing optional dependency.*\)\. Trying again later\.$/);
    expect(engines.dueAt()).toBeGreaterThan(Date.now() + 30 * 60_000);
    expect(engines.dueAt()).toBeLessThanOrEqual(Date.now() + 60 * 60_000);

    delete process.env.FAKE_NPM_MODE;
    await engines.check();
    expect(installs()).toHaveLength(2);
  });

  it("puts the old copy back when the new one stops starting once moved into place", async () => {
    await installNpmEngine("fake-engine", { baseDir: base, cli: "fakebin", version: "1.19.4" });
    process.env.FAKE_NPM_MODE = "pinned";
    await updater([plan()]).check();
    expect(npmCopyVersion("fake-engine", base)).toBe("1.19.4");
    expect(runsFakebin()).toContain('"1.19.4"');
    expect(leftovers()).toEqual([]);
    expect(lines[0]).toContain("did not start once in place");
  });

  it("does not switch to a copy that refuses the engine's handshake", async () => {
    await installNpmEngine("fake-engine", { baseDir: base, cli: "fakebin", version: "1.19.4" });
    const handshake = vi.fn(async () => "it refused the ACP handshake");
    await updater([plan({ acp: ["acp"] })], { steps: { handshake } }).check();
    expect(handshake).toHaveBeenCalledWith(expect.stringContaining(".npm-staging-"), ["acp"], expect.any(Object));
    expect(npmCopyVersion("fake-engine", base)).toBe("1.19.4");
    expect(lines[0]).toContain("it refused the ACP handshake");
  });

  it("leaves a copy Windows holds open where it is and tries again without counting a failure", async () => {
    await installNpmEngine("fake-engine", { baseDir: base, cli: "fakebin", version: "1.19.4" });
    const livePackage = join(npmModulesIn(enginesPrefix(base)), "fake-engine");
    const lockedRename = (async (from, to) => {
      if (String(from) === livePackage) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM", syscall: "rename" });
      return rename(from, to);
    }) as typeof rename;
    await expect(updateNpmEngineStaged({ pkg: "fake-engine", version: "2.2.5", baseDir: base, cli: "fakebin", host: { platform: "win32", rename: lockedRename } }))
      .rejects.toBeInstanceOf(EngineInUse);
    expect(npmCopyVersion("fake-engine", base)).toBe("1.19.4");
    expect(leftovers()).toEqual([]);

    const engines = updater([plan()], { steps: { updateNpm: (options) => updateNpmEngineStaged({ ...options, host: { platform: "win32", rename: lockedRename } }) } });
    await engines.check();
    expect(lines).toEqual([]);
    expect(engines.dueAt()).toBeLessThanOrEqual(Date.now() + ENGINE_UPDATE_BUSY_RETRY_MS);
    await updater([plan()]).check();
    expect(npmCopyVersion("fake-engine", base)).toBe("2.2.5");
  });

  it("moves an old npm copy to the app's own build, removing the npm copy only once the build is in place", async () => {
    await installNpmEngine("fake-old", { baseDir: base, cli: "fakebin", version: "1.19.4" });
    const program = "#!/bin/sh\necho 'fake 2.2.5'\n";
    const release: StandaloneRelease = {
      name: "Fake Engine", engine: "fake-engine", version: "2.2.5", hosts: ["downloads.example.test"],
      assets: { [standalonePlatformKey()]: { url: "https://downloads.example.test/fake", archive: "raw", executable: "fakebin", approxBytes: program.length, sha256: sha256(program), executableSha256: sha256(program) } },
    };
    const fetchImpl = (async () => new Response(program)) as unknown as typeof fetch;
    const migrate = plan({ formerNpm: ["fake-old"] }, { npm: undefined, standalone: release });

    let fail = true;
    const installStandalone = (r: StandaloneRelease, options: Parameters<typeof installStandaloneEngine>[1]) =>
      installStandaloneEngine(r, { ...options, fetchImpl: fail ? (async () => new Response("not it")) as unknown as typeof fetch : fetchImpl });
    const engines = updater([migrate], { steps: { installStandalone } });
    await engines.check();
    expect(standaloneCurrentVersion(release, base)).toBeNull();
    expect(npmCopyVersion("fake-old", base)).toBe("1.19.4");
    expect(lines[0]).toContain("Fake Engine stays on 1.19.4");

    fail = false;
    await updater([migrate], { steps: { installStandalone }, statePath: join(base, "after-the-backoff.json") }).check();
    expect(standaloneCurrentVersion(release, base)).toBe("2.2.5");
    expect(npmCopyVersion("fake-old", base)).toBeNull();
    expect(existsSync(join(enginesBinDir(base), "fakebin"))).toBe(false);
    expect(lines.at(-1)).toBe("Engine update: Fake Engine 1.19.4 → 2.2.5");
  });

  it("installs no build of the app's own that refuses the engine's handshake", async () => {
    await installNpmEngine("fake-old", { baseDir: base, cli: "fakebin", version: "1.19.4" });
    const program = "#!/bin/sh\necho 'fake 2.2.5'\n";
    const release: StandaloneRelease = {
      name: "Fake Engine", engine: "fake-engine", version: "2.2.5", hosts: ["downloads.example.test"],
      assets: { [standalonePlatformKey()]: { url: "https://downloads.example.test/fake", archive: "raw", executable: "fakebin", approxBytes: program.length, sha256: sha256(program), executableSha256: sha256(program) } },
    };
    const installStandalone = (r: StandaloneRelease, options: Parameters<typeof installStandaloneEngine>[1]) =>
      installStandaloneEngine(r, { ...options, fetchImpl: (async () => new Response(program)) as unknown as typeof fetch });
    await updater([plan({ formerNpm: ["fake-old"], acp: ["acp"] }, { npm: undefined, standalone: release })], {
      steps: { installStandalone, handshake: async () => "it refused the ACP handshake" },
    }).check();
    expect(standaloneCurrentVersion(release, base)).toBeNull();
    expect(npmCopyVersion("fake-old", base)).toBe("1.19.4");
    expect(lines[0]).toContain("it refused the ACP handshake");
  });

  it("keeps an npm copy a saved CLI path still runs", async () => {
    await installNpmEngine("fake-old", { baseDir: base, cli: "fakebin", version: "1.19.4" });
    const release: StandaloneRelease = { name: "Fake Engine", engine: "fake-engine", version: "2.2.5", hosts: [], assets: {} };
    await updater([plan({ formerNpm: ["fake-old"] }, { npm: undefined, standalone: release })], {
      configuredClis: () => [join(enginesBinDir(base), "fakebin")],
      steps: { standaloneVersion: () => "2.2.5" },
    }).check();
    expect(npmCopyVersion("fake-old", base)).toBe("1.19.4");
  });
});

describe("a runtime the app manages itself", () => {
  it("installs the pinned runtime beside an older one, and leaves one it never installed alone", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-engine-updates-"));
    try {
      const install = vi.fn(async () => {});
      const lines: string[] = [];
      let older: string | null = "1.4.2";
      const managed = { older: async () => older, install, folder: join(scratch, "runtimes") };
      const engines = createEngineUpdater({
        plans: [{ driverKind: "managedEngine", name: "Managed", pin: { target: "1.4.3", minimum: "1.4.3" }, managed }],
        baseDir: scratch, statePath: join(scratch, "state.json"), turnRunning: () => false, log: (line) => lines.push(line),
        liveCommands: () => [], steps: noSteps(),
      });
      await engines.check();
      expect(install).toHaveBeenCalledTimes(1);
      expect(lines).toEqual(["Engine update: Managed 1.4.2 → 1.4.3"]);
      older = null;
      await engines.check();
      expect(install).toHaveBeenCalledTimes(1);
    } finally {
      await removeTempDir(scratch);
    }
  });
});

describe.skipIf(process.platform === "win32")("the ACP handshake", () => {
  let scratch = "";
  beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "omb-handshake-")); });
  afterEach(async () => { await removeTempDir(scratch); });
  const agent = (body: string) => {
    const path = join(scratch, `agent-${Math.random().toString(36).slice(2)}`);
    writeFileSync(path, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
    return path;
  };

  it("passes a program that answers initialize, and says why one that does not fails", async () => {
    const answers = agent(`process.stdin.on("data", (chunk) => { const { id } = JSON.parse(String(chunk)); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: 1 } }) + "\\n"); });`);
    expect(await acpHandshake(answers, ["acp"], process.env)).toBeNull();
    const exits = agent(`console.error("unknown command: acp"); process.exit(2);`);
    expect(await acpHandshake(exits, ["acp"], process.env)).toBe("unknown command: acp");
    const silent = agent("setInterval(() => {}, 1000);");
    expect(await acpHandshake(silent, ["acp"], process.env, 300)).toBe("it did not answer the ACP handshake in time");
  });
});
