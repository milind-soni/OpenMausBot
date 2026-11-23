// @vitest-environment happy-dom
// The Devices page over a fake desktop bridge and a fake server: what the map draws, what its buttons call, the private
// network's states and Add a device's pairing link, with nothing reaching a real server or Tailscale.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionState } from "@/lib/companion-types";
import { setLocale } from "@/lib/i18n";
import { forgetSharedSession } from "@/lib/session-reuse";
import { initialState, StoreContext } from "@/state/store";
import { fullContext } from "../settings-index";
import { SettingsShellContext, type SettingsShell } from "../settings-shell";
import { DevicesPage, nextNetworkStep, tailscaleDownload } from "./DevicesPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = Date.now();
const off = { on: false, since: null };

let host: HTMLDivElement;
let root: Root;
let companion: CompanionState;
let session: unknown;
let sessions: Array<{ id: string; label: string; scopes: string[]; lastSeenAt: number }>;
let requests: string[];
let bridge: Record<string, ReturnType<typeof vi.fn>>;
let environments: Record<string, ReturnType<typeof vi.fn>>;
let go: ReturnType<typeof vi.fn<SettingsShell["go"]>>;

const reply = async () => companion;
function install(tailscaleProblem?: CompanionState["tailscaleProblem"]) {
  bridge = {
    state: vi.fn(reply), start: vi.fn(reply), stop: vi.fn(reply), keepAwake: vi.fn(reply), refreshTailscale: vi.fn(reply), pairing: vi.fn(reply),
    cloudDesktop: vi.fn(reply), browserControl: vi.fn(reply),
    revoke: vi.fn(async (id: string) => { companion = { ...companion, devices: companion.devices.filter((device) => device.id !== id) }; return companion; }),
    setTailscaleComputers: vi.fn(async () => {
      if (tailscaleProblem) return { ...companion, tailscaleProblem };
      companion = { ...companion, routes: { ...companion.routes!, tailscale: { on: true, since: NOW, name: "ada.tail1.ts.net", computers: true } }, tailnetShare: { on: true, origin: "http://ada.tail1.ts.net:8799", https: false, problem: null } };
      return companion;
    }),
  };
  environments = {
    state: vi.fn(async () => ({ localOrigin: "http://127.0.0.1:8799", remote: false, packaged: true, activeId: "local", environments: [
      { id: "local", kind: "local", name: "This computer" },
      { id: "home", kind: "remote", name: "Ada’s Cloud", origin: "https://ada.mausbot.cloud", home: true },
      { id: "vps", kind: "remote", name: "Hetzner box", origin: "https://maus.example.com" },
    ] })),
    status: vi.fn(async () => [{ id: "vps", state: "cantReach", since: NOW, version: "0.1.180", behind: false, install: "docker" }]),
    switch: vi.fn(async () => {}), forget: vi.fn(async () => {}), retry: vi.fn(async () => {}),
  };
  vi.stubGlobal("ogb", undefined);
  (window as unknown as { ogb: unknown }).ogb = {
    platform: "darwin", app: { version: "0.1.180" }, companion: bridge, environments,
    companionAccount: { state: async () => ({ available: true, status: "ready", email: "ada@example.com" }) },
  };
}

beforeEach(() => {
  setLocale("en");
  forgetSharedSession();
  requests = [];
  session = { kind: "loopback", trust: "owner" };
  sessions = [];
  companion = {
    enabled: true, keepAwake: false, port: 8810, pairing: null,
    devices: [
      { id: "iphone", name: "Ada’s iPhone", createdAt: NOW, lastSeenAt: NOW, cloudDesktopAccess: false, route: "wifi" },
      { id: "pixel", name: "Pixel 9", createdAt: NOW, lastSeenAt: NOW - 86_400_000, cloudDesktopAccess: false, route: null },
    ],
    connectedDeviceIds: ["iphone"],
    routes: { wifi: { on: true, since: NOW }, relay: off, tailscale: off, https: off },
  };
  install();
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input, "http://127.0.0.1").pathname;
    requests.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/auth/session") return Response.json(session);
    if (path === "/api/auth/sessions") return Response.json({ sessions, current: null });
    if (path === "/api/auth/pairing" && init?.method === "POST") return Response.json({ id: "p1", code: "7KQ2-M9XD-H4TP", expiresAt: NOW + 600_000, url: null, hint: null });
    if (path === "/api/phones") return Response.json({ phones: [] });
    if (path === "/api/config") return Response.json({ membership: { authority: "local", pairingCodes: true } });
    return Response.json({ error: "no route" }, { status: 404 });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  go = vi.fn<SettingsShell["go"]>();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  delete (window as unknown as { ogb?: unknown }).ogb;
  vi.unstubAllGlobals();
});

