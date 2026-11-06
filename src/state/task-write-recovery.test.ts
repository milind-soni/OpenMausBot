import { createElement, type Dispatch } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, StoreProvider, useStore, type Action, type BotAnnouncement } from "./store";

const SNAPSHOT = "/api/bots?messages=0";

const bot: BotAnnouncement = {
  id: "bot", threadId: "thread", name: "Fixture", title: "", description: "",
  notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "fake", model: "saved" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = () => {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

// Server rendering avoids mounting live event effects; every HTTP request is an offline fixture.
function mount(request: typeof fetch) {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("window", {});
  let dispatch!: Dispatch<Action>;
  function Capture() { dispatch = useStore().dispatch; return null; }
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Capture)));
  return {
    profile: () => dispatch({ type: "updateBot", botId: "bot", patch: { title: "Updated" } }),
    update: () => dispatch({ type: "updateTask", botId: "bot", threadId: "thread", patch: { approvalMode: "auto" } }),
    move: () => dispatch({ type: "updateTask", botId: "bot", threadId: "thread", patch: { projectId: null } }),
    send: () => dispatch({ type: "send", botId: "bot", threadId: "thread", text: "Continue" }),
  };
}
afterEach(() => { initialState.bots = []; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("thread setting save recovery", () => {
  it("does not let a successful queued folder move mask a failed approval save", async () => {
    const firstWrite = deferred();
    const secondWrite = deferred();
    let writes = 0;
    const requests = vi.fn<typeof fetch>(async (path) => {
      if (path === "/api/bots/bot/tasks/thread") return ++writes === 1 ? firstWrite.promise : secondWrite.promise;
      return response({});
    });
    const controls = mount(requests);
    controls.update();
    controls.move();
    controls.send();
    firstWrite.resolve(response({ error: "Approval save failed" }, 500));
    await flush();
    expect(writes).toBe(2);
    secondWrite.resolve(response({ bot }));
    await flush();
    expect(requests.mock.calls.some(([path]) => path === "/api/bots/bot/messages")).toBe(false);
    controls.send();
    await flush();
    expect(requests).toHaveBeenLastCalledWith("/api/bots/bot/messages", expect.objectContaining({ method: "POST" }));
  });

  it("does not revive a failed send that was waiting on a slower profile save", async () => {
    initialState.bots = [{ ...bot, messages: [] }];
    const profileSave = deferred();
    const reconciled = deferred();
    const requests = vi.fn<typeof fetch>(async (path) => {
      if (path === "/api/bots/bot") return profileSave.promise;
      if (path === "/api/bots/bot/tasks/thread") return response({ error: "Save failed" }, 500);
      if (path === SNAPSHOT) return reconciled.promise;
      return response({});
    });
    const controls = mount(requests);
    controls.profile();
    controls.update();
    controls.send();
    await flush();
    expect(requests.mock.calls.some(([path]) => path === "/api/bots/bot")).toBe(true);
    reconciled.resolve(response({ bots: [bot] }));
    await flush();
    profileSave.resolve(response({ bot }));
    await flush();
    expect(requests.mock.calls.some(([path]) => path === "/api/bots/bot/messages")).toBe(false);
    controls.send();
    await flush();
    expect(requests).toHaveBeenLastCalledWith("/api/bots/bot/messages", expect.objectContaining({ method: "POST" }));
  });

  it("blocks an immediate send, then permits a new send after authoritative reconciliation", async () => {
    const reconcile = deferred();
    const requests = vi.fn<typeof fetch>(async (path) => {
      if (path === "/api/bots/bot/tasks/thread") return response({ error: "Save failed" }, 500);
      if (path === SNAPSHOT) return reconcile.promise;
      return response({});
    });
    const controls = mount(requests);
    controls.update();
    controls.send();
    await flush();
    expect(requests.mock.calls.map(([path]) => path)).toEqual(["/api/bots/bot/tasks/thread", SNAPSHOT]);
    reconcile.resolve(response({ bots: [bot] }));
    await flush();
    expect(requests).toHaveBeenCalledTimes(2);
    controls.send();
    await flush();
    expect(requests).toHaveBeenLastCalledWith("/api/bots/bot/messages", expect.objectContaining({ method: "POST" }));
  });

  it.each(["unreachable", "missing bot"])("stays blocked when reconciliation is %s", async (failure) => {
    const requests = vi.fn<typeof fetch>(async (path) => path === SNAPSHOT
      ? response({ bots: [], error: "Offline" }, failure === "unreachable" ? 503 : 200)
      : response({ error: "Save failed" }, 500));
    const controls = mount(requests);
    controls.update();
    await flush();
    controls.send();
    await flush();
    expect(requests.mock.calls.map(([path]) => path)).toEqual(["/api/bots/bot/tasks/thread", SNAPSHOT]);
  });

  it("asks again after a failed reconciliation, and permits a send once the server answers", async () => {
    let reachable = false;
    const requests = vi.fn<typeof fetch>(async (path) => {
      if (path === SNAPSHOT) return reachable ? response({ bots: [bot] }) : response({ error: "Offline" }, 503);
      if (path === "/api/bots/bot/tasks/thread") return response({ error: "Save failed" }, 500);
      return response({});
    });
    const controls = mount(requests);
    controls.update();
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(requests.mock.calls.filter(([path]) => path === SNAPSHOT)).toHaveLength(2);
    reachable = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(requests.mock.calls.filter(([path]) => path === SNAPSHOT)).toHaveLength(3);
    controls.send();
    await flush();
    expect(requests).toHaveBeenLastCalledWith("/api/bots/bot/messages", expect.objectContaining({ method: "POST" }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests.mock.calls.filter(([path]) => path === SNAPSHOT), "no more reads once reconciled").toHaveLength(3);
  });

  it("does not let an old reconciliation clear a newer write", async () => {
    const reconcile = deferred();
    const nextWrite = deferred();
    let writes = 0;
    const requests = vi.fn<typeof fetch>(async (path) => {
      if (path === SNAPSHOT) return reconcile.promise;
      if (path === "/api/bots/bot/tasks/thread") return ++writes === 1
        ? response({ error: "Save failed" }, 500) : nextWrite.promise;
      return response({});
    });
    const controls = mount(requests);
    controls.update();
    await flush();
    controls.update();
    await flush();
    reconcile.resolve(response({ bots: [bot] }));
    await flush();
    controls.send();
    await flush();
    expect(requests.mock.calls.some(([path]) => path === "/api/bots/bot/messages")).toBe(false);
    nextWrite.resolve(response({ bot }));
    await flush();
    expect(requests.mock.calls.some(([path]) => path === "/api/bots/bot/messages")).toBe(false);
    controls.send();
    await flush();
    expect(requests).toHaveBeenLastCalledWith("/api/bots/bot/messages", expect.objectContaining({ method: "POST" }));
  });
});
