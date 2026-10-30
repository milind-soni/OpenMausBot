import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { StoreProvider, useStore } from "./store";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function controls() {
  let store!: ReturnType<typeof useStore>;
  function Capture() { store = useStore(); return null; }
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
  return store;
}

it("reports an explicit refresh failure while background refresh stays safe", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fixture offline")));
  const store = controls();
  await expect(store.refreshInstances({ reportErrors: true })).rejects.toThrow("fixture offline");
  await expect(store.refreshInstances()).resolves.toBeUndefined();
});

it("shares an in-flight probe and permits a fresh retry after failure", async () => {
  let reject!: (error: Error) => void;
  const request = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ instances: [] })));
  vi.stubGlobal("fetch", request);
  const store = controls();
  const background = store.refreshInstances();
  const explicit = expect(store.refreshInstances({ reportErrors: true })).rejects.toThrow("fixture offline");
  const concurrentRequests = request.mock.calls.length;
  reject(new Error("fixture offline"));
  await Promise.all([background, explicit]);
  expect(concurrentRequests).toBe(1);
  await store.refreshInstances({ reportErrors: true });
  expect(request).toHaveBeenCalledTimes(2);
});

it("rejects a malformed status response instead of replacing the last list", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
  await expect(controls().refreshInstances({ reportErrors: true })).rejects.toThrow("Couldn't get the status of your AIs");
});

it("releases a hung shared probe after its bounded timeout so retry can work", async () => {
  const timeout = new AbortController();
  const timer = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout.signal);
  vi.stubGlobal("fetch", vi.fn().mockImplementationOnce((_path, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })).mockResolvedValueOnce(new Response(JSON.stringify({ instances: [] }))));
  const store = controls();
  const request = expect(store.refreshInstances({ reportErrors: true })).rejects.toThrow("fixture timeout");
  expect(timer).toHaveBeenCalledWith(120_000);
  timeout.abort(new Error("fixture timeout"));
  await request;
  await expect(store.refreshInstances({ reportErrors: true })).resolves.toBeUndefined();
});
