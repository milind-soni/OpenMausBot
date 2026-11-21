// @vitest-environment happy-dom
// The real provider and live stream behind a parent that switches the page's language as App does: Settings, the
// routines calendar, a bot's settings, the command palette and the Inbox draw again in the new language, though App's
// redraws pass them by.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Action, BotAnnouncement, InstanceInfo } from "@/state/store";

const mode = vi.hoisted(() => ({ advanced: true }));
vi.mock("@/lib/interface-mode", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/interface-mode")>(), useAdvancedMode: () => mode.advanced }));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn(), analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));
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
const { effectiveLanguage, useLanguageChoice, usePageLanguage, setLanguageChoice } = await import("@/lib/language-preference");
const { activeLocale, t } = await import("@/lib/i18n");
const { SettingsModal, TriggersPage, BotSettingsDialog } = await import("./lazy-screens");
await Promise.all([SettingsModal.preload(), TriggersPage.preload(), BotSettingsDialog.preload()]);
const { CommandPalette, openCommandPalette } = await import("./CommandPalette");
const { InboxPanel } = await import("./inbox/InboxPanel");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

let surface: "settings" | "calendar" | "bot-settings" | "palette" | "inbox" | "none" = "none";
let dispatch!: (action: Action) => void;
const onBack = () => {}, onOpenRoom = () => {}, onOpenChange = () => {};
function App() {
  const { state, dispatch: storeDispatch } = useStore();
  dispatch = storeDispatch;
  usePageLanguage(effectiveLanguage(useLanguageChoice(), state.config?.language), true);
  const bot = state.bots.find((candidate) => candidate.id === state.selectedId);
  if (surface === "settings") return createElement(SettingsModal);
  if (surface === "calendar") return createElement(TriggersPage, { onBack, onOpenRoom });
  if (surface === "bot-settings") return bot ? createElement(BotSettingsDialog, { key: bot.id, bot, overlay: false }) : null;
  if (surface === "palette") return createElement(CommandPalette, { onOpenChange });
  if (surface === "inbox") return createElement(InboxPanel);
  return null;
}
let root: Root;
const task = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 60; i++) await task(); };
/** Brazilian Portuguese has every English string, so each surface's text changes. */
const speak = async (language: "en" | "pt-br") => {
  setLanguageChoice(language);
  await vi.waitFor(() => expect(activeLocale()).toBe(language));
  await settle();
};

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
afterAll(async () => {
  await speak("en");
  flushSync(() => root.unmount());
  vi.unstubAllGlobals();
});

const text = () => document.body.textContent ?? "";
async function open(next: typeof surface, action?: Action) {
  await speak("en");
  surface = next;
  flushSync(() => dispatch(action ?? { type: "connected", value: true }));
  await settle();
}

describe("a language switch", () => {
  it("draws the Inbox again in the new language", async () => {
    await open("inbox");
    expect(text()).toContain("Inbox");
    await speak("pt-br");
    expect(text()).toContain(t("inbox.panel.title"));
  });

  it("draws Settings again in the new language", async () => {
    await open("settings", { type: "toggleAppSettings", open: true, section: "general" });
    expect(text()).toContain("Settings");
    await speak("pt-br");
    expect(text()).toContain(t("settings.title"));
    flushSync(() => dispatch({ type: "toggleAppSettings", open: false }));
  });

  it("draws the routines calendar again in the new language, its sidebar and cards included", async () => {
    await open("calendar", { type: "showRoutines", view: "calendar" });
    const cards = () => [...document.querySelectorAll("[data-event-card]")].map((card) => card.getAttribute("aria-label"));
    const before = cards();
    expect(before.length).toBeGreaterThan(0);
    await speak("pt-br");
    expect(text()).toContain(t("routines.today"));
    expect(text()).toContain(t("routines.sidebar.myBots"));
    expect(cards()).not.toEqual(before);
    surface = "none";
  });

  it("draws a bot's settings again in the new language", async () => {
    mode.advanced = true;
    await open("bot-settings", { type: "toggleSettings", open: true, section: "overview" });
    expect(text()).toContain("Overview");
    await speak("pt-br");
    expect(text()).toContain(t("botSettings.sections.overview"));
    flushSync(() => dispatch({ type: "toggleSettings", open: false }));
  });

  it("draws the open command palette again in the new language", async () => {
    await open("palette");
    flushSync(() => openCommandPalette());
    await settle();
    const field = () => document.querySelector<HTMLInputElement>('[role="dialog"] input')?.placeholder;
    const before = field();
    await speak("pt-br");
    expect(field()).toBe(t("commandPalette.searchPlaceholder"));
    expect(field()).not.toBe(before);
  });
});
