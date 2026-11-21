// @vitest-environment happy-dom
// The real provider and live stream, with Settings, the routines calendar, a bot's settings, the command palette or the
// Inbox open behind a parent that reads the whole store as App does: another bot's turn draws none of them.
import { renderMark, renderedSince } from "@/testing/render-counts";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, AppSettingsSection, BotAnnouncement, BotSettingsSection, InstanceInfo } from "@/state/store";

const mode = vi.hoisted(() => ({ advanced: true }));
vi.mock("@/lib/interface-mode", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/interface-mode")>(), useAdvancedMode: () => mode.advanced }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn(), analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));
// What shows the time draws again as a minute turns; these counts are of store changes alone.
vi.mock("@/lib/minute-tick", () => ({ useMinuteTick: () => 0 }));
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

const announced = (i: number, extra: Partial<BotAnnouncement> = {}): BotAnnouncement => ({
  id: `b${i}`, threadId: `b${i}-thread`, name: `Bot ${i}`, title: "", description: "", notifications: true, unread: false, color: "green",
  modelSelection: { instanceId: "test", model: "m" }, section: i % 3 === 0 ? "Sales" : undefined,
  tasks: [{ threadId: `b${i}-thread`, title: "Chat", createdAt: 1, approvalMode: "ask" }], ...extra,
} as BotAnnouncement);
const at = Date.UTC(2026, 10, 18, 9);
const routines = Array.from({ length: 12 }, (_, i) => ({
  id: `r${i}`, name: `Routine ${i}`, prompt: "Do it.", target: "bot", botId: `b${i % 12}`, runOn: "maus", enabled: true,
  schedule: { type: "daily", time: `${String(8 + (i % 10)).padStart(2, "0")}:00`, weekdays: [0, 1, 2, 3, 4, 5, 6] }, durationMinutes: 30,
  nextRunAt: at + 3_600_000, createdAt: 0, updatedAt: 0,
}));
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const answers: Record<string, unknown> = {
  "/api/instances": { instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" }, models: { default: "m", options: [{ id: "m", label: "Model" }] } } as unknown as InstanceInfo] },
  "/api/config": {
    anthropic: { configured: true }, composio: { configured: false }, box: { configured: false }, vps: { configured: false, sshAlias: "" },
    rooms: { turnTimeoutMinutes: 10 }, mcp: { callTimeoutMinutes: 5 }, threads: { maxConcurrentPerBot: 3 }, localVm: { mode: "shared", maxInstances: 1 },
    profile: { name: "Ada", email: "ada@example.com", aboutMe: "" }, features: {}, edition: { edition: "community", features: [] }, browserProfiles: [],
    budgets: {}, billing: { currency: "USD", prices: {} }, pausedBots: [], heldBots: [], newBots: {},
  },
  "/api/routines": { routines, runs: [] },
  "/api/webhooks": { webhooks: [], attempts: [] },
  "/api/profile/learned": { learned: [] },
  "/api/themes": { themes: [] },
  "/api/themes/history": { items: [] },
};
const missing = () => Promise.resolve(new Response(JSON.stringify({ error: "not in this fixture" }), { status: 404 }));

const { StoreProvider, useStore } = await import("@/state/store");
const { SettingsModal, TriggersPage, BotSettingsDialog } = await import("./lazy-screens");
await Promise.all([SettingsModal.preload(), TriggersPage.preload(), BotSettingsDialog.preload()]);
const { CommandPalette, openCommandPalette } = await import("./CommandPalette");
const { InboxPanel } = await import("./inbox/InboxPanel");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

type Surface = "settings" | "calendar" | "bot-settings" | "palette" | "inbox" | "none";
let surface: Surface = "none";
let dispatch!: (action: Action) => void;
const onBack = () => {}, onOpenRoom = () => {}, onOpenChange = () => {};
function App() {
  const { state, dispatch: storeDispatch } = useStore();
  dispatch = storeDispatch;
  const bot = state.bots.find((candidate) => candidate.id === state.selectedId);
  if (surface === "settings") return createElement(SettingsModal);
  if (surface === "calendar") return createElement(TriggersPage, { onBack, onOpenRoom });
  if (surface === "bot-settings") return bot ? createElement(BotSettingsDialog, { key: bot.id, bot, overlay: false }) : null;
  if (surface === "palette") return createElement(CommandPalette, { onOpenChange });
  if (surface === "inbox") return createElement(InboxPanel);
  return null;
}

let root: Root;
let cursor = 0;
const task = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 30; i++) await task(); };
const send = async (frame: object) => { FixtureEventSource.opened[0]!.send(frame, `run:${++cursor}`); await settle(); };
const background = (busy: boolean) => send({ kind: "bot", bot: announced(7, busy ? { busy: true, activity: "working" } : { busy: false, activity: "idle" }) });