const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T & HTMLElement>(selector);
const click = async (selector: string) => { await act(async () => $(selector)!.click()); await settle(); };

async function render(over: Partial<SettingsShell["ctx"]> = {}) {
  const shell: SettingsShell = { ctx: fullContext({ advanced: false, ...over }), place: { name: "This computer", kind: "computer", color: null, named: false }, page: "devices", anchor: null, go };
  const state = { ...initialState, config: { profile: { email: "ada@example.com" }, managedPolicy: null } as never };
  act(() => root.render(createElement(StoreContext.Provider, { value: { state, dispatch: vi.fn() } as never },
    createElement(SettingsShellContext.Provider, { value: shell }, createElement(DevicesPage)))));
  await settle();
}

describe("the Devices page", () => {
  it("draws this computer at the root and one branch per way in, each device with its state", async () => {
    await render();
    expect($("[data-device-node=here]")?.textContent).toContain("This computer");
    expect([...document.querySelectorAll("[data-device-route]")].map((branch) => branch.getAttribute("data-device-route"))).toEqual(["tailscale", "local", "cloud", "internet"]);
    expect($("[data-device-route=local] [data-device-node='phone:iphone']")?.getAttribute("data-device-status")).toBe("online");
    expect($("[data-device-route=internet] [data-device-node='place:vps']")?.textContent).toContain("Can’t reach it");
    expect($("[data-device-route=cloud] [data-device-node='place:home']")?.textContent).toContain("Home");
    expect($("[data-device-row='phone:pixel']")?.textContent).toContain("Seen");
  });

  it("opens a chosen device's card, whose buttons call the actions that already exist", async () => {
    await render();
    await click("[data-device-node='place:vps']");
    expect($("[data-device-card='place:vps']")).not.toBeNull();
    await click("[data-device-card='place:vps'] [data-device-action=retry]");
    expect(environments.retry).toHaveBeenCalledWith("vps");
    await click("[data-device-card='place:vps'] [data-device-action=remove]");
    expect(environments.forget).toHaveBeenCalledWith("vps");
    await click("[data-device-node='phone:pixel']");
    await click("[data-device-card='phone:pixel'] [data-device-action=remove]");
    expect(bridge.revoke).toHaveBeenCalledWith("pixel");
    expect($("[data-device-node='phone:pixel']")).toBeNull();
    await click("[data-device-node='phone:iphone']");
    await click("[data-device-card='phone:iphone'] [data-device-action=manage]");
    expect(go).toHaveBeenCalledWith("phone", "paired");
  });

  it("never asks Tailscale on its own, and shows the check's answer and its next step after Set up", async () => {
    install("not-installed");
    await render();
    expect($("[data-network-state]")?.getAttribute("data-network-state")).toBe("unknown");
    expect(bridge.setTailscaleComputers).not.toHaveBeenCalled();
    expect(bridge.refreshTailscale).not.toHaveBeenCalled();
    await click("[data-network-action]");
    expect(bridge.setTailscaleComputers).toHaveBeenCalledWith(true);
    expect($("[data-network-state]")?.textContent).toBe("Not installed");
    expect($<HTMLAnchorElement>("a[data-network-action]")?.href).toBe("https://tailscale.com/download/mac");
    expect($("[data-network-line]")?.textContent).toContain("Install Tailscale");
  });

  it("puts devices reached over Tailscale inside the private network once it is ready", async () => {
    companion = {
      ...companion, routes: { ...companion.routes!, tailscale: { on: true, since: NOW, name: "ada.tail1.ts.net", computers: true } },
      devices: [...companion.devices, { id: "tab", name: "Tablet", createdAt: NOW, lastSeenAt: NOW, cloudDesktopAccess: false, route: "tailscale" }], connectedDeviceIds: ["iphone", "tab"],
    };
    await render();
    expect($("[data-network-state]")?.textContent).toBe("On");
    expect($("[data-private-network] [data-device-node='phone:tab']")).not.toBeNull();
    expect($("[data-network-line]")?.textContent).toContain("ada.tail1.ts.net");
    expect(bridge.setTailscaleComputers).not.toHaveBeenCalled();
  });

  it("gives another computer a pairing link over the private network and says when it connected", async () => {
    await render();
    await click("[data-network-action]");
    await click("[data-add-device]");
    await click("[data-add-kind=computer]");
    expect(requests).toContain("POST /api/auth/pairing");
    expect($("[data-pair-link]")?.textContent).toBe("http://ada.tail1.ts.net:8799/pair#code=7KQ2-M9XD-H4TP");
    expect($("[data-pair-state]")?.getAttribute("data-pair-state")).toBe("waiting");
    sessions = [{ id: "s-new", label: "Studio Mac mini", scopes: ["admin", "client"], lastSeenAt: NOW }];
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_300)); });
    await settle();
    expect($("[data-pair-state]")?.textContent).toBe("Studio Mac mini is connected");
  }, 10_000);

  it("cancels a code nobody used when the dialog closes", async () => {
    await render();
    await click("[data-network-action]");
    await click("[data-add-device]");
    await click("[data-add-kind=computer]");
    await click("[data-dialog-title] button");
    expect(requests).toContain("DELETE /api/auth/pairing/p1");
  });

  it("asks for the private network first when Add a computer comes before it", async () => {
    install("signed-out");
    await render();
    await click("[data-add-device]");
    await click("[data-add-kind=computer]");
    expect($("[data-add-network]")?.getAttribute("data-add-network")).toBe("unknown");
    expect(requests).not.toContain("POST /api/auth/pairing");
  });

  it("offers a chat-only session no code at all", async () => {
    delete (window as unknown as { ogb?: unknown }).ogb;
    session = { kind: "session", id: "s1", label: "Chrome on Mac", scopes: ["client"], expiresAt: 0 };
    await render({ here: false, desktop: false, home: false });
    await click("[data-add-device]");
    await click("[data-add-kind=phone]");
    expect($("[data-pair-blocked]")).not.toBeNull();
    expect(requests.filter((request) => request.startsWith("POST"))).toEqual([]);
    expect(requests).not.toContain("GET /api/auth/sessions");
  });

  it("gives a new server one line to run, the sign-in included", async () => {
    await render();
    await click("[data-add-device]");
    await click("[data-add-kind=server]");
    expect([...document.querySelectorAll("[data-server-command]")].map((line) => line.textContent)).toEqual([
      "npx openmausbot account login && npx openmausbot serve --tunnel", "npx openmausbot serve --tailscale",
    ]);
  });

  it("reads as a list in a narrow window: every device a full-width row", async () => {
    await render();
    expect($("[data-device-tree]")?.tagName).toBe("UL");
    expect($("[data-device-node='phone:iphone']")?.className).toContain("@max-[480px]/map:w-full");
  });
});

describe("the private network's next step", () => {
  const run = { check: vi.fn(), addComputer: vi.fn() };
  it("is one button per state, and none where an organization turned remote access off", () => {
    const step = (state: Parameters<typeof nextNetworkStep>[0], blocked = false) => nextNetworkStep(state, run, { busy: false, blocked, platform: "win32" });
    expect(step({ state: "unknown", name: null, shared: false })?.label).toBe("Set up");
    expect(step({ state: "not-installed", name: null, shared: false })?.href).toBe("https://tailscale.com/download/windows");
    expect(step({ state: "needs-approval", name: null, shared: false })?.label).toBe("Check again");
    expect(step({ state: "ready", name: "a", shared: false })?.label).toBe("Let your computers in");
    expect(step({ state: "ready", name: "a", shared: true })?.label).toBe("Add a computer");
    expect(step({ state: "unknown", name: null, shared: false }, true)).toBeNull();
    expect(tailscaleDownload("linux")).toBe("https://tailscale.com/download/linux");
  });
});
