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
const navigationRevision = { current: 0 };
const dispatch = (action: Action) => { actions.push(action); };
const state = { bots: [bot], groups: [group], transcriptGeneration: { t: 3, rt: 5 } } as unknown as AppState;

beforeEach(() => {
  actions = [];
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string) => pages[new URL(path, "http://x").searchParams.get("before")!]);
});

describe("landing on a search hit older than the loaded page", () => {
  it("loads earlier pages of the open bot thread until the hit is there, then focuses it", async () => {
    await landOnSearchHit({ ...hit, botId: "scout", threadId: "t" }, state, dispatch, true, navigationRevision);
    expect(fixture.api.mock.calls.map(([path]) => path)).toEqual([
      "/api/threads/t/messages?limit=200&before=m400",
      "/api/threads/t/messages?limit=200&before=m200",
    ]);
    expect(actions.map((action) => action.type)).toEqual(["searchNavigationStarted", "select", "olderMessages", "focusMessage"]);
    expect(actions[2]).toEqual({ type: "olderMessages", threadId: "t", generation: 3, messages: range(0, 400), hasMore: false });
  });

  it("does the same in the room's open thread", async () => {
    await landOnSearchHit({ ...hit, groupId: "room", threadId: "rt" }, state, dispatch, true, navigationRevision);
    expect(actions[2]).toMatchObject({ type: "olderMessages", threadId: "rt", generation: 5, hasMore: false });
    expect(actions[3]).toMatchObject({ type: "focusMessage", threadId: "rt", messageId: "m50" });
  });

  it("stops at the page that holds the hit", async () => {
    await landOnSearchHit({ ...hit, botId: "scout", threadId: "t", messageId: "m300" }, state, dispatch, true, navigationRevision);
    expect(fixture.api).toHaveBeenCalledOnce();
    expect(actions[2]).toEqual({ type: "olderMessages", threadId: "t", generation: 3, messages: range(200, 400), hasMore: true });
  });

  it("asks for nothing when the hit is already loaded", async () => {
    await landOnSearchHit({ ...hit, botId: "scout", threadId: "t", messageId: "m450" }, state, dispatch, true, navigationRevision);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(actions.map((action) => action.type)).toEqual(["searchNavigationStarted", "select", "focusMessage"]);
  });
});

describe("choosing another search hit while one is still landing", () => {
  let held: Array<{ path: string; body?: string; resolve: (answer: unknown) => void }>;
  const replies = (path: string, body?: string): unknown => path.includes("/active-branch")
    ? { activeLeafId: JSON.parse(body!).messageId }
    : path.includes("/tasks/") ? { bot: { ...bot, threadId: path.split("/").pop() } } : pages[new URL(path, "http://x").searchParams.get("before")!];
  const answerFirst = async () => {
    const request = held.shift()!;
    request.resolve(replies(request.path, request.body));
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const answerAll = async () => { while (held.length) await answerFirst(); };
  const types = () => actions.map((action) => action.type);
  const focused = () => actions.flatMap((action) => action.type === "focusMessage" ? [action.messageId] : []);
  const loaded = { ...hit, botId: "scout", threadId: "t", messageId: "m450" };
  const elsewhere = { ...hit, botId: "scout", threadId: "side", messageId: "s1", onActivePath: false };

  beforeEach(() => {
    held = [];
    fixture.api.mockImplementation((path: string, init?: { body?: string }) => new Promise((resolve) => { held.push({ path, body: init?.body, resolve }); }));
  });

  it("does not focus the earlier hit when its older pages arrive after the newer one landed", async () => {
    const earlier = landOnSearchHit({ ...hit, groupId: "room", threadId: "rt" }, state, dispatch, true, navigationRevision);
    await landOnSearchHit(loaded, state, dispatch, true, navigationRevision);
    await answerAll();
    await earlier;
    expect(focused()).toEqual(["m450"]);
  });

  it("does not switch the bot to the earlier hit's thread when the newer hit landed first", async () => {
    const earlier = landOnSearchHit(elsewhere, state, dispatch, true, navigationRevision);
    await landOnSearchHit(loaded, state, dispatch, true, navigationRevision);
    await answerAll();
    await earlier;
    expect(types()).not.toContain("taskSwitched");
    expect(types()).not.toContain("switchTask");
    expect(focused()).toEqual(["m450"]);
  });

  it("with threads hidden, lands on the newer hit when the earlier one answers first", async () => {
    const earlier = landOnSearchHit(elsewhere, state, dispatch, false, navigationRevision);
    const newer = landOnSearchHit({ ...elsewhere, threadId: "other", messageId: "o1" }, state, dispatch, false, navigationRevision);
    await answerFirst();
    await earlier;
    await answerAll();
    await newer;
    expect(actions.filter((action) => action.type === "switchTask")).toEqual([{ type: "switchTask", botId: "scout", threadId: "other", whole: true }]);
    expect(focused()).toEqual(["o1"]);
  });
});
