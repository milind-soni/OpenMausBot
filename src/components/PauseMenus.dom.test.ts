// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; body: unknown }>,
  admin: true as boolean | null,
  config: { pausedByPerson: { bots: [] as string[], departments: [] as string[] }, heldBots: [] as string[] },
}));
vi.mock("@/state/api", () => ({ api: async (path: string, init: { body: string }) => { fixture.calls.push({ path, body: JSON.parse(init.body) }); return { stopped: 2 }; } }));
vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: { config: fixture.config, bots: [], groups: [] }, dispatch: vi.fn() }) }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
import { TeamMenuItems } from "./SidebarTeamMenu";
import { RoutineList } from "./routines/RoutineList";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.calls = [];
  fixture.admin = true;
  fixture.config = { pausedByPerson: { bots: [], departments: [] }, heldBots: [] };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const menu = (onRead = vi.fn()) => createElement(TeamMenuItems, { department: "Sales", onRead, onAddBots: vi.fn(), onRename: vi.fn(), onShare: vi.fn(), onDelete: vi.fn() });

it("lets an admin pause a department, and resume it once paused", async () => {
  const onRead = vi.fn();
  await act(async () => root.render(menu(onRead)));
  const pause = container.querySelector<HTMLButtonElement>('[data-team-pause="pause"]')!;
  expect(pause.textContent).toBe("Pause department");
  await act(async () => pause.click());
  expect(fixture.calls).toEqual([{ path: "/api/paused", body: { kind: "department", id: "Sales", paused: true } }]);
  expect(onRead).toHaveBeenCalled();

  fixture.config = { pausedByPerson: { bots: [], departments: ["Sales"] }, heldBots: [] };
  await act(async () => root.render(menu()));
  expect(container.querySelector('[data-team-pause="resume"]')!.textContent).toBe("Resume department");
});

it("offers nothing to someone who is not an owner or admin", async () => {
  fixture.admin = false;
  await act(async () => root.render(menu()));
  expect(container.querySelector("[data-team-pause]")).toBeNull();
});

it("says on a routine that its bot is paused", async () => {
  const routine = { id: "r1", botId: "ada", name: "Morning report", enabled: true, schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, prompt: "x" };
  await act(async () => root.render(createElement(RoutineList, { routines: [routine] as never, runs: [], bots: [{ id: "ada", name: "Ada" }] as never, heldBots: ["ada"],
    loading: false, error: false, onOpen: vi.fn(), onLogs: vi.fn(), onToggle: vi.fn() })));
  expect(container.querySelector("[data-routine-bot-held]")!.textContent).toBe("Its bot is paused, so this routine won’t run until the bot is resumed.");
});
