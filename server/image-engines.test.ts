import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { enginesBinDir, registerEnginesBinDir } from "./engine-install.ts";
import { npmEnginesPrefix } from "./engine-roots.ts";
import type { StagedNpmUpdate } from "./engine-npm-update.ts";
import { createEngineUpdater, enginePlans } from "./engine-updates.ts";
import { ENGINE_VERSIONS } from "./engine-versions.ts";
import { findCliCandidates, resetPathCacheForTests } from "./env-path.ts";
import { dataCopyWins, imageBinFirst, imageCopyTooOld, imageEnginesOn, imagePrefix, runningImageVersion, sharedCopies } from "./image-engines.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const CLAUDE = "@anthropic-ai/claude-code";
const CODEX = "@openai/codex";
const CLI: Record<string, string> = { [CLAUDE]: "claude", [CODEX]: "codex" };

const folders: string[] = [];
afterAll(async () => { for (const folder of folders) await removeTempDir(folder); });

/** An npm prefix laid out as `npm install -g` leaves it: lib/node_modules/<pkg> and its command in bin/. */
function install(prefix: string, pkg: string, version: string): string {
  const dir = join(prefix, "lib", "node_modules", ...pkg.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg, version, bin: { [CLI[pkg]!]: "cli.js" } }));
  mkdirSync(join(prefix, "bin"), { recursive: true });
  const command = join(prefix, "bin", CLI[pkg]!);
  writeFileSync(command, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  return command;
}

function machine() {
  const root = mkdtempSync(join(tmpdir(), "omb-image-engines-"));
  folders.push(root);
  const image = join(root, "usr-local");
  const data = join(root, "data");
  return { root, image, data, dataPrefix: npmEnginesPrefix(data) };
}

describe("the switch", () => {
  it("is off unless set to 1 or an absolute prefix, and always off on Windows", () => {
    expect(imageEnginesOn({ env: {}, platform: "linux" })).toBe(false);
    expect(imageEnginesOn({ env: { OMB_IMAGE_ENGINES: "0" }, platform: "linux" })).toBe(false);
    expect(imageEnginesOn({ env: { OMB_IMAGE_ENGINES: "true" }, platform: "linux" })).toBe(false);
    expect(imageEnginesOn({ env: { OMB_IMAGE_ENGINES: "relative/prefix" }, platform: "linux" })).toBe(false);
    expect(imageEnginesOn({ env: { OMB_IMAGE_ENGINES: "1" }, platform: "linux" })).toBe(true);
    expect(imageEnginesOn({ env: { OMB_IMAGE_ENGINES: "/usr/local" }, platform: "linux" })).toBe(true);
    expect(imageEnginesOn({ env: { OMB_IMAGE_ENGINES: "1" }, platform: "win32" })).toBe(false);
    expect(imageEnginesOn({ env: { OMB_IMAGE_ENGINES: "1" }, platform: "darwin" })).toBe(true);
  });

  it("finds the image's prefix from Node's own place, or the absolute prefix it names", () => {
    expect(imagePrefix({ env: { OMB_IMAGE_ENGINES: "/opt/image" } })).toBe("/opt/image");
    expect(imagePrefix({ env: { OMB_IMAGE_ENGINES: "1" } })).toBe(join(process.execPath, "..", ".."));
    expect(runningImageVersion(CLAUDE, "/nowhere", { env: {} })).toBeNull();
  });
});

