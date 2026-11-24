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
let openCodes: string[];
let requests: string[];
let botRows: unknown[] | "forbidden";
let config: Record<string, unknown>;
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
  openCodes = ["p1"];
  botRows = [];
  config = { profile: { email: "ada@example.com" }, managedPolicy: null };
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
    if (path === "/api/auth/pairing") return Response.json({ pairings: openCodes.map((id) => ({ id })) });
    if (path === "/api/phones") return Response.json({ phones: [] });
    if (path === "/api/computers/bots") return botRows === "forbidden" ? Response.json({ error: "admin only" }, { status: 403 }) : Response.json({ now: NOW, rows: botRows });
    if (path === "/api/config" && init?.method === "PUT") return Response.json({ notice: "GPU box is no longer used. Its desktops stay on it.", vps: { configured: false, sshAlias: "", servers: [] } });
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

const BOTS = [{ id: "b1", name: "Scout", color: "green" }, { id: "b2", name: "Writer", color: "purple" }, { id: "b3", name: "Builder", color: "orange" }];
const gpu = { configured: true, sshAlias: "", servers: [{ name: "GPU box", sshAlias: "gpu" }] };
const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T & HTMLElement>(selector);
const click = async (selector: string) => { await act(async () => $(selector)!.click()); await settle(); };

async function render(over: Partial<SettingsShell["ctx"]> = {}) {
  const shell: SettingsShell = { ctx: fullContext({ advanced: false, ...over }), place: { name: "This computer", kind: "computer", color: null, named: false }, page: "devices", anchor: null, go };
  const state = { ...initialState, config: config as never, bots: BOTS as never };
  act(() => root.render(createElement(StoreContext.Provider, { value: { state, dispatch: vi.fn() } as never },
    createElement(SettingsShellContext.Provider, { value: shell }, createElement(DevicesPage)))));
  await settle();
}

