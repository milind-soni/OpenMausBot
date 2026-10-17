// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TodayReport } from "../../shared/today";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), openThread: vi.fn(), state: {} as Record<string, unknown> }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  openThread: fixture.openThread,
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
}));
vi.mock("./DesktopCapabilities", () => ({
  useCaptionChrome: () => ({ dragProps: {}, noDragStyle: undefined }),
  useDesktopCapabilities: () => ({ capabilities: { host: { platform: "darwin" }, windowChrome: "web" } }),
}));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
const { TodayPage } = await import("./TodayPage");
const { durationText, rangeStart } = await import("@/lib/today");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

const atlas = { id: "atlas", name: "Atlas", threadId: "atlas-main", color: "#4f46e5", tasks: [] };
const pepper = { id: "pepper", name: "Pepper", threadId: "pepper-main", color: "#16a34a", tasks: [] };
const at = (hour: number, minute = 0) => new Date(2026, 9, 17, hour, minute).getTime();

function report(overrides: Partial<TodayReport> = {}): TodayReport {
  return {
    since: at(0), until: at(15), tiles: [], minutesSaved: 0, routines: { ok: 0, failed: 0 }, needsYou: [], lines: [], moreLines: 0, routineCount: 0,
    ...overrides,
  };
}

const busyDay = report({
  tiles: [{ category: "emailRead", count: 12 }, { category: "draft", count: 3 }, { category: "emailSent", count: 2 }, { category: "report", count: 1 }],
  minutesSaved: 12 * 2 + 3 * 5 + 2 * 4 + 15,
  routines: { ok: 4, failed: 1 },
  needsYou: [
    { kind: "signed-out", id: "n1", at: at(9), instanceId: "claude", botIds: ["atlas", "pepper"] },
    { kind: "connection", id: "n2", at: at(10), app: "Gmail", botIds: ["atlas"], threadId: "atlas-main", text: "401 Unauthorized" },
    { kind: "question", id: "n3", at: at(11), botId: "pepper", threadId: "pepper-task", text: "Which list should I send the newsletter to?" },
  ],
  lines: [
    { id: "l1", at: at(14), botId: "pepper", threadId: "pepper-task", title: "Posted the lead list to #sales.", ok: true, startedBy: "bot", outcomes: { message: 1, lead: 2 } },
    { id: "l2", at: at(12), botId: "atlas", title: "Lead sweep", ok: false, routineId: "r-leads", error: "Could not create a task for this run", startedBy: "webhook", outcomes: {} },
    { id: "l3", at: at(9, 2), botId: "atlas", threadId: "atlas-brief", routineId: "r-brief", title: "Morning briefing", ok: true, startedBy: "schedule", outcomes: { emailRead: 12, draft: 3, report: 1 } },
  ],
  routineCount: 3,
});

