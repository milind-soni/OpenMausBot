// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppTrigger } from "@/lib/app-triggers";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  api: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  api: (...args: unknown[]) => fixture.api(...args),
}));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => false }));

const { NewAutomation } = await import("./NewAutomation");
const { AppEventEditor } = await import("./AppEventEditor");
const { AutomationPanel } = await import("./AutomationPanel");
const { automationsFrom } = await import("@/lib/automations");
const { applyAppTriggerSnapshot } = await import("@/lib/app-triggers");

const now = Date.now();
const scout = { id: "bot-a", name: "Scout", threadId: "thread-a", hidden: false, messages: [] } as unknown as Bot;
const catalog = {
  apps: [{
    app: "gmail", name: "Gmail", accounts: [{ id: "ca_1", alias: "sales" }],
    events: [{ event: "GMAIL_NEW_GMAIL_MESSAGE", name: "New Gmail message", description: "", delivery: "poll", configFields: [], filterFields: ["sender", "subject"] }],
  }],
  notConnected: [{ app: "slack", name: "Slack" }],
};
const acme: AppTrigger = {
  id: "acme", name: "Acme replies", prompt: "Draft a reply.", botId: "bot-a", runOn: "maus", enabled: true, app: "gmail", appName: "Gmail",
  event: "GMAIL_NEW_GMAIL_MESSAGE", eventName: "New Gmail message", delivery: "poll", accountId: "ca_1", config: { query: "from:acme.com" },
  filter: { from: "acme.com" }, remote: { triggerId: "ti_1", state: "active" }, received: 1, filtered: 0, createdAt: now, updatedAt: now,
  skipped: { day: new Date().toISOString().slice(0, 10), dailyLimit: 12, queueFull: 0, expired: 0, tooMany: 0 },
};

let root: Root | null = null;
function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(element));
  return container;
}
const button = (container: HTMLElement, label: string) => {
  const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`no ${label} button in ${container.innerHTML}`);
  return found;
};
const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
beforeEach(() => {
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.state = { bots: [scout], selectedId: "", routines: [], webhooks: [], routineRuns: [], config: null, instances: [] };
});
afterEach(() => { root?.unmount(); root = null; document.body.innerHTML = ""; });

describe("app events, set up by the person", () => {
  it("offers \"When something happens in an app\" under Set it up yourself", () => {
    const onSetUpYourself = vi.fn();
    const container = mount(createElement(NewAutomation, { onClose: vi.fn(), onSetUpYourself }));
    flushSync(() => button(container, "Set it up yourself").click());
    flushSync(() => button(container, "When something happens in an app").click());
    flushSync(() => button(container, "Continue").click());
    expect(onSetUpYourself).toHaveBeenCalledWith("app", "bot-a");
  });

  it("starts with the bot the New box chose, as the schedule and webhook editors do", async () => {
    const writer = { ...scout, id: "bot-b", name: "Writer", threadId: "thread-b" } as unknown as Bot;
    fixture.api.mockResolvedValue(catalog);
    mount(createElement(AppEventEditor, { bots: [scout, writer], initialBotId: "bot-b", onClose: vi.fn() }));
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledWith("/api/app-triggers/events?botId=bot-b"));
    expect(fixture.api).not.toHaveBeenCalledWith("/api/app-triggers/events?botId=bot-a");
  });

  it("picks from the bot's connected apps, filters in plain words, and creates it", async () => {
    fixture.api.mockImplementation(async (path: unknown) => {
      if (String(path).startsWith("/api/app-triggers/events")) return catalog;
      return { trigger: acme };
    });
    const onSaved = vi.fn();
    const container = mount(createElement(AppEventEditor, { bots: [scout], onClose: vi.fn(), onSaved }));
    await vi.waitFor(() => expect(container.querySelector('select[aria-label="App"]')).not.toBeNull());
    expect(fixture.api).toHaveBeenCalledWith("/api/app-triggers/events?botId=bot-a");
    expect([...container.querySelectorAll('select[aria-label="App"] option')].map((option) => option.textContent)).toEqual(["Gmail"]);
    expect(container.textContent).toContain("Checks for new ones every 15 minutes.");
    type(container.querySelector('input[placeholder="acme.com"]') as HTMLInputElement, "acme.com");
    type(container.querySelector("textarea") as HTMLTextAreaElement, "Draft a reply.");
    flushSync(() => button(container, "Set it up").click());
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [, init] = fixture.api.mock.calls.find(([path]) => path === "/api/app-triggers") as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ botId: "bot-a", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE", prompt: "Draft a reply.", filter: { from: "acme.com" } });
  });

  it("points to connecting an app when the bot has none with events", async () => {
    fixture.api.mockResolvedValue({ apps: [], notConnected: catalog.notConnected });
    const container = mount(createElement(AppEventEditor, { bots: [scout], onClose: vi.fn() }));
    await vi.waitFor(() => expect(container.textContent).toContain("No connected app this bot may use has events yet."));
    flushSync(() => button(container, "Connect an app").click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "togglePlugins", open: true, surface: "apps" });
  });
});

describe("the panel of an app-event automation", () => {
  it("shows recent events, what was skipped today, the day's limit, and Reconnect when the connection expired", () => {
    applyAppTriggerSnapshot({
      triggers: [acme],
      attempts: [{ id: "x", triggerId: "acme", eventId: "m1", at: now - 60_000, outcome: "started", runId: "r", preview: "From Ada · Order #1042" }],
      service: { available: true, plan: "desktop", eventsPerDay: 500, eventsToday: 500 },
    });
    const [automation] = automationsFrom({ routines: [], webhooks: [], appTriggers: [{ ...acme, problem: { kind: "reconnect", at: now } }], runs: [] });
    const container = mount(createElement(AutomationPanel, { automation: automation!, sentence: "When you get an email from acme.com, Scout drafts a reply", onClose: vi.fn(), onEdit: vi.fn(), onDeleted: vi.fn() }));
    const text = container.textContent ?? "";
    expect(text).toContain("Recent events");
    expect(text).toContain("Started a run · From Ada · Order #1042");
    expect(text).toContain("12 skipped today: daily limit");
    expect(text).toContain("Up to 500 app events a day on this computer.");
    expect(text).toContain("Gmail needs to be reconnected.");
    flushSync(() => button(container, "Reconnect").click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "togglePlugins", open: true, surface: "apps" });
    expect(text).not.toMatch(/webhook|endpoint|payload|composio|trigger/i);
  });

  it("pauses, tests and deletes through the app-event routes", async () => {
    fixture.api.mockResolvedValue({ trigger: { ...acme, enabled: false } });
    const [automation] = automationsFrom({ routines: [], webhooks: [], appTriggers: [acme], runs: [] });
    const container = mount(createElement(AutomationPanel, { automation: automation!, sentence: "s", onClose: vi.fn(), onEdit: vi.fn(), onDeleted: vi.fn() }));
    flushSync(() => button(container, "Pause").click());
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledWith("/api/app-triggers/acme", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: false }) })));
    await vi.waitFor(() => expect(button(container, "Run now").hasAttribute("disabled")).toBe(false));
    flushSync(() => button(container, "Run now").click());
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledWith("/api/app-triggers/acme/test", expect.objectContaining({ method: "POST" })));
    await vi.waitFor(() => expect(button(container, "Delete").hasAttribute("disabled")).toBe(false));
    window.confirm = () => true;
    flushSync(() => button(container, "Delete").click());
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledWith("/api/app-triggers/acme", expect.objectContaining({ method: "DELETE" })));
  });
});
