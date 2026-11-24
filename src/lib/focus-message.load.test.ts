import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Action, AppState, Bot, Group, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: (...args: unknown[]) => fixture.api(...args),
}));

const { landOnSearchHit } = await import("./focus-message");
const { initialState, reducer } = await import("@/state/store");

const message = (n: number): Message => ({ id: `m${n}`, role: "bot", kind: "text", text: `message ${n}`, at: n });
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => message(from + index));
const bot = { id: "scout", name: "Scout", threadId: "t", tasks: [], messages: range(400, 600), hasMore: true } as unknown as Bot;
const group = { id: "room", name: "Room", threadId: "rt", memberIds: [], messages: range(400, 600), hasMore: true } as unknown as Group;
const hit = { name: "Scout", role: "bot" as const, kind: "text", at: 50, snippet: "message 50", matchStart: 0, matchLength: 7, onActivePath: true, messageId: "m50" };
const pages: Record<string, { messages: Message[]; hasMore: boolean; activeLeafId?: string }> = {
  tail: { messages: range(400, 600), hasMore: true, activeLeafId: "m599" },
  m400: { messages: range(200, 400), hasMore: true },
  m200: { messages: range(0, 200), hasMore: false },
};

let actions: Action[];
const dispatch = (action: Action) => { actions.push(action); };
const state = { bots: [bot], groups: [group], transcriptGeneration: { t: 3, rt: 5 } } as unknown as AppState;

beforeEach(() => {
  actions = [];
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string) => pages[new URL(path, "http://x").searchParams.get("before") ?? "tail"]);
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


  it.each(["bot", "room"] as const)("lands on an older hit in a cold %s without a pagination cursor", async (kind) => {
    const cold = {
      ...initialState,
      bots: [{ ...bot, needsHistory: true, messages: [], hasMore: undefined }],
      groups: [{ ...group, needsHistory: true, messages: [], hasMore: undefined }],
      transcriptGeneration: state.transcriptGeneration,
    };
    const target = kind === "bot" ? { botId: "scout", threadId: "t" } : { groupId: "room", threadId: "rt" };
    await landOnSearchHit({ ...hit, ...target }, cold, dispatch, true);
    expect(fixture.api.mock.calls.map(([path]) => path)).toEqual([
      `/api/threads/${target.threadId}/messages?limit=200`,
      `/api/threads/${target.threadId}/messages?limit=200&before=m400`,
      `/api/threads/${target.threadId}/messages?limit=200&before=m200`,
    ]);
    const landed = actions.reduce(reducer, cold);
    const owner = kind === "bot" ? landed.bots[0] : landed.groups[0];
    expect(owner).toMatchObject({ needsHistory: false, hasMore: false, messages: range(0, 600) });
    expect(landed.focusMessage).toMatchObject({ threadId: target.threadId, messageId: "m50" });
  });

  it("asks for nothing when the hit is already loaded", async () => {
    await landOnSearchHit({ ...hit, botId: "scout", threadId: "t", messageId: "m450" }, state, dispatch, true);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(actions.map((action) => action.type)).toEqual(["select", "focusMessage"]);
  });
});

it("does not land on an older result after an in-chat search has moved on", async () => {
  const pending = Promise.withResolvers<{ messages: Message[]; hasMore: boolean }>();
  fixture.api.mockReturnValueOnce(pending.promise);
  const navigation = new AbortController();
  const older = landOnSearchHit({ ...hit, botId: "scout", threadId: "t", messageId: "m300" }, state, dispatch, true, navigation.signal);
  navigation.abort();
  await landOnSearchHit({ ...hit, botId: "scout", threadId: "t", messageId: "m450" }, state, dispatch, true);
  pending.resolve(pages.m400!);
  await expect(older).rejects.toHaveProperty("name", "AbortError");
  expect(actions.filter(action => action.type === "focusMessage").map(action => action.messageId)).toEqual(["m450"]);
});

it("rechecks a previously active result after the user has switched branches", async () => {
  const destination = { ...message(1), parentId: null };
  const current = { ...message(2), parentId: null };
  const branched = { ...state, bots: [{ ...bot, messages: [destination, current], activeLeafId: current.id }] };
  fixture.api.mockResolvedValue({ activeLeafId: destination.id });
  await landOnSearchHit({ ...hit, botId: "scout", threadId: "t", messageId: destination.id }, branched, dispatch, true);
  expect(actions.slice(-2)).toMatchObject([
    { type: "threadActive", activeLeafId: destination.id },
    { type: "focusMessage", messageId: destination.id },
  ]);
});
