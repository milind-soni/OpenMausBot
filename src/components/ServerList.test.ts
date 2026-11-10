// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ServerStatus } from "../../electron/server-status.mjs";
import { setLocale } from "@/lib/i18n";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
const { ServerList, updateCommand } = await import("./ServerList");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
let statuses: ServerStatus[] = [];
let tell: (() => void) | null = null;
const environments = { status: vi.fn(async () => statuses), retry: vi.fn(async () => {}), onStatus: vi.fn((callback: () => void) => { tell = callback; return () => { tell = null; }; }) };
const workspaces = { probe: vi.fn(async () => ({ outcome: "problem", problem: "unreachable", host: "x" })), add: vi.fn() };
const saved = {
  localOrigin: "http://127.0.0.1:1", remote: false, packaged: true, activeId: "local",
  environments: [
    { id: "cloud", name: "My Cloud", origin: "https://omb-u-1.fly.dev", home: true, kind: "remote" as const },
    { id: "vps", name: "hetzner-1", origin: "https://maus.example.com", kind: "remote" as const },
    { id: "mini", name: "office-mini", origin: "http://192.168.1.50:8799", kind: "remote" as const },
    { id: "mac", name: "Mac at home", origin: "https://mac.tail1234.ts.net", kind: "remote" as const },
    { id: "open", name: "old box", origin: "http://203.0.113.9:8799", kind: "remote" as const },
  ],
};
const props = { saved, busy: false, sharingOffered: false, appVersion: "0.1.147", onSwitch: vi.fn(), onForget: vi.fn(), onComputerAccess: vi.fn() };
const row = (id: string) => host.querySelector(`[data-server-row="${id}"]`)!;
const buttonIn = (element: Element, label: string) => [...element.querySelectorAll("button")].find((button) => button.textContent === label || button.getAttribute("aria-label") === label);
const click = async (element: Element | null | undefined) => { expect(element).toBeTruthy(); await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); }); };

beforeEach(() => {
  setLocale("en");
  vi.clearAllMocks();
  statuses = [
    { id: "vps", state: "connected", since: 0, version: "0.1.140", behind: true, install: "docker" },
    { id: "mini", state: "cantReach", since: new Date(2026, 10, 7, 9, 12).getTime(), version: null, behind: false, install: null },
    { id: "mac", state: "signedOut", since: 0, version: "0.1.147", behind: false, install: "npx" },
    { id: "open", state: "insecure", since: 0, version: null, behind: false, install: null },
  ];
  Object.assign(window, { ogb: { environments, workspaces } });
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); document.body.innerHTML = ""; });

async function mount() {
  root = createRoot(host);
  await act(async () => { root!.render(createElement(ServerList, props)); });
  await act(async () => { await Promise.resolve(); });
}