describe("which copy wins", () => {
  it("is the data folder's only when it is newer, or a version cannot be read", () => {
    expect(dataCopyWins({ image: "2.1.330", data: "2.1.329" })).toBe(false);
    expect(dataCopyWins({ image: "2.1.330", data: "2.1.330" })).toBe(false);
    expect(dataCopyWins({ image: "2.1.330", data: "2.1.331" })).toBe(true);
    expect(dataCopyWins({ image: "0.171.0", data: "0.172.0-alpha.1" })).toBe(true);
    expect(dataCopyWins({ image: null, data: "1.0.0" })).toBe(true);
    expect(dataCopyWins({ image: "1.0.0", data: "not a version" })).toBe(true);
    expect(imageBinFirst([])).toBe(false);
    expect(imageBinFirst([{ pkg: CLAUDE, image: "2.1.330", data: "2.1.300" }, { pkg: CODEX, image: "0.171.0", data: "0.171.0" }])).toBe(true);
    // One newer copy in the data folder keeps today's order for both: PATH is one list.
    expect(imageBinFirst([{ pkg: CLAUDE, image: "2.1.330", data: "2.1.340" }, { pkg: CODEX, image: "0.171.0", data: "0.167.0" }])).toBe(false);
  });

  it("asks for a newer copy only when the image's is below the driver's minimum, or below an exact target", () => {
    expect(imageCopyTooOld({ target: "latest", minimum: "2.1.267" }, "2.1.330")).toBe(false);
    expect(imageCopyTooOld({ target: "latest", minimum: "2.1.267" }, "2.1.200")).toBe(true);
    expect(imageCopyTooOld({ target: "0.167.0", minimum: "0.146.0" }, "0.171.0")).toBe(false);
    expect(imageCopyTooOld({ target: "0.167.0", minimum: "0.146.0" }, "0.160.0")).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("the PATH engines run from", () => {
  beforeEach(() => resetPathCacheForTests());
  afterEach(() => { vi.unstubAllEnvs(); resetPathCacheForTests(); });

  function boot(m: ReturnType<typeof machine>, switchOn: boolean) {
    vi.stubEnv("PATH", `${join(m.image, "bin")}:/usr/bin:/bin`);
    vi.stubEnv("OMB_TEST_SEALED_PATH", "1");
    vi.stubEnv("OMB_IMAGE_ENGINES", switchOn ? m.image : "");
    registerEnginesBinDir(m.data, []);
  }

  it("keeps today's order with the switch off: the data folder's copy first, even when older (desktop and every server)", () => {
    const m = machine();
    install(m.image, CLAUDE, "2.1.330");
    const data = install(m.dataPrefix, CLAUDE, "2.1.300");
    boot(m, false);
    expect(findCliCandidates("claude")[0]).toBe(data);
  });

  it("runs the image's copy over an older or equal one in the data folder", () => {
    const m = machine();
    const image = install(m.image, CLAUDE, "2.1.330");
    install(m.image, CODEX, "0.171.0");
    install(m.dataPrefix, CLAUDE, "2.1.300");
    install(m.dataPrefix, CODEX, "0.171.0");
    boot(m, true);
    expect(findCliCandidates("claude")[0]).toBe(image);
    expect(findCliCandidates("codex")[0]).toBe(join(m.image, "bin", "codex"));
    expect(sharedCopies(m.data, { env: { OMB_IMAGE_ENGINES: m.image } }).map((copy) => copy.pkg).sort()).toEqual([CLAUDE, CODEX]);
  });

  it("runs a newer copy someone installed in the data folder", () => {
    const m = machine();
    install(m.image, CLAUDE, "2.1.330");
    const data = install(m.dataPrefix, CLAUDE, "2.1.331");
    boot(m, true);
    expect(findCliCandidates("claude")[0]).toBe(data);
  });

  it("still finds an engine only the data folder has, ahead of the rest of PATH", () => {
    const m = machine();
    install(m.image, CLAUDE, "2.1.330");
    install(m.dataPrefix, CLAUDE, "2.1.300");
    const gemini = join(enginesBinDir(m.data), "gemini");
    writeFileSync(gemini, "#!/bin/sh\n", { mode: 0o755 });
    boot(m, true);
    expect(findCliCandidates("gemini")[0]).toBe(gemini);
  });

  it("leaves a CLI path someone saved on the engine alone", () => {
    const m = machine();
    install(m.image, CLAUDE, "2.1.330");
    const data = install(m.dataPrefix, CLAUDE, "2.1.300");
    boot(m, true);
    expect(findCliCandidates(data)).toEqual([data]);
  });
});

describe.skipIf(process.platform === "win32")("the engine updater with image copies", () => {
  afterEach(() => { vi.unstubAllEnvs(); resetPathCacheForTests(); });

  const plans = enginePlans(BUILT_IN_DRIVERS).filter((plan) => plan.npm === CLAUDE || plan.npm === CODEX);

  /** The data folder's copies on disk, as the updater and the PATH order read them. */
  function updater(m: ReturnType<typeof machine>, versions: Record<string, string>, configuredClis: string[] = []) {
    for (const [pkg, version] of Object.entries(versions)) install(m.dataPrefix, pkg, version);
    const npmLatest = vi.fn(async () => "2.1.350");
    const updateNpm = vi.fn(async (_options: StagedNpmUpdate) => {});
    const installStandalone = vi.fn(async () => { throw new Error("no standalone download in this test"); });
    const engines = createEngineUpdater({
      plans, baseDir: m.data, statePath: join(m.root, "engine-updates.json"), turnRunning: () => false, liveCommands: () => [], configuredClis: () => configuredClis, log: () => {},
      steps: { sweep: async () => {}, npmVersion: (pkg) => versions[pkg] ?? null, standaloneVersion: () => null, npmLatest, updateNpm, installStandalone },
    });
    return { engines, npmLatest, updateNpm, installStandalone };
  }

  it("downloads nothing while the image's copies are at least as new as the data folder's", async () => {
    expect(plans.map((plan) => plan.npm).sort()).toEqual([CLAUDE, CODEX]);
    const m = machine();
    install(m.image, CLAUDE, "2.1.330");
    install(m.image, CODEX, "0.171.0");
    vi.stubEnv("OMB_IMAGE_ENGINES", m.image);
    const { engines, npmLatest, updateNpm, installStandalone } = updater(m, { [CLAUDE]: "2.1.300", [CODEX]: "0.160.0" });
    await engines.check();
    expect(npmLatest).not.toHaveBeenCalled();
    expect(updateNpm).not.toHaveBeenCalled();
    expect(installStandalone).not.toHaveBeenCalled();
  });

  it("updates the data folder's copies as today with the switch off", async () => {
    const m = machine();
    install(m.image, CLAUDE, "2.1.330");
    install(m.image, CODEX, "0.171.0");
    const { engines, npmLatest, updateNpm } = updater(m, { [CLAUDE]: "2.1.300", [CODEX]: "0.160.0" });
    await engines.check();
    expect(npmLatest).toHaveBeenCalledOnce();
    expect(updateNpm.mock.calls.map(([options]) => [options.pkg, options.version]).sort())
      .toEqual([[CLAUDE, "2.1.350"], [CODEX, ENGINE_VERSIONS.codex!.target]]);
  });

  it("keeps a newer copy in the data folder up to date, as today", async () => {
    const m = machine();
    install(m.image, CLAUDE, "2.1.330");
    vi.stubEnv("OMB_IMAGE_ENGINES", m.image);
    const { engines, updateNpm } = updater(m, { [CLAUDE]: "2.1.340" });
    await engines.check();
    expect(updateNpm).toHaveBeenCalledOnce();
    expect(updateNpm.mock.calls[0]![0]).toMatchObject({ pkg: CLAUDE, version: "2.1.350" });
  });

  it("installs a newer copy when the image's is below what the driver needs", async () => {
    const m = machine();
    install(m.image, CLAUDE, "2.1.200");
    vi.stubEnv("OMB_IMAGE_ENGINES", m.image);
    const { engines, updateNpm } = updater(m, { [CLAUDE]: "2.1.100" });
    await engines.check();
    expect(updateNpm.mock.calls[0]![0]).toMatchObject({ pkg: CLAUDE, version: "2.1.350" });
  });

  it("keeps updating an older copy that still runs because another engine's newer copy keeps the data folder first", async () => {
    const m = machine();
    install(m.image, CLAUDE, "2.1.330");
    install(m.image, CODEX, "0.171.0");
    vi.stubEnv("OMB_IMAGE_ENGINES", m.image);
    const { engines, updateNpm } = updater(m, { [CLAUDE]: "2.1.300", [CODEX]: "0.172.0" });
    await engines.check();
    expect(updateNpm.mock.calls.map(([options]) => options.pkg)).toEqual([CLAUDE]);
  });

  it("keeps updating a data-folder copy a saved CLI path runs", async () => {
    const m = machine();
    install(m.image, CLAUDE, "2.1.330");
    vi.stubEnv("OMB_IMAGE_ENGINES", m.image);
    const { engines, updateNpm } = updater(m, { [CLAUDE]: "2.1.300" }, [join(enginesBinDir(m.data), "claude")]);
    await engines.check();
    expect(updateNpm).toHaveBeenCalledOnce();
  });
});
