import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../../contracts.ts";
import { TurnNotStartedError } from "../../contracts.ts";
import { engineHomes } from "../../engine-homes/engine-homes.ts";
import * as procs from "../../procs.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

const SUPPORT: AcpSupport = {
  driverKind: "sharedTest",
  displayName: "Shared Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
  defaultCli: FAKE_CLI,
  nativeSource: "shared-test.acp",
  loginNote: "never reached",
  spawnArgs: () => [],
  shareProcess: true,
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
};

interface Fixture {
  instance: ProviderInstance;
  recorder: EventRecorder;
  spawned: ChildProcess[];
  scratch: string;
  methods: () => string[];
  run: (threadId: string, input?: Partial<SendTurnInput>) => Promise<{ done: RuntimeEvent; events: RuntimeEvent[] }>;
}

const scratches: string[] = [];
const instances: ProviderInstance[] = [];
/** Engine processes started, by the scratch folder of the fixture that started them. */
const started = new Map<string, ChildProcess[]>();

beforeEach(() => {
  const spawn = procs.spawnCli;
  vi.spyOn(procs, "spawnCli").mockImplementation((...args) => {
    const child = spawn(...args);
    const dump = args[2]?.env?.FAKE_ACP_RPC_DUMP;
    if (args[3] === "bot" && dump) started.get(dirname(dump))?.push(child);
    return child;
  });
});

async function fixture(support: Partial<AcpSupport> = {}, environment: Record<string, string> = {}): Promise<Fixture> {
  const scratch = mkdtempSync(join(tmpdir(), "omb-acp-shared-"));
  scratches.push(scratch);
  const spawned: ChildProcess[] = [];
  started.set(scratch, spawned);
  const driver = createAcpDriver({ ...SUPPORT, ...support });
  const instance = await driver.create({
    instanceId: "shared-test", displayName: "Shared Test", enabled: true,
    config: { cli: FAKE_CLI, fullAuto: true, workspace: scratch },
    environment: { FAKE_ACP_RPC_DUMP: join(scratch, "methods.json"), FAKE_ACP_SESSION_CLOSE: "1", ...environment },
  });
  instances.push(instance);
  const recorder = recordEvents(instance.adapter);
  const run = async (threadId: string, input: Partial<SendTurnInput> = {}) => {
    const cwd = join(scratch, threadId);
    mkdirSync(cwd, { recursive: true });
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "fixture", cwd, approvalMode: "full", ...input });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    return { done, events: recorder.events.filter((event) => event.turnId === turnId) };
  };
  const methods = () => existsSync(join(scratch, "methods.json")) ? JSON.parse(readFileSync(join(scratch, "methods.json"), "utf8")) as string[] : [];
  return { instance, recorder, spawned, scratch, methods, run };
}

const exited = (child: ChildProcess) => new Promise<void>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve();
  else child.once("exit", () => resolve());
});

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  vi.restoreAllMocks();
  started.clear();
  for (const scratch of scratches.splice(0)) removeTempDir(scratch);
});

