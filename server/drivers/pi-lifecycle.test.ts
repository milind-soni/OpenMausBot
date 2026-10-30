import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import * as procs from "../procs.ts";
import { PiDriver } from "./pi.ts";

const CLI = fileURLToPath(new URL("../testing/fake-pi-lifecycle.mjs", import.meta.url));
let dir: string;
let instance: ProviderInstance;
let events: EventRecorder;

beforeEach(async () => {
  ensureDirs();
  chmodSync(CLI, 0o755);
  dir = mkdtempSync(join(tmpdir(), "omb-pi-lifecycle-"));
  instance = await PiDriver.create({
    instanceId: "pi-lifecycle",
    displayName: "Pi lifecycle fixture",
    enabled: true,
    config: { cli: CLI, fullAuto: false },
    environment: { FAKE_PI_LIFECYCLE_DUMP: join(dir, "rpc.jsonl") },
  });
  events = recordEvents(instance.adapter);
});

afterEach(async () => {
  await instance.dispose();
  const dump = join(dir, "rpc.jsonl");
  if (existsSync(dump)) {
    const rows = readFileSync(dump, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { pid?: number });
    for (const { pid } of rows) {
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  }
  events.stop();
  await removeTempDir(dir);
});

it.each(["interrupt", "stopAll", "dispose"])("keeps ownership through %s until the CLI has stopped", async (action) => {
  await instance.adapter.sendTurn({ threadId: "cancel", text: "wait" });
  await events.until((event) => event.type === "item.started");
  const { pid } = JSON.parse(readFileSync(join(dir, "rpc.jsonl"), "utf8").trim()) as { pid: number };
  let runningAtCompletion = false;
  instance.adapter.onEvent((event) => {
    if (event.type !== "turn.completed") return;
    try { process.kill(pid, 0); runningAtCompletion = true; } catch {}
  });
  const interrupted = action === "interrupt" ? instance.adapter.interruptTurn("cancel")
    : action === "stopAll" ? instance.adapter.stopAll() : instance.dispose();
  const ownedWhileStopping = instance.adapter.hasSession("cancel");
  const disposed = instance.dispose();
  await Promise.all([interrupted, disposed]);
  expect(ownedWhileStopping).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
  expect(runningAtCompletion).toBe(false);
  // Windows stops the CLI with taskkill /F: no TERM handler runs there.
  if (process.platform !== "win32") expect(readFileSync(join(dir, "rpc.jsonl"), "utf8")).toContain('"terminated":true');
  expect(events.events.filter((event) => event.type === "turn.completed")).toMatchObject([
    { ok: true, stopReason: "cancelled" },
  ]);
});

it.each(["interrupt", "dispose"])("waits for delayed Windows termination during %s", async (action) => {
  await instance.adapter.sendTurn({ threadId: "windows-cancel", text: "wait" });
  await events.until((event) => event.type === "item.started");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const kill = vi.spyOn(procs, "killCliTree").mockImplementation((child, timeoutMs = 5_000) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    child.once("close", () => { clearTimeout(timeout); resolve(true); });
    setTimeout(() => child.kill("SIGKILL"), 25);
  }));
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const stopped = action === "interrupt" ? instance.adapter.interruptTurn("windows-cancel") : instance.dispose();
    expect(instance.adapter.hasSession("windows-cancel")).toBe(true);
    const error = await stopped.then(() => null, (err: Error) => err.message);
    await events.until((event) => event.type === "turn.completed");
    expect({ error, completed: events.events.filter((event) => event.type === "turn.completed") }).toMatchObject({
      error: null, completed: [{ ok: true, stopReason: "cancelled" }],
    });
    expect(events.events.some((event) => event.type === "runtime.error")).toBe(false);
    expect(instance.adapter.hasSession("windows-cancel")).toBe(false);
  } finally {
    Object.defineProperty(process, "platform", platform);
    kill.mockRestore();
  }
});

