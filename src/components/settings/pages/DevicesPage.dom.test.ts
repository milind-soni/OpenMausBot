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
let setSub: ReturnType<typeof vi.fn<NonNullable<SettingsShell["setSub"]>>>;
let workspaces: Record<string, ReturnType<typeof vi.fn>>;
let lendWish: ReturnType<typeof vi.fn>;
let phoneApps: unknown[];
let saved: Array<{ id: string; kind: string; name: string; origin?: string; home?: boolean }>;

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
  saved = [
    { id: "local", kind: "local", name: "This computer" },
    { id: "home", kind: "remote", name: "Ada’s Cloud", origin: "https://ada.mausbot.cloud", home: true },
    { id: "vps", kind: "remote", name: "Hetzner box", origin: "https://maus.example.com" },
  ];
  environments = {
    state: vi.fn(async () => ({ localOrigin: "http://127.0.0.1:8799", remote: false, packaged: true, activeId: "local", environments: [...saved] })),
    status: vi.fn(async () => [{ id: "vps", state: "cantReach", since: NOW, version: "0.1.180", behind: false, install: "docker" }]),
    switch: vi.fn(async () => {}), forget: vi.fn(async () => {}), retry: vi.fn(async () => {}),
  };
  workspaces = {
    probe: vi.fn(async (address: string) => (address.trim() ? { outcome: "found", label: "Garage NUC", version: "0.1.180", transport: "https" } : { outcome: "problem", problem: "empty" })),
    add: vi.fn(async (how: string, address?: string) => {
      if (how !== "link") return;
      saved = [...saved, { id: "nuc", kind: "remote", name: "Garage NUC", origin: address }];
      return { outcome: "connected" };
    }),
  };
  lendWish = vi.fn(async () => true);
  vi.stubGlobal("ogb", undefined);
  (window as unknown as { ogb: unknown }).ogb = {
    platform: "darwin", app: { version: "0.1.180" }, companion: bridge, environments, workspaces, lendComputer: { wish: lendWish, state: async () => null, set: async () => null },
    companionAccount: { state: async () => ({ available: true, status: "ready", email: "ada@example.com" }) },
  };
}

beforeEach(() => {
  setLocale("en");
  forgetSharedSession();
  requests = [];
  phoneApps = [];
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
    if (path === "/api/phones") return Response.json({ phones: phoneApps });
    if (path === "/api/computers/bots") return botRows === "forbidden" ? Response.json({ error: "admin only" }, { status: 403 }) : Response.json({ now: NOW, rows: botRows });
    if (path === "/api/config" && init?.method === "PUT") return Response.json({ notice: "GPU box is no longer used. Its desktops stay on it.", vps: { configured: false, sshAlias: "", servers: [] } });
    if (path === "/api/config") return Response.json({ membership: { authority: "local", pairingCodes: true } });
    return Response.json({ error: "no route" }, { status: 404 });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  go = vi.fn<SettingsShell["go"]>();
  setSub = vi.fn<NonNullable<SettingsShell["setSub"]>>();
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
/** A key pressed on an element; true when it reached the window unhandled, where Settings would close. */
const press = async (selector: string | HTMLElement, key: string) => {
  let unhandled = false;
  const onWindow = (event: KeyboardEvent) => { unhandled = !event.defaultPrevented; };
  window.addEventListener("keydown", onWindow);
  const target = typeof selector === "string" ? $(selector)! : selector;
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  await settle();
  window.removeEventListener("keydown", onWindow);
  return unhandled;
};
const type = async (selector: string, value: string) => {
  const input = $<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
};
const wait = async (ms: number) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); await settle(); };
/** Layers this page opened: Settings itself is not in this render, so every role=dialog here sits over it. */
const layers = () => document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length;

