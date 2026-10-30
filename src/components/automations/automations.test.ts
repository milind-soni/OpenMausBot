// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveWebhookCredential } from "@/lib/webhook-credentials";
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
const copied = vi.hoisted(() => ({ texts: [] as string[] }));
const credentials = vi.hoisted(() => {
  const items = new Map<string, string>();
  return { items, store: { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); }, removeItem: (key: string) => { items.delete(key); } } };
});
vi.mock("@/lib/webhook-credentials", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/webhook-credentials")>(),
  webhookCredentialStore: () => credentials.store,
}));
vi.mock("@/lib/copy-text", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/copy-text")>(),
  copyText: async (text: string) => { copied.texts.push(text); return "copied"; },
}));

const { NewAutomation, defaultBot } = await import("./NewAutomation");
const { AutomationPanel } = await import("./AutomationPanel");
const { TriggersPage } = await import("../TriggersPage");
const { AutomationsCalendar } = await import("./AutomationsCalendar");
const { automationsFrom } = await import("@/lib/automations");

const now = Date.now();
const botA = { id: "bot-a", name: "Scout", threadId: "thread-a", hidden: false, messages: [{ id: "m1", at: now - 5_000 }] } as unknown as Bot;
const botB = { id: "bot-b", name: "Ledger", threadId: "thread-b", hidden: false, messages: [{ id: "m2", at: now - 50_000 }] } as unknown as Bot;
const webhook = { id: "hook-1", endpointId: "wh_abc", name: "Sales form leads", prompt: "Draft a follow-up for the lead.", botId: "bot-a", runOn: "maus", enabled: true, createdAt: now, updatedAt: now, deliveryCount: 1 };

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
beforeEach(() => {
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.api.mockResolvedValue({});
  fixture.state = { hydrated: true, bots: [botA, botB], selectedId: "", routines: [], webhooks: [webhook], routineRuns: [], webhookAttempts: [], routinesLoadState: "ready", webhookIngress: { available: true, baseUrl: "http://127.0.0.1:8800" } };
});
afterEach(() => { root?.unmount(); root = null; document.body.innerHTML = ""; });

describe("+ New", () => {
  it("talks to the bot open now, else the one most recently talked to", () => {
    expect(defaultBot([botA, botB], "bot-b")?.id).toBe("bot-b");
    expect(defaultBot([botB, botA], "")?.id).toBe("bot-a");
  });

  it("sends what should happen to that bot as a normal chat message and opens the conversation", () => {
    const onClose = vi.fn();
    const container = mount(createElement(NewAutomation, { initialText: "every morning at 9, send me a summary of my inbox", onClose, onSetUpYourself: vi.fn() }));
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("e.g. every morning at 9, send me a summary of my inbox");
    expect(container.querySelector('select[aria-label="Who should do it?"]')).not.toBeNull();
    flushSync(() => button(container, "Set it up").click());
    expect(fixture.dispatch).toHaveBeenNthCalledWith(1, { type: "select", id: "bot-a" });
    expect(fixture.dispatch).toHaveBeenNthCalledWith(2, { type: "send", botId: "bot-a", text: "every morning at 9, send me a summary of my inbox", threadId: "thread-a" });
    expect(onClose).toHaveBeenCalled();
  });

  it("asks no bot question with one bot, and does nothing until something is written", () => {
    fixture.state.bots = [botA];
    const container = mount(createElement(NewAutomation, { onClose: vi.fn(), onSetUpYourself: vi.fn() }));
    expect(container.querySelector("select")).toBeNull();
    expect(button(container, "Set it up").hasAttribute("disabled")).toBe(true);
  });

  it("lets a person set it up themselves: a schedule, or when another app sends something", () => {
    const onSetUpYourself = vi.fn();
    const container = mount(createElement(NewAutomation, { onClose: vi.fn(), onSetUpYourself }));
    flushSync(() => button(container, "Set it up yourself").click());
    flushSync(() => button(container, "When another app sends something").click());
    flushSync(() => button(container, "Continue").click());
    expect(onSetUpYourself).toHaveBeenCalledWith("webhook", "bot-a");
  });
});

