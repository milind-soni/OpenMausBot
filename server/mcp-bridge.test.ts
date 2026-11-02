// Unit level: the 45 s e2e wait is too slow for the suite, and what matters is the decision table, not the constant.
import { describe, expect, it, vi } from "vitest";

import { CONTROL_REFUSAL_PLAIN, CONTROL_UNCONFIRMED, CONTROL_WAITED, type ControlState } from "./control-client.ts";
import {
  createChildCalls,
  createGateInterceptor,
  createInactivityWatchdog,
  createLineSplitter,
  createMcpBridgeInterceptor,
  createReplyQueue,
  runLivenessProbe,
} from "./mcp-bridge.ts";

function scriptedProbe(answers: boolean[]) {
  const calls: Array<(alive: boolean) => void> = [];
  let handed = 0;
  return {
    calls,
    probe: () =>
      new Promise<boolean>((resolve) => {
        calls.push(resolve);
        const next = answers[handed];
        handed += 1;
        if (next !== undefined) resolve(next);
      }),
  };
}

describe("createInactivityWatchdog", () => {
  it("kills only after silence AND a failed probe, then never re-arms", async () => {
    vi.useFakeTimers();
    try {
      const onDead = vi.fn();
      const scripted = scriptedProbe([true, false]);
      createInactivityWatchdog({ inactivityMs: 1_000, probe: scripted.probe, onDead });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(scripted.calls).toHaveLength(1);
      expect(onDead).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(scripted.calls).toHaveLength(2);
      expect(onDead).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(onDead).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats traffic as proof of life, resetting the window and vetoing an in-flight probe", async () => {
    vi.useFakeTimers();
    try {
      const onDead = vi.fn();
      let probeResolvers: Array<(alive: boolean) => void> = [];
      const watchdog = createInactivityWatchdog({
        inactivityMs: 1_000,
        probe: () => new Promise<boolean>((resolve) => probeResolvers.push(resolve)),
        onDead,
      });

      for (let i = 0; i < 5; i += 1) {
        await vi.advanceTimersByTimeAsync(900);
        watchdog.touch();
      }
      expect(probeResolvers).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(probeResolvers).toHaveLength(1);
      watchdog.touch();
      probeResolvers[0]!(false); // SAFETY: length asserted above
      await vi.advanceTimersByTimeAsync(0);
      expect(onDead).not.toHaveBeenCalled();

      watchdog.stop();
      probeResolvers = [];
      await vi.advanceTimersByTimeAsync(10_000);
      expect(probeResolvers).toHaveLength(0);
      expect(onDead).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a rejected probe as not alive", async () => {
    vi.useFakeTimers();
    try {
      const onDead = vi.fn();
      createInactivityWatchdog({
        inactivityMs: 1_000,
        probe: () => Promise.reject(new Error("probe spawn failed")),
        onDead,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onDead).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runLivenessProbe", () => {
  it("uses the bridge's explicit environment for its transport probe", async () => {
    await expect(runLivenessProbe({
      command: process.execPath,
      args: ["-e", "process.exit(process.env.OMB_TEST_BRIDGE_ENV === 'shared-ssh' ? 0 : 1)"],
    }, 1_000, { ...process.env, OMB_TEST_BRIDGE_ENV: "shared-ssh" })).resolves.toBe(true);
  });

  it("maps exit status to liveness and treats an unspawnable probe as dead", async () => {
    await expect(
      runLivenessProbe({ command: process.execPath, args: ["-e", "process.exit(0)"] }),
    ).resolves.toBe(true);
    await expect(
      runLivenessProbe({ command: process.execPath, args: ["-e", "process.exit(3)"] }),
    ).resolves.toBe(false);
    await expect(
      runLivenessProbe({ command: "/nonexistent/openmausbot-probe", args: [] }),
    ).resolves.toBe(false);
  });

  it("times out a probe that hangs instead of inheriting the hang", async () => {
    await expect(
      runLivenessProbe({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, 300),
    ).resolves.toBe(false);
  });
});

describe("createLineSplitter", () => {
  it("reassembles lines across arbitrary chunk boundaries", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push('{"a"');
    splitter.push(':1}\n{"b":2}\n{"c"');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    splitter.flush();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c"']);
  });

  it("does not corrupt a UTF-8 character split between buffers", () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    const bytes = Buffer.from('{"text":"mouse 🐭"}\n');
    const splitAt = bytes.indexOf(Buffer.from("🐭")) + 2;
    splitter.push(bytes.subarray(0, splitAt));
    splitter.push(bytes.subarray(splitAt));
    splitter.flush();
    expect(lines).toEqual(['{"text":"mouse 🐭"}']);
  });
});

describe("createGateInterceptor", () => {
  const frame = (method: string, id?: number) => JSON.stringify({ jsonrpc: "2.0", id, method, params: {} });
  const drain = () => new Promise((resolve) => setTimeout(resolve, 0));
  const free: ControlState = { held: false, helpOpen: false };
  const person: ControlState = { held: true, helpOpen: false, reason: "person" };

  function harness(check: (frame?: unknown) => Promise<ControlState>) {
    const forwarded: string[] = [];
    const refused: string[] = [];
    const intercept = createGateInterceptor({
      check,
      forward: (line) => { forwarded.push(line); },
      refuse: (line) => refused.push(line),
    });
    return { forwarded, refused, intercept };
  }
  const refusalText = (line: string) => JSON.parse(line).result.content[0].text as string;

  it("forwards everything untouched while nobody is driving", async () => {
    const { forwarded, refused, intercept } = harness(async () => free);
    for (const line of [frame("initialize", 1), frame("tools/list", 2), frame("tools/call", 3), "not json at all"]) {
      intercept(line);
    }
    await drain();
    expect(refused).toEqual([]);
    expect(forwarded).toHaveLength(4);
    expect(forwarded[3]).toBe("not json at all");
  });

  it("hands the gate the tools/call frame it is checking, so a first ask can name what the call opens", async () => {
    const seen: unknown[] = [];
    const { forwarded, intercept } = harness(async (...args: unknown[]) => { seen.push(args[0]); return free; });
    const call = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "launch_app", arguments: { bundle_id: "com.google.Chrome" } } });
    intercept(call);
    await drain();
    expect(forwarded).toEqual([call]);
    expect(seen).toEqual([JSON.parse(call)]);
  });

  it("refuses only tools/call while the person is driving", async () => {
    const { forwarded, refused, intercept } = harness(async () => person);
    intercept(frame("tools/list", 1));
    intercept(frame("tools/call", 2));
    await drain();
    expect(forwarded).toEqual([frame("tools/list", 1)]);
    expect(refused).toHaveLength(1);
    const answer = JSON.parse(refused[0]!);
    expect(answer.id).toBe(2);
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0].text).toBe(CONTROL_REFUSAL_PLAIN);
  });

  it("preserves protocol order even though the check is async", async () => {
    const order: string[] = [];
    let calls = 0;
    let releaseFirst!: (state: ControlState) => void;
    const first = new Promise<ControlState>((resolve) => (releaseFirst = resolve));
    let drained!: () => void;
    const allForwarded = new Promise<void>((resolve) => (drained = resolve));
    const intercept = createGateInterceptor({
      check: () => (calls++ === 0 ? first : Promise.resolve(free)),
      forward: (line) => {
        const parsed = JSON.parse(line);
        order.push(`fwd:${parsed.id ?? parsed.marker}`);
        if (parsed.marker === "drained") drained();
      },
      refuse: (line) => order.push(`ref:${JSON.parse(line).id}`),
    });
    intercept(frame("tools/call", 1));
    intercept(frame("tools/call", 2));
    intercept(JSON.stringify({ marker: "drained" }));
    expect(order).toEqual([]);
    releaseFirst(free);
    await allForwarded;
    expect(order).toEqual(["fwd:1", "fwd:2", "fwd:drained"]);
  });

  it("fails closed when the control check rejects, without blaming a person", async () => {
    const { forwarded, refused, intercept } = harness(async () => {
      throw new Error("harness went away");
    });
    intercept(frame("tools/call", 1));
    await drain();
    expect(refused).toHaveLength(1);
    expect(JSON.parse(refused[0]!).result.isError).toBe(true);
    expect(refusalText(refused[0]!)).toBe(CONTROL_UNCONFIRMED);
    expect(forwarded).toEqual([]);
  });

  it("words each hold by what the harness said: its reason, a person, or nothing it could confirm", async () => {
    const refused: string[] = [];
    let state: ControlState = { held: true, helpOpen: false, blockedReason: "Another thread is using this computer." };
    const check = vi.fn(async () => state);
    const intercept = createGateInterceptor({ check, forward: () => {}, refuse: (line) => refused.push(line) });
    await intercept(frame("tools/list", 1));
    expect(check).not.toHaveBeenCalled();
    await intercept(frame("tools/call", 2));
    expect(refusalText(refused[0]!)).toBe("Another thread is using this computer.");
    state = person;
    await intercept(frame("tools/call", 3));
    expect(refusalText(refused[1]!)).toBe(CONTROL_REFUSAL_PLAIN);
    state = { held: true, helpOpen: false };
    await intercept(frame("tools/call", 4));
    expect(refusalText(refused[2]!)).toBe(CONTROL_UNCONFIRMED);
  });

  // Codex gives one tool call 60 s, so a call forwarded after a long wait could act twice on the model's retry.
  it("never forwards a call answered free late, whether the harness held its check or it queued behind another", async () => {
    vi.useFakeTimers();
    try {
      const checks: Array<(state: ControlState) => void> = [];
      const forwarded: string[] = [];
      const refused: string[] = [];
      const intercept = createGateInterceptor({
        check: () => new Promise<ControlState>((resolve) => checks.push(resolve)),
        forward: (line) => { forwarded.push(line); },
        refuse: (line) => refused.push(line),
        actWithinMs: 1_000,
      });
      const quick = intercept(frame("tools/call", 1));
      await vi.advanceTimersByTimeAsync(900);
      checks.shift()!(free);
      await quick;
      expect(forwarded).toEqual([frame("tools/call", 1)]);

      const held = intercept(frame("tools/call", 2));
      const queued = intercept(frame("tools/call", 3));
      await vi.advanceTimersByTimeAsync(1_500);
      checks.shift()!(free);
      await vi.advanceTimersByTimeAsync(0);
      expect(checks).toHaveLength(1);
      checks.shift()!(free);
      await Promise.all([held, queued]);
      expect(forwarded).toEqual([frame("tools/call", 1)]);
      expect(refused.map((line) => [JSON.parse(line).id, refusalText(line)])).toEqual([[2, CONTROL_WAITED], [3, CONTROL_WAITED]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks the next call only once a relayed one has acted, so the agent's calls act in order", async () => {
    const order: string[] = [];
    let finishRelay!: () => void;
    const relayed = new Promise<void>((resolve) => (finishRelay = resolve));
    const intercept = createGateInterceptor({
      check: async (checked: any) => { order.push(`check:${checked.id}`); return free; },
      forward: (line) => {
        const id = JSON.parse(line).id;
        order.push(`fwd:${id}`);
        return id === 1 ? relayed.then(() => { order.push("relayed:1"); }) : undefined;
      },
      refuse: (line) => order.push(`ref:${JSON.parse(line).id}`),
    });
    const first = intercept(frame("tools/call", 1));
    const second = intercept(frame("tools/call", 2));
    await drain();
    expect(order).toEqual(["check:1", "fwd:1"]);
    finishRelay();
    await Promise.all([first, second]);
    expect(order).toEqual(["check:1", "fwd:1", "relayed:1", "check:2", "fwd:2"]);
  });
});

describe("createChildCalls", () => {
  it("calls the child under ids of its own with the agent's metadata, and keeps those answers from the agent", async () => {
    const written: any[] = [];
    const children = createChildCalls((line) => written.push(JSON.parse(line)));
    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
    const typed = children.forCall(meta).call("type_text", { text: "a" });
    const plain = children.forCall(undefined).call("list_windows", {});
    expect(written).toEqual([
      { jsonrpc: "2.0", id: "omb-bridge-1", method: "tools/call", params: { name: "type_text", arguments: { text: "a" }, _meta: meta } },
      { jsonrpc: "2.0", id: "omb-bridge-2", method: "tools/call", params: { name: "list_windows", arguments: {} } },
    ]);
    expect(children.take(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }))).toBe(false);
    expect(children.take(JSON.stringify({ jsonrpc: "2.0", id: "omb-bridge-1", result: { content: [{ type: "text", text: "typed" }] } }))).toBe(true);
    expect(children.take(JSON.stringify({ jsonrpc: "2.0", id: "omb-bridge-2", error: { code: -32602, message: "Missing required per-request MCP metadata" } }))).toBe(true);
    await expect(typed).resolves.toEqual({ content: [{ type: "text", text: "typed" }] });
    await expect(plain).resolves.toEqual({ content: [{ type: "text", text: "Missing required per-request MCP metadata" }], isError: true });
    expect(children.take(JSON.stringify({ jsonrpc: "2.0", id: "omb-bridge-1", result: {} }))).toBe(false);
  });

  it("learns the driver's version from its initialize answer or its per-request metadata", () => {
    const legacy = createChildCalls(() => {});
    expect(legacy.forCall(undefined).driverVersion).toBeUndefined();
    expect(legacy.take(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { serverInfo: { name: "cua-driver", version: "0.28.2" } } }))).toBe(false);
    expect(legacy.forCall(undefined).driverVersion).toBe("0.28.2");
    const modern = createChildCalls(() => {});
    modern.take(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { tools: [], _meta: { "io.modelcontextprotocol/serverInfo": { name: "cua-driver", version: "0.38.0" } } } }));
    expect(modern.forCall(undefined).driverVersion).toBe("0.38.0");
  });

  it("ends every waiting call, and any later one, when the child is gone", async () => {
    const children = createChildCalls(() => {});
    const waiting = children.forCall(undefined).call("type_text", { text: "a" });
    children.close();
    const closed = { content: [{ type: "text", text: "Computer-control transport closed" }], isError: true };
    await expect(waiting).resolves.toEqual(closed);
    await expect(children.forCall(undefined).call("type_text", { text: "b" })).resolves.toEqual(closed);
  });
});

