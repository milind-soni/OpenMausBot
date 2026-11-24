// A status check that could not finish on a starved machine never reads as "not installed": the registry keeps what it last
// knew (across a restart too), takes a program file that is there as installed until a check answers, checks again later,
// and runs no check that can wait during the engine's turn, while the machine is pressed, or two at once on a small one.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderSnapshot, RuntimeEvent } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { makeFakeDriver, type FakeDriverHandle, type FakeDriverOptions } from "../testing/fake-driver.ts";
import { STATUS_SAVE_DELAY_MS } from "./engine-status-file.ts";
import { PERSON_CHECK_MS, PROBE_RETRY_MS, PROMPT_RETRY_MS, STATUS_STALE_MS, TURN_PROOF_MS } from "./probe-hold.ts";
import { readyToRun, selectDefaultModelSelection } from "../default-model-selection.ts";
import { probeUnsettled } from "../cli-program.ts";
import { ENGINE_LIST_REUSE_MS, ProviderRegistry, SNAPSHOT_DEADLINE_MS } from "./registry.ts";

const SIGNED_IN = { state: "available", version: "1.2.3", authenticated: true } as const satisfies ProviderSnapshot;
/** What a driver reports for a `--version` cut off at its limit (procs.ts, acp/core.ts). */
const TIMED_OUT = { state: "unavailable", reason: "`opencode` version check timed out after 8 seconds.", busy: true } as const satisfies ProviderSnapshot;
const NOT_FOUND = { state: "unavailable", reason: "`opencode` isn't installed, or isn't on this app's PATH." } as const satisfies ProviderSnapshot;

type Options = ConstructorParameters<typeof ProviderRegistry>[1];
/** The app's rule for its "no AI connected" page (src/lib/onboarding.ts noEnginesDue): no engine there, by checks that answered. */
const noEngines = (rows: ReadonlyArray<{ snapshot: ProviderSnapshot }>) => rows.length > 0 && !rows.some((row) => row.snapshot.state === "available" || row.snapshot.busy === true);
const registries: ProviderRegistry[] = [];
const scratch: string[] = [];

async function engine(answer: ProviderSnapshot, options: Options = {}, more: FakeDriverOptions = {}) {
  const opts: FakeDriverOptions = { kind: "opencodeGo", answer, ...more };
  const fake: FakeDriverHandle = makeFakeDriver(opts);
  fake.driver.defaultConfig = () => ({ cli: "opencode" });
  const registry = new ProviderRegistry([fake.driver], { cliPresent: () => true, ...options });
  registries.push(registry);
  await registry.load({ opencode: { driver: "opencodeGo" } });
  const emit = (event: Partial<RuntimeEvent> & { type: RuntimeEvent["type"] }) =>
    fake.created.get("opencode")!.emit({ eventId: `e${Math.random()}`, provider: "opencodeGo", threadId: "t1", createdAt: new Date().toISOString(), ...event } as RuntimeEvent);
  const listed = async () => (await registry.describe()).find((row) => row.instanceId === "opencode")!.snapshot;
  return { registry, fake, opts, emit, listed, probes: () => fake.probes.length };
}

function statusFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-probe-hold-"));
  scratch.push(dir);
  return join(dir, "providers", "engine-status.json");
}