describe("the Devices page", () => {
  it("draws this computer as the hub and the rest in plainly named groups, each tile with its state in a mark and words", async () => {
    await render();
    expect($("[data-device-hub] [data-device-node=here]")?.textContent).toContain("This computer");
    expect([...document.querySelectorAll("[data-device-group]")].map((group) => group.getAttribute("data-device-group"))).toEqual(["phones", "servers"]);
    expect([...document.querySelectorAll("[data-device-group] h3")].map((heading) => heading.textContent)).toEqual(["Phones", "Clouds and your own servers"]);
    const iphone = $("[data-device-group=phones] [data-device-node='phone:iphone']")!;
    expect(iphone.getAttribute("data-device-status")).toBe("online");
    expect(iphone.querySelector("[data-device-state]")?.textContent).toBe("Online");
    expect(iphone.querySelector("[data-device-route-chip]")?.textContent).toBe("Same network");
    expect(iphone.closest("li")?.querySelector("[data-line]")?.getAttribute("data-line")).toBe("live");
    const pixel = $("[data-device-node='phone:pixel']")!;
    expect(pixel.textContent).toContain("Seen");
    expect(pixel.closest("li")?.querySelector("[data-line]")?.getAttribute("data-line")).toBe("away");
    expect($("[data-device-group=servers] [data-device-node='place:vps']")?.textContent).toContain("Can’t reach it");
    expect($("[data-device-group=servers] [data-device-node='place:home']")?.textContent).toContain("Home");
    expect($("[data-device-row]")).toBeNull();
  });

  it("puts the one thing a device needs on its tile", async () => {
    await render();
    await click("[data-device-node='place:vps'] ~ * [data-tile-action=retry]");
    expect(environments.retry).toHaveBeenCalledWith("vps");
    expect($("[data-device-node='phone:iphone'] ~ * [data-tile-action]")).toBeNull();
  });

  it("opens a chosen device's card against the map, whose buttons call the actions that already exist, and closes on Escape", async () => {
    await render();
    await click("[data-device-node='place:vps']");
    expect($("[data-device-node='place:vps']")?.getAttribute("aria-expanded")).toBe("true");
    expect($("[data-device-map], [data-settings-block=map]")?.contains($("[data-device-card='place:vps']"))).toBe(true);
    await click("[data-device-card='place:vps'] [data-device-action=remove]");
    expect(environments.forget).toHaveBeenCalledWith("vps");
    await click("[data-device-node='phone:pixel']");
    await click("[data-device-card='phone:pixel'] [data-device-action=remove]");
    expect(bridge.revoke).toHaveBeenCalledWith("pixel");
    expect($("[data-device-node='phone:pixel']")).toBeNull();
    await click("[data-device-node='phone:iphone']");
    await click("[data-device-card='phone:iphone'] [data-device-action=manage]");
    expect(go).toHaveBeenCalledWith("phone", "paired");
    // Settings closes on an Escape that reaches the window unhandled: the map's Escape closes only the card.
    const reached: boolean[] = [];
    const onWindow = (event: KeyboardEvent) => reached.push(!event.defaultPrevented);
    window.addEventListener("keydown", onWindow);
    act(() => { $("[data-device-card='phone:iphone'] button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await settle();
    expect($("[data-device-card]")).toBeNull();
    await click("[data-device-node='place:vps']");
    act(() => { $("[data-device-node='place:vps']")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await settle();
    window.removeEventListener("keydown", onWindow);
    expect($("[data-device-card]")).toBeNull();
    expect(reached.filter(Boolean)).toEqual([]);
  });

  it("opens the card from a tile's Update…, and never closes it from there", async () => {
    environments.state.mockResolvedValue({ localOrigin: "http://127.0.0.1:8799", remote: false, packaged: true, activeId: "local", environments: [
      { id: "local", kind: "local", name: "This computer" }, { id: "mini", kind: "remote", name: "Studio Mac mini", origin: "http://mini.tail1.ts.net:8799" },
    ] });
    environments.status.mockResolvedValue([{ id: "mini", state: "connected", since: NOW, version: "0.1.170", behind: true, install: "global" }]);
    await render();
    await click("[data-device-node='place:mini'] ~ * [data-tile-action=copy-update]");
    expect($("[data-device-card='place:mini'] [data-device-action=copy-update]")?.textContent).toBe("Copy update command");
    await click("[data-device-node='place:mini'] ~ * [data-tile-action=copy-update]");
    expect($("[data-device-card='place:mini']")).not.toBeNull();
  });

  it("is a set of headed lists of buttons, so the keyboard and a screen reader reach every device", async () => {
    await render();
    const nodes = [...document.querySelectorAll<HTMLElement>("[data-device-node]")];
    expect(nodes.map((node) => node.tagName)).toEqual(nodes.map(() => "BUTTON"));
    expect(nodes.every((node) => node.tabIndex === 0 && node.getAttribute("aria-label"))).toBe(true);
    for (const group of document.querySelectorAll("[data-device-group]")) {
      expect(document.getElementById(group.getAttribute("aria-labelledby")!)?.tagName).toBe("H3");
      expect(group.querySelector("ul > li [data-device-node]")).not.toBeNull();
    }
  });

  it("shows which bots work where, the cloud desktops among the devices, and their names on the card", async () => {
    config = { ...config, vps: gpu };
    botRows = [
      { botId: "b1", kind: "local", computerId: "local", name: null, state: "ready", stateAt: NOW },
      { botId: "b2", kind: "cloud", computerId: "cloud:b2", name: null, state: "asleep", stateAt: NOW },
      { botId: "b3", kind: "vps", computerId: "vps:gpu/omb-b3", name: "GPU box", state: "ready", stateAt: NOW, vps: { serverId: "vps:gpu", alias: "gpu", container: "omb-b3" } },
    ];
    await render();
    expect(requests).toContain("GET /api/computers/bots");
    expect($("[data-device-node=here]")?.getAttribute("aria-label")).toContain("Bots here: Scout");
    expect($("[data-device-node=here] [data-device-bots]")?.getAttribute("data-device-bots")).toBe("1");
    const desktop = $("[data-device-group=servers] [data-device-node='cloud:b2']")!;
    expect(desktop.textContent).toContain("Writer’s cloud desktop");
    expect(desktop.querySelector("[data-device-state]")?.textContent).toBe("Asleep");
    await click("[data-device-node='vps:gpu']");
    expect($("[data-device-card='vps:gpu'] [data-device-bot-names]")?.textContent).toContain("Builder");
  });

  it("draws no state at all for a cloud desktop whose state nothing knows", async () => {
    botRows = [{ botId: "b2", kind: "cloud", computerId: "cloud:b2", name: null, state: "unknown", stateAt: null }];
    await render();
    expect($("[data-device-node='cloud:b2']")).not.toBeNull();
    expect($("[data-device-node='cloud:b2'] [data-device-state]")).toBeNull();
  });

  it("draws no bots when the list is refused", async () => {
    botRows = "forbidden";
    await render();
    expect(document.querySelector("[data-device-bots]")).toBeNull();
    expect($("[data-device-node='phone:iphone']")).not.toBeNull();
  });

  it("opens a server bots reach over SSH straight in its editor, and closes with the server's notice once it is removed", async () => {
    config = { ...config, vps: gpu };
    await render();
    await click("[data-device-node='vps:gpu']");
    expect($<HTMLInputElement>("[data-device-card='vps:gpu'] [data-vps-server=gpu] input")?.value).toBe("GPU box");
    await click("[data-device-card='vps:gpu'] [data-vps-server=gpu] button[aria-label^='Remove']");
    expect(requests).toContain("PUT /api/config");
    expect($("[data-device-card]")).toBeNull();
    expect($("[role=status]")?.textContent).toContain("GPU box is no longer used");
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
    expect($("[data-device-group=phones] [data-device-node='phone:tab'] [data-device-route-chip]")?.textContent).toBe("Private network");
    expect($("[data-private-network][data-settings-block=network]")).not.toBeNull();
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
    sessions = [{ id: "s-other", label: "Chrome on Windows", scopes: ["admin", "client"], lastSeenAt: NOW }];
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_300)); });
    await settle();
    expect($("[data-pair-state]")?.getAttribute("data-pair-state")).toBe("waiting");
    sessions = [...sessions, { id: "s-new", label: "Studio Mac mini", scopes: ["admin", "client"], lastSeenAt: NOW }];
    openCodes = [];
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_300)); });
    await settle();
    expect($("[data-pair-state]")?.textContent).toBe("Studio Mac mini is connected");
    await click("[data-dialog-title] button");
    expect(requests).not.toContain("DELETE /api/auth/pairing/p1");
  }, 15_000);

  it("cancels a code nobody used when the dialog closes", async () => {
    await render();
    await click("[data-network-action]");
    await click("[data-add-device]");
    await click("[data-add-kind=computer]");
    await click("[data-dialog-title] button");
    expect(requests).toContain("DELETE /api/auth/pairing/p1");
  });

  it("asks Tailscale again, rather than sharing again, once its route is on", async () => {
    companion = { ...companion, routes: { ...companion.routes!, tailscale: { on: true, since: NOW, name: null, computers: true } } };
    await render();
    expect($("[data-network-state]")?.getAttribute("data-network-state")).toBe("magicdns");
    await click("[data-network-action]");
    expect(bridge.refreshTailscale).toHaveBeenCalled();
    expect(bridge.setTailscaleComputers).not.toHaveBeenCalled();
  });

  it("says the private network is still starting, with Check again, when it is on but nothing answers yet", async () => {
    companion = { ...companion, routes: { ...companion.routes!, tailscale: { on: true, since: NOW, name: "ada.tail1.ts.net", computers: true } }, tailnetShare: { on: true, origin: null, https: false, problem: "not-listening" } };
    await render();
    await click("[data-add-device]");
    await click("[data-add-kind=computer]");
    expect($("[data-add-network]")?.getAttribute("data-add-network")).toBe("waiting");
    expect($("[data-add-network] [data-network-action]")?.textContent).toBe("Check again");
    expect(requests).not.toContain("POST /api/auth/pairing");
  });

  it("pairs a phone on This computer only through Pair a phone, never a server code", async () => {
    await render();
    await click("[data-add-device]");
    await click("[data-add-kind=phone]");
    expect($("[data-pair-dialog]")).not.toBeNull();
    expect($("[data-pair-panel]")).toBeNull();
    expect(requests).not.toContain("POST /api/auth/pairing");
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
    expect(requests).not.toContain("GET /api/phones");
    expect(document.querySelector("[data-device-action=remove]")).toBeNull();
    expect(requests).not.toContain("GET /api/computers/bots");
  });

  it("gives a new server one line to run, the sign-in included", async () => {
    await render();
    await click("[data-add-device]");
    await click("[data-add-kind=server]");
    expect([...document.querySelectorAll("[data-server-command]")].map((line) => line.textContent)).toEqual([
      "npx openmausbot account login && npx openmausbot serve --tunnel", "npx openmausbot serve --tailscale",
    ]);
  });

  it("reads as one column in a narrow window, with the chosen device's card right under its tile", async () => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(private readonly report: ResizeObserverCallback) {}
      observe() { this.report([{ contentRect: { width: 380 } } as ResizeObserverEntry], this as never); }
      disconnect() {}
    });
    await render();
    expect($("[data-map-layout]")?.getAttribute("data-map-layout")).toBe("narrow");
    expect($("[data-device-tree]")?.getAttribute("style")).toBeNull();
    await click("[data-device-node='phone:iphone']");
    const card = $("[data-device-card='phone:iphone']")!;
    expect(card.closest("[data-device-group=phones]")).not.toBeNull();
    expect(card.closest("li")?.previousElementSibling?.querySelector("[data-device-node='phone:iphone']")).not.toBeNull();
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
