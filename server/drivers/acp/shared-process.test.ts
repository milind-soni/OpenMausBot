import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  it.each([
    ["owns its process", false, ""],
    ["shares a process without session/close", true, ""],
    ["shares a process that rejects session/close", true, "error"],
  ])("ends execution before reporting a prompt timeout when the session %s", async (_, shareProcess, close) => {
    const previous = process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS;
    process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS = "100";
    try {
      const f = await fixture({ shareProcess }, { FAKE_ACP_HANG_ON: "HANG", FAKE_ACP_SESSION_CLOSE: close });
      if (shareProcess) await f.run("thread-b");
      let endedAtCompletion = false;
      f.instance.adapter.onEvent((event) => {
        if (event.type === "turn.completed" && event.threadId === "thread-a") {
          const [child] = f.spawned;
          endedAtCompletion = child!.exitCode !== null || child!.signalCode !== null;
        }
      });
      expect((await f.run("thread-a", { text: "HANG" })).done).toMatchObject({ ok: false, stopReason: "rpc_error" });
      expect(endedAtCompletion).toBe(true);
      expect((await f.run("thread-a")).done).toMatchObject({ ok: true });
      expect(f.spawned).toHaveLength(2);
    } finally {
      if (previous === undefined) delete process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS;
      else process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS = previous;
    }
  });

  it("holds a timed-out turn until session/close is confirmed without ending the other sessions", async () => {
    const previous = process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS;
    process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS = "100";
    try {
      const gateDir = mkdtempSync(join(tmpdir(), "omb-acp-close-"));
      scratches.push(gateDir);
      const gate = join(gateDir, "release");
      const f = await fixture({}, { FAKE_ACP_HANG_ON: "HANG", FAKE_ACP_SESSION_CLOSE_GATE: gate });
      await f.run("thread-b");
      const running = f.run("thread-a", { text: "HANG" });
      await vi.waitFor(() => expect(f.methods()).toContain("session/close"));
      expect(f.recorder.events.some((event) => event.type === "turn.completed" && event.threadId === "thread-a")).toBe(false);
      expect(f.instance.adapter.hasSession("thread-a")).toBe(true);
      writeFileSync(gate, "close");
      expect((await running).done).toMatchObject({ ok: false, stopReason: "rpc_error" });
      expect(f.spawned[0]!.exitCode).toBeNull();
      expect(f.spawned[0]!.signalCode).toBeNull();
      expect((await f.run("thread-b")).done).toMatchObject({ ok: true });
    } finally {
      if (previous === undefined) delete process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS;
      else process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS = previous;
    }
  });

  it.each(["dispose", "stopAll"] as const)("keeps turns active until %s has ended their shared process", async (action) => {
    const f = await fixture({}, { FAKE_ACP_HANG_ON: "HANG" });
    const running = f.run("thread-a", { text: "HANG" });
    await vi.waitFor(() => expect(f.methods()).toContain("session/prompt"));
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const killing = new Promise<void>((resolve) => { entered = resolve; });
    const kill = procs.killCliTree;
    vi.spyOn(procs, "killCliTree").mockImplementation(async (child) => {
      entered();
      await gate;
      return kill(child, 0);
    });
    const closing = action === "dispose" ? f.instance.dispose() : f.instance.adapter.stopAll();
    try {
      await killing;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.recorder.events.some((event) => event.type === "turn.completed")).toBe(false);
      expect(f.instance.adapter.hasSession("thread-a")).toBe(true);
    } finally {
      release();
      await closing;
      await running;
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
      let endedAtCompletion = false;
      f.instance.adapter.onEvent((event) => {
        if (event.type !== "turn.completed" || event.threadId !== "thread-a" || next) return;
        endedAtCompletion = child!.exitCode !== null || child!.signalCode !== null;
        next = f.instance.adapter.sendTurn({ threadId: "thread-a", text: "fixture", cwd: join(f.scratch, "thread-a"), approvalMode: "full" });
      });
      await f.instance.adapter.interruptTurn("thread-b");
      expect((await stopped).done).toMatchObject({ ok: true, stopReason: "cancelled" });
      expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
      expect((await other).done).toMatchObject({ ok: false });
      expect(endedAtCompletion).toBe(true);
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

    it("ends its own process before Stop settles in a driver that does not share", async () => {
      const f = await fixture({ shareProcess: false }, { FAKE_ACP_HANG_ON: "HANG", FAKE_ACP_IGNORE_CANCEL: "1" });
      const stopped = f.run("thread-a", { text: "HANG" });
      await promptsSent(f, 1);
      const [child] = f.spawned;
      await f.instance.adapter.interruptTurn("thread-a");
      expect((await stopped).done).toMatchObject({ ok: true, stopReason: "cancelled" });
      expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    });

    it("keeps the turn active after a failed kill until the process exits", async () => {
      const f = await fixture({ shareProcess: false }, { FAKE_ACP_HANG_ON: "HANG", FAKE_ACP_IGNORE_CANCEL: "1" });
      const stopped = f.run("thread-a", { text: "HANG" });
      await promptsSent(f, 1);
      const [child] = f.spawned;
      const kill = procs.killCliTree;
      let refused = false;
      vi.spyOn(procs, "killCliTree").mockImplementation(async (target, timeout) => {
        if (target !== child || refused) return kill(target, timeout);
        refused = true;
        return false;
      });
      await f.instance.adapter.interruptTurn("thread-a");
      await f.recorder.until((event) => event.type === "runtime.error" && /could not be ended/.test(event.message));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.instance.adapter.hasSession("thread-a")).toBe(true);
      expect(f.recorder.events.some((event) => event.type === "turn.completed")).toBe(false);
      await kill(child!, 0);
      expect((await stopped).done).toMatchObject({ ok: false });
    });
  });

  it.skipIf(process.platform === "win32").each([
    { label: "same group", detached: false, exitOnPrompt: false },
    ...(process.platform === "linux" ? [{ label: "detached Linux helper", detached: true, exitOnPrompt: false }] : []),
    { label: "root exit with inherited pipe", detached: false, exitOnPrompt: true },
  ])(
    "confirms descendants before timeout and collateral host-exit completions ($label)", async ({ detached, exitOnPrompt }) => {
      const root = mkdtempSync(join(tmpdir(), "omb-acp-tree-"));
      scratches.push(root);
      const previous = process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS;
      let descendant: number | undefined;
      const running = () => {
        if (!descendant) return false;
        if (process.platform === "linux") {
          try {
            const stat = readFileSync(`/proc/${descendant}/stat`, "utf8");
            return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
          } catch { return false; }
        }
        try { process.kill(descendant, 0); return true; } catch { return false; }
      };
      try {
        process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS = "100";
        const cli = join(dirname(FAKE_CLI), "fake-acp-tree-cli.mjs");
        const f = await fixture({ resolveCommand: async () => ({ command: process.execPath, args: [cli] }) }, {
          FAKE_ACP_TREE: root, FAKE_ACP_TREE_DETACHED: detached ? "1" : "0", FAKE_ACP_TREE_EXIT_PROMPT: exitOnPrompt ? "1" : "0",
        });
        const other = f.run("thread-b");
        await vi.waitFor(() => expect(existsSync(join(root, "prompt-s1"))).toBe(true));
        descendant = Number(readFileSync(join(root, "descendant"), "utf8"));
        expect(running()).toBe(true);
        const aliveAtCompletion: boolean[] = [];
        f.instance.adapter.onEvent((event) => {
          if (event.type !== "turn.completed") return;
          aliveAtCompletion.push(running());
          writeFileSync(join(root, "release"), "1");
        });
        const result = await f.run("thread-a");
        expect(f.spawned).toHaveLength(1);
        expect(aliveAtCompletion.length).toBeGreaterThan(0);
        expect(aliveAtCompletion.every((alive) => !alive)).toBe(true);
        await other;
        expect(result.done).toMatchObject({ ok: false, stopReason: "rpc_error" });
        expect(aliveAtCompletion).toEqual([false, false]);
        expect(existsSync(join(root, "effect"))).toBe(false);
      } finally {
        if (descendant && running()) process.kill(descendant, "SIGKILL");
        if (previous === undefined) delete process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS;
        else process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS = previous;
      }
    }, 20_000,
  );

  it.each(["dispose", "stopAll"] as const)("falls back from unanswered shared session/close before the %s teardown bound", async (action) => {
    const gateDir = mkdtempSync(join(tmpdir(), "omb-acp-teardown-close-"));
    scratches.push(gateDir);
    const f = await fixture({}, { FAKE_ACP_HANG_ON: "HANG", FAKE_ACP_SESSION_CLOSE_GATE: join(gateDir, "release") });
    await f.run("thread-idle");
    const running = f.run("thread-active", { text: "HANG" });
    await vi.waitFor(() => expect(f.methods().filter(method => method === "session/prompt")).toHaveLength(2));
    const child = f.spawned[0]!;
    const kill = procs.killCliTree;
    let fallbackAllowed = false;
    const killing = vi.spyOn(procs, "killCliTree").mockImplementation(target => fallbackAllowed ? kill(target, 0) : Promise.resolve(false));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const closing = (action === "dispose" ? f.instance.dispose() : f.instance.adapter.stopAll()).catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.instance.adapter.hasSession("thread-active")).toBe(true);
      fallbackAllowed = true;
      await vi.advanceTimersByTimeAsync(1_000);
      vi.useRealTimers();
      await vi.waitFor(() => expect(f.instance.adapter.hasSession("thread-active")).toBe(false));
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect((await running).done).toMatchObject({ ok: false, stopReason: "stop_failed" });
      expect(await closing).toBeUndefined();
    } finally {
      vi.useRealTimers();
      killing.mockRestore();
      await kill(child, 0);
      await closing;
      await running;
    }
  });

  it("accepts a pending prompt-stall close confirmation after Stop enters failed termination fallback", async () => {
    const previous = process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS;
    process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS = "100000";
    const gateDir = mkdtempSync(join(tmpdir(), "omb-acp-late-close-"));
    scratches.push(gateDir);
    const gate = join(gateDir, "release");
    const f = await fixture({}, { FAKE_ACP_HANG_ON: "HANG", FAKE_ACP_IGNORE_CANCEL: "1", FAKE_ACP_SESSION_CLOSE_GATE: gate });
    const kill = procs.killCliTree;
    const killing = vi.spyOn(procs, "killCliTree").mockResolvedValue(false);
    try {
      await f.run("thread-idle");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await f.instance.adapter.sendTurn({ threadId: "thread-active", text: "HANG", cwd: f.scratch, approvalMode: "full" });
      await vi.waitFor(() => expect(f.methods().filter(method => method === "session/prompt")).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(100_001);
      await vi.waitFor(() => expect(f.methods().filter(method => method === "session/close")).toHaveLength(1));
      await f.instance.adapter.interruptTurn("thread-active");
      await vi.advanceTimersByTimeAsync(10_001);
      expect(killing).toHaveBeenCalled();
      expect(f.instance.adapter.hasSession("thread-active")).toBe(true);
      const attempts = killing.mock.calls.length;
      writeFileSync(gate, "1");
      await vi.waitFor(() => expect(f.instance.adapter.hasSession("thread-active")).toBe(false));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(killing).toHaveBeenCalledTimes(attempts);
      expect(f.spawned[0]!.exitCode === null && f.spawned[0]!.signalCode === null).toBe(true);
      expect(f.methods().filter(method => method === "session/close")).toHaveLength(1);
      expect(f.recorder.events.filter(event => event.type === "turn.completed" && event.threadId === "thread-active")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      killing.mockRestore();
      await Promise.all(f.spawned.map(child => kill(child, 0)));
      if (previous === undefined) delete process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS;
      else process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS = previous;
    }
  });

  it("bounds Stop while a prompt-stall session/close is already pending", async () => {
    const previous = process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS;
    process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS = "100000";
    const gateDir = mkdtempSync(join(tmpdir(), "omb-acp-pending-close-"));
    scratches.push(gateDir);
    const f = await fixture({}, { FAKE_ACP_HANG_ON: "HANG", FAKE_ACP_SESSION_CLOSE_GATE: join(gateDir, "release") });
    const kill = procs.killCliTree;
    let running: Promise<{ turnId: string }> | undefined;
    try {
      await f.run("thread-idle");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      running = f.instance.adapter.sendTurn({ threadId: "thread-active", text: "HANG", cwd: f.scratch, approvalMode: "full" });
      await vi.waitFor(() => expect(f.methods().filter(method => method === "session/prompt")).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(100_001);
      await vi.waitFor(() => expect(f.methods().filter(method => method === "session/close")).toHaveLength(1));
      expect(f.instance.adapter.hasSession("thread-active")).toBe(true);
      expect(f.recorder.events.filter(event => event.type === "turn.completed" && event.threadId === "thread-active")).toHaveLength(0);
      await f.instance.adapter.interruptTurn("thread-active");
      await vi.advanceTimersByTimeAsync(10_001);
      vi.useRealTimers();
      await vi.waitFor(() => expect(f.instance.adapter.hasSession("thread-active")).toBe(false));
      const child = f.spawned[0]!;
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(f.recorder.events.find(event => event.type === "turn.completed" && event.threadId === "thread-active")).toMatchObject({ ok: true, stopReason: "cancelled" });
      expect(f.methods().filter(method => method === "session/close")).toHaveLength(1);
      expect(f.recorder.events.filter(event => event.type === "turn.completed" && event.threadId === "thread-active")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await Promise.all(f.spawned.map(child => kill(child, 0)));
      await running;
      if (previous === undefined) delete process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS;
      else process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS = previous;
    }
  });

  it.each(["dispose", "stopAll"] as const)("bounds %s while a prompt-stall session/close is already pending and retries a failed kill", async (action) => {
    const previous = process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS;
    process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS = "100000";
    const gateDir = mkdtempSync(join(tmpdir(), "omb-acp-pending-close-"));
    scratches.push(gateDir);
    const f = await fixture({}, { FAKE_ACP_HANG_ON: "HANG", FAKE_ACP_SESSION_CLOSE_GATE: join(gateDir, "release") });
    const kill = procs.killCliTree;
    let running: Promise<{ turnId: string }> | undefined;
    let closing: Promise<unknown> | undefined;
    let fallbackAllowed = false;
    const killing = vi.spyOn(procs, "killCliTree").mockImplementation(target => fallbackAllowed ? kill(target, 0) : Promise.resolve(false));
    try {
      await f.run("thread-idle");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      running = f.instance.adapter.sendTurn({ threadId: "thread-active", text: "HANG", cwd: f.scratch, approvalMode: "full" });
      await vi.waitFor(() => expect(f.methods().filter(method => method === "session/prompt")).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(100_001);
      await vi.waitFor(() => expect(f.methods().filter(method => method === "session/close")).toHaveLength(1));
      closing = (action === "dispose" ? f.instance.dispose() : f.instance.adapter.stopAll()).catch(error => error);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.instance.adapter.hasSession("thread-active")).toBe(true);
      expect(f.recorder.events.filter(event => event.type === "turn.completed" && event.threadId === "thread-active")).toHaveLength(0);
      const child = f.spawned[0]!;
      expect(child.exitCode === null && child.signalCode === null).toBe(true);
      fallbackAllowed = true;
      await vi.advanceTimersByTimeAsync(1_000);
      vi.useRealTimers();
      await vi.waitFor(() => expect(f.instance.adapter.hasSession("thread-active")).toBe(false));
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      await closing;
      expect(f.methods().filter(method => method === "session/close")).toHaveLength(1);
      expect(f.recorder.events.filter(event => event.type === "turn.completed" && event.threadId === "thread-active")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      killing.mockRestore();
      await Promise.all(f.spawned.map(child => kill(child, 0)));
      await closing;
      await running;
      if (previous === undefined) delete process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS;
      else process.env.OPENMAUS_ACP_PROMPT_IDLE_TIMEOUT_MS = previous;
    }
  });

  it.each(["dispose", "stopAll"] as const)("bounds failed %s and retains execution for a later Stop", async (action) => {
    const f = await fixture({ shareProcess: false }, { FAKE_ACP_HANG_ON: "HANG", FAKE_ACP_IGNORE_CANCEL: "1" });
    const running = f.run("thread-a", { text: "HANG" });
    await vi.waitFor(() => expect(existsSync(join(f.scratch, "methods.json"))
      && readFileSync(join(f.scratch, "methods.json"), "utf8").includes('"session/prompt"')).toBe(true));
    const [child] = f.spawned;
    const kill = procs.killCliTree;
    const killing = vi.spyOn(procs, "killCliTree").mockResolvedValue(false);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let result: unknown;
    const closing = (action === "dispose" ? f.instance.dispose() : f.instance.adapter.stopAll()).then(
      () => { result = "resolved"; }, (error: unknown) => { result = error; },
    );
    try {
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/teardown.*could not be ended/i);
      expect(f.instance.adapter.hasSession("thread-a")).toBe(true);
      expect(f.instance.adapter.enginePid?.("thread-a")).toBe(child!.pid);
      expect(f.recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(0);
      expect(f.recorder.events.some((event) => event.type === "runtime.error" && /teardown/.test(event.message))).toBe(true);
      if (action === "stopAll") await expect(f.instance.adapter.sendTurn({ threadId: "thread-a", text: "next", cwd: f.scratch })).rejects.toThrow("already running");
    } finally {
      vi.useRealTimers();
      killing.mockRestore();
      await kill(child!, 0);
      await closing;
    }
    await f.instance.adapter.interruptTurn("thread-a");
    await running;
    expect(f.recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });

  it("keeps the registry owner after bounded disposal and reloads once after confirmed exit", async () => {
    const { ProviderRegistry } = await import("../../harness/registry.ts");
    const { reloadProviderInstances } = await import("../../harness/provider-reload.ts");
    const { EventBus } = await import("../../harness/bus.ts");
    const bus = new EventBus(async () => {});
    const delivered: RuntimeEvent[] = [];
    bus.subscribe(event => delivered.push(event));
    const f = await fixture({ shareProcess: false }, { FAKE_ACP_HANG_ON: "HANG", FAKE_ACP_IGNORE_CANCEL: "1" });
    const create = vi.fn(async () => f.instance);
    const registry = new ProviderRegistry([{ ...createAcpDriver(SUPPORT), create }]);
    const configs = { "shared-test": { driver: SUPPORT.driverKind } };
    await registry.load(configs);
    const old = registry.get("shared-test")!;
    bus.attach([old]);
    const running = f.run("thread-a", { text: "HANG" });
    await vi.waitFor(() => expect(existsSync(join(f.scratch, "methods.json"))
      && readFileSync(join(f.scratch, "methods.json"), "utf8").includes('"session/prompt"')).toBe(true));
    const child = f.spawned[0]!;
    const kill = procs.killCliTree;
    const killing = vi.spyOn(procs, "killCliTree").mockResolvedValue(false);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const reload = reloadProviderInstances(registry, bus, configs, new Set(["shared-test"]));
        await vi.advanceTimersByTimeAsync(10_001);
        const { failed } = await reload;
        const error = failed?.reason;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/teardown.*could not be ended/i);
        expect(registry.get("shared-test")).toBe(old);
        expect(create).toHaveBeenCalledTimes(1);
        expect(old.adapter.hasSession("thread-a")).toBe(true);
        expect(old.adapter.enginePid?.("thread-a")).toBe(child.pid);
        expect(child.exitCode === null && child.signalCode === null).toBe(true);
        expect(f.recorder.events.filter(event => event.type === "turn.completed")).toHaveLength(0);
        vi.useRealTimers();
      }
      killing.mockRestore();
      await kill(child, 0);
      await old.adapter.interruptTurn("thread-a");
      await running;
      expect(f.recorder.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
      expect(delivered.filter(event => event.type === "turn.completed")).toHaveLength(1);
      const fresh = await fixture({ shareProcess: false });
      create.mockResolvedValue(fresh.instance);
      await registry.load(configs);
      expect(create).toHaveBeenCalledTimes(2);
      expect(registry.get("shared-test")).toBe(fresh.instance);
      expect((await fresh.run("thread-a")).done).toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
      killing.mockRestore();
      await kill(child, 0);
      await old.adapter.interruptTurn("thread-a");
      await running;
      await registry.disposeAll();
      bus.detachAll();
      await bus.flush();
    }
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