afterEach(async () => {
  vi.useRealTimers();
  for (const registry of registries.splice(0)) await registry.disposeAll();
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

describe("a status check that could not finish", () => {
  it("keeps the last status, signed in and all, and the setup page stays away", async () => {
    const { registry, opts, listed } = await engine(SIGNED_IN);
    expect(await listed()).toEqual(SIGNED_IN);

    opts.answer = TIMED_OUT;
    registry.forgetSnapshots();
    const held = await listed();
    expect(held).toEqual(SIGNED_IN);
    expect(registry.knownSnapshot("opencode")).toEqual(SIGNED_IN);
    expect(noEngines(await registry.describe())).toBe(false);
  });

  it("marks the CLI unsettled until a check answers, so no kept answer stands in for the check again", async () => {
    const { registry, opts, listed } = await engine(SIGNED_IN);
    await listed();
    opts.answer = TIMED_OUT;
    registry.forgetSnapshots();
    await listed();
    expect(probeUnsettled("opencode")).toBe(true);
    opts.answer = SIGNED_IN;
    registry.forgetSnapshots();
    await listed();
    expect(probeUnsettled("opencode")).toBe(false);
  });

  it("first ever, with the program file there: installed but unverified, never missing", async () => {
    const present = vi.fn(() => true);
    const { listed } = await engine(TIMED_OUT, { cliPresent: present });
    expect(await listed()).toEqual({ state: "available", unverified: true });
    expect(present).toHaveBeenCalledWith("opencode");
  });

  it("first ever, with no program file: not installed, and the setup page shows", async () => {
    const { registry, listed } = await engine(TIMED_OUT, { cliPresent: () => false });
    const snapshot = await listed();
    expect(snapshot).toMatchObject({ state: "unavailable", reason: TIMED_OUT.reason });
    expect("busy" in snapshot).toBe(false);
    expect(noEngines(await registry.describe())).toBe(true);
  });

  it("a binary that is truly missing still shows the setup page, whatever was known before", async () => {
    const { registry, opts, listed } = await engine(SIGNED_IN);
    await listed();
    opts.answer = NOT_FOUND;
    registry.forgetSnapshots();
    expect(await listed()).toEqual(NOT_FOUND);
    expect(noEngines(await registry.describe())).toBe(true);
  });

  it("a status read cut off by the registry's own minute is held too", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { registry, opts, listed } = await engine(SIGNED_IN);
    await listed();
    opts.hangSnapshot = true;
    registry.forgetSnapshots();
    const read = listed();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_DEADLINE_MS);
    expect(await read).toEqual(SIGNED_IN);
  });

  it("is checked again later, backing off; on a calm machine the third that cannot finish is its answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { registry, opts, listed, probes } = await engine(SIGNED_IN);
    await listed();
    opts.answer = TIMED_OUT;
    await vi.advanceTimersByTimeAsync(PERSON_CHECK_MS);
    expect(await listed()).toEqual(SIGNED_IN);
    expect(probes()).toBe(2);

    await vi.advanceTimersByTimeAsync(PROBE_RETRY_MS[0]);
    expect(probes()).toBe(3);
    expect(registry.knownSnapshot("opencode")).toEqual(SIGNED_IN);
    await vi.advanceTimersByTimeAsync(PROBE_RETRY_MS[0]);
    expect(probes()).toBe(3); // the next waits longer
    await vi.advanceTimersByTimeAsync(PROBE_RETRY_MS[1] - PROBE_RETRY_MS[0]);
    expect(probes()).toBe(4);
    // A hang or a kill every time on a calm machine is a broken engine, not a starved one.
    expect(registry.knownSnapshot("opencode")).toEqual({ state: "unavailable", reason: TIMED_OUT.reason });
    await vi.advanceTimersByTimeAsync(PROBE_RETRY_MS[4] * 2);
    expect(probes()).toBe(4);
    // Once taken as broken, it stays so through the next check that cannot finish, until one answers.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await listed()).toEqual({ state: "unavailable", reason: TIMED_OUT.reason });
    opts.answer = SIGNED_IN;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await listed()).toEqual(SIGNED_IN);
  });

  it("on a pressed machine it is never taken as broken, and is checked anyway at the back-off's last step", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let pressed = false;
    const { opts, listed, probes, registry } = await engine(SIGNED_IN, { pressed: () => pressed });
    await listed();
    opts.answer = TIMED_OUT;
    pressed = true;
    await vi.advanceTimersByTimeAsync(PERSON_CHECK_MS);
    await listed();
    expect(probes()).toBe(2);
    const lastStep = PROBE_RETRY_MS.slice(0, PROBE_RETRY_MS.length - 1).reduce((sum, ms) => sum + ms, 0);
    await vi.advanceTimersByTimeAsync(lastStep - 1);
    expect(probes()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(probes()).toBe(3);
    expect(registry.knownSnapshot("opencode")).toEqual(SIGNED_IN);
  });

  it("after the person's own change, a check that cannot finish is tried again promptly, pressed or not", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const SIGNED_OUT = { ...SIGNED_IN, authenticated: false } as const;
    const { registry, opts, listed, probes } = await engine(SIGNED_OUT, { pressed: () => true });
    await listed();
    opts.answer = TIMED_OUT;
    registry.forgetSnapshots(); // the person signed in
    expect(await listed()).toEqual(SIGNED_OUT);
    opts.answer = SIGNED_IN;
    await vi.advanceTimersByTimeAsync(PROMPT_RETRY_MS);
    expect(probes()).toBe(3);
    expect(registry.knownSnapshot("opencode")).toEqual(SIGNED_IN);
  });

  it("a sign-out read on a pressed machine is checked once more, pressed or not, then believed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { registry, opts, listed, probes } = await engine(SIGNED_IN, { pressed: () => true });
    await listed();
    opts.answer = { ...SIGNED_IN, authenticated: false };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await listed()).toEqual(SIGNED_IN);
    await vi.advanceTimersByTimeAsync(PROBE_RETRY_MS[0]);
    expect(probes()).toBe(3);
    expect(registry.knownSnapshot("opencode")).toEqual({ ...SIGNED_IN, authenticated: false });
  });

  it("a sign-out after a sign-in change is believed at once, pressed or not", async () => {
    const { registry, opts, listed } = await engine(SIGNED_IN, { pressed: () => true });
    await listed();
    opts.answer = { ...SIGNED_IN, authenticated: false };
    registry.forgetSnapshots();
    expect(await listed()).toEqual({ ...SIGNED_IN, authenticated: false });
  });

  it("a restart on a busy machine starts from the last status saved, not from nothing installed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const file = statusFile();
    const first = await engine(SIGNED_IN, { statusFile: file });
    await first.listed();
    await vi.advanceTimersByTimeAsync(STATUS_SAVE_DELAY_MS);
    await first.registry.disposeAll();

    const second = await engine(TIMED_OUT, { statusFile: file, pressed: () => true });
    const { engines } = await second.registry.readAtStart();
    expect(engines.find((row) => row.instanceId === "opencode")!.snapshot).toEqual(SIGNED_IN);
    expect(await second.listed()).toEqual(SIGNED_IN);
    await vi.advanceTimersByTimeAsync(STATUS_SAVE_DELAY_MS);

    const third = await engine(TIMED_OUT, { statusFile: file, pressed: () => true });
    await third.registry.readAtStart();
    expect(third.registry.knownSnapshot("opencode")).toEqual(SIGNED_IN);
    await third.registry.disposeAll();

    // The saved status never brings back an engine whose program was deleted meanwhile.
    const deleted = await engine(TIMED_OUT, { statusFile: file, pressed: () => true, cliPresent: () => false });
    await deleted.registry.readAtStart();
    expect(deleted.registry.knownSnapshot("opencode")).toEqual({ state: "unavailable", reason: TIMED_OUT.reason });
  });

  it("an engine only found installed is never chosen to run, as a default, or as a backup", async () => {
    const { registry } = await engine(TIMED_OUT);
    const rows = await registry.describe();
    expect(rows[0]!.snapshot).toEqual({ state: "available", unverified: true });
    expect(readyToRun({ ...rows[0]!, enabled: true })).toBe(false);
    expect(selectDefaultModelSelection(rows.map((row) => ({ ...row, enabled: true })))).toEqual({ instanceId: "", model: "" });
  });
});

