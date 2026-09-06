// The bridge's dead-transport watchdog, pinned at the unit level: the 45s
// e2e wait is too slow for the suite, and the property that matters is not
// the constant but the decision table — silence alone never kills, only
// silence PLUS a failed liveness probe does, and traffic always vetoes.
import { describe, expect, it, vi } from "vitest";

import {
  createGateInterceptor,
  createInactivityWatchdog,
  createLineSplitter,
  createMcpBridgeInterceptor,
  runLivenessProbe,
} from "./mcp-bridge.ts";

/** a probe whose answers the test scripts one call at a time */
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

      // first silence window: the probe answers alive → no kill, re-armed
      await vi.advanceTimersByTimeAsync(1_000);
      expect(scripted.calls).toHaveLength(1);
      expect(onDead).not.toHaveBeenCalled();

      // second silence window: the probe fails → dead, exactly once
      await vi.advanceTimersByTimeAsync(1_000);
      expect(scripted.calls).toHaveLength(2);
      expect(onDead).toHaveBeenCalledTimes(1);

      // dead is terminal: no timer survives to fire again
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

      // steady traffic keeps the probe from ever firing
      for (let i = 0; i < 5; i += 1) {
        await vi.advanceTimersByTimeAsync(900);
        watchdog.touch();
      }
      expect(probeResolvers).toHaveLength(0);

      // silence fires the probe — but a byte arriving WHILE it runs must
      // outrank even a failed answer (a slow screenshot finishing is life)
      await vi.advanceTimersByTimeAsync(1_000);
      expect(probeResolvers).toHaveLength(1);
      watchdog.touch();
      probeResolvers[0]!(false); // SAFETY: length asserted above
      await vi.advanceTimersByTimeAsync(0);
      expect(onDead).not.toHaveBeenCalled();

      // the veto re-armed the window; a stopped watchdog stays quiet
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

  function harness(isHeld: () => Promise<boolean>) {
    const forwarded: string[] = [];
    const refused: string[] = [];
    const intercept = createGateInterceptor({
      isHeld,
      forward: (line) => forwarded.push(line),
      refuse: (line) => refused.push(line),
    });
    return { forwarded, refused, intercept };
  }

  it("forwards everything untouched while nobody is driving", async () => {
    const { forwarded, refused, intercept } = harness(async () => false);
    for (const line of [frame("initialize", 1), frame("tools/list", 2), frame("tools/call", 3), "not json at all"]) {
      intercept(line);
    }
    await drain();
    expect(refused).toEqual([]);
    expect(forwarded).toHaveLength(4);
    // byte-for-byte: the transparent path must not re-serialize a frame
    expect(forwarded[3]).toBe("not json at all");
  });

  it("refuses only tools/call while the person is driving", async () => {
    const { forwarded, refused, intercept } = harness(async () => true);
    intercept(frame("tools/list", 1));
    intercept(frame("tools/call", 2));
    await drain();
    expect(forwarded).toEqual([frame("tools/list", 1)]);
    expect(refused).toHaveLength(1);
    const answer = JSON.parse(refused[0]!);
    expect(answer.id).toBe(2);
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0].text).toMatch(/taken control/i);
  });

  it("preserves protocol order even though the held-check is async", async () => {
    const order: string[] = [];
    let calls = 0;
    let releaseFirst!: (held: boolean) => void;
    const first = new Promise<boolean>((resolve) => (releaseFirst = resolve));
    let drained!: () => void;
    const allForwarded = new Promise<void>((resolve) => (drained = resolve));
    const intercept = createGateInterceptor({
      isHeld: () => (calls++ === 0 ? first : Promise.resolve(false)),
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
    releaseFirst(false);
    await allForwarded;
    expect(order).toEqual(["fwd:1", "fwd:2", "fwd:drained"]);
  });

  it("fails open: a broken held-check forwards rather than wedging the computer", async () => {
    const { forwarded, refused, intercept } = harness(async () => {
      throw new Error("harness went away");
    });
    intercept(frame("tools/call", 1));
    await drain();
    expect(refused).toEqual([]);
    expect(forwarded).toHaveLength(1);
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
      forward: (line) => forwarded.push(line),
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
      forward: (line) => forwarded.push(line),
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
      forward: (line) => forwarded.push(line),
    });
    for (const line of [frame("initialize", 1), frame("tools/list", 2), "not json"]) {
      intercept(line);
    }
    expect(answered).toEqual([]);
    expect(forwarded).toEqual([frame("initialize", 1), frame("tools/list", 2), "not json"]);
  });

  it("answers ping even when a gate would refuse tools/call", async () => {
    const forwarded: string[] = [];
    const answered: string[] = [];
    const intercept = createMcpBridgeInterceptor({
      answer: (line) => answered.push(line),
      forward: (line) => forwarded.push(line),
      gate: { isHeld: async () => true },
    });
    intercept(frame("ping", 1));
    intercept(frame("tools/call", 2));
    await drain();
    expect(forwarded).toEqual([]);
    expect(answered).toHaveLength(2);
    expect(JSON.parse(answered[0]!)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(JSON.parse(answered[1]!).result.isError).toBe(true);
    expect(JSON.parse(answered[1]!).result.content[0].text).toMatch(/taken control/i);
  });

  it("forwards other frames through the gate", async () => {
    const forwarded: string[] = [];
    const answered: string[] = [];
    const intercept = createMcpBridgeInterceptor({
      answer: (line) => answered.push(line),
      forward: (line) => forwarded.push(line),
      gate: { isHeld: async () => true },
    });
    intercept(frame("tools/list", 1));
    await drain();
    expect(answered).toEqual([]);
    expect(forwarded).toEqual([frame("tools/list", 1)]);
  });
});
