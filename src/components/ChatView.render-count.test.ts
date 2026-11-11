// @vitest-environment happy-dom
// The real provider and live stream with two bots, B's chat on screen: frames about A must not draw B's chat again.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "../../shared/wire";
import type { Action, BotAnnouncement, InstanceInfo, Message } from "@/state/store";

const renders = vi.hoisted(() => ({ chat: 0, composer: 0, header: 0 }));
vi.mock("@/lib/drafts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/drafts")>();
  return {
    ...original,
    useReplyDraft: (...args: Parameters<typeof original.useReplyDraft>) => { renders.chat++; return original.useReplyDraft(...args); },
    useComposerDraft: (...args: Parameters<typeof original.useComposerDraft>) => { renders.composer++; return original.useComposerDraft(...args); },
  };
});
vi.mock("./SidebarBotActivity", async (importOriginal) => {
  const original = await importOriginal<typeof import("./SidebarBotActivity")>();
  return { ...original, sidebarBotActivityTasks: (...args: Parameters<typeof original.sidebarBotActivityTasks>) => { renders.header++; return original.sidebarBotActivityTasks(...args); } };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => "user" }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false, setAdvancedMode: vi.fn() }));

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}

const announced = (id: string, name: string): BotAnnouncement => ({
  id, threadId: `${id}-thread`, name, title: "", description: "", notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: `${id}-thread`, title: "Chat", createdAt: 1, approvalMode: "ask" }],
});
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const answers: Record<string, unknown> = {
  "/api/instances": { instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" }, models: { options: [{ id: "m", label: "Model" }] } } as unknown as InstanceInfo] },
  "/api/config": {},
  "/api/routines": { routines: [], runs: [] },
  "/api/webhooks": { webhooks: [], attempts: [] },
};

const { StoreProvider, useStore } = await import("@/state/store");
const { useStoreSelector } = await import("@/state/store-select");
const { ChatView } = await import("./ChatView");

let dispatch!: (action: Action) => void;
function Shown() {
  dispatch = useStore().dispatch;
  return null;
}
function Shell() {
  const bot = useStoreSelector((state) => state.bots.find((candidate) => candidate.id === "b"));
  return bot ? createElement(ChatView, { bot }) : null;
}

let root: Root;
let cursor = 0;
const task = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await task(); };
const stream = () => FixtureEventSource.opened[0]!;
const send = async (frame: object) => { stream().send(frame, `run:${++cursor}`); await settle(); };
const reply = (threadId: string, id: string): ServerFrame => ({ kind: "message", threadId, message: { id, at: ++cursor, role: "bot", kind: "text", text: id } as Message } as ServerFrame);
const counts = () => ({ ...renders });

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string) => path.startsWith("/api/bots?")
    ? json({ bots: [announced("a", "Ada"), announced("b", "Bea")].map((bot) => ({ ...bot, messages: [] })), groups: [] })
    : json(answers[path.replace(/\?.*$/, "")] ?? {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Shown), createElement(Shell))));
  await settle();
  stream().send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
  flushSync(() => dispatch({ type: "select", id: "b" }));
  await settle();
});
afterAll(() => {
  flushSync(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("a chat on screen", () => {
  it("is drawn", () => {
    expect(document.querySelector('[data-chathead-pill]')).not.toBeNull();
    expect(renders.chat).toBeGreaterThan(0);
    expect(renders.composer).toBeGreaterThan(0);
    expect(renders.header).toBeGreaterThan(0);
  });

  it("does not draw again, nor its composer or header, for another bot's turn", async () => {
    // The header's mascot motion is one for the whole app: A's first frame takes it from B, a change B does show.
    await send({ kind: "bot", bot: { ...announced("a", "Ada"), busy: true, activity: "working" } });
    const before = counts();
    await send({ kind: "bot", bot: { ...announced("a", "Ada"), busy: true, activity: "working", title: "Still working" } });
    await send(reply("a-thread", "a1"));
    await send({ kind: "message.patch", threadId: "a-thread", message: { id: "a1", at: 1, role: "bot", kind: "text", text: "a1, longer" } });
    await send({ kind: "runtime", event: { type: "turn.started", eventId: "e1", provider: "codex", threadId: "a-thread", turnId: "t1", createdAt: "2026-11-11T00:00:00.000Z" } });
    await send({ kind: "bot", bot: { ...announced("a", "Ada"), busy: false, activity: "idle" } });
    expect(counts()).toEqual(before);
  });

  it("does not draw again for a store change it does not show", async () => {
    const before = counts();
    flushSync(() => dispatch({ type: "connected", value: false }));
    flushSync(() => dispatch({ type: "connected", value: true }));
    await settle();
    expect(counts()).toEqual(before);
  });

  it("draws again for its own bot's reply", async () => {
    const before = counts();
    await send(reply("b-thread", "b1"));
    expect(renders.chat).toBeGreaterThan(before.chat);
    expect(document.querySelector('[data-mid="b1"]')).not.toBeNull();
  });
});