describe("checks that can wait", () => {
  const reused = (registry: ProviderRegistry) => registry.describe({ reuse: { ms: ENGINE_LIST_REUSE_MS, changed: () => {} } });

  it("do not run during the engine's turn, and run again once it ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { registry, emit, probes } = await engine(SIGNED_IN, { turnsProve: true });
    await reused(registry);
    expect(probes()).toBe(1);

    emit({ type: "turn.started", turnId: "u1" } as Partial<RuntimeEvent> & { type: "turn.started" });
    vi.setSystemTime(Date.now() + ENGINE_LIST_REUSE_MS);
    expect((await reused(registry))[0]!.snapshot).toEqual(SIGNED_IN);
    expect(probes()).toBe(1);

    emit({ type: "turn.completed", turnId: "u1", ok: true, stopReason: "end_turn", cost: null } as Partial<RuntimeEvent> & { type: "turn.completed" });
    await reused(registry);
    expect(probes()).toBe(2);
  });

  it("a turn that has sent nothing for a while proves nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { registry, emit, probes } = await engine(SIGNED_IN, { turnsProve: true });
    await reused(registry);
    emit({ type: "turn.started", turnId: "u1" } as Partial<RuntimeEvent> & { type: "turn.started" });
    vi.setSystemTime(Date.now() + TURN_PROOF_MS);
    await reused(registry);
    expect(probes()).toBe(2);
  });

  it("do not run while the machine is pressed, until the last answer is STATUS_STALE_MS old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let pressed = false;
    const { registry, probes } = await engine(SIGNED_IN, { pressed: () => pressed });
    await reused(registry);
    pressed = true;
    vi.setSystemTime(Date.now() + ENGINE_LIST_REUSE_MS);
    await reused(registry);
    expect(probes()).toBe(1);
    vi.setSystemTime(Date.now() + STATUS_STALE_MS - ENGINE_LIST_REUSE_MS);
    await reused(registry);
    expect(probes()).toBe(2);
  });

  it("a retry that comes due while the machine is pressed waits for another", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let pressed = false;
    const { opts, listed, probes } = await engine(SIGNED_IN, { pressed: () => pressed });
    await listed();
    opts.answer = TIMED_OUT;
    await vi.advanceTimersByTimeAsync(5_000);
    await listed();
    pressed = true;
    await vi.advanceTimersByTimeAsync(PROBE_RETRY_MS[0]);
    expect(probes()).toBe(2);
    pressed = false;
    await vi.advanceTimersByTimeAsync(PROBE_RETRY_MS[1]);
    expect(probes()).toBe(3);
  });

  it("without a turn signal or pressure (the desktop app), the engine list reads as before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { registry, emit, probes } = await engine(SIGNED_IN);
    await reused(registry);
    emit({ type: "turn.started", turnId: "u1" } as Partial<RuntimeEvent> & { type: "turn.started" });
    vi.setSystemTime(Date.now() + ENGINE_LIST_REUSE_MS);
    await reused(registry);
    expect(probes()).toBe(2);
  });
});

describe("on a small machine", () => {
  it("runs one engine's status check at a time", async () => {
    const opens: Array<() => void> = [];
    const gate = () => new Promise<void>((resolve) => opens.push(resolve));
    const fakes = ["a", "b"].map((kind) => {
      const fake = makeFakeDriver({ kind, holdSnapshot: gate() });
      fake.driver.defaultConfig = () => ({ cli: `${kind}-cli` });
      return fake;
    });
    const registry = new ProviderRegistry(fakes.map((fake) => fake.driver), { small: () => true });
    registries.push(registry);
    await registry.load({ a: { driver: "a" }, b: { driver: "b" } });
    const listed = registry.describe();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fakes.map((fake) => fake.probes.length)).toEqual([1, 0]);
    opens[0]!();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fakes.map((fake) => fake.probes.length)).toEqual([1, 1]);
    opens[1]!();
    expect((await listed).map((row) => row.snapshot.state)).toEqual(["available", "available"]);
  });
});