let dispatch: ReturnType<typeof vi.fn>;
async function render(over: Partial<SettingsShell["ctx"]> = {}, shellOver: Partial<SettingsShell> = {}) {
  const shell: SettingsShell = { ctx: fullContext({ advanced: false, ...over }), place: { name: "This computer", kind: "computer", color: null, named: false }, page: "devices", anchor: null, go, ...shellOver };
  const state = { ...initialState, config: config as never, bots: BOTS as never };
  dispatch = vi.fn();
  act(() => root.render(createElement(StoreContext.Provider, { value: { state, dispatch } as never },
    createElement(SettingsShellContext.Provider, { value: shell }, createElement(DevicesPage)))));
  await settle();
}

describe("the Devices page", () => {
  it("lists this computer first, then each group by what a person calls it, every row with its state in a mark and words", async () => {
    await render();
    expect($("[data-device-node=here]")?.textContent).toContain("This computer");
    expect([...document.querySelectorAll("[data-settings-block^=group-] h3")].map((heading) => heading.textContent)).toEqual(["Phones and tablets", "Computers", "Clouds and your own servers"]);
    const iphone = $("[data-device-row='phone:iphone']")!;
    expect(iphone.getAttribute("data-device-status")).toBe("online");
    expect(iphone.querySelector("[data-device-state]")?.getAttribute("data-device-state")).toBe("online");
    expect(iphone.querySelector("[data-device-state]")?.textContent).toContain("Online");
    expect(iphone.querySelector("[data-device-route]")?.textContent).toBe("Same Wi-Fi");
    expect($("[data-device-row='phone:pixel']")?.textContent).toContain("Seen");
    const vps = $("[data-device-row='place:vps'] [data-device-state]")!;
    expect(vps.textContent).toContain("Can’t reach it");
    expect(vps.getAttribute("data-device-state")).toBe("attention");
    expect($("[data-devices-empty=computers]")?.textContent).toBe("No other computers yet");
  });

  it("puts the one thing a device needs on its row, and leads its details with it once they are open", async () => {
    await render();
    await click("[data-device-row='place:vps'] [data-row-action=retry]");
    expect(environments.retry).toHaveBeenCalledWith("vps");
    expect($("[data-device-row='phone:iphone'] [data-row-action]")).toBeNull();
    await click("[data-device-node='place:vps']");
    expect($("[data-device-row='place:vps'] [data-row-action]")).toBeNull();
    expect($("[data-device-details='place:vps'] [data-device-action]")?.getAttribute("data-device-action")).toBe("retry");
  });

  it("opens a device's details under its own row, whose buttons call the actions that already exist, with one Remove last", async () => {
    await render();
    await click("[data-device-node='place:vps']");
    expect($("[data-device-node='place:vps']")?.getAttribute("aria-expanded")).toBe("true");
    expect($("[data-device-row='place:vps'] [data-device-details='place:vps']")).not.toBeNull();
    expect(layers()).toBe(0);
    const actions = [...document.querySelectorAll("[data-device-details='place:vps'] [data-device-action]")].map((one) => one.getAttribute("data-device-action"));
    expect(actions.at(-1)).toBe("remove");
    expect(actions.filter((one) => one === "remove")).toHaveLength(1);
    await click("[data-device-details='place:vps'] [data-device-action=remove]");
    expect(environments.forget).toHaveBeenCalledWith("vps");
    expect($("[data-devices-notice]")?.textContent).toBe("Hetzner box was removed.");
    await click("[data-device-node='phone:pixel']");
    await click("[data-device-details='phone:pixel'] [data-device-action=remove]");
    expect(bridge.revoke).toHaveBeenCalledWith("pixel");
    expect($("[data-device-node='phone:pixel']")).toBeNull();
    await click("[data-device-node='phone:iphone']");
    await click("[data-device-details='phone:iphone'] [data-device-action=manage]");
    expect(go).toHaveBeenCalledWith("phone", "paired");
  });

  it("closes the open details on Escape, gives focus back to its row, and never lets that Escape close Settings", async () => {
    await render();
    await click("[data-device-node='phone:iphone']");
    expect(await press("[data-device-details='phone:iphone'] button", "Escape")).toBe(false);
    expect($("[data-device-details]")).toBeNull();
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    expect(document.activeElement?.getAttribute("data-device-node")).toBe("phone:iphone");
    // Nothing open: Escape is Settings' own.
    expect(await press("[data-device-node='phone:iphone']", "Escape")).toBe(true);
  });

  it("removes a phone whole, its pairing and its app together, and keeps a computer's sign-in its own action", async () => {
    phoneApps = [{ key: "k1", registration: { installId: "i1", name: "Ada’s iPhone", platform: "ios", appVersion: "2.4.0", timeZone: "UTC", capabilities: {} }, registeredAt: NOW, seen: NOW, lastUsedAt: null, online: true, busy: false }];
    sessions = [{ id: "s-vps", label: "Hetzner box", scopes: ["admin", "client"], lastSeenAt: NOW }];
    await render();
    await click("[data-device-node='phone:iphone']");
    expect(document.querySelectorAll("[data-device-details='phone:iphone'] [data-device-action=remove]")).toHaveLength(1);
    await click("[data-device-details='phone:iphone'] [data-device-action=remove]");
    expect(bridge.revoke).toHaveBeenCalledWith("iphone");
    expect(requests.some((request) => request.startsWith("DELETE /api/phones"))).toBe(true);
    await click("[data-device-node='place:vps']");
    expect([...document.querySelectorAll("[data-device-details='place:vps'] [data-device-action=remove]")].map((one) => one.textContent)).toEqual(["Remove", "Sign it out"]);
    await click("[data-device-details='place:vps'] [data-device-action=remove]");
    expect(environments.forget).toHaveBeenCalledWith("vps");
    expect(requests).not.toContain("DELETE /api/auth/sessions/s-vps");
  });

  it("closes the open details on an Escape pressed with focus nowhere, as after Pair again's Cancel", async () => {
    await render();
    await click("[data-device-node='place:vps']");
    await click("[data-device-details='place:vps'] [data-device-action=pair-again]");
    await click("[data-pair-again-cancel]");
    (document.activeElement as HTMLElement | null)?.blur();
    expect(await press(document.body, "Escape")).toBe(false);
    expect($("[data-device-details]")).toBeNull();
  });

  it("pairs a saved server again inside its details, with nothing over the page", async () => {
    await render();
    await click("[data-device-node='place:vps']");
    await click("[data-device-details='place:vps'] [data-device-action=pair-again]");
    expect($("[data-device-details='place:vps'] [data-device-pair-again] [data-own-server-link]")).not.toBeNull();
    expect($<HTMLInputElement>("[data-own-server-link]")?.readOnly).toBe(true);
    expect(layers()).toBe(0);
    await click("[data-pair-again-cancel]");
    expect($("[data-device-pair-again]")).toBeNull();
    expect($("[data-device-details='place:vps'] [data-device-action=pair-again]")).not.toBeNull();
  });

  it("is reachable from the keyboard: every row is a button with a full label, in page order", async () => {
    await render();
    const nodes = [...document.querySelectorAll<HTMLElement>("[data-device-node]")];
    expect(nodes.map((node) => node.tagName)).toEqual(nodes.map(() => "BUTTON"));
    expect(nodes.every((node) => node.tabIndex === 0 && node.getAttribute("aria-label") && node.hasAttribute("aria-expanded"))).toBe(true);
    expect(nodes.map((node) => node.getAttribute("data-device-node"))).toEqual(["here", "phone:iphone", "phone:pixel", "place:home", "place:vps"]);
  });

  it("shows which bots use each device, and their names in its details", async () => {
    config = { ...config, vps: gpu };
    botRows = [
      { botId: "b1", kind: "local", computerId: "local", name: null, state: "ready", stateAt: NOW },
      { botId: "b2", kind: "cloud", computerId: "cloud:b2", name: null, state: "asleep", stateAt: NOW },
      { botId: "b3", kind: "vps", computerId: "vps:gpu/omb-b3", name: "GPU box", state: "ready", stateAt: NOW, vps: { serverId: "vps:gpu", alias: "gpu", container: "omb-b3" } },
    ];
    await render();
    expect(requests).toContain("GET /api/computers/bots");
    expect($("[data-device-node=here]")?.getAttribute("aria-label")).toContain("Bots here: Scout");
    const desktop = $("[data-device-row='cloud:b2']")!;
    expect(desktop.textContent).toContain("Writer’s cloud desktop");
    expect(desktop.querySelector("[data-device-state]")?.textContent).toContain("Asleep");
    await click("[data-device-node='vps:gpu']");
    expect($("[data-device-details='vps:gpu'] [data-device-bot-names]")?.textContent).toContain("Builder");
  });

  it("draws no bots when the list is refused", async () => {
    botRows = "forbidden";
    await render();
    expect(document.querySelector("[data-device-bots]")).toBeNull();
    expect($("[data-device-node='phone:iphone']")).not.toBeNull();
  });

  it("opens a server bots reach over SSH in its editor, in place, and closes with the server's notice once it is removed", async () => {
    config = { ...config, vps: gpu };
    await render();
    await click("[data-device-node='vps:gpu']");
    expect($<HTMLInputElement>("[data-device-details='vps:gpu'] [data-vps-server=gpu] input")?.value).toBe("GPU box");
    expect(layers()).toBe(0);
    await click("[data-device-details='vps:gpu'] [data-vps-server=gpu] button[aria-label^='Remove']");
    expect(requests).toContain("PUT /api/config");
    expect($("[data-device-details]")).toBeNull();
    expect($("[role=status]")?.textContent).toContain("GPU box is no longer used");
  });
});

