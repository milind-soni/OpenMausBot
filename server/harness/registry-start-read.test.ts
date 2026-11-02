// The start-up read on a later start: the most used engine probed alone first, a turn's own engine at once, and the
// engine list answered from the last run's status until the read reaches each engine.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InstanceConfigMap } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { makeFakeDriver, type FakeDriverOptions } from "../testing/fake-driver.ts";
import { snapshotFrom, STATUS_SAVE_DELAY_MS } from "./engine-status-file.ts";
import { enginesByUse, ProviderRegistry, SNAPSHOT_DEADLINE_MS, START_READ_STEP_MS } from "./registry.ts";

const AVAILABLE = { state: "available", version: "0.0.0-fake" } as const;
const GONE = { state: "unavailable", reason: "`fake` CLI not found" } as const;

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
/** The recorded status is written a second after the last probe lands. */
const saved = async () => { await vi.advanceTimersByTimeAsync(STATUS_SAVE_DELAY_MS); };
const timersForTheFile = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

async function engines(options: Record<string, FakeDriverOptions>, registryOptions: ConstructorParameters<typeof ProviderRegistry>[1] = {}, configs?: InstanceConfigMap) {
  const fakes = Object.entries(options).map(([kind, opts]) => {
    const fake = makeFakeDriver(Object.assign(opts, { kind }));
    if (!kind.startsWith("api")) fake.driver.defaultConfig = () => ({ cli: `${kind}-cli` });
    return fake;
  });
  const registry = new ProviderRegistry(fakes.map((fake) => fake.driver), registryOptions);
  await registry.load(configs ?? Object.fromEntries(Object.keys(options).map((kind) => [kind, { driver: kind }])));
  const probes = () => Object.fromEntries(fakes.map((fake) => [fake.driver.driverKind, fake.probes.length]));
  return { registry, probes };
}

const scratch: string[] = [];
function statusFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-engine-status-"));
  scratch.push(dir);
  return join(dir, "providers", "engine-status.json");
}

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

