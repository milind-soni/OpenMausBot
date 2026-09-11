import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn(), effects: [] as Array<() => void> }));
vi.mock("@/state/store", () => ({ api: fixture.api }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => void) => { fixture.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

import { mcpServersForBot } from "./mcp-servers";

describe("mcpServersForBot", () => {
  const all = [
    { name: "notes", enabled: true },
    { name: "linear", enabled: true },
    { name: "off", enabled: false },
  ];

  it("gives a bot without a list every enabled server", () => {
    expect(mcpServersForBot(all, undefined).map((s) => s.name)).toEqual(["notes", "linear"]);
    expect(mcpServersForBot(all, null).map((s) => s.name)).toEqual(["notes", "linear"]);
  });

  it("narrows to the bot's own names and never revives a disabled server", () => {
    expect(mcpServersForBot(all, ["linear", "off", "gone"]).map((s) => s.name)).toEqual(["linear"]);
    expect(mcpServersForBot(all, [])).toEqual([]);
  });
});

describe("shared MCP inventory", () => {
  beforeEach(() => { vi.resetModules(); fixture.api.mockReset(); fixture.effects = []; });
  const notes = { name: "notes", enabled: true };
  const changed = { name: "notes", enabled: false };

  it("renders cached inventory immediately and revalidates when Access mounts", async () => {
    fixture.api.mockResolvedValue({ servers: [changed] });
    const { updateMcpServers, useMcpServers } = await import("./mcp-servers");
    updateMcpServers([notes]);
    expect(useMcpServers().servers).toEqual([notes]);
    expect(fixture.api).not.toHaveBeenCalled();
    fixture.effects[0]();
    await vi.waitFor(() => expect(useMcpServers().servers).toEqual([changed]));
    expect(fixture.api).toHaveBeenCalledOnce();
  });

  it("does not let an older read replace a forced refresh", async () => {
    const pending: Array<(result: { servers: typeof notes[] }) => void> = [];
    fixture.api.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const { loadMcpServers, useMcpServers } = await import("./mcp-servers");
    const old = loadMcpServers();
    const fresh = loadMcpServers(true);
    expect(fixture.api).toHaveBeenCalledTimes(2);
    pending[1]({ servers: [changed] });
    await fresh;
    pending[0]({ servers: [notes] });
    await old;
    expect(useMcpServers().servers).toEqual([changed]);
  });

  it("publishes mutation results and ignores reads started before the write", async () => {
    let resolve!: (result: { servers: typeof notes[] }) => void;
    fixture.api.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const { loadMcpServers, updateMcpServers, useMcpServers } = await import("./mcp-servers");
    const old = loadMcpServers();
    updateMcpServers([changed]);
    resolve({ servers: [notes] });
    await old;
    expect(await loadMcpServers()).toEqual([changed]);
    expect(fixture.api).toHaveBeenCalledOnce();
    expect(useMcpServers().error).toBe(false);
  });

  it("settles failures as errors and allows a retry without discarding known servers", async () => {
    fixture.api.mockRejectedValueOnce(new Error("offline"));
    const { loadMcpServers, updateMcpServers, useMcpServers } = await import("./mcp-servers");
    await loadMcpServers();
    expect(useMcpServers()).toMatchObject({ servers: null, error: true });
    updateMcpServers([notes]);
    fixture.api.mockRejectedValueOnce(new Error("offline"));
    await loadMcpServers(true);
    expect(useMcpServers()).toMatchObject({ servers: [notes], error: true });
    fixture.api.mockResolvedValueOnce({ servers: [changed] });
    await loadMcpServers();
    expect(useMcpServers()).toMatchObject({ servers: [changed], error: false });
  });
});