describe("the private network", () => {
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
    expect($("[data-network-line]")?.textContent).toContain("free app");
  });

  it("says when it is ready, by this computer's short name, with nothing left to press but Manage", async () => {
    companion = {
      ...companion, routes: { ...companion.routes!, tailscale: { on: true, since: NOW, name: "ada.tail1.ts.net", computers: true } },
      devices: [...companion.devices, { id: "tab", name: "Tablet", createdAt: NOW, lastSeenAt: NOW, cloudDesktopAccess: false, route: "tailscale" }], connectedDeviceIds: ["iphone", "tab"],
    };
    await render();
    expect($("[data-network-state]")?.textContent).toBe("On");
    expect($("[data-device-row='phone:tab'] [data-device-route]")?.textContent).toBe("Private network");
    expect($("[data-network-line]")?.textContent).toContain("on it as ada.");
    expect($("[data-network-action]")).toBeNull();
    expect(bridge.setTailscaleComputers).not.toHaveBeenCalled();
  });

  it("asks Tailscale again, rather than sharing again, once its route is on", async () => {
    companion = { ...companion, routes: { ...companion.routes!, tailscale: { on: true, since: NOW, name: null, computers: true } } };
    await render();
    expect($("[data-network-state]")?.getAttribute("data-network-state")).toBe("magicdns");
    await click("[data-network-action]");
    expect(bridge.refreshTailscale).toHaveBeenCalled();
    expect(bridge.setTailscaleComputers).not.toHaveBeenCalled();
  });
});

