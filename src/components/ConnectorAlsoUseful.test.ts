// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", () => ({ api }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
const { ConnectorAlsoUseful } = await import("./ConnectorAlsoUseful");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, page: { location: { replace: ReturnType<typeof vi.fn> }; closed: boolean; close: ReturnType<typeof vi.fn>; opener: unknown };
const app = (slug: string, label: string) => ({ slug, label, blurb: "", logo: null, domain: null });
let cards: Array<ReturnType<typeof app>>;
let authorize: () => unknown;

const settle = () => act(async () => { for (let turn = 0; turn < 6; turn += 1) await Promise.resolve(); });
const chip = (slug: string) => host.querySelector<HTMLButtonElement>(`[data-also-useful-app="${slug}"]`);
async function render() {
  await act(async () => root.render(createElement(ConnectorAlsoUseful, { botId: "atlas", slug: "gmail" })));
  await settle();
}

beforeEach(() => {
  setLocale("en");
  vi.useFakeTimers();
  cards = [app("googlecalendar", "Google Calendar"), app("slack", "Slack")];
  authorize = () => ({ url: "https://connect.composio.dev/link/abc" });
  api.mockReset();
  api.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/connectors/suggestions")) return { cards, pick: "available" };
    if (path.endsWith("/authorize")) return authorize();
    if (path.startsWith("/api/connectors/connected")) return { services: {} };
    return { services: { slack: { connected: true, pending: false, status: "ACTIVE" } } };
  });
  page = { location: { replace: vi.fn() }, closed: false, close: vi.fn(), opener: {} };
  vi.stubGlobal("open", vi.fn(() => page));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("offers the suggested apps for this bot and this card", async () => {
  await render();
  expect(api.mock.calls[0]![0]).toBe("/api/connectors/suggestions?botId=atlas&for=gmail&limit=3");
  expect(host.textContent).toContain("Also useful");
  expect(chip("slack")?.textContent).toContain("Slack");
  expect(chip("slack")?.getAttribute("aria-label")).toBe("Connect Slack");
});

it("shows nothing with fewer than two apps to offer, or when they can't be read", async () => {
  cards = [app("slack", "Slack")];
  await render();
  expect(host.querySelector("[data-also-useful]")).toBeNull();
  api.mockRejectedValue(Object.assign(new Error("forbidden: this session lacks the admin scope"), { status: 403 }));
  await act(async () => root.render(createElement(ConnectorAlsoUseful, { botId: "atlas", slug: "notion" })));
  await settle();
  expect(host.querySelector("[data-also-useful]")).toBeNull();
  expect(host.querySelector("[role=alert]")).toBeNull();
});

it("connects in one tap, on the sign-in page, and shows when it's done", async () => {
  await render();
  await act(async () => { chip("slack")!.click(); });
  await settle();
  expect(window.open).toHaveBeenCalledWith("", "_blank");
  expect(api).toHaveBeenCalledWith("/api/connectors/slack/authorize", { method: "POST" });
  expect(page.location.replace).toHaveBeenCalledWith("https://connect.composio.dev/link/abc");
  expect(chip("slack")!.disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
  await settle();
  expect(chip("slack")!.getAttribute("aria-label")).toBe("Slack · Connected");
});

it("says why when the sign-in can't start and lets the person try again", async () => {
  authorize = () => { throw new Error("The app's sign-in couldn't start."); };
  await render();
  await act(async () => { chip("slack")!.click(); });
  await settle();
  expect(host.querySelector("[role=alert]")?.textContent).toBe("The app's sign-in couldn't start.");
  expect(chip("slack")!.disabled).toBe(false);
  expect(page.close).toHaveBeenCalled();
});
