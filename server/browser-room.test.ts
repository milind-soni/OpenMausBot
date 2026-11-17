import { describe, expect, it, vi } from "vitest";

import { BrowserRoom, browserRoomSize, pidsLimit, SharedToolLists, spareForRoom } from "./browser-room.ts";

const files = (map: Record<string, string>) => (path: string) => map[path] ?? null;

describe("the task limit a server runs under", () => {
  it("reads a container's cgroup v2 limit, the tightest over the cgroup and its parents", () => {
    expect(pidsLimit(files({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/pids.max": "2048\n" }))).toBe(2048);
    expect(pidsLimit(files({
      "/proc/self/cgroup": "0::/system.slice/omb.service\n",
      "/sys/fs/cgroup/system.slice/omb.service/pids.max": "max\n",
      "/sys/fs/cgroup/system.slice/pids.max": "1000\n",
    }))).toBe(1000);
  });

  it("reads cgroup v1's pids controller, and has none off Linux or without a limit", () => {
    expect(pidsLimit(files({ "/proc/self/cgroup": "12:pids:/docker/abc\n4:memory:/docker/abc\n", "/sys/fs/cgroup/pids/docker/abc/pids.max": "512" }))).toBe(512);
    expect(pidsLimit(files({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/pids.max": "max" }))).toBeNull();
    expect(pidsLimit(files({}))).toBeNull();
  });

  it("on a hybrid host, reads v1's limit when the unified v2 hierarchy has none, and takes the tighter of both", () => {
    const hybrid = "12:pids:/system.slice/omb.service\n4:memory:/system.slice/omb.service\n0::/system.slice/omb.service\n";
    expect(pidsLimit(files({ "/proc/self/cgroup": hybrid, "/sys/fs/cgroup/pids/system.slice/omb.service/pids.max": "700\n" }))).toBe(700);
    expect(pidsLimit(files({
      "/proc/self/cgroup": hybrid,
      "/sys/fs/cgroup/pids/system.slice/omb.service/pids.max": "700\n",
      "/sys/fs/cgroup/unified/system.slice/pids.max": "300\n",
    }))).toBe(300);
  });
});

describe("how many browsers run at once", () => {
  const GiB = 1024 ** 3;
  it("fits the browsers' share of the container's task limit and memory", () => {
    expect(browserRoomSize({ pids: 2048, memoryBytes: 8 * GiB })).toBe(5);
    expect(browserRoomSize({ pids: 1000, memoryBytes: 8 * GiB })).toBe(2);
    expect(browserRoomSize({ pids: null, memoryBytes: 2 * GiB })).toBe(2);
    expect(browserRoomSize({ pids: null, memoryBytes: 64 * GiB })).toBe(16);
    expect(browserRoomSize({ pids: 200, memoryBytes: 512 * 1024 ** 2 })).toBe(1);
  });

  it("takes OMB_BROWSER_MAX_RUNNING over all of that", () => {
    expect(browserRoomSize({ override: "9", pids: 1000, memoryBytes: GiB })).toBe(9);
  });

  it("refuses an OMB_BROWSER_MAX_RUNNING that is not 1 or more with a log line, 0 included, and sizes by the limits", () => {
    for (const override of ["0", "zero", "-2", "1.5"]) {
      const warn = vi.fn();
      expect(browserRoomSize({ override, pids: 1000, memoryBytes: 8 * GiB }, warn)).toBe(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`OMB_BROWSER_MAX_RUNNING="${override}" is not a whole number of at least 1`));
    }
    const quiet = vi.fn();
    expect(browserRoomSize({ override: undefined, pids: 1000, memoryBytes: 8 * GiB }, quiet)).toBe(2);
    expect(browserRoomSize({ override: "", pids: 1000, memoryBytes: 8 * GiB }, quiet)).toBe(2);
    expect(quiet).not.toHaveBeenCalled();
  });
});

describe("a browser over the limit", () => {
  function room(options: { max: number; spare?: Record<string, number | null>; close?: (session: string) => Promise<boolean> }) {
    const close = vi.fn(options.close ?? (async () => true));
    const value = new BrowserRoom({ max: () => options.max, spare: (session) => options.spare?.[session] ?? null, close, waitMs: 300, pollMs: 20 });
    return { value, close };
  }

  it("starts at once while there is room, and counts each browser once", async () => {
    const { value } = room({ max: 2 });
    expect(await value.enter("a", Date.now() + 1_000)).toBeNull();
    expect(await value.enter("a", Date.now() + 1_000)).toBeNull();
    expect(await value.enter("b", Date.now() + 1_000)).toBeNull();
    expect(value.open).toBe(2);
  });

  it("closes the least recently used idle browser to make room", async () => {
    const { value, close } = room({ max: 2, spare: { a: 5_000, b: 60_000 } });
    await value.enter("a", Date.now() + 1_000);
    await value.enter("b", Date.now() + 1_000);
    expect(await value.enter("c", Date.now() + 1_000)).toBeNull();
    expect(close.mock.calls).toEqual([["b"]]);
    expect(value.open).toBe(2);
  });

  it("with none idle, waits for one to leave, else says why it cannot start", async () => {
    const { value, close } = room({ max: 1 });
    await value.enter("a", Date.now() + 1_000);
    const waiting = value.enter("b", Date.now() + 1_000);
    setTimeout(() => value.left("a"), 50);
    expect(await waiting).toBeNull();
    expect(await value.enter("c", Date.now() + 1_000)).toMatch(/^1 browser is already open on this computer, the most it runs at once/);
    expect(close).not.toHaveBeenCalled();
  });

  it("does not count a browser it could not close as gone", async () => {
    const { value, close } = room({ max: 1, spare: { a: 1_000 }, close: async () => false });
    await value.enter("a", Date.now() + 1_000);
    expect(await value.enter("b", Date.now() + 100)).toMatch(/already open/);
    expect(close).toHaveBeenCalled();
    expect(value.open).toBe(1);
  });

  it("tries the next least recently used idle browser when one will not close", async () => {
    const { value, close } = room({ max: 3, spare: { a: 60_000, b: 30_000, c: 5_000 }, close: async (session) => session === "b" });
    for (const session of ["a", "b", "c"]) await value.enter(session, Date.now() + 1_000);
    expect(await value.enter("d", Date.now() + 1_000)).toBeNull();
    expect(close.mock.calls).toEqual([["a"], ["b"]]);
    expect(value.open).toBe(3);
  });

  it("says so in the plural with more than one browser open", async () => {
    const { value } = room({ max: 2 });
    await value.enter("a", Date.now() + 1_000);
    await value.enter("b", Date.now() + 1_000);
    expect(await value.enter("c", Date.now() + 50)).toMatch(/^2 browsers are already open/);
  });

  it("counts a browser a person's view started, so a bot's new one waits for room", async () => {
    const { value } = room({ max: 1 });
    value.entered("viewed");
    expect(await value.enter("b", Date.now() + 50)).toMatch(/already open/);
    value.left("viewed");
    expect(await value.enter("b", Date.now() + 1_000)).toBeNull();
  });

  it("asks the server's room for its processes once the count allows, and closes a spare browser before refusing", async () => {
    let free = 0;
    const admit = vi.fn(async () => (free > 0 ? (free--, null) : "No room for another browser."));
    const close = vi.fn(async () => { free++; return true; });
    const value = new BrowserRoom({ max: () => 3, spare: (session) => (session === "a" ? 1_000 : null), close, admit, waitMs: 300, pollMs: 20 });
    value.entered("a");
    value.entered("b");
    // the count allows a third, the server's room does not: a spare browser closed for it lets the new one in
    expect(await value.enter("c", Date.now() + 1_000)).toBeNull();
    expect(close.mock.calls).toEqual([["a"]]);
    expect(admit.mock.calls).toEqual([["c"], ["c"]]);
    expect(value.open).toBe(2);
    // an open browser is never asked about again, and with no spare browser left the refusal is the server's
    expect(await value.enter("c", Date.now() + 1_000)).toBeNull();
    expect(await value.enter("d", Date.now() + 1_000)).toBe("No room for another browser.");
    expect(admit).toHaveBeenCalledTimes(3);
    expect(value.open).toBe(2);
  });
});

describe("which browser a bot waiting for a slot may close", () => {
  const idle = (idleMs: number, savesSignIns = true) => ({ idleMs, savesSignIns });
  it("any no turn holds, however recently used", () => {
    expect(spareForRoom(idle(1_000), { holds: false, idleMs: 180_000 })).toBe(1_000);
    expect(spareForRoom(idle(1_000, false), { holds: false, idleMs: 180_000 })).toBe(1_000);
  });

  it("one a running turn holds only after the idle time, and only when it reopens with its sign-ins", () => {
    expect(spareForRoom(idle(179_999), { holds: true, idleMs: 180_000 })).toBeNull();
    expect(spareForRoom(idle(180_000), { holds: true, idleMs: 180_000 })).toBe(180_000);
    expect(spareForRoom(idle(600_000, false), { holds: true, idleMs: 180_000 })).toBeNull();
  });

  it("none a call, a person or a view has", () => {
    expect(spareForRoom(null, { holds: false, idleMs: 180_000 })).toBeNull();
  });
});

describe("agent-browser's tool list", () => {
  it("is read once for each binary and arguments, whichever session asks", async () => {
    const lists = new SharedToolLists();
    const load = vi.fn(async () => ({ tools: [{ name: "agent_browser_open" }] }));
    const spec = { command: "/bin/agent-browser", args: ["mcp"] };
    const [one, two] = await Promise.all([lists.get(spec, load), lists.get({ ...spec }, load)]);
    expect(one).toBe(two);
    expect(await lists.get(spec, load)).toBe(one);
    expect(lists.known(spec)).toBe(one);
    expect(load).toHaveBeenCalledTimes(1);
    await lists.get({ command: "/bin/agent-browser", args: ["mcp", "--other"] }, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("is read again after a failed or empty answer", async () => {
    const lists = new SharedToolLists();
    const spec = { command: "/bin/agent-browser", args: ["mcp"] };
    await expect(lists.get(spec, async () => { throw new Error("spawn EAGAIN"); })).rejects.toThrow(/EAGAIN/);
    expect(await lists.get(spec, async () => ({ error: "no tools" }))).toEqual({ error: "no tools" });
    expect(lists.known(spec)).toBeUndefined();
    expect(await lists.get(spec, async () => ({ tools: [] }))).toEqual({ tools: [] });
    expect(lists.known(spec)).toEqual({ tools: [] });
  });
});
