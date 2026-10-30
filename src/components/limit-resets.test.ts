// @vitest-environment happy-dom
// The engines' usage limits on screen: the warning with "Move to after reset", the chat's notice and the stopped turn's
// Continue button, and the calendar's reset marker that a bot or an automation is dropped on.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineLimit } from "../../shared/limit-reset";
import { failedTurnTool } from "../../shared/failed-turn";
import type { Routine } from "@/lib/routines";
import type { Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  api: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch, refreshInstances: vi.fn(), refreshModels: vi.fn() }),
  api: (...args: unknown[]) => fixture.api(...args),
}));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "darwin" }, localComputer: { available: true } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => null }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { setLocale, t } = await import("@/lib/i18n");
const limits = await import("@/lib/limit-resets");
const { automationSentence, isDone, statusLine } = await import("@/lib/automations");
const { LimitWarnings } = await import("./automations/LimitWarnings");
const { EngineLimitNotice } = await import("./LimitResetContinue");
const { FailedTurnRow } = await import("./ChatView");
const { CalendarGrid } = await import("./RoutineCalendarPage");

const NOW = new Date(2026, 9, 19, 10, 0, 0).getTime();
const RESET = new Date(2026, 9, 19, 15, 40, 0).getTime();
const HOUR = 3_600_000;
const claude = (used: number, blocked = false): EngineLimit => ({ engine: "claude", name: "Claude", driver: "claude", window: "5-hour", usedPercent: used, resetsAt: RESET, blocked });
const bot = { id: "scout", name: "Scout", hidden: false, threadId: "t-main", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, tasks: [] } as unknown as Bot;
const routine = (id: string, nextRunAt: number, extra: Partial<Routine> = {}): Routine => ({
  id, name: id, prompt: "Finish the report.", target: "bot", botId: "scout", runOn: "maus", enabled: true,
  schedule: { type: "daily", time: "11:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, durationMinutes: 30, nextRunAt, createdAt: 0, updatedAt: 0, ...extra,
});

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
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  setLocale("en");
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async () => ({ checkedAt: NOW, engines: [claude(92)] }));
  fixture.state = { bots: [bot], routines: [], instances: [] as InstanceInfo[], config: {}, groups: [] };
  limits.rememberLimits({ checkedAt: NOW, engines: [claude(92)] });
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("the words", () => {
  it("say how full an engine is and when it resets", () => {
    expect(limits.limitLine(claude(92), NOW)).toBe("Claude: 92% used · resets 3:40 PM");
    expect(limits.limitLine(claude(100, true), NOW)).toBe("Claude: at its limit · resets 3:40 PM");
    expect(limits.nearLimitEngines([claude(89), { ...claude(90), engine: "codex" }]).map((limit) => limit.engine)).toEqual(["codex"]);
  });

  it("read a limit-reset automation as a sentence, and say when its time is not known", () => {
    const automation = { kind: "schedule" as const, name: "Report", instructions: "Finish the report.", schedule: { type: "limit_reset" as const, engine: "claude", repeat: "once" as const, at: null } };
    expect(automationSentence(automation, "Scout")).toBe("When your Claude limit resets, Scout finishes the report");
    expect(automationSentence({ ...automation, schedule: { ...automation.schedule, repeat: "every_reset" } }, "Scout")).toBe("Each time your Claude limit resets, Scout finishes the report");
    expect(statusLine({ ...automation, id: "r", botId: "scout", enabled: true, nextRunAt: null, runs: [] }, NOW)).toContain("runs when the limit resets (time not known yet)");
    expect(isDone({ schedule: { ...automation.schedule, at: NOW - 1 } }, NOW)).toBe(true);
    expect(isDone({ schedule: { ...automation.schedule, at: null } }, NOW)).toBe(false);
  });

  it("find the automations due before a reset on a bot that uses that engine", () => {
    const due = limits.dueBeforeReset([
      routine("before", NOW + HOUR), routine("after", RESET + 2 * 60_000), routine("paused", NOW + HOUR, { enabled: false }),
      routine("other-bot", NOW + HOUR, { botId: "codex-bot" }), routine("limit", NOW + HOUR, { schedule: { type: "limit_reset", engine: "claude", repeat: "once", at: null } }),
    ], (botId) => botId === "scout" ? "claude" : "codex", claude(92), NOW);
    expect(due.map((candidate) => candidate.id)).toEqual(["before"]);
  });

  it("put each known reset in the calendar's range", () => {
    expect(limits.resetMarkers([claude(92), { ...claude(10), engine: "codex", name: "Codex", resetsAt: null }], NOW, NOW + 24 * HOUR, NOW))
      .toEqual([{ engine: "claude", name: "Claude", at: RESET }]);
    expect(limits.resetMarkers([claude(92)], RESET + 1, RESET + HOUR, NOW)).toEqual([]);
  });
});

describe("the Automations page warning", () => {
  it("shows the engine near its limit and moves just the next run of what is due before the reset", async () => {
    fixture.state = { ...fixture.state, routines: [routine("brief", NOW + HOUR)] };
    const moved = routine("brief", RESET + 60_000);
    fixture.api.mockImplementation(async (path: unknown) => String(path).startsWith("/api/limit-resets/after-reset") ? { routine: moved } : { checkedAt: NOW, engines: [claude(92)] });
    const container = mount(createElement(LimitWarnings));
    const warning = container.querySelector('[data-limit-warning="claude"]')!;
    expect(warning.textContent).toContain("Claude: 92% used · resets 3:40 PM");
    expect(warning.textContent).toContain("1 automation runs before then");
    flushSync(() => button(container, "Move to after reset").click());
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/limit-resets/after-reset", { method: "POST", body: JSON.stringify({ routineId: "brief", engine: "claude" }) });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "routinePatched", routine: moved });
  });

  it("stays away while every engine has room", () => {
    limits.rememberLimits({ checkedAt: NOW, engines: [claude(40)] });
    fixture.api.mockImplementation(async () => ({ checkedAt: NOW, engines: [claude(40)] }));
    expect(mount(createElement(LimitWarnings)).innerHTML).toBe("");
  });
});