describe("ACP threads sharing one agent process", () => {
  it("runs threads with the same spawn contract as separate sessions of one process, each on its own thread", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.run("thread-a"), f.run("thread-b")]);
    const c = await f.run("thread-c");
    expect(f.spawned).toHaveLength(1);
    for (const [threadId, result] of [["thread-a", a], ["thread-b", b], ["thread-c", c]] as const) {
      expect(result.done).toMatchObject({ ok: true, threadId });
      expect(result.events.every((event) => event.threadId === threadId)).toBe(true);
      expect(result.events.find((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toBeTruthy();
    }
    const sessions = [a, b, c].map((result) => (result.events.find((event) => event.type === "session.started") as { sessionId: string }).sessionId);
    expect(new Set(sessions).size).toBe(3);
    expect(f.methods().filter((method) => method === "initialize")).toHaveLength(1);
  });

  it("gives a thread with another spawn contract, and every thread of a driver that does not share, its own process", async () => {
    const f = await fixture();
    await f.run("thread-a");
    await f.run("thread-b", { approvalMode: "ask" });
    expect(f.spawned).toHaveLength(2);
    const g = await fixture({ shareProcess: false });
    await Promise.all([g.run("thread-a"), g.run("thread-b")]);
    expect(g.spawned).toHaveLength(2);
  });

  it("on a Team Cloud never shares a process between two audiences, whose engines have homes of their own", async () => {
    const f = await fixture();
    const dataDir = mkdtempSync(join(tmpdir(), "omb-acp-homes-"));
    scratches.push(dataDir);
    engineHomes.start({ dataDir, serverHome: dataDir, audienceOf: (threadId) => (threadId === "thread-c" ? "member:p_cleo" : "member:p_ada"), threads: () => [], log: () => {} });
    try {
      await Promise.all(["thread-a", "thread-b"].map((threadId) => engineHomes.within(threadId, () => f.run(threadId))));
      expect(f.spawned).toHaveLength(1);
      expect((await engineHomes.within("thread-c", () => f.run("thread-c"))).done).toMatchObject({ ok: true });
      expect(f.spawned).toHaveLength(2);
    } finally {
      engineHomes.stop();
    }
  });

  it("closes only the leaving thread's session while others use the process, and ends the process with the last one", async () => {
    const f = await fixture();
    await f.run("thread-a");
    await f.run("thread-b");
    const [child] = f.spawned;
    expect((await f.run("thread-a", { sessionReset: true })).done).toMatchObject({ ok: true });
    expect(f.methods()).toContain("session/close");
    expect(f.spawned).toHaveLength(1);
    expect(child!.exitCode).toBeNull();
    await f.instance.adapter.stopAll();
    await exited(child!);
  });

  it("never adds a session to a process that is ending because its last session closed", async () => {
    const f = await fixture();
    await f.run("thread-a");
    await f.instance.adapter.stopAll();
    expect((await f.run("thread-b")).done).toMatchObject({ ok: true });
    expect(f.spawned).toHaveLength(2);
  });

  it("ends a shared process holding closed sessions once none has run a turn for a while; threads reload in a new one", async () => {
    const previous = process.env.OMB_ACP_SHARED_RECYCLE_MS;
    process.env.OMB_ACP_SHARED_RECYCLE_MS = "200";
    try {
      const f = await fixture();
      await f.run("thread-a");
      await f.run("thread-b");
      const [first] = f.spawned;
      expect((await f.run("thread-a", { sessionReset: true })).done).toMatchObject({ ok: true });
      await exited(first!);
      expect((await f.run("thread-b")).done).toMatchObject({ ok: true });
      expect(f.spawned).toHaveLength(2);
    } finally {
      if (previous === undefined) delete process.env.OMB_ACP_SHARED_RECYCLE_MS;
      else process.env.OMB_ACP_SHARED_RECYCLE_MS = previous;
    }
  });

  it("never recycles a shared process while one of its sessions runs a turn", async () => {
    const previous = process.env.OMB_ACP_SHARED_RECYCLE_MS;
    process.env.OMB_ACP_SHARED_RECYCLE_MS = "200";
    try {
      const f = await fixture({}, { FAKE_ACP_HANG_ON: "HANG" });
      await f.run("thread-a");
      await f.run("thread-b");
      await f.run("thread-a", { sessionReset: true });
      const long = f.run("thread-b", { text: "HANG" });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(f.spawned[0]!.exitCode).toBeNull();
      await f.instance.adapter.interruptTurn("thread-b");
      expect((await long).done).toMatchObject({ ok: true, stopReason: "cancelled" });
      await exited(f.spawned[0]!);
    } finally {
      if (previous === undefined) delete process.env.OMB_ACP_SHARED_RECYCLE_MS;
      else process.env.OMB_ACP_SHARED_RECYCLE_MS = previous;
    }
  });

  it("stops adding sessions to a process that has opened its lifetime's worth", async () => {
    const f = await fixture();
    for (let i = 0; i < 4; i++) await f.run(`thread-${i}`);
    for (let i = 0; i < 8; i++) await f.run(`thread-${i % 4}`, { sessionReset: true });
    expect(f.spawned).toHaveLength(1);
    await f.run("thread-4");
    expect(f.spawned).toHaveLength(2);
  });

  it("starts a fresh process once a shared one is full", async () => {
    const f = await fixture();
    for (let i = 0; i < 7; i++) await f.run(`thread-${i}`);
    expect(f.spawned).toHaveLength(2);
  });

  it("retires a process whose session stalled: later threads start a new one", async () => {
    const f = await fixture({}, { FAKE_ACP_HANG_ON: "HANG" });
    const previous = process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS;
    process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS = "300";
    try {
      expect((await f.run("thread-b")).done).toMatchObject({ ok: true });
      expect((await f.run("thread-a", { text: "HANG" })).done).toMatchObject({ ok: false, stopReason: "rpc_error" });
      expect(f.spawned).toHaveLength(1);
      expect((await f.run("thread-c")).done).toMatchObject({ ok: true });
      expect(f.spawned).toHaveLength(2);
      expect((await f.run("thread-b")).done).toMatchObject({ ok: true });
    } finally {
      if (previous === undefined) delete process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS;
      else process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS = previous;
    }
  });

  it("fails every running turn when the shared process dies", async () => {
    const f = await fixture({}, { FAKE_ACP_MODE: "crash-in-prompt" });
    const results = await Promise.all([f.run("thread-a"), f.run("thread-b")]);
    expect(f.spawned).toHaveLength(1);
    for (const result of results) {
      expect(result.done).toMatchObject({ ok: false });
      expect(result.events.some((event) => event.type === "runtime.error" && /exited/.test(event.message))).toBe(true);
    }
  });

  describe("a session that ignores session/cancel", () => {
    const promptsSent = async (f: Fixture, count: number) => {
      const sent = () => { try { return f.methods().filter((method) => method === "session/prompt").length; } catch { return 0; } };
      while (sent() < count) await new Promise((resolve) => setTimeout(resolve, 20));
    };

    it.each([
      ["advertises no session/close", ""],
      ["fails session/close", "error"],
    ])("ends the shared process before Stop settles when the agent %s, and fails the other threads' turns", async (_, close) => {
      const f = await fixture({}, { FAKE_ACP_HANG_ON: "HANG", FAKE_ACP_IGNORE_CANCEL: "1", FAKE_ACP_SESSION_CLOSE: close });
      const other = f.run("thread-a", { text: "HANG" });
      await promptsSent(f, 1);
      const stopped = f.run("thread-b", { text: "HANG" });
      await promptsSent(f, 2);
      const [child] = f.spawned;
      // A listener may start the next turn synchronously on the turn.completed of the turn this Stop ends.
      let next: Promise<{ turnId: string }> | undefined;
      f.instance.adapter.onEvent((event) => {
        if (event.type !== "turn.completed" || event.threadId !== "thread-a" || next) return;
        next = f.instance.adapter.sendTurn({ threadId: "thread-a", text: "fixture", cwd: join(f.scratch, "thread-a"), approvalMode: "full" });
      });
      await f.instance.adapter.interruptTurn("thread-b");
      expect((await stopped).done).toMatchObject({ ok: true, stopReason: "cancelled" });
      expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
      expect((await other).done).toMatchObject({ ok: false });
      const { turnId } = await next!;
      expect(await f.recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ ok: true });
      expect(f.spawned).toHaveLength(2);
    });

    it("ends the shared process before Stop settles when the last session leaves while another awaits session/close", async () => {
      const f = await fixture({}, { FAKE_ACP_HANG_ON: "HANG", FAKE_ACP_IGNORE_CANCEL: "1", FAKE_ACP_SESSION_CLOSE_MS: "2000" });
      void f.run("thread-a", { text: "HANG" }).catch(() => undefined);
      await promptsSent(f, 1);
      const second = f.run("thread-b", { text: "HANG" });
      await promptsSent(f, 2);
      const [child] = f.spawned;
      await f.instance.adapter.interruptTurn("thread-a");
      await new Promise((resolve) => setTimeout(resolve, 200));
      await f.instance.adapter.interruptTurn("thread-b");
      expect((await second).done).toMatchObject({ ok: true, stopReason: "cancelled" });
      expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
      // Its session/close went unanswered when the process ended, so it settles once that request times out.
      expect(await f.recorder.until((event) => event.type === "turn.completed" && event.threadId === "thread-a", 15_000))
        .toMatchObject({ ok: true, stopReason: "cancelled" });
    });

    it("settles Stop only once the agent confirms session/close, and keeps the process for the other threads", async () => {
      const f = await fixture({}, { FAKE_ACP_HANG_ON: "HANG", FAKE_ACP_IGNORE_CANCEL: "1", FAKE_ACP_SESSION_CLOSE_MS: "600" });
      await f.run("thread-a");
      const stopped = f.run("thread-b", { text: "HANG" });
      await promptsSent(f, 2);
      const [child] = f.spawned;
      const start = Date.now();
      await f.instance.adapter.interruptTurn("thread-b");
      expect((await stopped).done).toMatchObject({ ok: true, stopReason: "cancelled" });
      expect(Date.now() - start).toBeGreaterThanOrEqual(5_500);
      expect(child!.exitCode).toBeNull();
      expect((await f.run("thread-a")).done).toMatchObject({ ok: true });
      expect(f.spawned).toHaveLength(1);
    });
  });

  it("asks for admission before it starts a process or adds a session, never for a thread already running", async () => {
    const f = await fixture();
    const asked: Array<[string, number | undefined]> = [];
    const engineAdmission = async (start: "process" | "session", joining?: number) => { asked.push([start, joining]); };
    await f.run("thread-a", { engineAdmission });
    await f.run("thread-b", { engineAdmission });
    await f.run("thread-a", { engineAdmission });
    expect(asked).toEqual([["process", undefined], ["session", f.spawned[0]!.pid]]);
    const refused = f.instance.adapter.sendTurn({ threadId: "thread-c", text: "x", cwd: tmpdir(), approvalMode: "full",
      engineAdmission: async () => { throw new TurnNotStartedError("t", "stopped while waiting for memory"); } });
    await expect(refused).rejects.toBeInstanceOf(TurnNotStartedError);
    expect(f.spawned).toHaveLength(1);
  });
});