it("each saved server says how it is reached and how it is doing, with one thing to do when it needs the person", async () => {
  await mount();
  expect(row("cloud").querySelector("[data-server-where]")?.textContent).toBe("Managed by MausBot");
  expect(buttonIn(row("cloud"), "Remove My Cloud"), "My Cloud has no Remove").toBeUndefined();
  expect(row("vps").querySelector("[data-server-where]")?.textContent).toBe("maus.example.com · HTTPS");
  expect(row("mini").querySelector("[data-server-where]")?.textContent).toBe("192.168.1.50:8799 · Private network, not encrypted");
  expect(row("mac").querySelector("[data-server-where]")?.textContent).toBe("mac.tail1234.ts.net · Tailscale");
  expect(row("vps").querySelector("[data-server-state]"), "a connected server needs no line").toBeNull();
  expect(row("mini").querySelector("[data-server-state]")?.textContent).toMatch(/^Can't reach · since 0?9:12.*Try now$/);
  expect(row("mac").querySelector("[data-server-state]")?.textContent).toBe("Needs a new codePair again");
  expect(row("open").querySelector("[data-server-state]")?.textContent).toBe("Not encrypted on the open internetEdit address");
  await click(buttonIn(row("mini").querySelector("[data-server-state]")!, "Try now"));
  expect(environments.retry).toHaveBeenCalledWith("mini");
});

it("the update note shows only for a server behind this app, with the command that fits its install, and hides", async () => {
  await mount();
  const notes = [...host.querySelectorAll("[data-server-behind]")];
  expect(notes).toHaveLength(1);
  expect(notes[0]!.textContent).toContain("hetzner-1 runs MausBot 0.1.140. This app is 0.1.147.");
  expect(notes[0]!.textContent).toContain("Copy update command");
  await click(buttonIn(notes[0]!, "Hide this note"));
  expect(host.querySelector("[data-server-behind]")).toBeNull();
  expect(updateCommand("docker", "0.1.147")).toBe("git pull && ./update.sh");
  expect(updateCommand("npx", "0.1.147")).toBe("npx openmausbot@0.1.147 serve");
  expect(updateCommand(null, "0.1.147")).toBe("npx openmausbot@0.1.147 serve");
  expect(updateCommand("global", "0.1.147")).toBe("npm install -g openmausbot@0.1.147");
});

it("Pair again opens the Connect sheet with the address locked and the code field ready; Remove only asks main", async () => {
  await mount();
  await click(buttonIn(row("mac").querySelector("[data-server-state]")!, "Pair again"));
  const form = document.querySelector('[data-place-add="own-server"]')!;
  expect(form.textContent).toContain("Pair again with Mac at home");
  const address = form.querySelector("[data-own-server-link]") as HTMLInputElement;
  expect([address.value, address.readOnly]).toEqual(["https://mac.tail1234.ts.net", true]);
  expect(document.activeElement).toBe(form.querySelector("[data-own-server-code]"));
  await click(document.querySelector('[aria-label="Close"]'));
  await click(buttonIn(row("vps"), "Remove hetzner-1"));
  expect(props.onForget).toHaveBeenCalledWith("vps");
  await click(host.querySelector("[data-server-connect]"));
  expect((document.querySelector("[data-own-server-link]") as HTMLInputElement).readOnly).toBe(false);
});

it("main's word that a status changed is read at once", async () => {
  await mount();
  statuses = [{ id: "mini", state: "reconnecting", since: 0, version: null, behind: false, install: null }];
  await act(async () => { tell!(); await Promise.resolve(); });
  expect(row("mini").querySelector("[data-server-state]")?.textContent).toBe("Reconnecting…");
  expect(row("mac").querySelector("[data-server-state]")).toBeNull();
});

it("a server of the person's own has \"Share this computer\" with its switch; Choose what it can use opens only while it is on", async () => {
  const onShare = vi.fn();
  root = createRoot(host);
  const render = async (ownServers: Array<{ id: string; enabled: boolean; connected: boolean; paused: boolean }>) => {
    await act(async () => { root!.render(createElement(ServerList, { ...props, ownServers, onShare })); });
  };
  await render([{ id: "vps", enabled: false, connected: false, paused: false }]);
  const share = row("vps").querySelector("[data-server-share]")!;
  expect(share.textContent).toContain("Share this computer");
  expect(share.textContent).toContain("Let hetzner-1's bots use folders you choose, a terminal and the apps on your screen.");
  expect(row("mini").querySelector("[data-server-share]"), "only servers of the person's own").toBeNull();
  expect(row("cloud").querySelector("[data-server-share]")).toBeNull();
  expect(buttonIn(share, "Choose what it can use")).toBeUndefined();
  const toggle = share.querySelector("[role=switch]")!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.getAttribute("aria-label")).toBe("Share this computer with hetzner-1");
  await click(toggle);
  expect(onShare).toHaveBeenCalledWith("vps", true);

  await render([{ id: "vps", enabled: true, connected: true, paused: false }]);
  expect(row("vps").querySelector("[role=switch]")?.getAttribute("aria-checked")).toBe("true");
  expect(row("vps").querySelector("[data-server-share]")?.textContent).toContain("hetzner-1's bots can use this computer while this app is open.");
  await click(buttonIn(row("vps"), "Choose what it can use"));
  expect(props.onComputerAccess).toHaveBeenCalledWith("vps");
  await click(row("vps").querySelector("[role=switch]"));
  expect(onShare).toHaveBeenLastCalledWith("vps", false);

  await render([{ id: "vps", enabled: true, connected: false, paused: true }]);
  expect(row("vps").querySelector("[data-server-share]")?.textContent).toContain("Paused: hetzner-1's bots can't use this computer until you resume.");
});