describe("the chat", () => {
  it("shows a compact notice for the bot's own engine only when it is near its limit", () => {
    expect(mount(createElement(EngineLimitNotice, { engine: "claude" })).textContent).toBe("Claude: 92% used · resets 3:40 PM");
    root!.unmount();
    root = null;
    expect(mount(createElement(EngineLimitNotice, { engine: "codex" })).innerHTML).toBe("");
  });

  it("explains on hover why a blocked engine is shown, and how it clears", () => {
    const near = mount(createElement(EngineLimitNotice, { engine: "claude" })).querySelector("button")!;
    expect(near.title).toBe(t("limits.chatHint"));
    root!.unmount();
    limits.rememberLimits({ checkedAt: NOW, engines: [claude(100, true)] });
    const blocked = mount(createElement(EngineLimitNotice, { engine: "claude" })).querySelector("button")!;
    expect(blocked.textContent).toBe("Claude: at its limit · resets 3:40 PM");
    expect(blocked.title).toContain("clears by itself once a reply on Claude works again");
    expect(blocked.getAttribute("aria-label")).toContain("Claude: at its limit");
  });

  it("checks the engine's usage again when clicked", async () => {
    const notice = mount(createElement(EngineLimitNotice, { engine: "claude" })).querySelector("button")!;
    fixture.api.mockClear();
    flushSync(() => notice.click());
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/limit-resets?refresh=1");
  });

  it("reads limits on its own as a background poll, so a sleeping Cloud home stays asleep", async () => {
    fixture.api.mockClear();
    mount(createElement(EngineLimitNotice, { engine: "claude" }));
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/limit-resets", { background: true });
    expect(fixture.api).not.toHaveBeenCalledWith("/api/limit-resets");
  });

  it("offers Continue on a turn its limit stopped, which sets up the automation in this conversation", async () => {
    const created = routine("continue", RESET + 60_000, { schedule: { type: "limit_reset", engine: "claude", repeat: "once", at: RESET + 60_000 } });
    fixture.api.mockImplementation(async (path: unknown) => String(path) === "/api/limit-resets/continue" ? { routine: created } : { checkedAt: NOW, engines: [claude(100, true)] });
    const tool = failedTurnTool("This Claude account has reached its 5-hour limit, which resets Oct 19, 3:40 PM (UTC).", { limitResetsAt: RESET });
    const container = mount(createElement(FailedTurnRow, { tool, engine: undefined, botId: "scout", threadId: "t-1", onRetry: vi.fn() }));
    expect([...container.querySelectorAll("button")].map((candidate) => candidate.textContent?.trim())).toEqual(["Continue at 3:40 PM when your limit resets"]);
    flushSync(() => button(container, "Continue at 3:40 PM when your limit resets").click());
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/limit-resets/continue", { method: "POST", body: JSON.stringify({ botId: "scout", threadId: "t-1" }) });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "routinePatched", routine: created });
    flushSync(() => {});
    expect(container.textContent).not.toContain("Continue at");
  });

  it("offers Retry as before once the reset has passed, or when the engine named no reset", () => {
    const passed = mount(createElement(FailedTurnRow, { tool: failedTurnTool("limit", { limitResetsAt: NOW - 1 }), engine: undefined, botId: "scout", threadId: "t-1", onRetry: vi.fn() }));
    expect(passed.textContent).toContain("Retry");
    expect(passed.textContent).not.toContain("Continue at");
  });
});

describe("the calendar", () => {
  const marker = { engine: "claude", name: "Claude", at: RESET };
  const grid = (onDropOnReset = vi.fn(), onCreate = vi.fn()) => mount(createElement(CalendarGrid, {
    anchor: new Date(2026, 9, 19).getTime(), days: 1, items: [], bots: [bot], groups: [], markers: [marker],
    onOpen: vi.fn(), onCreate, onMove: vi.fn(), onResize: vi.fn(), onDropOnReset,
  }));
  const drop = (target: Element, type: string, value: string) => {
    const transfer = { types: [type], getData: (asked: string) => asked === type ? value : "", dropEffect: "none" };
    for (const name of ["dragover", "drop"]) {
      const event = new Event(name, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      flushSync(() => target.dispatchEvent(event));
    }
  };

  it("draws each engine's next reset as a labelled marker", () => {
    const container = grid();
    const shown = container.querySelector('[data-limit-marker="claude"]')!;
    expect(shown.textContent).toBe("Claude resets 3:40 PM");
    expect(shown.getAttribute("title")).toBe("Drop a bot or an automation here to run it when Claude's limit resets");
  });

  it("turns a bot or an automation dropped on the marker into a limit-reset automation, not a fixed time", () => {
    const onDropOnReset = vi.fn();
    const onCreate = vi.fn();
    const container = grid(onDropOnReset, onCreate);
    const shown = container.querySelector('[data-limit-marker="claude"]')!;
    drop(shown, "application/x-openmaus-bot", "scout");
    expect(onDropOnReset).toHaveBeenLastCalledWith({ botId: "scout" }, marker);
    drop(shown, "application/x-openmaus-calendar-event", JSON.stringify({ kind: "routine", id: "brief", at: NOW + HOUR }));
    expect(onDropOnReset).toHaveBeenLastCalledWith({ event: { kind: "routine", id: "brief", at: NOW + HOUR } }, marker);
    expect(onCreate).not.toHaveBeenCalled();
  });
});
