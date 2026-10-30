import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Action, AppState, Bot, Group, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: (...args: unknown[]) => fixture.api(...args),
}));

const { landOnSearchHit } = await import("./focus-message");

const message = (n: number): Message => ({ id: `m${n}`, role: "bot", kind: "text", text: `message ${n}`, at: n });
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => message(from + index));
const bot = { id: "scout", name: "Scout", threadId: "t", tasks: [], messages: range(400, 600), hasMore: true } as unknown as Bot;
const group = { id: "room", name: "Room", threadId: "rt", memberIds: [], messages: range(400, 600), hasMore: true } as unknown as Group;
const hit = { name: "Scout", role: "bot" as const, kind: "text", at: 50, snippet: "message 50", matchStart: 0, matchLength: 7, onActivePath: true, messageId: "m50" };
const pages: Record<string, { messages: Message[]; hasMore: boolean }> = {
  m400: { messages: range(200, 400), hasMore: true },
  m200: { messages: range(0, 200), hasMore: false },
};

let actions: Action[];
const dispatch = (action: Action) => { actions.push(action); };
const state = { bots: [bot], groups: [group], transcriptGeneration: { t: 3, rt: 5 } } as unknown as AppState;

beforeEach(() => {
  actions = [];
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string) => pages[new URL(path, "http://x").searchParams.get("before")!]);
});

describe("landing on a search hit older than the loaded page", () => {
  it("loads earlier pages of the open bot thread until the hit is there, then focuses it", async () => {
    await landOnSearchHit({ ...hit, botId: "scout", threadId: "t" }, state, dispatch, true);
    expect(fixture.api.mock.calls.map(([path]) => path)).toEqual([
      "/api/threads/t/messages?limit=200&before=m400",
      "/api/threads/t/messages?limit=200&before=m200",
    ]);
    expect(actions.map((action) => action.type)).toEqual(["select", "olderMessages", "focusMessage"]);
    expect(actions[1]).toEqual({ type: "olderMessages", threadId: "t", generation: 3, messages: range(0, 400), hasMore: false });
  });

  it("does the same in the room's open thread", async () => {
    await landOnSearchHit({ ...hit, groupId: "room", threadId: "rt" }, state, dispatch, true);
    expect(actions[1]).toMatchObject({ type: "olderMessages", threadId: "rt", generation: 5, hasMore: false });
    expect(actions[2]).toMatchObject({ type: "focusMessage", threadId: "rt", messageId: "m50" });
  });

  it("stops at the page that holds the hit", async () => {
    await landOnSearchHit({ ...hit, botId: "scout", threadId: "t", messageId: "m300" }, state, dispatch, true);
    expect(fixture.api).toHaveBeenCalledOnce();
    expect(actions[1]).toEqual({ type: "olderMessages", threadId: "t", generation: 3, messages: range(200, 400), hasMore: true });
  });

  it("asks for nothing when the hit is already loaded", async () => {
    await landOnSearchHit({ ...hit, botId: "scout", threadId: "t", messageId: "m450" }, state, dispatch, true);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(actions.map((action) => action.type)).toEqual(["select", "focusMessage"]);
  });
});
