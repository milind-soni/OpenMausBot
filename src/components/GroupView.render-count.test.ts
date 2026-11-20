// @vitest-environment happy-dom
// The real provider and live stream with a room of 120 messages on screen: a streamed delta draws only the bubble it
// grows, and a store change the bubbles do not show draws none.
import { renderMark, renderedSince } from "@/testing/render-counts";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Action, BotAnnouncement, InstanceInfo, Message } from "@/state/store";
import type { RuntimeEvent } from "../../shared/runtime-events";
import { setLocale } from "@/lib/i18n";

const renders = vi.hoisted(() => ({ bubbles: 0, chips: 0 }));
vi.mock("./ToolActivity", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ToolActivity")>();
  return { ...original, ToolActivity: (props: Parameters<typeof original.ToolActivity>[0]) => { renders.chips++; return original.ToolActivity(props); } };
});
// A text bubble asks for its pin action once each time it is drawn.
vi.mock("./message-menu", async (importOriginal) => {
  const original = await importOriginal<typeof import("./message-menu")>();
  return { ...original, roomPin: (...args: Parameters<typeof original.roomPin>) => { renders.bubbles++; return original.roomPin(...args); } };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/cloud-guest")>(), useCanWriteIn: () => true, useReactor: () => "user" }));

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
const at = Date.UTC(2026, 10, 11, 12);
const history: Message[] = Array.from({ length: 120 }, (_, i) => i % 2 === 0
  ? { id: `m${i}`, role: "user", kind: "text", at: at + i, text: `Question ${i}` } as Message
  : { id: `m${i}`, role: "bot", kind: "text", at: at + i, text: `Answer **${i}** with a [link](https://example.com).`, from: { botId: i % 4 === 1 ? "a" : "b", name: i % 4 === 1 ? "Ada" : "Bea", color: "green" } } as Message);
const room = {
  id: "room", threadId: "room-thread", name: "Planning", memberIds: ["a", "b"], defaultResponder: { kind: "member", botId: "a" },
  bulletin: "", unread: false, createdAt: 1, messages: history, setupCompletedAt: 1,
  tasks: [{ threadId: "room-thread", title: "Chat", createdAt: 1 }],
};
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const answers: Record<string, unknown> = {
  "/api/instances": { instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" }, models: { options: [{ id: "m", label: "Model" }] } } as unknown as InstanceInfo] },
  "/api/config": { features: { showToolCalls: true } },
  "/api/routines": { routines: [], runs: [] },
  "/api/webhooks": { webhooks: [], attempts: [] },
};

const { StoreProvider, useStore } = await import("@/state/store");
const { useStoreSelector } = await import("@/state/store-select");
const { GroupView } = await import("./GroupView");
const { noteLiveReplyEvent } = await import("@/state/live-reply");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

let dispatch!: (action: Action) => void;
function Shown() {
  dispatch = useStore().dispatch;
  return null;
}
function Shell() {
  const group = useStoreSelector((state) => state.groups.find((candidate) => candidate.id === "room"));
  return group ? createElement(GroupView, { group }) : null;
}

let root: Root;
let cursor = 0;
const task = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await task(); };
const stream = () => FixtureEventSource.opened[0]!;
const send = async (frame: object) => { stream().send(frame, `run:${++cursor}`); await settle(); };
let seq = 0;
const delta = (text: string) => flushSync(() => noteLiveReplyEvent({
  eventId: `d${++seq}`, provider: "claudeAgent", threadId: "room-thread", createdAt: new Date(at).toISOString(), turnId: "t1", itemId: "x",
  type: "content.delta", streamKind: "assistant_text", delta: text, botId: "a",
} as RuntimeEvent));

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string) => path.startsWith("/api/bots?")
    ? json({ bots: [announced("a", "Ada"), announced("b", "Bea"), announced("c", "Cy")].map((bot) => ({ ...bot, messages: [] })), groups: [room] })
    : json(answers[path.replace(/\?.*$/, "")] ?? {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Shown), createElement(Shell))));
  await settle();
  stream().send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
  flushSync(() => dispatch({ type: "select", id: "room" }));
  await settle();
});
afterAll(() => {
  flushSync(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("a room on screen", () => {
  it("draws every bubble once", () => {
    expect(document.querySelectorAll("[data-mid]")).toHaveLength(120);
    expect(renders.bubbles).toBeGreaterThanOrEqual(120);
  });

  it("touches no saved row while members take turns streaming, changing status and handing over", async () => {
    // The window moves down as rows arrive, and its new first row takes the day's stamp.
    const savedRows = [...document.querySelectorAll("[data-mid]")].slice(8);
    let touched = 0;
    const count = (records: MutationRecord[]) => {
      for (const record of records) if (savedRows.some((row) => row.contains(record.target))) touched += record.addedNodes.length + record.removedNodes.length;
    };
    const watcher = new MutationObserver(count);
    watcher.observe(document.querySelector('[role="log"]')!, { childList: true, subtree: true });
    const runtime = (event: object) => send({ kind: "runtime", event: { provider: "claudeAgent", threadId: "room-thread", createdAt: new Date(at).toISOString(), ...event } });
    let listOnWords = 0;
    const savedIds = new Set(savedRows.map((row) => row.getAttribute("data-mid"))), turns = renderMark();
    for (const [botId, name, other] of [["a", "Ada", "Bea"], ["b", "Bea", "Ada"]] as const) {
      const turnId = `turn-${botId}`, itemId = `item-${botId}`;
      await runtime({ eventId: `start-${botId}`, turnId, type: "turn.started", botId });
      for (let i = 0; i < 6; i++) {
        const mark = renderMark();
        await runtime({ eventId: `${botId}${i}`, turnId, itemId, type: "content.delta", streamKind: "assistant_text", delta: `${name} asks @${other} word${i} `, botId });
        if (i > 0) listOnWords += renderedSince(mark).filter((entry) => entry.component === "Transcript").length;
        await send({ kind: "bot", bot: { ...announced(botId, name), busy: true, activity: i % 2 ? "working" : "thinking" } });
      }
      expect(document.querySelector(`[data-mid="live:${itemId}"]`)?.textContent, "the streaming row names whom it asks").toContain(other);
      await runtime({ eventId: `done-${botId}`, turnId, itemId, type: "item.completed", itemType: "assistant_text", text: `${name} is done`, botId });
      await send({ kind: "message", threadId: "room-thread", message: { id: `said-${botId}`, itemId, turnId, at: at + 200 + ++cursor, role: "bot", kind: "text", text: `${name} is done`, from: { botId, name, color: "green" } } });
      await runtime({ eventId: `end-${botId}`, turnId, type: "turn.completed", botId });
      await send({ kind: "bot", bot: { ...announced(botId, name), busy: false } });
      expect(document.querySelector(`[data-mid="said-${botId}"]`)?.textContent).toContain(`${name} is done`);
    }
    count(watcher.takeRecords());
    watcher.disconnect();
    expect(document.querySelectorAll('[data-mid^="live:"]')).toHaveLength(0);
    expect(listOnWords, "the room's list drawn for a word").toBe(0);
    expect(renderedSince(turns).filter((entry) => savedIds.has(entry.row) && /Avatar|ClusterLabel/.test(entry.component)), "saved rows' speakers").toEqual([]);
    expect(touched, "nodes replaced inside saved rows").toBe(0);
  });

  it("draws only the streaming bubble for each delta", async () => {
    flushSync(() => noteLiveReplyEvent({ eventId: "ts", provider: "claudeAgent", threadId: "room-thread", createdAt: new Date(at).toISOString(), turnId: "t1", type: "turn.started" } as RuntimeEvent));
    delta("Starting ");
    await settle();
    expect(document.querySelector('[data-mid^="live:"]')?.textContent).toContain("Starting");
    const before = renders.bubbles, mark = renderMark();
    for (let i = 0; i < 20; i++) delta(`word${i} `);
    await settle();
    expect(renders.bubbles - before).toBe(20);
    expect(renderedSince(mark).filter((entry) => entry.component === "Transcript"), "the room's list").toEqual([]);
    expect(renderedSince(mark).filter((entry) => entry.row !== null && !entry.row.startsWith("live:")), "saved rows").toEqual([]);
    expect(document.querySelector('[data-mid^="live:"]')?.textContent).toContain("word19");
  });

  it("draws no bubble for a store change none of them shows", async () => {
    const before = renders.bubbles;
    flushSync(() => dispatch({ type: "connected", value: false }));
    flushSync(() => dispatch({ type: "connected", value: true }));
    await send({ kind: "bot", bot: { ...announced("c", "Cy"), busy: true, activity: "working" } });
    await send({ kind: "message", threadId: "c-thread", message: { id: "c1", at: ++cursor, role: "bot", kind: "text", text: "c1" } });
    await send({ kind: "message", threadId: "a-thread", message: { id: "a1", at: ++cursor, role: "bot", kind: "text", text: "a1" } });
    await send({ kind: "bot", bot: { ...announced("a", "Ada"), busy: true, activity: "working" } });
    expect(renders.bubbles).toBe(before);
  });

  it("draws only the newest bubbles for a message saved in the room", async () => {
    const before = renders.bubbles;
    await send({ kind: "message", threadId: "room-thread", message: { id: "saved-1", at: at + ++cursor, role: "bot", kind: "text", text: "Saved", from: { botId: "b", name: "Bea", color: "green" } } });
    expect(document.querySelector('[data-mid="saved-1"]')).not.toBeNull();
    expect(renders.bubbles - before).toBeLessThanOrEqual(3);
  });

  it("draws no bubble again for a tool step saved in the room", async () => {
    const before = renders.bubbles;
    await send({ kind: "message", threadId: "room-thread", message: { id: "step-1", at: at + ++cursor, role: "bot", kind: "activity", tool: { name: "Read file" }, from: { botId: "a", name: "Ada", color: "green" } } });
    expect(document.querySelector('[data-mid="step-1"]')).not.toBeNull();
    expect(renders.bubbles - before).toBe(0);
  });

  it("draws no tool chip again for a delta or a store change it does not show", async () => {
    const chips = renders.chips;
    expect(chips).toBeGreaterThan(0);
    flushSync(() => noteLiveReplyEvent({ eventId: "ts2", provider: "claudeAgent", threadId: "room-thread", createdAt: new Date(at).toISOString(), turnId: "t2", type: "turn.started" } as RuntimeEvent));
    for (let i = 0; i < 5; i++) flushSync(() => noteLiveReplyEvent({
      eventId: `d2-${i}`, provider: "claudeAgent", threadId: "room-thread", createdAt: new Date(at).toISOString(), turnId: "t2", itemId: "y",
      type: "content.delta", streamKind: "assistant_text", delta: `more${i} `, botId: "a",
    } as RuntimeEvent));
    flushSync(() => dispatch({ type: "connected", value: false }));
    flushSync(() => dispatch({ type: "connected", value: true }));
    await settle();
    expect(document.querySelector('[data-mid^="live:"]')?.textContent).toContain("more4");
    expect(renders.chips).toBe(chips);
  });

  it("draws every bubble, tool chip and speaker line again in a new language", async () => {
    const before = renders.bubbles, chips = renders.chips, mark = renderMark();
    setLocale("de");
    try {
      flushSync(() => dispatch({ type: "connected", value: false }));
      await settle();
      expect(renders.bubbles - before).toBeGreaterThanOrEqual(120);
      expect(renders.chips).toBeGreaterThan(chips);
      expect(renderedSince(mark).filter((entry) => entry.component === "ClusterLabel").length, "speaker lines").toBeGreaterThan(20);
    } finally {
      setLocale("en");
      flushSync(() => dispatch({ type: "connected", value: true }));
      await settle();
    }
  });

  it("draws every bubble again when a member's name changes, which @-mentions show", async () => {
    const before = renders.bubbles;
    await send({ kind: "bot", bot: { ...announced("a", "Ada Lovelace"), busy: true, activity: "working" } });
    expect(renders.bubbles - before).toBeGreaterThanOrEqual(120);
  });
});