describe("Add a device, in the page", () => {
  it("opens from Add a device, from each group and from search's anchor, and never puts a layer over Settings", async () => {
    await render();
    expect($("[data-settings-block=add] [data-add-device]")).not.toBeNull();
    for (const [opener, step] of [["[data-add-device]", "choose"], ["[data-add-group=phones]", "phone"], ["[data-add-group=computers]", "computer"], ["[data-add-group=servers]", "choose"]] as const) {
      await click(opener);
      expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe(step);
      expect(layers()).toBe(0);
      await click("[data-add-back]");
      expect($("[data-add-panel]")).toBeNull();
    }
    for (const kind of ["phone", "computer", "server", "cloud"]) {
      await click("[data-add-device]");
      await click(`[data-add-kind=${kind}]`);
      expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe(kind);
      expect(layers()).toBe(0);
      await click("[data-add-back]");
      await click("[data-add-back]");
    }
  });

  it("steps back one level on Escape, to the choice just left and then to the list, never closing Settings", async () => {
    await render();
    await click("[data-add-device]");
    await click("[data-add-kind=server]");
    expect(await press("[data-add-panel]", "Escape")).toBe(false);
    expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe("choose");
    expect(document.activeElement?.getAttribute("data-add-kind")).toBe("server");
    expect(await press("[data-add-panel]", "Escape")).toBe(false);
    expect($("[data-add-panel]")).toBeNull();
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    expect(document.activeElement?.hasAttribute("data-add-device")).toBe(true);
  });

  it("steps back on an Escape pressed with focus nowhere or on the header's Back, as after a step swaps its controls", async () => {
    await render({}, { setSub });
    await click("[data-add-device]");
    await click("[data-add-kind=computer]");
    (document.activeElement as HTMLElement | null)?.blur();
    expect(await press(document.body, "Escape")).toBe(false);
    expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe("choose");
    const header = document.createElement("header");
    header.setAttribute("data-settings-header", "");
    const back = document.createElement("button");
    header.append(back);
    document.body.append(header);
    back.focus();
    expect(await press(back, "Escape")).toBe(false);
    expect($("[data-add-panel]")).toBeNull();
    // A field elsewhere in Settings (its search) keeps its own Escape.
    await click("[data-add-device]");
    const search = document.createElement("input");
    document.body.append(search);
    search.focus();
    expect(await press(search, "Escape")).toBe(true);
    expect($("[data-add-panel]")).not.toBeNull();
  });

  it("shows no device as just joined that was already there when Add opened before the lists answered", async () => {
    const shell: SettingsShell = { ctx: fullContext({ advanced: false }), place: { name: "This computer", kind: "computer", color: null, named: false }, page: "devices", anchor: null, go };
    act(() => root.render(createElement(StoreContext.Provider, { value: { state: { ...initialState, config: config as never, bots: BOTS as never }, dispatch: vi.fn() } as never },
      createElement(SettingsShellContext.Provider, { value: shell }, createElement(DevicesPage)))));
    act(() => $("[data-add-device]")!.click());
    act(() => $("[data-add-kind=phone]")!.click());
    await settle();
    expect($("[data-add-connected]")).toBeNull();
  });

  it("names each step in a narrow window's own header, with its way back, and leaves out the page's copy of it", async () => {
    await render({}, { narrow: true, setSub });
    await click("[data-add-device]");
    expect(setSub).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Add a device", back: "Devices" }));
    await click("[data-add-kind=server]");
    expect(setSub).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Add your own server", short: "Your own server", back: "Add a device" }));
    expect($("[data-add-back]")).toBeNull();
    act(() => setSub.mock.lastCall![0]!.onBack());
    await settle();
    expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe("choose");
    await click("[data-add-kind=phone]");
    act(() => setSub.mock.lastCall![0]!.onBack());
    await settle();
    act(() => setSub.mock.lastCall![0]!.onBack());
    await settle();
    expect($("[data-add-panel]")).toBeNull();
    expect(setSub).toHaveBeenLastCalledWith(null);
  });

  it("pairs a phone on This computer with Pair a phone's own steps, in the page, never a server code", async () => {
    companion = { ...companion, routes: { wifi: off, relay: off, tailscale: off, https: off } };
    await render();
    await click("[data-add-group=phones]");
    expect($("[data-add-panel] [data-pair-turn-on]")).not.toBeNull();
    expect($("[data-add-panel] [role=radiogroup]")).not.toBeNull();
    expect($("[data-pair-dialog]")).toBeNull();
    expect(layers()).toBe(0);
    expect(requests).not.toContain("POST /api/auth/pairing");
  });

  it("goes straight to the phone's code when a way in is already on, asking the phone link for it once", async () => {
    companion = { ...companion, lan: "192.168.1.5", hosts: ["192.168.1.5"] };
    bridge.pairing.mockImplementation(async (open: boolean) => {
      companion = { ...companion, pairing: open ? { code: "482913", token: `omb_pair_${"a".repeat(43)}`, expiresAt: NOW + 600_000 } : null };
      return companion;
    });
    await render();
    await click("[data-add-group=phones]");
    expect($("[data-pair-turn-on]")).toBeNull();
    expect(bridge.pairing).toHaveBeenCalledOnce();
    expect($("[data-add-panel] [data-pair-panel=phone] [data-pair-qr]")).not.toBeNull();
    expect($("[data-pairing-code]")?.textContent).toBe("482913");
    expect(layers()).toBe(0);
    expect(requests).not.toContain("POST /api/auth/pairing");
  });

  it("asks for the private network first when Add a computer comes before it, with the later steps shown but quiet", async () => {
    install("signed-out");
    await render();
    await click("[data-add-group=computers]");
    expect($("[data-add-network]")?.getAttribute("data-add-network")).toBe("unknown");
    expect([...document.querySelectorAll("[data-step]")].map((step) => step.getAttribute("data-step-state"))).toEqual(["now", "later", "later"]);
    expect(requests).not.toContain("POST /api/auth/pairing");
  });

  it("gives another computer a link over the private network, says when it connected, and confirms it in the page", async () => {
    await render();
    await click("[data-network-action]");
    await click("[data-add-group=computers]");
    expect(requests).toContain("POST /api/auth/pairing");
    expect($("[data-pair-link]")?.getAttribute("data-pair-link")).toBe("http://ada.tail1.ts.net:8799/pair#code=7KQ2-M9XD-H4TP");
    expect($("[data-pairing-code]")?.textContent).toBe("7KQ2-M9XD-H4TP");
    expect($("[data-pair-state]")?.getAttribute("data-pair-state")).toBe("waiting");
    sessions = [{ id: "s-other", label: "Chrome on Windows", scopes: ["admin", "client"], lastSeenAt: NOW }];
    await wait(2_300);
    expect($("[data-pair-state]")?.getAttribute("data-pair-state")).toBe("waiting");
    sessions = [...sessions, { id: "s-new", label: "Studio Mac mini", scopes: ["admin", "client"], lastSeenAt: NOW }];
    openCodes = [];
    await wait(2_300);
    await wait(5_200);
    expect($("[data-add-connected]")?.textContent).toContain("is connected");
    expect(requests).not.toContain("DELETE /api/auth/pairing/p1");
    await click("[data-add-done]");
    expect($("[data-add-panel]")).toBeNull();
    expect($("[data-device-details]")).not.toBeNull();
  }, 20_000);

  it("cancels a code nobody used when the person goes back", async () => {
    await render();
    await click("[data-network-action]");
    await click("[data-add-group=computers]");
    await click("[data-add-back]");
    expect(requests).toContain("DELETE /api/auth/pairing/p1");
  });

  it("says the private network is still starting, with Check again, when it is on but nothing answers yet", async () => {
    companion = { ...companion, routes: { ...companion.routes!, tailscale: { on: true, since: NOW, name: "ada.tail1.ts.net", computers: true } }, tailnetShare: { on: true, origin: null, https: false, problem: "not-listening" } };
    await render();
    await click("[data-add-group=computers]");
    expect($("[data-add-network]")?.getAttribute("data-add-network")).toBe("waiting");
    expect($("[data-add-network] [data-network-action]")?.textContent).toBe("Check again");
    expect(requests).not.toContain("POST /api/auth/pairing");
  });

  it("adds your own server in two steps: the line to run, then Connect to a server's own form with its lend switch, and confirms it", async () => {
    await render();
    await click("[data-add-device]");
    await click("[data-add-kind=server]");
    expect([...document.querySelectorAll("[data-server-command]")].map((line) => line.textContent)).toEqual([
      "npx openmausbot account login && npx openmausbot serve --tunnel", "npx openmausbot serve --tailscale",
    ]);
    expect($("[data-add-panel] [data-place-add=own-server]")).not.toBeNull();
    expect(layers()).toBe(0);
    await type("[data-own-server-link]", "https://maus.example.org/pair#code=7KQ2-M9XD-H4TP");
    await wait(500);
    expect($("[data-connect-found]")?.textContent).toContain("Garage NUC");
    expect($("[data-lend-add]")?.getAttribute("data-lend-add")).toBe("off");
    await click("[data-lend-add] [role=switch]");
    expect(lendWish).toHaveBeenLastCalledWith("https://maus.example.org/pair#code=7KQ2-M9XD-H4TP", true);
    await click("[data-own-server-connect]");
    expect(workspaces.add).toHaveBeenCalledWith("link", "https://maus.example.org/pair#code=7KQ2-M9XD-H4TP", "");
    expect($("[data-add-connected='place:nuc']")?.textContent).toContain("Garage NUC is connected");
  });

  it("gets a Cloud by closing Settings for the plans, the one place this page hands over to something else", async () => {
    await render();
    await click("[data-add-device]");
    await click("[data-add-kind=cloud]");
    expect(workspaces.add).not.toHaveBeenCalled();
    await click("[data-get-cloud]");
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: false });
    expect(workspaces.add).toHaveBeenCalledWith("cloud");
  });

  it("offers a chat-only session no code at all", async () => {
    delete (window as unknown as { ogb?: unknown }).ogb;
    session = { kind: "session", id: "s1", label: "Chrome on Mac", scopes: ["client"], expiresAt: 0 };
    await render({ here: false, desktop: false, home: false });
    await click("[data-add-device]");
    expect($("[data-add-kind=cloud]")).toBeNull();
    await click("[data-add-kind=phone]");
    expect($("[data-pair-blocked]")).not.toBeNull();
    expect(requests.filter((request) => request.startsWith("POST"))).toEqual([]);
    expect(requests).not.toContain("GET /api/auth/sessions");
    expect(requests).not.toContain("GET /api/phones");
    expect(document.querySelector("[data-device-action=remove]")).toBeNull();
    expect(requests).not.toContain("GET /api/computers/bots");
  });
});

describe("the private network's next step", () => {
  const run = { check: vi.fn() };
  it("is one button per state, none once everything is on, and none where an organization turned remote access off", () => {
    const step = (state: Parameters<typeof nextNetworkStep>[0], blocked = false) => nextNetworkStep(state, run, { busy: false, blocked, platform: "win32" });
    expect(step({ state: "unknown", name: null, shared: false })?.label).toBe("Set up Tailscale");
    expect(step({ state: "not-installed", name: null, shared: false })?.href).toBe("https://tailscale.com/download/windows");
    expect(step({ state: "needs-approval", name: null, shared: false })?.href).toBe("https://login.tailscale.com/admin/machines");
    expect(step({ state: "signed-out", name: null, shared: false })?.label).toBe("Check again");
    expect(step({ state: "ready", name: "a", shared: false })?.label).toBe("Allow my other computers");
    expect(step({ state: "ready", name: "a", shared: true })).toBeNull();
    expect(step({ state: "unknown", name: null, shared: false }, true)).toBeNull();
    expect(tailscaleDownload("linux")).toBe("https://tailscale.com/download/linux");
  });
});