describe("createMcpBridgeInterceptor", () => {
  const frame = (method: string, id?: number) => JSON.stringify({ jsonrpc: "2.0", id, method, params: {} });
  const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("answers ping locally and does not forward it", () => {
    const forwarded: string[] = [];
    const answered: string[] = [];
    const intercept = createMcpBridgeInterceptor({
      answer: (line) => answered.push(line),
      forward: (line) => { forwarded.push(line); },
    });
    intercept(frame("ping", 1));
    expect(answered).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}']);
    expect(forwarded).toEqual([]);
  });

  it("treats a ping notification as a silent swallow", () => {
    const forwarded: string[] = [];
    const answered: string[] = [];
    const intercept = createMcpBridgeInterceptor({
      answer: (line) => answered.push(line),
      forward: (line) => { forwarded.push(line); },
    });
    intercept(JSON.stringify({ jsonrpc: "2.0", method: "ping", params: {} }));
    expect(answered).toEqual([]);
    expect(forwarded).toEqual([]);
  });

  it("forwards non-ping frames untouched", () => {
    const forwarded: string[] = [];
    const answered: string[] = [];
    const intercept = createMcpBridgeInterceptor({
      answer: (line) => answered.push(line),
      forward: (line) => { forwarded.push(line); },
    });
    for (const line of [frame("initialize", 1), frame("tools/list", 2), "not json"]) {
      expect(intercept(line)).toBeUndefined();
    }
    expect(answered).toEqual([]);
    expect(forwarded).toEqual([frame("initialize", 1), frame("tools/list", 2), "not json"]);
  });

  it("answers ping even when a gate would refuse tools/call", async () => {
    const forwarded: string[] = [];
    const answered: string[] = [];
    const intercept = createMcpBridgeInterceptor({
      answer: (line) => answered.push(line),
      forward: (line) => { forwarded.push(line); },
      gate: { check: async () => ({ held: true, helpOpen: false, reason: "person" }) },
    });
    intercept(frame("ping", 1));
    intercept(frame("tools/call", 2));
    await drain();
    expect(forwarded).toEqual([]);
    expect(answered).toHaveLength(2);
    expect(JSON.parse(answered[0]!)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(JSON.parse(answered[1]!).result.isError).toBe(true);
    expect(JSON.parse(answered[1]!).result.content[0].text).toBe(CONTROL_REFUSAL_PLAIN);
  });

  it("forwards other frames through the gate", async () => {
    const forwarded: string[] = [];
    const answered: string[] = [];
    const intercept = createMcpBridgeInterceptor({
      answer: (line) => answered.push(line),
      forward: (line) => { forwarded.push(line); },
      gate: { check: async () => ({ held: true, helpOpen: false, reason: "person" }) },
    });
    intercept(frame("tools/list", 1));
    await drain();
    expect(answered).toEqual([]);
    expect(forwarded).toEqual([frame("tools/list", 1)]);
  });
});

describe("createReplyQueue", () => {
  it("writes synchronously without a tap", () => {
    const written: string[] = [];
    createReplyQueue(null, (line) => written.push(line))("raw", "out");
    expect(written).toEqual(["out"]);
  });

  it("keeps replies in order and still writes them when the tap rejects or throws", async () => {
    const written: string[] = [];
    const seen: string[] = [];
    const tap = {
      response: (raw: string): Promise<void> => {
        seen.push(raw);
        if (raw === "a") return Promise.reject(new Error("tap failed"));
        if (raw === "b") throw new Error("tap threw");
        return new Promise((resolve) => setTimeout(resolve, 10));
      },
    };
    const reply = createReplyQueue(tap, (line) => written.push(line));
    reply("a", "A");
    reply("b", "B");
    reply("c", "C");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).toEqual(["a", "b", "c"]);
    expect(written).toEqual(["A", "B", "C"]);
  });
});