describe("the automation panel", () => {
  it("shows the sentence, the status, an address to paste with Copy address, the recent runs and the four actions, in plain words", () => {
    fixture.state.routineRuns = [{ id: "run-1", routineId: "hook-1", botId: "bot-a", status: "completed", scheduledFor: now - 60_000, startedAt: now - 60_000, createdAt: now - 60_000, output: "Drafted a follow-up for Ada.", threadId: "exec-1" }];
    const [automation] = automationsFrom({ routines: [], webhooks: [webhook] as never, runs: fixture.state.routineRuns as never });
    const container = mount(createElement(AutomationPanel, { automation: automation!, sentence: "When your sales form sends something, Scout drafts a follow-up for the lead", onClose: vi.fn(), onEdit: vi.fn(), onDeleted: vi.fn() }));
    const text = container.textContent ?? "";
    expect(container.querySelector("h2")!.textContent).toBe("Sales form leads");
    expect(container.querySelector("h2 + p")!.textContent).toBe("When your sales form sends something, Scout drafts a follow-up for the lead");
    expect(container.querySelector("[data-automation-status]")!.textContent).toContain("On");
    expect(text).not.toContain("Working");
    expect(text).toContain("Paste this address into the other app");
    expect(text).toContain("Recent runs");
    expect(text).toMatch(/Today [^✓]*✓Drafted a follow-up for Ada\./);
    for (const label of ["Copy address", "Run now", "Pause", "Edit", "Delete"]) expect(button(container, label)).toBeTruthy();
    expect(container.querySelector("details summary")!.textContent).toBe("More");
    expect(container.querySelector("details")!.textContent).toContain("Show secret / settings");
    const visible = text.replace(container.querySelector("details")!.textContent ?? "", "");
    expect(visible).not.toMatch(/webhook|endpoint|payload|fired|trigger/i);
  });

  it("runs now through the test route, and pauses through its own API", async () => {
    const [automation] = automationsFrom({ routines: [], webhooks: [webhook] as never, runs: [] });
    const container = mount(createElement(AutomationPanel, { automation: automation!, sentence: "s", onClose: vi.fn(), onEdit: vi.fn(), onDeleted: vi.fn() }));
    flushSync(() => button(container, "Run now").click());
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledWith("/api/webhooks/hook-1/test", expect.objectContaining({ method: "POST" })));
    expect(container.textContent).toContain("It hasn't run yet.");
  });
});

describe("a routine's panel", () => {
  it("is titled with the routine's name, says when it runs and who runs it, and shows its whole instructions", () => {
    const prompt = "Every weekday at 9 AM, search for the latest AI news from the last 24 hours (new models, funding, research) and send a 5-bullet brief, each with a source link.";
    const routine = { id: "routine-1", name: "Daily AI News Brief", prompt, botId: "bot-a", runOn: "maus", enabled: true, createdAt: now, updatedAt: now,
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, nextRunAt: now + 86_400_000, durationMinutes: 30 };
    const [automation] = automationsFrom({ routines: [routine] as never, webhooks: [], runs: [] });
    const container = mount(createElement(AutomationPanel, { automation: automation!, sentence: "Every weekday at 9 AM, Scout searches for the latest AI news from the last 24 hours (new…", onClose: vi.fn(), onEdit: vi.fn(), onDeleted: vi.fn() }));
    expect(container.querySelector("h2")!.textContent).toBe("Daily AI News Brief");
    expect(container.querySelector("h2 + p")!.textContent).toBe("Every weekday at 9 AM · Scout");
    expect(container.querySelector("[data-testid=automation-instructions]")!.textContent).toBe(prompt);
    expect(container.textContent).not.toContain("(new…");
    expect(container.querySelector("[data-automation-status]")!.textContent).toBe("On");
  });

  it("falls back to its sentence when it has no name", () => {
    const [automation] = automationsFrom({ routines: [], webhooks: [{ ...webhook, name: " " }] as never, runs: [] });
    const container = mount(createElement(AutomationPanel, { automation: automation!, sentence: "When another app sends something, Scout drafts a follow-up", onClose: vi.fn(), onEdit: vi.fn(), onDeleted: vi.fn() }));
    expect(container.querySelector("h2")!.textContent).toBe("When another app sends something, Scout drafts a follow-up");
    expect(container.querySelector("h2 + p")).toBeNull();
    expect(container.querySelector("[data-testid=automation-instructions]")).toBeNull();
  });
});

