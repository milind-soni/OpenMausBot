// @vitest-environment happy-dom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppState, Bot } from "@/state/store";
import type { MapComputer } from "../../shared/map-computer";

const fixture = vi.hoisted(() => {
  let value: { state: AppState; dispatch: () => void } | null = null;
  const listeners = new Set<() => void>();
  return {
    get value() { return value!; },
    set(state: AppState) { value = { state, dispatch: () => {} }; for (const listener of listeners) listener(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    computers: [] as MapComputer[],
    computersAnswer: true,
    teamMap: { collaborations: [], queued: [], running: [] } as object,
  };
});

async function fakeApi(path: string) {
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (path.startsWith("/.well-known/openmausbot/environment")) return { environmentId: "fixture" };
  if (path.startsWith("/api/team-map")) return structuredClone(fixture.teamMap);
  if (path.startsWith("/api/computers/frames")) {
    if (!fixture.computersAnswer) return new Promise(() => {});
    return { computers: structuredClone(fixture.computers), configured: true, available: true, now: Date.now() };
  }
  if (path.startsWith("/api/team-computers")) return { computers: [], configured: true };
  return {};
}

vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  const { useSyncExternalStore } = await import("react");
  return { ...actual, api: fakeApi, useStore: () => useSyncExternalStore(fixture.subscribe, () => fixture.value) };
});
vi.mock("@/state/api", async (original) => ({ ...await original<object>(), api: fakeApi }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } } }),
  useCaptionChrome: () => ({}),
}));

const { initialState } = await import("@/state/store");
const { TeamMapPage } = await import("./TeamMapPage");

const bot = (id: string, section: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `thread-${id}`, name: id, title: "", description: "", notifications: false, color: "green", unread: false,
  modelSelection: { instanceId: "fixture", model: "model" }, tasks: [{ threadId: `thread-${id}`, title: "Task", createdAt: 1 }],
  messages: [], section, ...extra,
} as Bot);
const team = (computers: boolean) => [
  bot("chief", "Sales", { chiefOfStaff: true, ...(computers ? { computer: "cloud" } : {}) }),
  bot("ana", "Sales"), bot("ben", "Sales"), bot("cy", "Ops"), bot("dee", "Ops"),
];

const resizeCallbacks = new Set<() => void>();
class FixtureResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe() { resizeCallbacks.add(this.callback); queueMicrotask(this.callback); }
  unobserve() {}
  disconnect() { resizeCallbacks.delete(this.callback); }
}
const elementRect = HTMLElement.prototype.getBoundingClientRect;
let container: HTMLDivElement, root: Root;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FixtureResizeObserver);
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return this.matches("[data-team-canvas]") ? new DOMRect(0, 0, 1200, 800) : elementRect.call(this);
  };
  const stored = new Map([["omb-team-canvas:fixture", JSON.stringify({ Ops: { x: 900, y: 60 } })]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
  fixture.computersAnswer = true;
  fixture.teamMap = { collaborations: [], queued: [], running: [] };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  root.unmount();
  container.remove();
  HTMLElement.prototype.getBoundingClientRect = elementRect;
  resizeCallbacks.clear();
  vi.unstubAllGlobals();
});

/** What a person could see between two tasks: the world's view, each team's tile, and the cards and screens in them. */
function look(): string | null {
  const world = container.querySelector<HTMLElement>("[data-canvas-world]");
  if (!world || world.style.visibility === "hidden") return null;
  const tiles = [...container.querySelectorAll<HTMLElement>("section[data-team-key]")]
    .map((tile) => `${tile.dataset.teamKey}@${tile.style.left},${tile.style.top} ${tile.style.width}x${tile.style.height}`);
  return [world.style.transform, ...tiles, `cards ${container.querySelectorAll("article").length}`, `screens ${container.querySelectorAll("[data-computer-node]").length}`].join(" | ");
}
async function watch(tasks: number, seen: Array<string | null>) {
  for (let task = 0; task < tasks; task++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    const now = look();
    if (seen.at(-1) !== now) seen.push(now);
  }
}

for (const computers of [false, true]) {
  it(`opens straight into its settled layout${computers ? " with computers shown" : ""}: no earlier view, team spot or card layout is ever on screen`, async () => {
    fixture.computers = computers ? [{ id: "chief", kind: "bot", name: "chief", botIds: ["chief"], state: "idle" }] : [];
    fixture.set({ ...initialState, bots: team(computers), sections: ["Sales", "Ops"] });
    const seen: Array<string | null> = [];
    root.render(createElement(TeamMapPage));
    await watch(200, seen);
    const shown = seen.filter((state): state is string => state !== null);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("Ops@900px,60px");
    expect(shown[0]).toContain(`screens ${computers ? 1 : 0}`);
  });
}

it("a bot working in the background remounts no card and moves nothing on the canvas", async () => {
  fixture.computers = [{ id: "chief", kind: "bot", name: "chief", botIds: ["chief"], state: "idle" }];
  fixture.set({ ...initialState, bots: team(true), sections: ["Sales", "Ops"] });
  root.render(createElement(TeamMapPage));
  const settling: Array<string | null> = [];
  await watch(200, settling);
  const cards = [...container.querySelectorAll("article")];
  const settled = look();
  const seen: Array<string | null> = [settled];
  for (let frame = 0; frame < 20; frame++) {
    fixture.set({ ...fixture.value.state, bots: fixture.value.state.bots.map((item) => item.id === "ana"
      ? { ...item, busy: true, messages: [...item.messages, { id: `reply-${frame}`, role: "bot", kind: "text", text: "working", at: frame }] } : item) });
    await watch(3, seen);
  }
  expect(seen).toEqual([settled]);
  expect([...container.querySelectorAll("article")].every((card, index) => card === cards[index])).toBe(true);
});

it("shows the teams anyway when the computers never answer", async () => {
  fixture.computersAnswer = false;
  fixture.set({ ...initialState, bots: team(true), sections: ["Sales", "Ops"] });
  root.render(createElement(TeamMapPage));
  const early: Array<string | null> = [];
  await watch(20, early);
  expect(early.at(-1)).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(look()).toContain("cards 5");
});

it("draws a line between bots that hand work to each other, labelled with what the hand-off is doing", async () => {
  fixture.computers = [];
  fixture.teamMap = {
    collaborations: [{ groupId: "group", botIds: ["ana", "ben"], lastAt: 1 }],
    queued: [],
    running: [{ sourceBotId: "chief", targetBotId: "cy", threadId: "thread-cy" }],
  };
  fixture.set({ ...initialState, bots: team(false), sections: ["Sales", "Ops"] });
  root.render(createElement(TeamMapPage));
  await watch(200, []);
  const world = container.querySelector("[data-canvas-world]")!;
  const lines = [...world.querySelectorAll<SVGPathElement>("[data-handoff-line]")];
  expect(lines.map((line) => line.dataset.state)).toEqual(["running", "connected"]);
  expect(lines.every((line) => /^M [\d.]+ [\d.]+ C /.test(line.getAttribute("d") ?? ""))).toBe(true);
  expect([...world.querySelectorAll("[data-handoff-label]")].map((label) => label.textContent)).toEqual(["Running"]);
  expect(world.querySelectorAll("[data-handoff-arrow]")).toHaveLength(1);
});
