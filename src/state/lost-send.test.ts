import { createElement, type Dispatch } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { initialState, StoreProvider, useStore, type Action } from "./store";

const SEND = "/api/bots/bot/messages";
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function mount(request: typeof fetch) {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("window", {});
  let dispatch!: Dispatch<Action>;
  function Capture() { dispatch = useStore().dispatch; return null; }
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
  return (onError: () => void) => dispatch({ type: "send", botId: "bot", threadId: "thread", text: "say ok6", sendId: "send-0123456789abcdef", onError });
}
afterEach(() => { initialState.bots = []; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("asks again with the same sendId when a send's answer is lost, and never gives a delivered message back", async () => {
  const bodies: string[] = [];
  const requests = vi.fn<typeof fetch>(async (path, init) => {
    if (path !== SEND) return response({});
    bodies.push(String(init?.body));
    if (bodies.length === 1) throw new TypeError("Failed to fetch");
    return response({ threadId: "thread", message: { id: "m1", role: "user", kind: "text", text: "say ok6", at: 1, sendId: "send-0123456789abcdef" } }, 202);
  });
  const onError = vi.fn();
  mount(requests)(onError);
  await flush();
  await vi.advanceTimersByTimeAsync(5_000);
  await flush();
  expect(bodies).toHaveLength(2);
  expect(JSON.parse(bodies[1]!).sendId).toBe(JSON.parse(bodies[0]!).sendId);
  expect(onError).not.toHaveBeenCalled();
});

it("still gives the draft back when the server refuses the send", async () => {
  const requests = vi.fn<typeof fetch>(async (path) => path === SEND ? response({ error: "no" }, 409) : response({}));
  const onError = vi.fn();
  mount(requests)(onError);
  await flush();
  expect(requests.mock.calls.filter(([path]) => path === SEND)).toHaveLength(1);
  expect(onError).toHaveBeenCalledOnce();
});
