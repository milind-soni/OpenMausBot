// @vitest-environment happy-dom
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, BotAnnouncement, Message } from "./store";

const sounds = vi.hoisted(() => ({ played: [] as string[] }));
vi.mock("@/lib/app-sounds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-sounds")>()),
  playAppSound: (event: string) => (sounds.played.push(event), "played"),
}));

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

const approval: Message = {
  id: "approval", role: "bot", kind: "options", at: 1,
  card: { title: "Approval needed", subtitle: "run a command", options: ["Allow", "Deny"], requestId: "request-1" },
};
const bot: BotAnnouncement = {
  id: "bot", threadId: "thread", name: "Fixture", title: "", description: "",
  notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "fake", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1 }],
  messages: [approval],
};

let answer: () => Promise<Response>;
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

const { StoreProvider, useStore } = await import("./store");

let dispatch!: Dispatch<Action>;
function Probe() {
  ({ dispatch } = useStore());
  return null;
}
let root: Root;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string) => {
    if (path.startsWith("/api/bots?")) return json({ bots: [bot], groups: [] });
    if (path.endsWith("/respond")) return answer();
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
  sounds.played = [];
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

const allow = () => flushSync(() => dispatch({ type: "decideRequest", threadId: "thread", requestId: "request-1", behavior: "allow" }));

describe("the approval sound", () => {
  it("waits for the server to carry out the approval", async () => {
    let reply!: (response: Response) => void;
    answer = () => new Promise((resolve) => { reply = resolve; });
    allow();
    await settle();
    expect(sounds.played).toEqual([]);
    reply(new Response(JSON.stringify({ ok: true, outcome: "allowed-once" }), { status: 200 }));
    await settle();
    expect(sounds.played).toEqual(["approved"]);
  });

  it("sounds no success when the server refuses the approval, only the error", async () => {
    answer = () => json({ error: "nothing is waiting on an answer in this conversation" }, 404);
    allow();
    await settle();
    expect(sounds.played).toEqual(["error"]);
  });

  it("sounds no success when the approval was not carried out or its record could not finish", async () => {
    answer = () => json({ ok: true, outcome: "unavailable" });
    allow();
    await settle();
    answer = () => json({ ok: true, outcome: "allowed-once", settlementPending: true, message: "Applied, but the record could not finish." });
    allow();
    await settle();
    expect(sounds.played).toEqual(["error"]);
  });

  it("sounds nothing for a denial", async () => {
    answer = () => json({ ok: true, outcome: "rejected" });
    flushSync(() => dispatch({ type: "decideRequest", threadId: "thread", requestId: "request-1", behavior: "deny" }));
    await settle();
    expect(sounds.played).toEqual([]);
  });
});