beforeEach(() => {
  fixture.api.mockReset();
  fixture.dispatch.mockReset();
  fixture.openThread.mockReset();
  fixture.state = {
    bots: [atlas, pepper], groups: [], config: { cloudHome: true },
    instances: [{ instanceId: "claude", displayName: "Claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: false } }],
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function show(value: TodayReport) {
  fixture.api.mockResolvedValue(value);
  await act(async () => root.render(createElement(TodayPage)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
const text = (selector: string) => [...host.querySelectorAll(selector)].map((node) => node.textContent?.replace(/\s+/g, " ").trim());

describe("the Today page", () => {
  it("asks for today from local midnight and shows only the outcomes that happened, with time saved first", async () => {
    await show(busyDay);
    expect(fixture.api).toHaveBeenCalledWith(`/api/today?since=${rangeStart("today")}`, { timeoutMs: 20_000 });
    expect(text("[data-today-tile]")).toEqual(["Emails read or sorted12", "Drafts written3", "Emails sent2", "Reports and briefings1", "Routines and triggers4 OK · 1 failed"]);
    const saved = host.querySelector("[data-testid=today-time-saved]")!;
    expect(saved.textContent).toContain("≈ 1 h 2 m");
    expect(saved.getAttribute("title")).toContain("Emails read or sorted 2 min, Drafts written 5 min, Emails sent 4 min");
    expect(saved.getAttribute("title")).toContain("An estimate, not a measurement.");
    expect(host.querySelector("[data-today-tile=doc]")).toBeNull();
  });

  it("lists what needs the person, each with the one action that fixes it, and never an approval", async () => {
    await show(busyDay);
    expect(text("[data-needs-you] p:first-child")).toEqual(["Claude is signed out", "Gmail needs to be connected again", "Pepper asked you"]);
    expect(host.textContent).toContain("Waiting on this: Atlas and Pepper");
    expect(host.textContent).toContain("Which list should I send the newsletter to?");
    await act(async () => button("Sign in")!.click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleAppSettings", open: true, section: "engines" });
    await act(async () => button("Reconnect")!.click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "togglePlugins", open: true });
    await act(async () => button("Answer")!.click());
    expect(fixture.openThread).toHaveBeenCalledWith(fixture.dispatch, { botId: "pepper", threadId: "pepper-task" }, fixture.state, true);
    expect(button("Allow")).toBeUndefined();
  });

  it("shows each finished piece of work as one line that opens its conversation, filterable by bot", async () => {
    await show(busyDay);
    const lines = [...host.querySelectorAll("[data-today-line]")];
    expect(lines.map((line) => line.getAttribute("data-today-line"))).toEqual(["ok", "failed", "ok"]);
    expect(lines[0]!.textContent).toContain("Pepper·Posted the lead list to #sales.");
    expect(lines[0]!.textContent).toContain("From a bot");
    expect(lines[1]!.textContent).toContain("Could not create a task for this run");
    expect(lines[2]!.textContent).toContain("On schedule");
    await act(async () => (lines[2]!.querySelector("button") as HTMLButtonElement).click());
    expect(fixture.openThread).toHaveBeenCalledWith(fixture.dispatch, { botId: "atlas", threadId: "atlas-brief" }, fixture.state, true);
    await act(async () => (lines[1]!.querySelector("button") as HTMLButtonElement).click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "showRoutines", section: "logs", routineId: "r-leads" });
    const select = host.querySelector("select[aria-label='Show work by']") as HTMLSelectElement;
    await act(async () => { select.value = "atlas"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect([...host.querySelectorAll("[data-today-line]")]).toHaveLength(2);
  });

  it("switches to the last seven days", async () => {
    await show(busyDay);
    await act(async () => button("Last 7 days")!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(fixture.api).toHaveBeenLastCalledWith(`/api/today?since=${rangeStart("week")}`, { timeoutMs: 20_000 });
    expect(button("Last 7 days")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("with nothing done yet, gives one next step and no numbers", async () => {
    await show(report());
    expect(host.querySelector("[data-testid=today-empty]")!.textContent).toContain("Nothing finished yet today");
    expect(host.querySelector("[data-testid=today-time-saved]")).toBeNull();
    await act(async () => button("Set up your first routine")!.click());
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "showRoutines" });
    act(() => root.unmount());
    root = createRoot(host);
    await show(report({ routineCount: 2, needsYou: [{ kind: "signed-out", id: "n1", at: at(9), instanceId: "claude", botIds: ["atlas"] }] }));
    expect(text("[data-needs-you] p:first-child")).toEqual(["Claude is signed out"]);
    expect(button("See your routines")).toBeDefined();
  });

  it("lists chat work that produced no app outcome without an empty state or a zero estimate", async () => {
    await show(report({ lines: [{ id: "l1", at: at(10), botId: "atlas", threadId: "atlas-main", title: "Answered your pricing question.", ok: true, startedBy: "person", outcomes: {} }] }));
    expect(host.querySelector("[data-testid=today-empty]")).toBeNull();
    expect(host.querySelector("[data-testid=today-time-saved]")).toBeNull();
    expect(text("[data-today-line]")).toEqual([expect.stringContaining("Atlas·Answered your pricing question.")]);
    act(() => root.unmount());
    root = createRoot(host);
    await show(report({ routines: { ok: 0, failed: 2 }, lines: [{ id: "l2", at: at(8), botId: "atlas", routineId: "r1", title: "Lead sweep", ok: false, outcomes: {} }] }));
    expect(host.querySelector("[data-testid=today-time-saved]")).toBeNull();
    expect(text("[data-today-tile]")).toEqual(["Routines and triggers0 OK · 2 failed"]);
  });

  it("says when it could not load, and tries again", async () => {
    fixture.api.mockRejectedValueOnce(new Error("offline"));
    await act(async () => root.render(createElement(TodayPage)));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.querySelector("[role=alert]")!.textContent).toContain("Couldn't load what your bots did: offline");
    fixture.api.mockResolvedValueOnce(busyDay);
    await act(async () => button("Try again")!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.querySelectorAll("[data-today-line]")).toHaveLength(3);
  });
});

describe("time and window helpers", () => {
  it("words a duration in hours and minutes", () => {
    expect(durationText(0)).toBe("0 m");
    expect(durationText(48)).toBe("48 m");
    expect(durationText(120)).toBe("2 h");
    expect(durationText(135)).toBe("2 h 15 m");
  });

  it("starts today at local midnight and the week six days before it", () => {
    const now = new Date(2026, 9, 17, 15, 30);
    expect(rangeStart("today", now)).toBe(new Date(2026, 9, 17).getTime());
    expect(rangeStart("week", now)).toBe(new Date(2026, 9, 11).getTime());
  });
});
