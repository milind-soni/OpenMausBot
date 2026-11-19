// @vitest-environment happy-dom
// The real provider and live stream, a long chat on screen: a reply streaming in, or another bot at work, draws no saved row again.
import { countBy, renderMark, renderedSince } from "@/testing/render-counts";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BotAnnouncement, InstanceInfo, Message } from "@/state/store";

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

const DAY = 86_400_000;
const start = Date.UTC(2026, 10, 1, 9);
/** Sixty rows over a few days: asks, answers with a link, folded tool steps and work summaries. */
function transcript(): Message[] {
  const rows: Message[] = [];
  for (let turn = 0; turn < 10; turn++) {
    const at = start + turn * DAY / 3, turnId = `turn-${turn}`;
    rows.push({ id: `ask-${turn}`, role: "user", kind: "text", at, text: `Question ${turn}` });
    rows.push({ id: `note-${turn}`, role: "bot", kind: "text", at: at + 1_000, text: `Looking into ${turn}.`, turnId });
    rows.push({ id: `step-${turn}a`, role: "bot", kind: "activity", at: at + 2_000, tool: { name: "Bash", ok: true }, turnId });
    rows.push({ id: `step-${turn}b`, role: "bot", kind: "activity", at: at + 3_000, tool: { name: "Read", ok: true }, turnId });
    rows.push({ id: `answer-${turn}`, role: "bot", kind: "text", at: at + 9_000, text: `Answer ${turn}, see https://example.com/${turn}.`, turnId, turnTerminal: true });
    rows.push({ id: `digest-${turn}`, role: "bot", kind: "digest", at: at + 9_500, text: "", digest: {
      turnId, botId: "b", threadId: "b-thread", at: at + 9_500, durationMs: 9_000, tools: [{ name: "Bash", count: 1, failed: 0 }, { name: "Read", count: 1, failed: 0 }],
      memory: [], reply: "", hookCoverage: "preview",
    } } as Message);
  }
  return rows;
}

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const answers: Record<string, unknown> = {
  "/api/instances": { instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" }, models: { options: [{ id: "m", label: "Model" }] } } as unknown as InstanceInfo] },
  "/api/config": { features: { showToolCalls: true } },
  "/api/routines": { routines: [], runs: [] },
  "/api/webhooks": { webhooks: [], attempts: [] },
};

const { StoreProvider, useStore } = await import("@/state/store");
const { useStoreSelector } = await import("@/state/store-select");
const { ChatView } = await import("./ChatView");

let dispatch!: ReturnType<typeof useStore>["dispatch"];
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
const runtime = (threadId: string, event: object) => send({ kind: "runtime", event: {
  eventId: `e${++cursor}`, provider: "codex", threadId, turnId: "live-turn", createdAt: "2026-11-18T00:00:00.000Z", ...event,
} });
const say = (threadId: string, delta: string) => runtime(threadId, { type: "content.delta", streamKind: "assistant_text", delta, itemId: "live-item" });
const liveRow = () => document.querySelector('[data-mid^="live:"]');
let mounted = new Map<string, number>();

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string) => path.startsWith("/api/bots?")
    ? json({ bots: [{ ...announced("a", "Ada"), messages: [] }, { ...announced("b", "Bea"), messages: transcript() }], groups: [] })
    : json(answers[path.replace(/\?.*$/, "")] ?? {}));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const mark = renderMark();
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Shown), createElement(Shell))));
  await settle();
  stream().send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
  flushSync(() => dispatch({ type: "select", id: "b" }));
  await settle();
  mounted = countBy(renderedSince(mark), (entry) => entry.component);
});
afterAll(() => {
  flushSync(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("a long chat on screen", () => {
  it("draws every kind of row these checks watch", () => {
    expect(document.querySelectorAll("[data-mid]").length).toBeGreaterThan(30);
    for (const component of ["Bubble", "DigestChip", "TurnNarrationRun", "PublishedSiteCards", "DaySeparator", "ForkLinks"]) {
      expect(mounted.get(component) ?? 0, component).toBeGreaterThan(0);
    }
  });

  it("draws no saved row again while a reply streams in", async () => {
    await send({ kind: "bot", bot: { ...announced("b", "Bea"), busy: true, activity: "working" } });
    await runtime("b-thread", { type: "turn.started" });
    await say("b-thread", "Streaming ");
    expect(liveRow()?.textContent).toContain("Streaming");
    const mark = renderMark();
    for (let word = 0; word < 20; word++) await say("b-thread", `word${word} `);
    expect(liveRow()?.textContent).toContain("word19");
    const list = renderedSince(mark).filter((entry) => entry.component === "MessagesList" || (entry.row !== null && !entry.row.startsWith("live:")));
    expect(countBy(list, (entry) => entry.component), "neither the list nor a saved row draws again").toEqual(new Map());
    expect(renderedSince(mark).length, "the streaming row itself").toBeGreaterThan(0);
  });

  it("draws only the streamed row and the saved reply that takes its place", async () => {
    const mark = renderMark();
    await runtime("b-thread", { type: "item.completed", itemType: "assistant_text", itemId: "live-item", text: "Streaming done." });
    await send({ kind: "message", threadId: "b-thread", message: {
      id: "b-saved", itemId: "live-item", at: Date.now(), role: "bot", kind: "text", text: "Streaming done.", turnId: "live-turn", turnTerminal: true,
    } });
    expect(liveRow()).toBeNull();
    expect(document.querySelector('[data-mid="b-saved"]')?.textContent).toContain("Streaming done.");
    const rows = new Set(renderedSince(mark).flatMap((entry) => entry.row === null ? [] : [entry.row]));
    expect(rows).toEqual(new Set(["live:live-item", "b-saved"]));
    expect(renderedSince(mark).filter((entry) => entry.component === "TurnNarrationRun"), "a folded turn above").toEqual([]);
  });

  it("draws no row again while another bot works", async () => {
    const mark = renderMark();
    await send({ kind: "bot", bot: { ...announced("a", "Ada"), busy: true, activity: "working" } });
    await runtime("a-thread", { type: "turn.started" });
    for (let word = 0; word < 5; word++) await say("a-thread", `other${word} `);
    await send({ kind: "message", threadId: "a-thread", message: { id: "a1", at: start, role: "bot", kind: "text", text: "Done." } });
    await send({ kind: "bot", bot: { ...announced("a", "Ada"), busy: false, activity: "idle", tasks: [
      ...announced("a", "Ada").tasks!, { threadId: "a-fork", title: "Fork", createdAt: 2, approvalMode: "ask", origin: { threadId: "a-thread", messageId: "a1" } },
    ] } });
    flushSync(() => dispatch({ type: "connected", value: false }));
    flushSync(() => dispatch({ type: "connected", value: true }));
    await settle();
    expect(countBy(renderedSince(mark).filter((entry) => entry.row !== null), (entry) => entry.component)).toEqual(new Map());
  });
});
