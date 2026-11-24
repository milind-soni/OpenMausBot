// @vitest-environment happy-dom
// "Let <server>'s bots use this computer" in each place it shows, over a stand-in for main's lend:* bridge: the Screen
// panel on a server's own page (not lent, lent, waiting, permission missing, can't be lent, Cloud or team), the browser
// with no app, this app's own page, and the add form.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { lendLine } from "@/lib/use-lend-computer";

let capabilities: { host: { label: string; platform: string }; localComputer: { reasonCode?: string; available: boolean } };
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities, ready: true }) }));
const { AddFormLendSwitch, LendComputerSwitch, LendHere } = await import("./LendComputerSwitch");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
let view: DesktopLendView;
const lendComputer = {
  state: vi.fn(async (_id: string | null) => view),
  set: vi.fn(async (_id: string | null, on: boolean) => { view = { ...(view as Extract<DesktopLendView, { lendable: true }>), on, connected: on }; return view; }),
  allowScreen: vi.fn(async (_id: string | null) => { view = { ...(view as Extract<DesktopLendView, { lendable: true }>), screen: undefined }; return view; }),
  wish: vi.fn(async () => true) as ((address: string, on: boolean) => Promise<boolean>) | undefined,
};
const REMOTE_PAGE = { host: { label: "macOS", platform: "darwin" }, localComputer: { reasonCode: "remote-server", available: false } };
const own = (over: Partial<Extract<DesktopLendView, { lendable: true }>> = {}): DesktopLendView => ({ name: "hetzner-1", lendable: true, on: false, connected: false, paused: false, ...over });

beforeEach(() => {
  setLocale("en");
  vi.clearAllMocks();
  capabilities = REMOTE_PAGE;
  Object.assign(window, { ogb: { lendComputer } });
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); });

async function show(element: ReturnType<typeof createElement>) {
  root = createRoot(host);
  await act(async () => { root!.render(element); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const click = async (element: Element | null | undefined) => { expect(element).toBeTruthy(); await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); await Promise.resolve(); }); };
const line = () => host.querySelector("[data-lend-line]")?.textContent;
const toggle = () => host.querySelector("[role=switch]");

it("Screen panel on your own server, not lent: what it means and one switch, which lends at once", async () => {
  view = own();
  await show(createElement(LendHere));
  expect(host.textContent).toContain("Let hetzner-1’s bots use this computer");
  expect(line()).toBe("Its bots can then see and use the apps on your screen while MausBot is open here.");
  expect(toggle()?.getAttribute("aria-checked")).toBe("false");
  await click(toggle());
  expect(lendComputer.set).toHaveBeenCalledWith(null, true);
  expect(toggle()?.getAttribute("aria-checked")).toBe("true");
  expect(line()).toBe("On: hetzner-1’s bots can use the apps on your screen while MausBot is open here.");
  await click(toggle());
  expect(lendComputer.set).toHaveBeenLastCalledWith(null, false);
  expect(toggle()?.getAttribute("aria-checked")).toBe("false");
});

it("Screen panel on your own server, lent: on, connecting, paused, and macOS's permission with the button that asks for it", async () => {
  view = own({ on: true, connected: true });
  await show(createElement(LendHere));
  expect(line()).toBe("On: hetzner-1’s bots can use the apps on your screen while MausBot is open here.");
  expect(host.querySelector("[data-lend-allow]")).toBeNull();
  await act(async () => root!.unmount()); root = null;

  view = own({ on: true, screen: "permissions" });
  await show(createElement(LendHere));
  expect(toggle()?.getAttribute("aria-checked"), "on, with one step left").toBe("true");
  expect(line()).toBe("One more step: macOS has to allow MausBot to see and control your screen.");
  await click(host.querySelector("[data-lend-allow]"));
  expect(lendComputer.allowScreen).toHaveBeenCalledWith(null);
  expect(host.querySelector("[data-lend-allow]"), "gone once the permission is there").toBeNull();

  expect(lendLine(own({ on: true }))).toBe("On: connecting to hetzner-1…");
  expect(lendLine(own({ on: true, paused: true }))).toBe("Paused from the MausBot icon’s menu. Resume it there.");
  expect(lendLine(own({ on: true, connected: true, screen: "blocked" }))).toContain("computer control is blocked on this computer");
});