describe("Copy address", () => {
  const kept = { endpointUrl: "http://127.0.0.1:8800/hooks/wh_abc", url: "http://127.0.0.1:8800/hooks/wh_abc/whsec_kept-fixture", secret: "whsec_kept-fixture" };
  const fresh = { endpointUrl: kept.endpointUrl, url: "http://127.0.0.1:8800/hooks/wh_abc/whsec_new-fixture", secret: "whsec_new-fixture" };
  const panel = () => {
    const [automation] = automationsFrom({ routines: [], webhooks: [webhook] as never, runs: [] });
    return mount(createElement(AutomationPanel, { automation: automation!, sentence: "s", onClose: vi.fn(), onEdit: vi.fn(), onDeleted: vi.fn() }));
  };
  beforeEach(() => { copied.texts = []; credentials.items.clear(); });

  it("copies the address the server keeps, which the bot that owns it may already have given an app, and never replaces it", async () => {
    fixture.api.mockImplementation(async (path: unknown) => path === "/api/webhooks/hook-1/address" ? { credential: kept } : { webhook, credential: fresh });
    const container = panel();
    flushSync(() => button(container, "Copy address").click());
    await vi.waitFor(() => expect(copied.texts).toEqual([kept.url]));
    expect(fixture.api.mock.calls.map(([path]) => path)).not.toContain("/api/webhooks/hook-1/rotate");
    expect(credentials.items.get("omb-webhook-credentials")).toContain(kept.url);
  });

  it("makes a new one only for an address from before addresses were kept that nothing here holds", async () => {
    fixture.api.mockImplementation(async (path: unknown) => {
      if (path === "/api/webhooks/hook-1/address") throw Object.assign(new Error("this address was made before addresses were kept"), { status: 404 });
      return { webhook, credential: fresh };
    });
    const container = panel();
    flushSync(() => button(container, "Copy address").click());
    await vi.waitFor(() => expect(copied.texts).toEqual([fresh.url]));
    expect(fixture.api).toHaveBeenCalledWith("/api/webhooks/hook-1/rotate", expect.objectContaining({ method: "POST" }));
  });
});