it.each(["stopAll", "dispose"])("waits for every turn and reports termination failure during %s", async (action) => {
  for (const threadId of ["failed-stop", "delayed-stop"]) {
    await instance.adapter.sendTurn({ threadId, text: "wait" });
    await events.until((event) => event.type === "item.started" && event.threadId === threadId);
  }
  const terminate = procs.killCliTree;
  let failedChild!: ChildProcess;
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const kill = vi.spyOn(procs, "killCliTree")
    .mockImplementationOnce(async (child) => { failedChild = child; return false; })
    .mockImplementationOnce(async (child) => { await delayed; return terminate(child); });
  let returned = false;
  const stopped = (action === "stopAll" ? instance.adapter.stopAll() : instance.dispose()).then(
    () => { returned = true; return null; },
    (error: Error) => { returned = true; return error.message; },
  );
  try {
    await events.until((event) => event.type === "runtime.error" && event.threadId === "failed-stop");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const returnedBeforeSecondStopped = returned;
    expect(instance.adapter.hasSession("delayed-stop")).toBe(true);
    release();
    await events.until((event) => event.type === "turn.completed" && event.threadId === "delayed-stop");
    const error = await stopped;
    expect(instance.adapter.hasSession("delayed-stop")).toBe(false);
    expect(instance.adapter.hasSession("failed-stop")).toBe(true);
    const beforeLateExit = events.events.length;
    const closed = once(failedChild, "close");
    failedChild.kill("SIGKILL");
    await closed;
    await instance.adapter.interruptTurn("failed-stop");
    expect({ returnedBeforeSecondStopped, error, lateEvents: events.events.slice(beforeLateExit).map((event) => event.type) }).toEqual({
      returnedBeforeSecondStopped: false,
      error: "Pi process termination could not be confirmed",
      lateEvents: action === "dispose" ? [] : ["turn.completed"],
    });
  } finally {
    release();
    await stopped;
    kill.mockRestore();
  }
});

it("preserves cancellation when the CLI closes after termination timed out", async () => {
  await instance.adapter.sendTurn({ threadId: "late-exit", text: "wait" });
  await events.until((event) => event.type === "item.started");
  let child!: ChildProcess;
  const kill = vi.spyOn(procs, "killCliTree").mockImplementationOnce(async (cli) => { child = cli; return false; });
  try {
    await expect(instance.adapter.interruptTurn("late-exit")).rejects.toThrow("termination could not be confirmed");
    expect(instance.adapter.hasSession("late-exit")).toBe(true);
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
    expect(await events.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(events.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(instance.adapter.hasSession("late-exit")).toBe(false);
  } finally {
    kill.mockRestore();
  }
});

it("fails a refused model change without sending the prompt", async () => {
  await instance.adapter.sendTurn({ threadId: "refused-model", text: "hello", model: "fixture/refused" });
  const completed = await events.until((event) => event.type === "turn.completed");
  expect(completed).toMatchObject({ ok: false, stopReason: "failed" });
  expect(events.events.some((event) => event.type === "runtime.error")).toBe(true);
  const rows = readFileSync(join(dir, "rpc.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(rows.some((row) => "prompt" in row)).toBe(false);
  expect(events.events.some((event) => event.type === "session.started" && event.model === "fixture/refused")).toBe(false);
});

it.each([
  ["fixture/alias", "fixture/confirmed"],
  [undefined, "fixture/default"],
])("reports the confirmed model for selection %s", async (model, confirmed) => {
  await instance.adapter.sendTurn({ threadId: "confirmed-model", text: "hello", model });
  await events.until((event) => event.type === "turn.completed");
  expect(events.events.find((event) => event.type === "session.started")).toMatchObject({ model: confirmed });
});

it.each(["retry", "nonterminal", "compaction_start", "auto_compaction_start", "agent_start", "turn_start"])(
  "keeps a turn running beyond the completion grace after %s",
  async (kind) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await instance.adapter.sendTurn({ threadId: "maintenance", text: `maintenance:${kind}` });
      await events.until((event) => event.type === "content.delta" && event.delta === "maintenance-ready");
      await vi.advanceTimersByTimeAsync(60_001);
      expect(await instance.adapter.steer!("maintenance", "complete")).toBe("steered");
    } finally {
      vi.useRealTimers();
    }
    const completed = await events.until((event) => event.type === "turn.completed");
    expect(completed).toMatchObject({ ok: true, stopReason: "end_turn" });
    expect(events.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  },
);

it("retains the completion fallback when no continuation or maintenance arrives", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    await instance.adapter.sendTurn({ threadId: "legacy", text: "maintenance:legacy" });
    await events.until((event) => event.type === "content.delta" && event.delta === "maintenance-ready");
    await vi.advanceTimersByTimeAsync(60_001);
  } finally {
    vi.useRealTimers();
  }
  expect(await events.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true, stopReason: "end_turn" });
});

it.each(["toolUse", "tool_use", "tool_calls"])("accumulates usage across %s rounds without counting duplicate fields", async (reason) => {
  await instance.adapter.sendTurn({ threadId: "usage", text: `usage:${reason}` });
  expect(await events.until((event) => event.type === "turn.completed")).toMatchObject({
    ok: true, usage: { input: 17, output: 3 },
  });
});

it("keeps usage already consumed when Stop cancels a continuation", async () => {
  await instance.adapter.sendTurn({ threadId: "usage-stop", text: "usage:hold" });
  await events.until((event) => event.type === "content.delta" && event.delta === "usage-ready");
  await instance.adapter.interruptTurn("usage-stop");
  expect(await events.until((event) => event.type === "turn.completed")).toMatchObject({
    ok: true, stopReason: "cancelled", usage: { input: 5, output: 1 },
  });
});
