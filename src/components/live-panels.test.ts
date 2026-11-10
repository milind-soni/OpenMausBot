// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../../shared/runtime-events";
import type { AppState, Bot } from "@/state/store";
import { setLocale } from "@/lib/i18n";

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
  const render = (next: Bot) => flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(panel, { bot: next }) })));
  render(bot);
  await settle();
  return render;
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
  setLocale("en");
});

describe("Inspector on the app's live stream", () => {
  it("retains a distinct equal-time live event received before a later refresh", async () => {
    await mount(InspectorPanel);
    const events = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "events")!;
    flushSync(() => events.click());
    frame(runtime("before-equal", { type: "item.started", itemType: "tool", title: "pre-refresh equal tail" }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("pre-refresh equal tail"));
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({
      entries: [{ kind: "runtime", at: "2026-10-04T09:00:00.000Z", data: runtime("disk-equal", { type: "item.started", itemType: "tool", title: "equal disk snapshot" }) }],
      total: { runtime: 1, native: 0 },
    }))));
    missed();
    await vi.waitFor(() => expect(document.body.textContent).toContain("equal disk snapshot"));
    expect(document.body.textContent).toContain("pre-refresh equal tail");
    expect(document.querySelectorAll('button .tabular-nums')).toHaveLength(2);
    expect(document.body.textContent).toContain("2 entries");
    missed();
    await settle();
    expect(document.querySelectorAll('button .tabular-nums')).toHaveLength(2);
    expect(document.body.textContent).toContain("2 entries");
  });

  it("buffers distinct equal-time live events during the initial snapshot load", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { finish = resolve; }));
    await mount(InspectorPanel);
    const events = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "events")!;
    flushSync(() => events.click());
    frame(runtime("initial-live", { type: "item.started", itemType: "tool", title: "equal time live tail" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    finish(new Response(JSON.stringify({
      entries: [{ kind: "runtime", at: "2026-10-04T09:00:00.000Z", data: runtime("initial-disk", { type: "item.started", itemType: "tool", title: "equal time disk row" }) }],
      total: { runtime: 1, native: 0 },
    })));
    await vi.waitFor(() => expect(document.body.textContent).toContain("equal time disk row"));
    await vi.waitFor(() => expect(document.body.textContent).toContain("equal time live tail"));
    expect(document.querySelectorAll('button .tabular-nums')).toHaveLength(2);
    expect(document.body.textContent).toContain("2 entries");
  });

  it("deduplicates live events already present in the initial snapshot", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { finish = resolve; }));
    await mount(InspectorPanel);
    const events = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "events")!;
    flushSync(() => events.click());
    const overlap = runtime("initial-overlap", { type: "item.started", itemType: "tool", title: "initial overlap" });
    frame(overlap);
    finish(new Response(JSON.stringify({
      entries: [{ kind: "runtime", at: overlap.createdAt, data: overlap }], total: { runtime: 40, native: 0 },
    })));
    await vi.waitFor(() => expect(document.body.textContent).toContain("initial overlap"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(document.querySelectorAll('button .tabular-nums')).toHaveLength(1);
    expect(document.body.textContent).toContain("last 1 of 40");
  });

  it("keeps the initial live tail when the first snapshot fails", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { finish = resolve; }));
    await mount(InspectorPanel);
    const events = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "events")!;
    flushSync(() => events.click());
    frame(runtime("initial-failed", { type: "item.started", itemType: "tool", title: "live despite failure" }));
    finish(new Response("", { status: 503 }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("live despite failure"));
    expect(document.body.textContent).toContain("503");
    expect(document.querySelectorAll('button .tabular-nums')).toHaveLength(1);
  });

  it("keeps live events missing from a stale refresh snapshot, including an unflushed batch", async () => {
    await mount(InspectorPanel);
    const events = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "events")!;
    flushSync(() => events.click());
    frame(runtime("before-refresh", { type: "item.started", itemType: "tool", title: "not on disk yet" }));
    missed();
    await settle();
    await vi.waitFor(() => expect(document.body.textContent).toContain("not on disk yet"));
    expect(document.querySelectorAll('button .tabular-nums')).toHaveLength(1);
    missed();
    await settle();
    expect(document.body.textContent).toContain("not on disk yet");
    expect(document.querySelectorAll('button .tabular-nums')).toHaveLength(1);
  });

  it("does not expand a replacement native record after refresh, while keeping runtime expansion", async () => {
    let nativeMessage = "first private record";
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({
      entries: [
        { kind: "runtime", at: "1", data: runtime("keep-open", { type: "item.started", itemType: "tool", title: "retained runtime" }) },
        { kind: "native", at: nativeMessage, data: { at: nativeMessage, dir: "out", source: "fixture", msg: { secretDetail: nativeMessage } } },
      ],
      total: { runtime: 1, native: 400 },
    }))));
    await mount(InspectorPanel);
    const tab = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) => el.textContent === name)!;
    const row = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.includes(text))!;
    flushSync(() => tab("events").click());
    flushSync(() => row("retained runtime").click());
    expect(document.querySelector("pre")?.textContent).toContain("keep-open");
    flushSync(() => tab("raw").click());
    flushSync(() => row("fixture").click());
    expect(document.querySelector("pre")?.textContent).toContain("first private record");
    frame(runtime("live-only", { type: "item.started", itemType: "tool", title: "live update" }));
    flushSync(() => tab("events").click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("live update"));
    flushSync(() => tab("raw").click());
    expect(document.querySelector("pre")?.textContent).toContain("first private record");
    nativeMessage = "replacement private record";
    missed();
    await vi.waitFor(() => expect(document.body.textContent).toContain("replacement private record"));
    expect(document.querySelector("pre")).toBeNull();
    flushSync(() => tab("events").click());
    expect(document.querySelector("pre")?.textContent).toContain("keep-open");
  });

  it("keeps a native record expanded when reloading its snapshot fails", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({
      entries: [{ kind: "native", at: "1", data: { at: "1", dir: "out", source: "fixture", msg: { detail: "still the same record" } } }],
      total: { runtime: 0, native: 1 },
    }))));
    await mount(InspectorPanel);
    const raw = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) => el.textContent === "raw")!;
    flushSync(() => raw.click());
    const row = [...document.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.includes("fixture"))!;
    flushSync(() => row.click());
    const expanded = document.querySelector("pre");
    expect(expanded?.textContent).toContain("still the same record");
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("", { status: 503 })));
    missed();
    await vi.waitFor(() => expect(document.body.textContent).toContain("503"));
    expect(document.querySelector("pre")).toBe(expanded);
  });

  it("keeps only the newest 400 runtime entries during a long turn, with its total and raw snapshot", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({
      entries: [{ kind: "native", at: "2026-10-04T09:00:00.000Z", data: { at: "2026-10-04T09:00:00.000Z", dir: "out", source: "fixture", msg: { type: "raw retained" } } }],
      total: { runtime: 700, native: 12 },
    }))));
    await mount(InspectorPanel);
    const events = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "events")!;
    flushSync(() => events.click());
    flushSync(() => {
      for (let i = 0; i < 1_000; i++) frame(runtime(`bounded-${i}`, { type: "item.started", itemType: "tool", title: `long step ${i}` }));
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("long step 999"));
    expect(document.body.textContent).not.toContain("long step 599");
    expect(document.body.textContent).toContain("long step 600");
    expect(document.body.textContent).toContain("1700");
    expect(document.querySelectorAll('button .tabular-nums')).toHaveLength(400);
    flushSync(() => {
      frame(runtime("bounded-999", { type: "item.started", itemType: "tool", title: "duplicated tail" }));
      frame(runtime("bounded-1000", { type: "item.started", itemType: "tool", title: "next batch" }));
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("next batch"));
    expect(document.body.textContent).not.toContain("duplicated tail");
    expect(document.body.textContent).toContain("1701");
    const raw = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "raw")!;
    flushSync(() => raw.click());
    expect(document.body.textContent).toContain("raw retained");
  });

  it("shows this thread's runtime events and opens no stream of its own", async () => {
    await mount(InspectorPanel);
    const events = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "events")!;
    flushSync(() => events.click());
    flushSync(() => {
      frame(runtime("e1", { type: "item.started", itemType: "tool", title: "List the files" }));
      frame(runtime("e2", { type: "item.started", itemType: "tool", title: "Somebody else's step" }, "other-thread"));
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("tool: List the files"));
    expect(document.body.textContent).not.toContain("Somebody else's step");
    expect(opened).not.toHaveBeenCalled();
  });

  it("merges events received during a reload once and keeps the new live tail", async () => {
    await mount(InspectorPanel);
    const events = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "events")!;
    flushSync(() => events.click());
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { finish = resolve; }));
    missed();
    frame(runtime("overlap", { type: "item.started", itemType: "tool", title: "in both sources" }));
    frame(runtime("tail", { type: "item.started", itemType: "tool", title: "after snapshot" }));
    finish(new Response(JSON.stringify({
      entries: [{ kind: "runtime", at: "2026-10-04T09:00:00.000Z", data: runtime("overlap", { type: "item.started", itemType: "tool", title: "in both sources" }) }],
      total: { runtime: 70, native: 0 },
    })));
    await vi.waitFor(() => expect(document.body.textContent).toContain("after snapshot"));
    expect(document.querySelectorAll('button .tabular-nums')).toHaveLength(2);
    expect(document.body.textContent).toContain("71");
  });

  it("lets only the newest refresh merge its buffered tail", async () => {
    await mount(InspectorPanel);
    const events = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "events")!;
    flushSync(() => events.click());
    frame(runtime("before", { type: "item.started", itemType: "tool", title: "before either fetch" }));
    const finishes: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { finishes.push(resolve); }));
    missed();
    frame(runtime("during", { type: "item.started", itemType: "tool", title: "during both fetches" }));
    missed();
    const snapshot = { entries: [], total: { runtime: 0, native: 0 } };
    finishes[1](new Response(JSON.stringify(snapshot)));
    await vi.waitFor(() => expect(document.body.textContent).toContain("during both fetches"));
    finishes[0](new Response(JSON.stringify(snapshot)));
    await settle();
    expect(document.body.textContent).toContain("before either fetch");
    expect(document.body.textContent).toContain("during both fetches");
    expect(document.querySelectorAll('button .tabular-nums')).toHaveLength(2);
  });

  it("cancels the old thread's queued batch when switching conversations", async () => {
    const render = await mount(InspectorPanel);
    frame(runtime("old", { type: "item.started", itemType: "tool", title: "old queued work" }));
    render({ ...bot, threadId: "next-thread" });
    const events = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "events")!;
    flushSync(() => events.click());
    frame(runtime("next", { type: "item.started", itemType: "tool", title: "next thread work" }, "next-thread"));
    await vi.waitFor(() => expect(document.body.textContent).toContain("next thread work"));
    expect(document.body.textContent).not.toContain("old queued work");
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
  it.each([["en", "Email"], ["pt-br", "E-mail"]])("shows the email app in %s without translating the tool identifier", async (language, app) => {
    setLocale(language);
    const tool = "mcp__email__EMAIL_SEND_EMAIL";
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({ rows: [{
      at: "2026-10-04T09:00:00.000Z", threadId: "thread", tool, app: "Email", appKey: "activity.app.email", label: "Send email", outcome: "ran",
    }] }))));
    await mount(ActivityPanel);
    const line = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.title === tool)!;
    expect(line.querySelector(".font-medium")?.textContent).toBe(app);
    expect(line.textContent).toContain("Send email");
    expect(line.title).toBe(tool);
  });

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

  it("still reloads when the bot changes while a settled turn waits", async () => {
    const render = await mount(ActivityPanel);
    frame(runtime("e5", { type: "turn.completed", ok: true }));
    render({ ...bot, unread: true, tasks: [...bot.tasks!] });
    await new Promise((resolve) => setTimeout(resolve, 450));
    await settle();
    expect(fetched).toHaveLength(2);
  });

  it("reloads when the stream missed frames it could not replay", async () => {
    await mount(ActivityPanel);
    missed();
    await settle();
    expect(fetched).toHaveLength(2);
  });
});