it("Screen panel on a server it can't be lent to: the reason in one line, no switch; a Cloud or team says nothing unless the bot is set to This computer", async () => {
  view = { name: "office", lendable: false, why: "shared" };
  await show(createElement(LendHere));
  expect(host.querySelector("[data-lend-reason]")?.textContent).toBe("Bots on office can’t use this computer: other people sign in to it too.");
  expect(toggle()).toBeNull();
  await act(async () => root!.unmount()); root = null;

  view = { name: "Acme", lendable: false, why: "team" };
  await show(createElement(LendHere));
  expect(host.textContent).toBe("");
  await act(async () => root!.unmount()); root = null;
  await show(createElement(LendHere, { appNeeded: true }));
  expect(host.querySelector("[data-lend-reason]")?.textContent).toBe("Bots on Acme can’t use this computer: it’s a team’s server.");

  expect(lendLine({ name: "My Cloud", lendable: false, why: "cloud" })).toBe("My Cloud uses this computer by its own Cloud rules, not this switch. Pause it from the MausBot icon’s menu.");
  expect(lendLine({ name: "box", lendable: false, why: "not-owner" })).toBe("Bots on box can’t use this computer: this app isn’t paired with it as its owner.");
  expect(lendLine({ name: "box", lendable: false, why: "old" })).toBe("Update box to let its bots use this computer.");
  expect(lendLine({ name: "box", lendable: false, why: "unreachable" })).toBe("Can’t reach box to check whether its bots can use this computer.");
});

it("in a browser, for a bot set to This computer: only the app on a computer can lend it, with where to get the app", async () => {
  Object.assign(window, { ogb: undefined });
  capabilities = { host: { label: "Browser", platform: "unknown" }, localComputer: { available: false } };
  await show(createElement(LendHere, { appNeeded: true }));
  expect(host.querySelector("[data-lend-browser]")?.textContent).toContain("Or, in the MausBot app on a computer, connect to this server and turn on “Let its bots use this computer”.");
  expect(host.querySelector("a")?.getAttribute("href")).toBe("https://www.openmausbot.com/download");
  await act(async () => root!.unmount()); root = null;
  await show(createElement(LendHere));
  expect(host.textContent, "never in every browser panel").toBe("");
});

it("this app's own page: the panel shows nothing, while a server's row has the switch by its id", async () => {
  capabilities = { host: { label: "macOS", platform: "darwin" }, localComputer: { available: true } };
  view = own();
  await show(createElement(LendHere));
  expect(host.textContent).toBe("");
  await act(async () => root!.unmount()); root = null;
  await show(createElement(LendComputerSwitch, { id: "vps" }));
  expect(lendComputer.state).toHaveBeenCalledWith("vps");
  await click(toggle());
  expect(lendComputer.set).toHaveBeenCalledWith("vps", true);
});

it("the add form: off by default, and its switch tells main what to do once that server is paired", async () => {
  await show(createElement(AddFormLendSwitch, { address: "https://maus.example.com" }));
  expect(host.textContent).toContain("Let its bots use this computer");
  expect(host.textContent).toContain("Only for a server that’s yours alone.");
  expect(toggle()?.getAttribute("aria-checked")).toBe("false");
  expect(lendComputer.wish).toHaveBeenLastCalledWith("https://maus.example.com", false);
  await click(toggle());
  expect(lendComputer.wish).toHaveBeenLastCalledWith("https://maus.example.com", true);
  await act(async () => root!.unmount()); root = null;
  Object.assign(window, { ogb: { lendComputer: { ...lendComputer, wish: undefined } } });
  await show(createElement(AddFormLendSwitch, { address: "https://maus.example.com" }));
  expect(host.textContent, "a server's own page has no add form switch").toBe("");
});
