// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BringMyCloud } from "./BringMyCloud";
import { WelcomeBring } from "./WelcomeBring";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const TEAM = { id: "team-acme", name: "Acme", ready: true };
const ATLAS = { id: "atlas", name: "Atlas" }, BEACON = { id: "beacon", name: "Beacon" }, MAUS = { id: "maus", name: "MausBot", stays: "default" as const };
const movingAtlas = { bot: { id: "atlas", name: "Atlas" }, team: { id: "team-acme", name: "Acme" }, phase: "moving" as const };

let host: HTMLElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); (window as { ogb?: unknown }).ogb = undefined; });

function page(bots: unknown[], over: Record<string, unknown> = {}) {
  const bridge = { teamBring: vi.fn(async () => ({ team: TEAM, bots })), teamBringMove: vi.fn(async () => ({ started: true, move: movingAtlas })), teamBringStatus: vi.fn(async () => movingAtlas), ...over };
  (window as { ogb?: unknown }).ogb = { cloudSendPage: bridge };
  return bridge;
}
const draw = async () => { await act(async () => { root.render(createElement(BringMyCloud)); }); await act(async () => {}); };
const moveButton = (id: string) => host.querySelector<HTMLButtonElement>(`[data-bring-move="${id}"]`);

it("lists My Cloud's bots with one Move each, and says why MausBot stays", async () => {
  page([MAUS, ATLAS, BEACON]);
  await draw();
  expect(host.textContent).toContain("Move a bot here from My Cloud");
  expect(moveButton("atlas")).not.toBeNull();
  expect(moveButton("beacon")).not.toBeNull();
  expect(moveButton("maus")).toBeNull();
  expect(host.querySelector('[data-bring-bot="maus"]')?.textContent).toContain("MausBot");
  expect(host.querySelector('[data-bring-bot="maus"]')?.textContent).toContain("Stays on My Cloud: everyone on a team gets their own");
});

it("shows nothing with no bot to bring, on an older app, or in a browser", async () => {
  page([MAUS]);
  await draw();
  expect(host.innerHTML).toBe("");
  page([ATLAS], { teamBringMove: undefined });
  await draw();
  expect(host.innerHTML).toBe("");
  (window as { ogb?: unknown }).ogb = undefined;
  await draw();
  expect(host.innerHTML).toBe("");
});

it("asks main to move that one bot by its id, says it is on its way, and holds the other Moves meanwhile", async () => {
  const bridge = page([ATLAS, BEACON]);
  await draw();
  await act(async () => { moveButton("atlas")!.click(); });
  expect(bridge.teamBringMove).toHaveBeenCalledExactlyOnceWith("atlas");
  expect(host.querySelector('[data-bring-line="sending"]')?.textContent).toContain("Moving Atlas to Acme");
  expect(moveButton("beacon")!.disabled).toBe(true);
});

it("changes nothing when the person cancels in the confirm", async () => {
  page([ATLAS, BEACON], { teamBringMove: vi.fn(async () => ({ started: false, move: null })) });
  await draw();
  await act(async () => { moveButton("atlas")!.click(); });
  expect(host.querySelector("[data-bring-line]")).toBeNull();
  expect(moveButton("atlas")!.disabled).toBe(false);
});

it("follows the move to the end, then reads the list again so the moved bot leaves it", async () => {
  vi.useFakeTimers();
  const bridge = page([ATLAS, BEACON], { teamBringStatus: vi.fn(async () => ({ ...movingAtlas, phase: "done" })) });
  await draw();
  await act(async () => { moveButton("atlas")!.click(); });
  bridge.teamBring.mockResolvedValue({ team: TEAM, bots: [BEACON] });
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(host.querySelector('[data-bring-line="done"]')?.textContent).toContain("Atlas is in Acme now");
  expect(moveButton("atlas")).toBeNull();
  expect(moveButton("beacon")!.disabled).toBe(false);
});

it("says plainly when the move can't start", async () => {
  page([ATLAS, BEACON], { teamBringMove: vi.fn(async () => { throw new Error("no"); }) });
  await draw();
  await act(async () => { moveButton("atlas")!.click(); });
  expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy();
});

it("is on the team's Bring your stuff in the desktop app, and nowhere else", async () => {
  page([ATLAS, BEACON]);
  const bring = async (team: boolean, desktop: boolean) => {
    await act(async () => { root.render(createElement(WelcomeBring, { name: "Acme", desktop, cloudHasWork: true, team, headingRef: { current: null }, onTeam: () => {}, onFinish: () => {} })); });
    await act(async () => {});
    return Boolean(host.querySelector("[data-bring-my-cloud]"));
  };
  expect(await bring(true, true)).toBe(true);
  expect(await bring(false, true), "on My Cloud itself").toBe(false);
  expect(await bring(true, false), "in a browser").toBe(false);
});

const SCOUT = { id: "scout", name: "Scout" }, QUILL = { id: "quill", name: "Quill" }, LUNA = { id: "luna", name: "Luna", stays: "chief" as const };
const computerButton = (id: string) => host.querySelector<HTMLButtonElement>(`[data-bring-move-computer="${id}"]`);

it("with no My Cloud, lists this computer's bots, each with one Move from this computer, and says why the Chief stays", async () => {
  const bridge = page([], { teamBring: vi.fn(async () => ({ team: TEAM, bots: [], computer: [LUNA, SCOUT, QUILL] })) });
  await draw();
  expect(host.textContent).not.toContain("Move a bot here from My Cloud");
  expect(host.textContent).toContain("Move a bot here from this computer");
  expect(host.querySelector('[data-bring-computer-bot="luna"]')?.textContent).toContain("Your Chief of Staff stays on this computer");
  expect(computerButton("luna")).toBeNull();
  await act(async () => { computerButton("scout")!.click(); });
  expect(bridge.teamBringMove).toHaveBeenCalledExactlyOnceWith("scout", "computer");
});

it("lists both places when the person has both, and offers several of this computer's at once through the chooser, sent by id with main's one confirm", async () => {
  const many = { ...movingAtlas, bot: SCOUT, from: "computer" as const, batch: [{ ...SCOUT, phase: "moving" as const }, { ...QUILL, phase: "moving" as const }] };
  const teamBringMany = vi.fn(async (_ids: string[]) => ({ started: true, move: many }));
  page([ATLAS], { teamBring: vi.fn(async () => ({ team: TEAM, bots: [ATLAS], computer: [SCOUT, QUILL] })), teamBringMany });
  await draw();
  expect(moveButton("atlas")).not.toBeNull();
  expect(computerButton("scout")).not.toBeNull();
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-bring-several]")!.click(); });
  const chooser = document.body.querySelector("[data-move-chooser]")!;
  expect(chooser.textContent).toContain("Move bots to Acme");
  await act(async () => { document.body.querySelector<HTMLButtonElement>("[data-move-select-all]")!.click(); });
  await act(async () => { document.body.querySelector<HTMLButtonElement>("[data-move-chosen]")!.click(); });
  expect(teamBringMany).toHaveBeenCalledExactlyOnceWith(["scout", "quill"]);
  expect(document.body.querySelector("[data-move-chooser]")).toBeNull();
  expect(host.querySelector('[data-bring-line="sending"]')?.textContent).toContain("Moving Scout to Acme (1 of 2)…");
});

it("offers no several with one bot of this computer's to bring", async () => {
  page([], { teamBring: vi.fn(async () => ({ team: TEAM, bots: [], computer: [SCOUT] })), teamBringMany: vi.fn() });
  await draw();
  expect(host.querySelector("[data-bring-several]")).toBeNull();
});
