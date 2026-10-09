// @vitest-environment happy-dom
// The Inspector and Activity panels follow the app's one live stream. They
// open no stream of their own: runtime events reach them from the stream the
// store already holds, and a gap the stream could not replay reloads them.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../../shared/runtime-events";
import type { AppState, Bot } from "@/state/store";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useCaptionChrome: () => ({ padClass: undefined }),
}));

const { InspectorPanel } = await import("./InspectorPanel");
const { ActivityPanel } = await import("./ActivityPanel");
const { BotEditorStore, initialState } = await import("@/state/store");
const { publishLiveFrame, publishMissedFrames } = await import("@/lib/live-events");

const opened = vi.fn();
class SpyEventSource {
  onopen = null;
  onerror = null;
  onmessage = null;
  constructor(url: string) { opened(url); }
  close() {}
}

const bot = {
  id: "bot", threadId: "thread", name: "Fixture", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "fake", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
} as unknown as Bot;
const runtime = (eventId: string, fields: Record<string, unknown>, threadId = "thread") => ({
  eventId, provider: "codex", threadId, createdAt: "2026-10-04T09:00:00.000Z", ...fields,
}) as RuntimeEvent;
// How the store hands frames on; the panels hear nothing else.
const frame = (event: RuntimeEvent) => publishLiveFrame({ kind: "runtime", event });
const missed = () => publishMissedFrames();

const fetched: string[] = [];
let root: Root;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
async function mount(panel: typeof InspectorPanel | typeof ActivityPanel) {
  const state: AppState = { ...initialState, bots: [bot], selectedId: bot.id };
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(panel, { bot }) })));
  await settle();
}

beforeEach(() => {
  opened.mockClear();
  fetched.length = 0;
  vi.stubGlobal("EventSource", SpyEventSource);
  vi.stubGlobal("fetch", (path: string) => {
    fetched.push(path);
    const body = path.startsWith("/api/threads/") ? { entries: [], total: { runtime: 0, native: 0 } } : { rows: [] };
    return Promise.resolve(new Response(JSON.stringify(body)));
  });
});
afterEach(() => {
  root.unmount();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("Inspector on the app's live stream", () => {
  it("shows this thread's runtime events and opens no stream of its own", async () => {
    await mount(InspectorPanel);
    const events = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "events")!;
    flushSync(() => events.click());
    flushSync(() => {
      frame(runtime("e1", { type: "item.started", itemType: "tool", title: "List the files" }));
      frame(runtime("e2", { type: "item.started", itemType: "tool", title: "Somebody else's step" }, "other-thread"));
    });
    await settle();
    expect(document.body.textContent).toContain("tool: List the files");
    expect(document.body.textContent).not.toContain("Somebody else's step");
    expect(opened).not.toHaveBeenCalled();
  });

  it("reloads from disk when the stream missed frames it could not replay", async () => {
    await mount(InspectorPanel);
    expect(fetched).toEqual(["/api/threads/thread/events?limit=400"]);
    missed();
    await settle();
    expect(fetched).toEqual(["/api/threads/thread/events?limit=400", "/api/threads/thread/events?limit=400"]);
  });
});

describe("Activity on the app's live stream", () => {
  it("reloads when one of the bot's turns settles, with no stream of its own", async () => {
    await mount(ActivityPanel);
    expect(fetched).toEqual(["/api/bots/bot/activity?limit=300"]);
    frame(runtime("e3", { type: "turn.completed", ok: true }, "other-thread"));
    frame(runtime("e4", { type: "turn.completed", ok: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));
    await settle();
    expect(fetched).toEqual(["/api/bots/bot/activity?limit=300", "/api/bots/bot/activity?limit=300"]);
    expect(opened).not.toHaveBeenCalled();
  });

  it("reloads when the stream missed frames it could not replay", async () => {
    await mount(ActivityPanel);
    missed();
    await settle();
    expect(fetched).toHaveLength(2);
  });
});
