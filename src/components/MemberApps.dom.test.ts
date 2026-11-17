// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const f = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), open: vi.fn(async () => true) }));
vi.mock("@/state/store", () => ({ api: f.api, useStore: () => ({ state: { config: { team: { id: "team-acme", name: "Acme" } } }, dispatch: f.dispatch }) }));
vi.mock("@/lib/connector-oauth", () => ({ reserveConnectionPage: () => ({ open: f.open, cancel: vi.fn() }) }));
const { MemberApps } = await import("./MemberApps");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
let apps: Array<{ slug: string; name: string; connected: boolean; reconnect?: boolean }>;
const show = async () => { await act(async () => { root.render(createElement(MemberApps)); }); };
const press = async (label: string) => { await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === label)!.click(); }); };
const calls = () => f.api.mock.calls.map(([path, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${path}`);

beforeEach(() => {
  setLocale("en");
  apps = [{ slug: "gmail", name: "Gmail", connected: false }, { slug: "googlecalendar", name: "Google Calendar", connected: true }];
  f.api.mockReset(); f.dispatch.mockReset(); f.open.mockClear();
  f.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/team/my-connections") return { apps };
    if (init?.method === "POST") return { url: "https://connect.example.test/link" };
    return {};
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("lists only the member's own apps, with no word about an installation's admin or an unavailable service", async () => {
  await show();
  expect(calls()).toEqual(["GET /api/team/my-connections"]);
  expect(host.textContent).toContain("Yours to connect");
  expect([...host.querySelectorAll("[data-app-tile]")].map((tile) => `${tile.getAttribute("data-app-tile")}: ${tile.querySelector("button")!.textContent}`))
    .toEqual(["gmail: Connect", "googlecalendar: Disconnect"]);
  expect(host.textContent).not.toMatch(/forbidden|admin of this installation|temporarily unavailable/);
});

it("Connect opens the app's own sign-in and Disconnect removes the member's own connection", async () => {
  await show();
  await press("Connect");
  expect(calls()).toContain("POST /api/team/my-connections/apps/gmail/connect");
  expect(f.open).toHaveBeenCalledWith("https://connect.example.test/link");
  await press("Disconnect");
  expect(calls()).toContain("DELETE /api/team/my-connections/apps/googlecalendar");
});

it("offers the sign-in as a link when the browser blocked the new tab, and Reconnect for an app to connect again", async () => {
  apps = [{ slug: "gmail", name: "Gmail", connected: true, reconnect: true }];
  f.open.mockResolvedValueOnce(false);
  await show();
  await press("Reconnect");
  expect(host.querySelector("a")?.getAttribute("href")).toBe("https://connect.example.test/link");
});

it("says so when nothing is theirs to connect, and says the server's own words when it refuses", async () => {
  apps = [];
  await show();
  expect(host.querySelector("[data-member-apps-none]")?.textContent).toBe("Nothing here is yours to connect yet. Acme's admins connect apps for the whole team.");
  f.api.mockRejectedValueOnce(new Error("Your own apps can't be connected on Acme yet."));
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Your own apps can't be connected on Acme yet.");
});