describe("the Automations list switch", () => {
  const routine = { id: "routine-1", name: "Morning summary", prompt: "Send me a summary of my inbox.", target: "bot", botId: "bot-a", runOn: "maus", enabled: true,
    schedule: { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, durationMinutes: 30, nextRunAt: now + 3_600_000, createdAt: now, updatedAt: now };
  let container: HTMLElement;
  /** The page, re-rendered from the store each time it changes, as the app's provider would. */
  function mountPage() {
    container = mount(createElement(TriggersPage, { onBack: vi.fn(), onOpenRoom: vi.fn() }));
    fixture.dispatch.mockImplementation((action: { type: string; routine?: { id: string }; webhook?: { id: string } }) => {
      if (action.type === "routinePatched") fixture.state.routines = (fixture.state.routines as Array<{ id: string }>).map((item) => item.id === action.routine!.id ? action.routine : item);
      if (action.type === "webhookPatched") fixture.state.webhooks = (fixture.state.webhooks as Array<{ id: string }>).map((item) => item.id === action.webhook!.id ? action.webhook : item);
      flushSync(() => root!.render(createElement(TriggersPage, { onBack: vi.fn(), onOpenRoom: vi.fn() })));
    });
  }
  const toggle = (name: string) => container.querySelector<HTMLButtonElement>(`[role=switch][aria-label="Turn “${name}” on or off"]`)!;
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-automation="${id}"]`)!;

  beforeEach(() => { fixture.state.routines = [routine]; });

  it.each([
    ["a schedule", "Morning summary", "routine-1", "/api/routines/routine-1", (enabled: boolean) => ({ enabled }), (enabled: boolean) => ({ routine: { ...routine, enabled, nextRunAt: enabled ? now + 3_600_000 : null, updatedAt: now + (enabled ? 2 : 1) } })],
    ["another app's", "Sales form leads", "hook-1", "/api/webhooks/hook-1", (enabled: boolean) => ({ enabled, verificationPending: false }), (enabled: boolean) => ({ webhook: { ...webhook, enabled } })],
  ])("turns %s automation off and back on, showing each answer at once", async (_kind, name, id, path, body, answer) => {
    mountPage();
    // Only the switch's writes answer; the page's own reads (its app events) get an empty answer.
    fixture.api.mockImplementation(async (_path: unknown, init: unknown) => (init as { body?: string } | undefined)?.body ? answer(JSON.parse((init as { body: string }).body).enabled) : {});
    expect(toggle(name).getAttribute("aria-checked")).toBe("true");
    flushSync(() => toggle(name).click());
    await vi.waitFor(() => expect(toggle(name).getAttribute("aria-checked")).toBe("false"));
    expect(row(id).dataset.automationStatus).toBe("paused");
    expect(row(id).textContent).toContain("Paused");
    await vi.waitFor(() => expect(toggle(name).disabled).toBe(false));
    flushSync(() => toggle(name).click());
    await vi.waitFor(() => expect(toggle(name).getAttribute("aria-checked")).toBe("true"));
    expect(row(id).dataset.automationStatus).toBe("working");
    const writes = fixture.api.mock.calls.filter(([, init]) => (init as { body?: string } | undefined)?.body);
    expect(writes.map(([calledPath, init]) => [calledPath, JSON.parse((init as { body: string }).body)])).toEqual([[path, body(false)], [path, body(true)]]);
  });

  it("says why beside the automation when turning it back on is refused, and keeps it off", async () => {
    fixture.state.routines = [{ ...routine, enabled: false, nextRunAt: null }];
    mountPage();
    fixture.api.mockRejectedValue(new Error("The assigned bot no longer exists"));
    flushSync(() => toggle("Morning summary").click());
    await vi.waitFor(() => expect(row("routine-1").querySelector("[role=alert]")?.textContent).toBe("The assigned bot no longer exists"));
    expect(toggle("Morning summary").getAttribute("aria-checked")).toBe("false");
  });

  it("labels each automation by its name, with what it does beneath, and by what it does when it has no name", () => {
    fixture.state.routines = [routine, { ...routine, id: "unnamed", name: " " }];
    mountPage();
    expect(row("routine-1").querySelector("button")!.textContent).toBe("Morning summary");
    expect(row("routine-1").textContent).toContain("sends you a summary of your inbox");
    expect(row("unnamed").querySelector("button")!.textContent).toContain("sends you a summary of your inbox");
  });

  it("offers no switch for a one-time automation that already happened, and lists no automation whose bot is gone", () => {
    fixture.state.routines = [{ ...routine, enabled: false, nextRunAt: null, schedule: { type: "once", at: now - 60_000 } }, { ...routine, id: "orphan", name: "Orphan", botId: "deleted-bot" }];
    fixture.state.webhooks = [webhook, { ...webhook, id: "orphan-hook", name: "Orphan hook", botId: "deleted-bot" }];
    mountPage();
    expect(row("routine-1").dataset.automationStatus).toBe("done");
    expect(row("routine-1").querySelector("[role=switch]")).toBeNull();
    expect(container.querySelector('[data-automation="orphan"]')).toBeNull();
    expect(container.querySelector('[data-automation="orphan-hook"]')).toBeNull();
  });
});

describe("More, for another app's automation", () => {
  it("lists recent calls with ✓ or ✗ and a plain reason, shows a call's payload on click, and the last thing it received", () => {
    fixture.state.webhookAttempts = [
      { id: "a1", webhookId: "hook-1", receivedAt: now - 120_000, outcome: "accepted", statusCode: 202, preview: '{ "lead": "Ada", "email": "ada@example.com" }', runId: "run-1" },
      { id: "a2", webhookId: "hook-1", receivedAt: now - 60_000, outcome: "rejected", statusCode: 401, reason: "Invalid webhook URL or secret" },
    ];
    const [automation] = automationsFrom({ routines: [], webhooks: [webhook] as never, runs: [] });
    const container = mount(createElement(AutomationPanel, { automation: automation!, sentence: "s", onClose: vi.fn(), onEdit: vi.fn(), onDeleted: vi.fn() }));
    const more = container.querySelector("details")!;
    expect(more.textContent).toContain("Last thing it received");
    expect(more.querySelector("pre")!.textContent).toBe('{ "lead": "Ada", "email": "ada@example.com" }');
    const calls = [...more.querySelectorAll("[data-call]")];
    expect(calls.map((call) => call.textContent)).toEqual([expect.stringMatching(/✗Wrong secret$/), expect.stringMatching(/✓Received$/)]);
    flushSync(() => calls[1]!.querySelector("button")!.click());
    expect(calls[1]!.querySelector("pre")!.textContent).toBe('{ "lead": "Ada", "email": "ada@example.com" }');
    flushSync(() => calls[0]!.querySelector("button")!.click());
    expect(calls[0]!.querySelector("pre")!.textContent).toBe("Nothing to show.");
    const visible = (container.textContent ?? "").replace(more.textContent ?? "", "");
    expect(visible).not.toContain("Recent calls");
  });
});

describe("on a Cloud", () => {
  it("never asks the person to keep the app open for another app's automation", () => {
    const [automation] = automationsFrom({ routines: [], webhooks: [webhook] as never, runs: [] });
    const props = { automation: automation!, sentence: "s", onClose: vi.fn(), onEdit: vi.fn(), onDeleted: vi.fn() };
    expect(mount(createElement(AutomationPanel, props)).textContent).toContain("Keep MausBot open so it can receive.");
    root!.unmount();
    fixture.state.config = { cloudHome: true };
    expect(mount(createElement(AutomationPanel, props)).textContent).not.toContain("Keep MausBot open");
  });
});

describe("the calendar", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("shows a future event of an automation that needs you in its status colour, and none of a deleted bot", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 14, 8, 0));
    const at = new Date(2026, 9, 14, 17, 0).getTime();
    const daily = (id: string, name: string, botId = "bot-a") => ({ id, name, prompt: `${name}.`, target: "bot", botId, runOn: "maus", enabled: true,
      schedule: { type: "daily", time: "17:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, durationMinutes: 30, nextRunAt: at, createdAt: 0, updatedAt: 0 });
    fixture.state.routines = [daily("failing", "Sales inbox check"), daily("fine", "Morning summary"), daily("orphan", "Orphan check", "deleted-bot")];
    // Last week's failure: its own receipt is off this week's grid, so only the future event can say Needs you.
    const failedAt = at - 8 * 86_400_000;
    fixture.state.routineRuns = [{ id: "run-1", routineId: "failing", botId: "bot-a", status: "failed", error: "Claude is signed out", scheduledFor: failedAt, startedAt: failedAt, createdAt: failedAt }];
    fixture.state.groups = [];
    const container = mount(createElement(AutomationsCalendar, { botFilter: "all", onOpenAutomation: vi.fn(), onOpenRoom: vi.fn() }));
    const dots = (name: string) => [...container.querySelectorAll(`[data-event-card][aria-label^="${name}"] [data-event-status]`)].map((dot) => (dot as HTMLElement).dataset.eventStatus);
    expect(dots("Sales inbox check")).toContain("needs-you");
    expect(dots("Morning summary").length).toBeGreaterThan(0);
    expect(dots("Morning summary").every((status) => status === "working")).toBe(true);
    expect(container.querySelector('[data-event-card][aria-label^="Orphan check"]')).toBeNull();
  });
});

describe("the secret, under More", () => {
  const secret = "whsec_fixture-secret-value";
  beforeEach(() => {
    copied.texts = [];
    credentials.items.clear();
    saveWebhookCredential(credentials.store as never, "hook-1", { endpointUrl: "http://127.0.0.1:8800/hooks/wh_abc", url: `http://127.0.0.1:8800/hooks/wh_abc/${secret}`, secret });
  });
  afterEach(() => { credentials.items.clear(); });

  it("is masked when More opens, copies without showing, and shows only on Show, for that panel", async () => {
    const [automation] = automationsFrom({ routines: [], webhooks: [webhook] as never, runs: [] });
    const props = { automation: automation!, sentence: "s", onClose: vi.fn(), onEdit: vi.fn(), onDeleted: vi.fn() };
    let container = mount(createElement(AutomationPanel, props));
    const more = () => container.querySelector("details")!;
    expect(more().textContent).toContain("Recent calls");
    expect(more().textContent).toContain("Secret: ••••••••");
    expect(container.innerHTML).not.toContain(secret);
    flushSync(() => container.querySelector<HTMLButtonElement>('button[aria-label="Copy the secret"]')!.click());
    await vi.waitFor(() => expect(copied.texts).toEqual([secret]));
    await vi.waitFor(() => expect(container.querySelector('button[aria-label="Copy the secret"]')!.textContent).toBe("Copied"));
    expect(container.innerHTML).not.toContain(secret);
    flushSync(() => container.querySelector<HTMLButtonElement>('button[aria-label="Show the secret"]')!.click());
    expect(more().textContent).toContain(`Secret: ${secret}`);
    flushSync(() => container.querySelector<HTMLButtonElement>('button[aria-label="Hide the secret"]')!.click());
    expect(container.innerHTML).not.toContain(secret);
    flushSync(() => container.querySelector<HTMLButtonElement>('button[aria-label="Show the secret"]')!.click());
    root!.unmount();
    container = mount(createElement(AutomationPanel, props));
    expect(container.innerHTML).not.toContain(secret);
  });
});