async function show(next: Surface, setUp: () => void = () => {}) {
  surface = next;
  flushSync(setUp);
  flushSync(() => dispatch({ type: "connected", value: false }));
  flushSync(() => dispatch({ type: "connected", value: true }));
  await settle();
  // The selected bot's own motion ends with the first move of another bot: that one draw is not what is counted here.
  await background(false);
}

/** The components drawn while another bot works: it goes busy, its turn adds and patches a message, it goes idle. */
async function drawnByAnotherBotsTurn(): Promise<string[]> {
  const mark = renderMark();
  await background(true);
  await send({ kind: "message", threadId: "b7-thread", message: { id: `m${cursor}`, at: at + cursor, role: "bot", kind: "activity", tool: { name: "Bash" } } });
  await send({ kind: "message.patch", threadId: "b7-thread", message: { id: `m${cursor - 1}`, at: at + cursor, role: "bot", kind: "activity", tool: { name: "Bash", ok: true } } });
  await background(false);
  return renderedSince(mark).map((entry) => entry.component).filter((name) => name !== "App" && name !== "StoreProvider");
}

beforeAll(async () => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (input: string) => {
    const path = String(input).replace(/\?.*$/, "");
    if (path === "/api/bots") return json({ bots: Array.from({ length: 12 }, (_, i) => ({ ...announced(i), messages: [] })), groups: [] });
    if (path in answers) return json(answers[path]);
    return /^\/api\/bots\/[^/]+\/overview$/.test(path) ? missing() : json({});
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(App))));
  await settle();
  FixtureEventSource.opened[0]!.send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
  flushSync(() => dispatch({ type: "select", id: "b0" }));
  await settle();
});
afterAll(() => {
  flushSync(() => root.unmount());
  vi.unstubAllGlobals();
});
beforeEach(async () => { await show("none"); });

describe("another bot's turn", () => {
  for (const advanced of [true, false]) for (const section of ["overview", "ai", "bots", "general"] as AppSettingsSection[]) {
    it(`draws nothing in Settings → ${section}${advanced ? "" : " (Simple)"}`, async () => {
      mode.advanced = advanced;
      await show("settings", () => dispatch({ type: "toggleAppSettings", open: true, section }));
      expect(document.querySelector("[data-settings-page-body]")).not.toBeNull();
      expect(await drawnByAnotherBotsTurn()).toEqual([]);
      flushSync(() => dispatch({ type: "toggleAppSettings", open: false }));
    });
  }

  it("draws nothing on the routines calendar, its cards included", async () => {
    mode.advanced = true;
    await show("calendar", () => dispatch({ type: "showRoutines", view: "calendar" }));
    expect(document.querySelectorAll("[data-event-card]").length).toBeGreaterThan(0);
    expect(await drawnByAnotherBotsTurn()).toEqual([]);
  });

  for (const advanced of [true, false]) for (const section of ["overview", "model", "permissions", "access"] as BotSettingsSection[]) {
    it(`draws nothing in the selected bot's settings → ${section}${advanced ? "" : " (Simple)"}`, async () => {
      mode.advanced = advanced;
      await show("bot-settings", () => dispatch({ type: "toggleSettings", open: true, section }));
      expect(await drawnByAnotherBotsTurn()).toEqual([]);
      flushSync(() => dispatch({ type: "toggleSettings", open: false }));
    });
  }

  it("draws nothing in the command palette, closed or open", async () => {
    await show("palette");
    expect(await drawnByAnotherBotsTurn()).toEqual([]);
    flushSync(() => openCommandPalette());
    await settle();
    expect(document.querySelectorAll('[role="dialog"] button').length).toBeGreaterThan(0);
    expect(await drawnByAnotherBotsTurn()).toEqual([]);
  });

  it("draws nothing in the Inbox for a patched message that moves no conversation", async () => {
    await show("inbox");
    const mark = renderMark();
    await send({ kind: "message.patch", threadId: "b7-thread", message: { id: "never-added", at, role: "bot", kind: "activity", tool: { name: "Bash", ok: true } } });
    expect(renderedSince(mark).map((entry) => entry.component).filter((name) => name !== "App" && name !== "StoreProvider")).toEqual([]);
  });
});
