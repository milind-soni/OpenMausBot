// @vitest-environment happy-dom
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, AppState, BotAnnouncement, Message } from "./store";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

const allowKey = "provider-tool:claude:linear:list_issues:0123456789abcdef";
const approval: Message = {
  id: "approval", role: "bot", kind: "options", at: 1,
  card: { title: "Approval needed", subtitle: "list issues", options: ["Allow", "Deny"], requestId: "request-1", allowKey },
};
const bot: BotAnnouncement = {
  id: "bot", threadId: "thread", name: "Fixture", title: "", description: "",
  notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "fake", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1 }],
  messages: [approval],
};

let saveGrant: () => Promise<Response>;
const writes: string[] = [];
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

const { StoreProvider, useStore } = await import("./store");

let seen!: AppState;
let dispatch!: Dispatch<Action>;
function Probe() {
  ({ state: seen, dispatch } = useStore());
  return null;
}
let root: Root;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string, options?: RequestInit) => {
    if (options?.method && options.method !== "GET") writes.push(path);
    if (path.startsWith("/api/bots?")) return json({ bots: [bot], groups: [] });
    if (path === "/api/bots/bot/always-allow") return saveGrant();
    if (path.endsWith("/respond")) return json({ ok: true });
    return json({});
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  FixtureEventSource.opened[0].send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
});
beforeEach(() => {
  writes.length = 0;
  flushSync(() => dispatch({ type: "error", message: null }));
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

const alwaysAllow = (onError?: (message: string) => void) => flushSync(() => dispatch({
  type: "decideRequest", threadId: "thread", requestId: "request-1", behavior: "allow",
  alwaysAllow: { botId: "bot", key: allowKey }, onError,
}));

describe("Always allow on an approval card", () => {
  it("saves the grant and then approves the request", async () => {
    let finishSave!: (response: Response) => void;
    saveGrant = () => new Promise((resolve) => { finishSave = resolve; });
    alwaysAllow();
    await settle();
    expect(writes).toEqual(["/api/bots/bot/always-allow"]);
    finishSave(new Response(JSON.stringify({ bot }), { status: 200 }));
    await settle();
    expect(writes).toEqual(["/api/bots/bot/always-allow", "/api/threads/thread/respond"]);
    expect(seen.error).toBeNull();
  });

  it("leaves the request waiting when the grant could not be saved", async () => {
    saveGrant = () => json({ error: "This bot already always-allows 200 tools." }, 400);
    const onError = vi.fn();
    alwaysAllow(onError);
    await settle();
    expect(writes).toEqual(["/api/bots/bot/always-allow"]);
    expect(seen.error).toContain("200 tools");
    expect(onError).toHaveBeenCalledOnce();
  });
});
