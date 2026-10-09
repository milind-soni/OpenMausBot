// @vitest-environment happy-dom
// The store keeps one data sheet per bot and talks to the panel routes. A
// `data` frame replaces the sheet whole; run, cancel, patch and delete post
// to their routes and leave the answer to the frame.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DATA_ROUTES, type DataSheet } from "../../shared/data-surface";
import type { ServerFrame } from "../../shared/wire";
import type { AppState, BotAnnouncement } from "./store";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

const bot: BotAnnouncement = {
  id: "bot", threadId: "thread", name: "Fixture", title: "", description: "",
  notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "fake", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
};
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const sheet = (cardIds: string[]): DataSheet => ({
  version: 1, botId: "bot", updatedAt: "2026-10-09T10:00:00.000Z", sources: [],
  cards: cardIds.map((id) => ({ id, kind: "table", title: id, status: "ready", by: "bot", createdAt: "2026-10-09T10:00:00.000Z", updatedAt: "2026-10-09T10:00:00.000Z" })),
});
const requests: Array<{ path: string; method: string; body: unknown }> = [];
const answers: Record<string, unknown> = {
  "/api/instances": { instances: [] },
  "/api/config": {},
  "/api/routines": { routines: [], runs: [] },
  "/api/webhooks": { webhooks: [], attempts: [] },
  [DATA_ROUTES.sheet("bot")]: sheet(["from-get"]),
};

const { StoreProvider, useStore, dataSheetFromResponse, reducer } = await import("./store");

