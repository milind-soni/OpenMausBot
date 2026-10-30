import { createElement, type Dispatch } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { initialState, StoreProvider, useStore, type Action } from "./store";

const CREATE = "/api/bots/bot/tasks";
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
afterEach(() => { initialState.bots = []; vi.unstubAllGlobals(); });

it("makes one conversation for a double or triple click on New conversation", async () => {
  let answer!: () => void;
  const requests = vi.fn<typeof fetch>(async (path) => {
    if (path !== CREATE) return new Response("{}");
    await new Promise<void>((resolve) => { answer = resolve; });
    return new Response(JSON.stringify({ bot: { id: "bot", threadId: "new" } }), { status: 201 });
  });
  vi.stubGlobal("fetch", requests);
  vi.stubGlobal("window", {});
  let dispatch!: Dispatch<Action>;
  function Capture() { dispatch = useStore().dispatch; return null; }
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
  for (let click = 0; click < 3; click++) dispatch({ type: "newTask", botId: "bot" });
  await flush();
  expect(requests.mock.calls.filter(([path]) => path === CREATE)).toHaveLength(1);
  answer();
  await flush();
  dispatch({ type: "newTask", botId: "bot" });
  await flush();
  expect(requests.mock.calls.filter(([path]) => path === CREATE)).toHaveLength(2);
});

it("answers every click's callbacks with the one conversation's outcome", async () => {
  let fail!: () => void;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (path) => {
    if (path !== CREATE) return new Response("{}");
    await new Promise<void>((resolve) => { fail = resolve; });
    return new Response(JSON.stringify({ error: "no room for another" }), { status: 409 });
  }));
  vi.stubGlobal("window", {});
  let dispatch!: Dispatch<Action>;
  function Capture() { dispatch = useStore().dispatch; return null; }
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
  const errors: string[] = [];
  for (let click = 0; click < 2; click++) dispatch({ type: "newTask", botId: "bot", cwd: "/work", onError: (message) => errors.push(message) });
  await flush();
  fail();
  await flush();
  expect(errors).toEqual(["no room for another", "no room for another"]);
});

it("tells a click that came while the conversation was being made that it was made", async () => {
  let answer!: () => void;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (path) => {
    if (path !== CREATE) return new Response("{}");
    await new Promise<void>((resolve) => { answer = resolve; });
    return new Response(JSON.stringify({ bot: { id: "bot", threadId: "new" } }), { status: 201 });
  }));
  vi.stubGlobal("window", {});
  let dispatch!: Dispatch<Action>;
  function Capture() { dispatch = useStore().dispatch; return null; }
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
  const created = vi.fn();
  dispatch({ type: "newTask", botId: "bot", onCreated: created });
  dispatch({ type: "newTask", botId: "bot", onCreated: created });
  await flush();
  answer();
  await flush();
  expect(created).toHaveBeenCalledTimes(2);
});
