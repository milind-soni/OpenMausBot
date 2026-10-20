import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

import type { OneWorkspaceView } from "../../shared/one-workspace";
import { oneWorkspaceBridge, setOneWorkspaceForTests, useMergedWorkspace, useOwnHome, useTwinWork } from "./one-workspace";

const view: OneWorkspaceView = { page: "computer", twinHome: "computer", cloudName: "My Cloud",
  other: { side: "cloud", state: "ready", at: 1, bots: [{ id: "ember", threadId: "t", name: "Ember", title: "", color: "blue", avatarUrl: null, unread: false }], rooms: [], sections: [] } };
const bots = [{ id: "ember" }];
const groups: never[] = [];

afterEach(() => { setOneWorkspaceForTests(null); vi.unstubAllGlobals(); });

describe("the merged view's hooks", () => {
  it("merge nothing until this page's own store has loaded, so a bot both sides have never flashes as its other copy", () => {
    setOneWorkspaceForTests({ view });
    expect(useMergedWorkspace({ hydrated: false, bots: [], groups })).toBeNull();
    const merged = useMergedWorkspace({ hydrated: true, bots, groups });
    expect(merged?.bots).toEqual([]);
    expect(merged?.homes.get("ember")).toEqual({ side: "computer", twin: true });
    expect(useMergedWorkspace({ hydrated: true, bots, groups })).toBe(merged);
  });

  it("give this page's rows their home only while the two show together", () => {
    expect(useOwnHome("ember")).toBeNull();
    setOneWorkspaceForTests({ view });
    expect(useOwnHome("ember")).toEqual({ side: "computer", twin: true });
    expect(useOwnHome("juno")).toEqual({ side: "computer", twin: false });
  });

  it("tell a row of this page what its copy on the other side has of its own", () => {
    setOneWorkspaceForTests({ view: { ...view, other: { ...view.other, bots: [{ ...view.other.bots[0]!, threads: ["phone-1", "t"], automations: 1 }] } } });
    expect(useTwinWork({ id: "ember", threadId: "t", tasks: [{ threadId: "t" }] })).toEqual({ side: "cloud", chats: 1, unshared: 0, unread: false, automations: 1, threadId: "phone-1" });
    setOneWorkspaceForTests({ view: { ...view, unshared: { ember: [{ threadId: "t", cloud: 2, computer: 0 }] }, other: { ...view.other, bots: [{ ...view.other.bots[0]!, threads: ["t"] }] } } });
    expect(useTwinWork({ id: "ember", threadId: "t", tasks: [{ threadId: "t" }] })).toEqual({ side: "cloud", chats: 0, unshared: 2, unread: false, automations: 0, threadId: "t" });
    expect(useTwinWork({ id: "juno", threadId: "j" })).toBeNull();
  });

  it("are never reached from a browser, a paired desktop or a page without main's bridge", () => {
    const bridge = { view: async () => null, onView: () => () => {}, open: async () => {}, take: async () => null };
    vi.stubGlobal("window", { ogb: { oneWorkspace: bridge } });
    expect(oneWorkspaceBridge()).toBe(bridge);
    vi.stubGlobal("window", { ogb: { oneWorkspace: bridge, remoteClient: { active: true } } });
    expect(oneWorkspaceBridge()).toBeUndefined();
    vi.stubGlobal("window", {});
    expect(oneWorkspaceBridge()).toBeUndefined();
  });
});