let seen!: AppState;
let dispatch!: ReturnType<typeof useStore>["dispatch"];
function Probe() {
  const store = useStore();
  seen = store.state;
  dispatch = store.dispatch;
  return null;
}
let root: Root;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const stream = () => FixtureEventSource.opened[0]!;
let cursor = 0;
const send = async (frame: ServerFrame) => {
  stream().send(frame, `run:${++cursor}`);
  await settle();
};
const sent = (path: string) => requests.filter((request) => request.path === path);

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) => {
    requests.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return path.startsWith("/api/bots?") ? json({ bots: [bot], groups: [] }) : json(answers[path] ?? {});
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  stream().send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

describe("data sheets in the store", () => {
  it("opens the referenced bot's Data result, including repeated clicks", () => {
    const opened = reducer(seen, { type: "openDataResult", botId: "bot", cardId: "c_1" });
    expect(opened).toMatchObject({ selectedId: "bot", computerOpen: true, activeView: "chat", dataResultFocus: { botId: "bot", id: "c_1", requestId: 1 } });
    expect(reducer(opened, { type: "openDataResult", botId: "bot", cardId: "c_1" }).dataResultFocus?.requestId).toBe(2);
    const consumed = reducer(opened, { type: "dataResultFocusConsumed", requestId: 1 });
    expect(consumed.dataResultFocus?.consumed).toBe(true);
    expect(reducer(consumed, { type: "openDataResult", botId: "bot", cardId: "c_1" }).dataResultFocus).toMatchObject({ consumed: false, requestId: 2 });
    expect(reducer(opened, { type: "openDataResult", botId: "deleted", cardId: "c_1" })).toBe(opened);
  });
  it("opens a receipt's bot the way selecting it does: unread clears and the read is posted", async () => {
    // Another bot with unread messages, not the one on screen.
    const other: BotAnnouncement = { ...bot, id: "other", name: "Other", unread: true, tasks: [{ ...bot.tasks![0]!, unread: true }] };
    await send({ kind: "bot", bot: other as unknown as Extract<ServerFrame, { kind: "bot" }>["bot"] });
    expect(seen.selectedId).toBe("bot");
    expect(seen.bots.find((candidate) => candidate.id === "other")?.unread).toBe(true);
    expect(sent("/api/bots/other/read")).toHaveLength(0);
    dispatch({ type: "openDataResult", botId: "other", cardId: "c_1" });
    await settle();
    expect(seen).toMatchObject({ selectedId: "other", activeView: "chat", computerOpen: true, dataResultFocus: { botId: "other", id: "c_1", consumed: false } });
    const openedBot = seen.bots.find((candidate) => candidate.id === "other");
    expect(openedBot?.unread).toBe(false);
    expect(openedBot?.tasks?.[0]?.unread).toBe(false);
    expect(sent("/api/bots/other/read").map((request) => [request.method, request.body])).toEqual([["POST", { threadId: "thread" }]]);
    dispatch({ type: "select", id: "bot" });
    await settle();
  });
  it("start empty and are not fetched with the app", () => {
    expect(seen.dataSheets).toEqual({});
    expect(sent(DATA_ROUTES.sheet("bot"))).toHaveLength(0);
  });

  it("load once from GET when the tab asks", async () => {
    dispatch({ type: "loadDataSheet", botId: "bot" });
    await settle();
    expect(sent(DATA_ROUTES.sheet("bot"))).toHaveLength(1);
    expect(seen.dataSheets.bot?.cards.map((card) => card.id)).toEqual(["from-get"]);
  });

  it("are replaced whole by a data frame", async () => {
    await send({ kind: "data", botId: "bot", sheet: sheet(["a", "b"]) });
    expect(seen.dataSheets.bot?.cards.map((card) => card.id)).toEqual(["a", "b"]);
    await send({ kind: "data", botId: "bot", sheet: sheet(["b"]) });
    expect(seen.dataSheets.bot?.cards.map((card) => card.id)).toEqual(["b"]);
    expect(seen.dataSheets.bot?.botId).toBe("bot");
  });

  it("post the person's SQL to run, with the card to update when editing", async () => {
    dispatch({ type: "runDataSql", botId: "bot", request: { sql: "select 1" } });
    dispatch({ type: "runDataSql", botId: "bot", request: { sql: "select 2", cardId: "b" } });
    await settle();
    expect(sent(DATA_ROUTES.run("bot")).map((request) => [request.method, request.body])).toEqual([
      ["POST", { sql: "select 1" }],
      ["POST", { sql: "select 2", cardId: "b" }],
    ]);
    // The reply changes nothing: the frame does.
    expect(seen.dataSheets.bot?.cards.map((card) => card.id)).toEqual(["b"]);
  });

  it("post cancel, patch and delete to their routes", async () => {
    dispatch({ type: "cancelDataCard", botId: "bot", cardId: "b" });
    dispatch({ type: "patchDataCard", botId: "bot", cardId: "b", patch: { pinned: true } });
    dispatch({ type: "deleteDataCard", botId: "bot", cardId: "b" });
    await settle();
    expect(sent(DATA_ROUTES.cancel("bot")).map((request) => [request.method, request.body])).toEqual([["POST", { cardId: "b" }]]);
    expect(sent(DATA_ROUTES.card("bot", "b")).map((request) => [request.method, request.body])).toEqual([
      ["PATCH", { pinned: true }],
      ["DELETE", undefined],
    ]);
  });

  it("tell the panel, not the app, when a route refuses", async () => {
    answers[DATA_ROUTES.sheet("other")] = undefined;
    vi.stubGlobal("fetch", (path: string) => path === DATA_ROUTES.run("other")
      ? Promise.resolve(new Response(JSON.stringify({ error: "Not Found" }), { status: 404 }))
      : json(answers[path] ?? {}));
    const onError = vi.fn();
    dispatch({ type: "runDataSql", botId: "other", request: { sql: "select 1" }, onError });
    await settle();
    expect(onError).toHaveBeenCalledWith("Not Found");
    expect(seen.error).toBeNull();
  });

  it("read a sheet from either answer shape, and an empty sheet from nothing", () => {
    const direct = sheet(["x"]);
    expect(dataSheetFromResponse(direct, "bot")).toEqual(direct);
    expect(dataSheetFromResponse({ sheet: direct }, "bot")).toEqual(direct);
    expect(dataSheetFromResponse({}, "bot")).toMatchObject({ version: 1, botId: "bot", cards: [], sources: [] });
    expect(dataSheetFromResponse({ version: 1, cards: [] }, "bot")).toMatchObject({ botId: "bot", sources: [] });
  });
});