describe("the start-up read", () => {
  it("probes CLIs one at a time, the most used first, engines without a CLI at once, and a turn's own engine at once", async () => {
    const [a, b, c, d, api] = [gate(), gate(), gate(), gate(), gate()];
    const { registry, probes } = await engines({ a: { holdSnapshot: a.promise }, b: { holdSnapshot: b.promise }, c: { holdSnapshot: c.promise },
      d: { holdSnapshot: d.promise }, api: { holdSnapshot: api.promise } });

    let afterFirst = 0;
    const read = registry.readAtStart(["b", "a"], () => { afterFirst += 1; });
    expect(probes()).toEqual({ a: 0, b: 1, c: 0, d: 0, api: 1 });

    expect(registry.engineRead(undefined, "missing")).toBeNull();
    const turn = registry.engineRead("c", undefined, "c");
    expect(turn).not.toBeNull();
    expect(probes()).toEqual({ a: 0, b: 1, c: 1, d: 0, api: 1 });
    c.open();
    await turn;
    expect(registry.lastSnapshot("c")).toEqual(AVAILABLE);
    expect(registry.engineRead("c")).toBeNull();
    await settle();
    expect(probes()).toEqual({ a: 0, b: 1, c: 1, d: 0, api: 1 });

    expect(afterFirst).toBe(0);
    b.open();
    await settle();
    expect(afterFirst).toBeGreaterThan(0);
    expect(probes()).toEqual({ a: 1, b: 1, c: 1, d: 0, api: 1 });
    expect(registry.engineRead("b", "c")).toBeNull();
    expect(registry.engineRead("b", "a")).not.toBeNull();
    a.open();
    await settle();
    expect(probes()).toEqual({ a: 1, b: 1, c: 1, d: 1, api: 1 });
    d.open();
    await settle();
    expect(registry.provisional()).toBe(true);
    api.open();

    const { engines: described } = await read;
    expect(described.map((engine) => [engine.instanceId, engine.snapshot])).toEqual(["a", "b", "c", "d", "api"].map((id) => [id, AVAILABLE]));
    expect(probes()).toEqual({ a: 1, b: 1, c: 1, d: 1, api: 1 });
    expect(registry.engineRead("a")).toBeNull();
    expect(registry.provisional()).toBe(false);
  });

  it("moves on from a CLI that does not answer after one step, and still waits for its answer before it ends", async () => {
    vi.useFakeTimers();
    const { registry, probes } = await engines({ stuck: { hangSnapshot: true }, b: {} });

    let ended = false, afterFirst = false;
    const read = registry.readAtStart(["stuck"], () => { afterFirst = true; }).then((result) => { ended = true; return result; });
    expect(probes()).toEqual({ stuck: 1, b: 0 });
    await vi.advanceTimersByTimeAsync(START_READ_STEP_MS - 1);
    expect(probes()).toEqual({ stuck: 1, b: 0 });
    expect(afterFirst).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(probes()).toEqual({ stuck: 1, b: 1 });
    expect(afterFirst).toBe(true);
    expect(registry.engineRead("b")).toBeNull();
    expect(registry.engineRead("stuck")).not.toBeNull();
    expect(ended).toBe(false);

    await vi.advanceTimersByTimeAsync(SNAPSHOT_DEADLINE_MS);
    const { engines: described } = await read;
    expect(described.find((engine) => engine.instanceId === "stuck")!.snapshot).toMatchObject({ state: "unavailable", reason: expect.stringContaining("within a minute") });
    expect(probes()).toEqual({ stuck: 1, b: 1 });
  });

  it("answers the engine list from the last run's status until it reaches an engine, and never decides from that status", async () => {
    const file = statusFile();
    const options: FakeDriverOptions = {};
    timersForTheFile();
    const lastRun = await engines({ fake: options }, { statusFile: file });
    await lastRun.registry.describe();
    expect(existsSync(file)).toBe(false);
    await saved();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, engines: [{ instanceId: "fake", driverKind: "fake", cli: "fake-cli", snapshot: AVAILABLE }] });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    const probe = gate();
    Object.assign(options, { holdSnapshot: probe.promise, answer: GONE });
    const { registry, probes } = await engines({ fake: options }, { statusFile: file });
    const read = registry.readAtStart();
    const [listed] = await registry.describe({ known: true });
    expect(listed.snapshot).toEqual(AVAILABLE);
    expect(registry.knownSnapshot("fake")).toEqual(AVAILABLE);
    expect(registry.lastSnapshot("fake")).toBeUndefined();
    expect(registry.provisional()).toBe(true);
    expect(registry.engineRead("fake")).not.toBeNull();
    const probed = registry.describe();
    expect(probes()).toEqual({ fake: 1 });

    probe.open();
    const { engines: described, changed } = await read;
    expect(described[0].snapshot).toEqual(GONE);
    expect((await probed)[0].snapshot).toEqual(GONE);
    expect(changed).toBe(true);
    expect(registry.lastSnapshot("fake")).toEqual(GONE);
    expect(registry.knownSnapshot("fake")).toEqual(GONE);
    expect(registry.provisional()).toBe(false);
    expect(registry.provisional([listed])).toBe(true);
    expect(registry.provisional(described)).toBe(false);
    await saved();
    expect(JSON.parse(readFileSync(file, "utf8")).engines[0].snapshot).toEqual(GONE);
    expect(probes()).toEqual({ fake: 2 });
  });

  it("probes once more, warm, an engine the last run saw available that a cold probe found unavailable", async () => {
    const file = statusFile();
    const options: FakeDriverOptions = {};
    timersForTheFile();
    await (await engines({ fake: options }, { statusFile: file })).registry.describe();
    await saved();
    const probe = gate();
    Object.assign(options, { holdSnapshot: probe.promise, answer: GONE });
    const { registry, probes } = await engines({ fake: options }, { statusFile: file });
    const read = registry.readAtStart(["fake"]);
    expect(probes()).toEqual({ fake: 1 });
    const warm = gate();
    options.holdSnapshot = warm.promise;
    probe.open();
    await settle();
    expect(probes()).toEqual({ fake: 2 });
    expect(registry.engineRead("fake")).not.toBeNull();
    delete options.answer;
    warm.open();
    const { engines: described, changed } = await read;
    expect(probes()).toEqual({ fake: 2 });
    expect(described[0].snapshot).toEqual(AVAILABLE);
    expect(changed).toBe(false);
  });

  it("reports no change when the probe agrees with the last run", async () => {
    const file = statusFile();
    timersForTheFile();
    await (await engines({ fake: {} }, { statusFile: file })).registry.describe();
    await saved();
    const { registry } = await engines({ fake: {} }, { statusFile: file });
    expect((await registry.readAtStart()).changed).toBe(false);
  });

  it("keeps no seed for an engine whose driver or CLI changed, or once the engines must be probed again", async () => {
    const file = statusFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ v: 1, engines: [
      { instanceId: "moved", driverKind: "fake", cli: "/old/fake", snapshot: AVAILABLE },
      { instanceId: "other", driverKind: "someone-else", cli: "fake-cli", snapshot: AVAILABLE },
      { instanceId: "kept", driverKind: "fake", cli: "fake-cli", snapshot: AVAILABLE },
    ] }));
    const probe = gate();
    const { registry } = await engines({ fake: { holdSnapshot: probe.promise } }, { statusFile: file }, {
      moved: { driver: "fake", config: { cli: "/new/fake" } }, other: { driver: "fake" }, kept: { driver: "fake" },
    });
    const read = registry.readAtStart(["kept"]);
    expect(["moved", "other", "kept"].map((id) => registry.knownSnapshot(id))).toEqual([undefined, undefined, AVAILABLE]);

    registry.forgetSnapshots();
    expect(registry.knownSnapshot("kept")).toBeUndefined();
    probe.open();
    await read;
  });
});

describe("the engines' recorded status", () => {
  it("keeps only the fields a snapshot has, and refuses one without a state", () => {
    expect(snapshotFrom({ state: "available", version: null, authenticated: true, account: { email: "a@example.test", token: "x" },
      billing: "subscription", update: { title: "t", message: "m", command: "c" }, warning: { title: "t" }, secret: "x" }))
      .toEqual({ state: "available", version: null, authenticated: true, account: { email: "a@example.test" }, billing: "subscription",
        update: { title: "t", message: "m", command: "c" } });
    expect(snapshotFrom({ state: "maybe" })).toBeNull();
    expect(snapshotFrom(undefined)).toBeNull();
  });

  it("orders the engines by how many selections name them", () => {
    expect(enginesByUse([{ instanceId: "codex" }, undefined, { instanceId: "claude" }, { instanceId: "claude" }, { instanceId: "" }, { instanceId: "grok" }]))
      .toEqual(["claude", "codex", "grok"]);
  });
});
