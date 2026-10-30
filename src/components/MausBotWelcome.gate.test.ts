// @vitest-environment happy-dom
// When MausBot's first-launch card may open: like the Cloud Pro popup and the product-updates question, never over the
// first chat before a reply, never in the launch the welcome finished, never while the app tour runs, and never in the
// same launch as those two.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { launchDialogShown, markLaunchDialog } from "@/lib/launch-dialogs";
import { EMPTY_ONBOARDING, LOCAL_VIEWER, markWelcomeFinished, WELCOME_VERSION } from "@/lib/onboarding";
import { setLocale } from "@/lib/i18n";

const f = vi.hoisted(() => ({ state: {} as Record<string, unknown>, welcoming: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", async (original) => ({ ...(await original<typeof import("@/state/store")>()), useStore: () => ({ state: f.state, dispatch: f.dispatch }) }));
vi.mock("@/lib/analytics", () => ({ emailGateDone: () => false, track: vi.fn() }));
vi.mock("@/lib/default-bot", async (original) => ({
  ...(await original<typeof import("@/lib/default-bot")>()),
  useViewerEmail: () => null,
  setWelcomingBot: (id: string | null) => f.welcoming(id),
}));
vi.mock("./MausBotCustomize", () => ({ MausBotCustomize: () => null }));
const { MausBotWelcome } = await import("./MausBotWelcome");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const maus = (turns: number) => ({ id: "maus", threadId: "t1", name: "MausBot", title: "", description: "", notifications: true, color: "chrome",
  mascotBody: null, avatarUrl: null, unread: false, modelSelection: { instanceId: "claude", model: "sonnet" }, createdAt: 1, defaultBot: {}, messages: [],
  tasks: [{ threadId: "t1", title: "", createdAt: 1, ...(turns ? { usage: { input: 1, output: 1, costUsd: null, turns } } : {}) }] });
let host: HTMLDivElement, root: Root;
const show = async () => { await act(async () => { root.render(createElement(MausBotWelcome, { viewer: LOCAL_VIEWER })); }); };
const opened = () => f.welcoming.mock.calls.some(([id]) => id === "maus");
beforeEach(() => {
  setLocale("en");
  f.welcoming.mockReset();
  f.dispatch.mockReset();
  sessionStorage.clear();
  vi.stubGlobal("ogb", undefined);
  const welcomed = { ...EMPTY_ONBOARDING, completedAt: "2026-10-23T00:00:00.000Z", version: WELCOME_VERSION };
  f.state = { hydrated: true, config: { onboarding: welcomed }, bots: [maus(1)], welcomeOpen: false, tourOpen: false, instances: [], groups: [] };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("opens once the welcome is done and a bot has answered, though the app tour was never taken", async () => {
  await show();
  expect(opened()).toBe(true);
});

it("claims the launch when it opens, so the Cloud Pro popup and the updates question wait for a later one", async () => {
  await show();
  expect(launchDialogShown()).toBe("mausbot");
});

it("waits while the app tour runs from Settings", async () => {
  f.state = { ...f.state, tourOpen: true };
  await show();
  expect(opened()).toBe(false);
});

it("waits for a first reply, and does not decide before the bots have loaded", async () => {
  f.state = { ...f.state, bots: [maus(0)] };
  await show();
  expect(opened(), "the first chat, no reply yet").toBe(false);
  f.state = { ...f.state, bots: [maus(1)], hydrated: undefined };
  await show();
  expect(opened(), "bots not loaded yet").toBe(false);
});

it("waits for a launch after the one whose welcome finished", async () => {
  markWelcomeFinished();
  await show();
  expect(opened()).toBe(false);
  sessionStorage.clear();
  await act(async () => root.unmount());
  root = createRoot(host);
  await show();
  expect(opened(), "the next launch").toBe(true);
});

it("never opens in a launch where the Cloud Pro popup or the updates question already opened", async () => {
  markLaunchDialog("notices");
  await show();
  expect(opened()).toBe(false);
});

it("Escape keeps the card as seen, so it does not come back and claim every later launch", async () => {
  await show();
  const dialog = document.querySelector<HTMLElement>("[data-mausbot-welcome] [role=dialog]");
  expect(dialog).toBeTruthy();
  await act(async () => { dialog!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(f.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "maus", patch: { welcomed: true } });
  expect(document.querySelector("[data-mausbot-welcome]"), "closed").toBeNull();
});

it("never comes after a first run that met the Chief, which already introduced MausBot; an older install still gets it once", async () => {
  f.state = { ...f.state, bots: [{ ...maus(1), welcomed: true }] };
  await show();
  expect(opened()).toBe(false);
  f.state = { ...f.state, bots: [maus(1)] };
  await show();
  expect(opened()).toBe(true);
});
