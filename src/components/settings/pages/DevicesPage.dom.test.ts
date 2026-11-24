// @vitest-environment happy-dom
// The Devices page over a fake desktop bridge and a fake server: what the map draws, what its buttons call, the private
// network's states and Add a device's pairing link, with nothing reaching a real server or Tailscale.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionState } from "@/lib/companion-types";
import { setLocale } from "@/lib/i18n";
import { takePhonePairingRequest } from "@/lib/phone-pairing";
import { forgetSharedSession } from "@/lib/session-reuse";
import { initialState, StoreContext } from "@/state/store";
import { fullContext, resolveSettingsTarget, searchSettings } from "../settings-index";
import { SettingsShellContext, type SettingsShell } from "../settings-shell";
import { DevicesPage, nextNetworkStep, tailscaleDownload } from "./DevicesPage";
import { overrideDeviceMap } from "../../devices/DeviceMap";

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
let account: Record<string, unknown>;
let vpsState: string;
let alwaysOn: Record<string, unknown> | null;

const reply = async () => companion;
function install(tailscaleProblem?: CompanionState["tailscaleProblem"]) {
  bridge = {
    state: vi.fn(reply), start: vi.fn(reply), stop: vi.fn(reply), keepAwake: vi.fn(reply), refreshTailscale: vi.fn(reply), pairing: vi.fn(reply),
    cloudDesktop: vi.fn(reply), browserControl: vi.fn(reply), routes: vi.fn(reply), setRoute: vi.fn(reply), setTailscale: vi.fn(reply),
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
    status: vi.fn(async () => [{ id: "vps", state: vpsState, since: NOW, version: "0.1.180", behind: false, install: "docker" }]),
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
    companionAccount: { state: async () => account, prepare: vi.fn(async () => account) },
    ...(alwaysOn ? { alwaysOnHome: { state: async () => alwaysOn, set: vi.fn(async () => alwaysOn) } } : {}),
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
  account = { available: true, status: "ready", email: "ada@example.com" };
  vpsState = "cantReach";
  alwaysOn = null;
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
async function render(over: Partial<SettingsShell["ctx"]> = {}, shellOver: Partial<SettingsShell> = {}, pairRequest = 0) {
  const shell: SettingsShell = { ctx: fullContext({ advanced: false, ...over }), place: { name: "This computer", kind: "computer", color: null, named: false }, page: "devices", anchor: null, go, ...shellOver };
  const state = { ...initialState, config: config as never, bots: BOTS as never, appSettingsPhonePairing: pairRequest };
  dispatch = vi.fn();
  act(() => root.render(createElement(StoreContext.Provider, { value: { state, dispatch } as never },
    createElement(SettingsShellContext.Provider, { value: shell }, createElement(DevicesPage)))));
  await settle();
}

describe("the Devices page", () => {
  it("lists this computer first, then each group by what a person calls it, every row with its state in a mark and words", async () => {
    await render();
    expect($("[data-device-node=here]")?.textContent).toContain("This computer");
    expect([...document.querySelectorAll("section:is([data-settings-block=phones], [data-settings-block^=group-]) > div h3")].map((heading) => heading.textContent))
      .toEqual(["Phones and tablets", "Computers", "Clouds and your own servers"]);
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

  it("names a phone's way in only while that way is on", async () => {
    companion = { ...companion, routes: { wifi: off, relay: { on: true, since: NOW }, tailscale: off, https: off } };
    await render();
    expect($("[data-device-row='phone:iphone'] [data-device-route]")?.textContent).toBe("Anywhere, through MausBot");
  });

  it("names no way for a phone kept to home whose ways are off, while Anywhere is on, and asks nothing of the person", async () => {
    companion = { ...companion, devices: [{ ...companion.devices[0]!, routes: "local" }], routes: { wifi: off, relay: { on: true, since: NOW }, tailscale: off, https: off } };
    await render();
    const iphone = $("[data-device-row='phone:iphone']")!;
    expect(iphone.querySelector("[data-device-route]")).toBeNull();
    expect(iphone.querySelector("[data-row-action]")).toBeNull();
    expect(iphone.getAttribute("data-device-status")).not.toBe("attention");
  });

  it("marks a phone as needing the person while no way in is on, and its button goes to the ways in", async () => {
    companion = { ...companion, routes: { wifi: off, relay: off, tailscale: off, https: off } };
    await render();
    const iphone = $("[data-device-row='phone:iphone']")!;
    expect(iphone.querySelector("[data-device-state]")?.textContent).toBe("Can’t reach it: no way in is on");
    expect(iphone.querySelector("[data-device-route]")).toBeNull();
    await click("[data-device-row='phone:iphone'] [data-row-action=turn-on-way]");
    await wait(20);
    expect(document.activeElement?.closest("[data-settings-block=reach]")).not.toBeNull();
    expect($("[data-remote-access-headline]")?.textContent).toBeTruthy();
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
    expect($("[data-device-details='phone:iphone'] [data-device-action=manage]")).toBeNull();
    expect($("[data-device-details='phone:iphone'] [data-phone-controls=iphone]")).not.toBeNull();
    expect(go).not.toHaveBeenCalled();
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

  it("never says a phone was removed when the computer could not remove it", async () => {
    bridge.revoke.mockRejectedValueOnce(new Error("phone link is not running"));
    await render();
    await click("[data-device-node='phone:pixel']");
    await click("[data-device-details='phone:pixel'] [data-device-action=remove]");
    expect($("[data-devices-notice]")).toBeNull();
    expect($("[role=alert]")?.textContent).toBeTruthy();
    expect($("[data-device-node='phone:pixel']")).not.toBeNull();
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
    expect([...document.querySelectorAll("[data-device-details='place:vps'] [data-device-action=remove]")].map((one) => one.textContent)).toEqual(["Remove from this app", "Sign it out"]);
    expect($("[data-device-details='place:vps'] [data-device-removes]")?.lastElementChild?.textContent).toBe("Sign it out");
    expect($("[data-device-details='place:vps'] [data-device-remove-hint]")?.textContent).toContain("ends the sign-in");
    await click("[data-device-details='place:vps'] [data-device-action=remove]");
    expect(environments.forget).toHaveBeenCalledWith("vps");
    expect(requests).not.toContain("DELETE /api/auth/sessions/s-vps");
  });

  it("closes the open details on an Escape pressed with focus nowhere, as after Pair again's Cancel", async () => {
    vpsState = "signedOut";
    await render();
    await click("[data-device-node='place:vps']");
    await click("[data-device-details='place:vps'] [data-device-action=pair-again]");
    await click("[data-pair-again-cancel]");
    (document.activeElement as HTMLElement | null)?.blur();
    expect(await press(document.body, "Escape")).toBe(false);
    expect($("[data-device-details]")).toBeNull();
  });

  it("pairs a saved server again inside its details, with nothing over the page", async () => {
    vpsState = "signedOut";
    await render();
    await click("[data-device-node='place:vps']");
    await click("[data-device-details='place:vps'] [data-device-action=pair-again]");
    expect($("[data-device-details='place:vps'] [data-device-pair-again] [data-own-server-link]")).not.toBeNull();
    expect($<HTMLInputElement>("[data-own-server-link]")?.readOnly).toBe(true);
    await wait(450);
    expect($("[data-connect-other-server]")?.textContent).toBe("This link reaches Garage NUC, not Hetzner box.");
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
    expect(setSub).toHaveBeenLastCalledWith({ title: "Add your own server", back: "Add a device", onBack: expect.any(Function) });
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
    expect($("[data-add-panel] [data-copy-link]")).not.toBeNull();
    expect(layers()).toBe(0);
    expect(requests).not.toContain("POST /api/auth/pairing");
  });

  it("offers Copy link and until when the encrypted QR works, which has no code to type", async () => {
    companion = { ...companion, lan: "192.168.1.5", hosts: ["192.168.1.5"], e2e: { enabled: true, relay: "connected", node: "relay1", descriptor: null } };
    bridge.pairing.mockImplementation(async (open: boolean) => {
      companion = { ...companion, pairing: open ? { code: "482913", token: `omb_pair_${"a".repeat(43)}`, expiresAt: NOW + 600_000 } : null };
      return companion;
    });
    await render();
    await click("[data-add-group=phones]");
    expect($("[data-pair-qr]")).not.toBeNull();
    expect($("[data-pairing-code]")).toBeNull();
    expect($("[data-pair-cant-scan]")?.textContent).toContain("Copy the link");
    expect($("[data-add-panel] [data-copy-link]")?.textContent).toBe("Copy link");
    expect($("[data-pair-until]")?.textContent).toBeTruthy();
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

  it("adds your own server in two steps: the line to run, then Connect to another computer's own form with its lend switch, and confirms it", async () => {
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

describe("phones and how they reach this computer, on Devices", () => {
  it("lays the page out in one order: here, phones, how they reach it, computers, servers, always-on home, other places", async () => {
    alwaysOn = { available: true, on: false, platform: "darwin", openAtLogin: false, awake: "off", updates: "by-itself" };
    install();
    await render();
    const blocks = [...document.querySelectorAll("section[data-settings-block]")].map((section) => section.getAttribute("data-settings-block"));
    expect(blocks).toEqual(["add", "phones", "reach", "group-computers", "group-servers", "always-on", "other-places"]);
    expect($("[data-settings-block=phones] [data-add-group=phones]")?.hasAttribute("data-phone-pairing-action")).toBe(true);
  });

  it("keeps each phone's own controls in its details, and each one calls the phone link with nothing over the page", async () => {
    companion = { ...companion, e2e: { enabled: true, relay: "connected" }, devices: companion.devices.map((device) => ({ ...device, e2eAt: NOW, routes: "any" })) } as CompanionState;
    await render();
    await click("[data-device-node='phone:iphone']");
    await click("[data-phone-cloud-desktop]");
    expect(bridge.cloudDesktop).toHaveBeenCalledWith("iphone", true);
    await click("[data-phone-browser]");
    expect(bridge.browserControl).toHaveBeenCalledWith("iphone", true);
    await click("[data-phone-routes=local]");
    expect(bridge.routes).toHaveBeenCalledWith("iphone", "local");
    expect(layers()).toBe(0);
  });

  it("shows a phone app's capabilities in its details", async () => {
    phoneApps = [{ key: "k2", registration: { installId: "i2", name: "Ada’s iPad", platform: "ios", appVersion: "2.4.0", timeZone: "UTC", capabilities: { calendar: true, reminders: true } }, registeredAt: NOW, seen: NOW, lastUsedAt: null, online: true, busy: false }];
    await render();
    await click("[data-device-node='phone-app:k2']");
    expect($("[data-device-details='phone-app:k2'] [data-phone-app-chips]")?.textContent).toBe("CalendarReminders");
  });

  it("pairs a phone with an older app again in the page, from its details", async () => {
    account = { ...account, tunnelRetired: true };
    await render();
    expect($("[data-devices-notice=tunnel-retired]")).not.toBeNull();
    await click("[data-device-node='phone:pixel']");
    await click("[data-device-details='phone:pixel'] [data-pair-again]");
    expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe("phone");
    expect(layers()).toBe(0);
  });

  it("lists a code still open above the phones, with Revoke", async () => {
    companion = { ...companion, pairing: { code: "482913", token: `omb_pair_${"a".repeat(43)}`, expiresAt: NOW + 600_000 } };
    await render();
    expect($("[data-settings-block=phones] [data-open-code]")).not.toBeNull();
    await click("[data-open-code] button");
    expect(bridge.pairing).toHaveBeenCalledWith(false, `omb_pair_${"a".repeat(43)}`);
  });

  it("says once, under Phones and tablets, that an organization turned remote access off, and offers no Add a phone", async () => {
    config = { ...config, managedPolicy: { remoteAccess: false, organizationName: "Acme" } };
    await render();
    expect($("[data-phone-policy]")?.textContent).toContain("Acme");
    expect($("[data-add-group=phones]")).toBeNull();
  });

  it("reads as one closed row while nothing is paired and no way is on, and opens in place", async () => {
    companion = { ...companion, devices: [], connectedDeviceIds: [], routes: { wifi: off, relay: off, tailscale: off, https: off } };
    await render();
    expect($("[data-settings-block=reach] [data-reach-fold]")).not.toBeNull();
    expect($("[data-settings-block=more-ways]")).not.toBeNull();
    await click("[data-reach-fold]");
    expect($("[data-route-row=wifi]")).not.toBeNull();
  });

  it("turns each way in on and off with the calls the phone link already has", async () => {
    await render({ advanced: true });
    await click("[data-route-row=wifi] [role=switch]");
    expect(bridge.setRoute).toHaveBeenCalledWith("wifi", false);
    await click("[data-settings-block=reach] [role=switch][aria-label^='Keep this computer awake']");
    expect(bridge.keepAwake).toHaveBeenCalledWith(true);
    expect($("[data-route-row=tailscale]")).toBeNull();
    expect($("[data-settings-disclosure=more-ways]")).toBeNull();
    expect(layers()).toBe(0);
  });

  it("opens Add a phone in the page from Anywhere's Sign in, at the sign-in", async () => {
    account = { available: true, status: "signed-out" };
    await render();
    await click("[data-relay-sign-in]");
    expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe("phone");
    expect($("[data-pair-turn-on]")).toBeNull();
    expect(layers()).toBe(0);
  });

  it("opens Add a phone in the page from the HTTPS address's Set up, never a Wi-Fi code", async () => {
    await render({ advanced: true });
    await click("[data-route-row=https] button");
    expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe("phone");
    expect($("[data-pair-turn-on]")).toBeNull();
    expect(layers()).toBe(0);
  });

  it("keeps the update's route notes at the top, with Turn off", async () => {
    companion = { ...companion, notices: ["wifi"] };
    await render();
    expect(document.querySelector("[data-route-notices]")?.compareDocumentPosition($("[data-settings-block=add]")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await click("[data-route-notice=wifi] button");
    expect(bridge.setRoute).toHaveBeenCalledWith("wifi", false);
  });
});

describe("a paused web address", () => {
  it("comes back once when Devices opens with a phone paired, and says so in the phone's details", async () => {
    account = { ...account, paused: true };
    install();
    await render();
    const prepare = (window as unknown as { ogb: { companionAccount: { prepare: ReturnType<typeof vi.fn> } } }).ogb.companionAccount.prepare;
    expect(prepare).toHaveBeenCalledOnce();
    await click("[data-device-node='phone:iphone']");
    expect($("[data-phone-controls=iphone]")?.textContent).toContain("Paused after 30 days unused.");
    await render({}, { anchor: "reach" });
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("is never asked for while nothing is paired", async () => {
    account = { ...account, paused: true };
    companion = { ...companion, devices: [], connectedDeviceIds: [] };
    install();
    await render();
    expect((window as unknown as { ogb: { companionAccount: { prepare: ReturnType<typeof vi.fn> } } }).ogb.companionAccount.prepare).not.toHaveBeenCalled();
  });
});

describe("Your other computers, on the private network row", () => {
  it("is the row's switch once Tailscale is on, and turning it off asks for exactly that", async () => {
    companion = { ...companion, routes: { ...companion.routes!, tailscale: { on: true, since: NOW, name: "ada.tail1.ts.net", computers: true } } };
    await render();
    expect($("[data-network-share]")?.getAttribute("aria-checked")).toBe("true");
    expect($("[data-network-action]")).toBeNull();
    await click("[data-network-share]");
    expect(bridge.setTailscaleComputers).toHaveBeenCalledWith(false);
    expect(bridge.refreshTailscale).not.toHaveBeenCalled();
  });

  it("turns on from the same switch when Tailscale is on but the share is not", async () => {
    companion = { ...companion, routes: { ...companion.routes!, tailscale: { on: true, since: NOW, name: "ada.tail1.ts.net", computers: false } } };
    await render();
    expect($("[data-network-share]")?.getAttribute("aria-checked")).toBe("false");
    await click("[data-network-share]");
    expect(bridge.setTailscaleComputers).toHaveBeenCalledWith(true);
  });

  it("says in words that agree with the switch when Tailscale is on but the share is off, and turns it off for phones from one button", async () => {
    companion = { ...companion, routes: { ...companion.routes!, tailscale: { on: true, since: NOW, name: "ada.tail1.ts.net", computers: false } } };
    await render();
    const row = $("[data-private-network]")!;
    expect($("[data-network-state]")?.textContent).toBe("Your other computers can’t connect yet");
    expect(row.querySelector("label")?.textContent).toBe("Let my other computers connect");
    expect(row.textContent).not.toMatch(/tailnet|\.ts\.net|\bhost\b/);
    await click("[data-network-phones-off]");
    expect(bridge.setTailscale).toHaveBeenCalledWith(false);
    expect(bridge.setTailscaleComputers).not.toHaveBeenCalled();
  });

  it("is the one place Tailscale is turned on or off: How your phone reaches it has no switch of its own", async () => {
    companion = { ...companion, routes: { ...companion.routes!, tailscale: { on: true, since: NOW, name: "ada.tail1.ts.net", computers: true } } };
    await render({ advanced: true });
    expect($("[data-settings-block=reach]")?.textContent).not.toContain("Tailscale");
    expect($("[data-network-phones-off]")).toBeNull();
    expect(document.body.textContent).not.toMatch(/tailnet|\.ts\.net|\bhost\b|being paired/);
  });

  it("still turns off where an organization keeps remote access off, though it never turns on there", async () => {
    config = { ...config, managedPolicy: { remoteAccess: false, organizationName: "Acme" } };
    companion = { ...companion, routes: { ...companion.routes!, tailscale: { on: true, since: NOW, name: "ada.tail1.ts.net", computers: true } } };
    await render();
    expect($<HTMLButtonElement>("[data-network-share]")?.disabled).toBe(false);
    await click("[data-network-share]");
    expect(bridge.setTailscaleComputers).toHaveBeenCalledWith(false);
  });
});

describe("Always-on home, on Devices", () => {
  const home = { available: true, platform: "darwin", openAtLogin: true, awake: "holding", updates: "by-itself" };
  it("adds an always-on computer with Add your own server's steps in the page", async () => {
    alwaysOn = { ...home, on: false };
    install();
    await render();
    await click("[data-settings-disclosure=add-always-on] button");
    await click("[data-always-on-connect]");
    expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe("server");
    expect(layers()).toBe(0);
  });

  it("adds a phone or another computer to this home with the page's own steps", async () => {
    alwaysOn = { ...home, on: true };
    install();
    await render();
    await click("[data-always-on-add-phone]");
    expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe("phone");
    await click("[data-add-back]");
    await click("[data-always-on-add-computer]");
    expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe("computer");
    expect(bridge.setTailscaleComputers).not.toHaveBeenCalled();
    expect(layers()).toBe(0);
  });
});

describe("pairing asked for from elsewhere", () => {
  it("opens Add a phone in the page once, and keeps it when the window then names the phones section", async () => {
    takePhonePairingRequest("http://127.0.0.1/?desktop-settings=phone&pair=open", true);
    await render({}, {}, 1);
    expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe("phone");
    expect(layers()).toBe(0);
    await render({}, { anchor: "phones" }, 1);
    expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe("phone");
    await render({}, { anchor: "reach" }, 1);
    expect($("[data-add-panel]")).toBeNull();
    expect($("[data-settings-block=reach]")).not.toBeNull();
  });

  it("brings Phones and tablets' Add a phone forward without opening it when no link asked for the code", async () => {
    await render({}, { anchor: "phones" }, 1);
    expect($("[data-add-panel]")).toBeNull();
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    expect(document.activeElement?.getAttribute("data-add-group")).toBe("phones");
  });

  it("makes a code in the page on a Cloud's page", async () => {
    delete (window as unknown as { ogb?: unknown }).ogb;
    takePhonePairingRequest("http://127.0.0.1/?desktop-settings=phone&pair=open", true);
    await render({ here: false, cloud: true }, {}, 1);
    expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe("phone");
    expect(requests).toContain("POST /api/auth/pairing");
    expect($("[data-pairing-code]")?.textContent).toBe("7KQ2-M9XD-H4TP");
    expect(layers()).toBe(0);
  });
});

describe("what a Cloud's or server's page says about pairing", () => {
  it("shows a team member their own phone card on the page", async () => {
    delete (window as unknown as { ogb?: unknown }).ogb;
    session = { kind: "session", id: "s1", label: "Chrome", scopes: ["client"], expiresAt: 0, team: { id: "t", name: "Acme", role: "member" } };
    config = { ...config, team: { name: "Acme" } };
    await render({ here: false, cloud: true, team: true, admin: false });
    expect($("[data-settings-block=phones] [data-team-phone]")).not.toBeNull();
    expect($("[data-add-group=phones]")).toBeNull();
    expect(layers()).toBe(0);
  });

  it("says pairing codes are off where an organization's Admin signs people in", async () => {
    delete (window as unknown as { ogb?: unknown }).ogb;
    vi.mocked(fetch).mockImplementation(async (input) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      if (path === "/api/auth/session") return Response.json(session);
      if (path === "/api/config") return Response.json({ membership: { authority: "portal", pairingCodes: false } });
      return Response.json({ sessions: [], current: null });
    });
    await render({ here: false });
    expect($("[data-settings-block=phones] [data-server-pairing-portal]")).not.toBeNull();
    expect($("[data-add-group=phones]")).toBeNull();
  });

  it("offers a chat-only code in Advanced, and says what a phone can't do there", async () => {
    delete (window as unknown as { ogb?: unknown }).ogb;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      requests.push(`${init?.method ?? "GET"} ${path} ${init?.body ?? ""}`);
      if (path === "/api/auth/session") return Response.json(session);
      if (path === "/api/config") return Response.json({ membership: { authority: "local", pairingCodes: true }, computerName: "garage" });
      if (path === "/api/auth/pairing" && init?.method === "POST") return Response.json({ id: "p2", code: "7KQ2-M9XD-H4TP", expiresAt: NOW + 600_000, url: "http://192.168.1.9:8799/pair#code=7KQ2", hint: null, phoneSecrets: false });
      return Response.json({ sessions: [], current: null, pairings: [] });
    });
    await render({ here: false, advanced: true });
    expect($<HTMLInputElement>("[data-computer-name] input")?.value).toBe("garage");
    await click("[data-add-group=phones]");
    expect($("[data-pair-no-phone-secrets]")).not.toBeNull();
    expect($("[data-pair-same-wifi]")).not.toBeNull();
    expect($("[data-copy-link]")).not.toBeNull();
    const scope = $<HTMLSelectElement>("[data-pair-scope]")!;
    await act(async () => { scope.value = "client"; scope.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(requests).toContain('POST /api/auth/pairing {"scopes":["client"]}');
    expect(requests.some((request) => request.startsWith("DELETE /api/auth/pairing/p2"))).toBe(true);
  });
});

describe("Settings sends every old phone address to its block on Devices", () => {
  const ctx = fullContext({ advanced: false });
  it.each([
    ["phone", "phones"], ["companion", "phones"], ["remote", "reach"],
  ] as const)("the old section %s opens Devices at %s, and that block is on the page in every state", async (section, anchor) => {
    expect(resolveSettingsTarget(section, ctx)).toMatchObject({ page: "devices", anchor });
    companion = { ...companion, devices: [], connectedDeviceIds: [], routes: { wifi: off, relay: off, tailscale: off, https: off } };
    await render();
    expect($(`[data-settings-block=${anchor}]`)).not.toBeNull();
    await click("[data-add-device]");
    await render({}, { anchor });
    expect($("[data-add-panel]")).toBeNull();
    expect($(`[data-settings-block=${anchor}]`)).not.toBeNull();
  });

  it.each([
    ["phone", "phones"], ["pair", "phones"], ["tailscale", "network"], ["wifi", "reach"], ["always on", "always-on"],
  ] as const)("search for %s lands on Devices at %s first", async (query, anchor) => {
    const [first] = searchSettings(query, ctx, (entry) => entry.id, (page) => page.id);
    expect(first?.entry).toMatchObject({ page: "devices", anchor });
    alwaysOn = { available: true, on: false, platform: "darwin", openAtLogin: false, awake: "off", updates: "by-itself" };
    install();
    await render();
    expect($(`[data-settings-block=${anchor}]`)).not.toBeNull();
  });

  it("finds the HTTPS address under Devices, shown when asked for even in Simple", async () => {
    expect(searchSettings("https", { ...ctx, advanced: true }, (entry) => entry.id, (page) => page.id).find((hit) => hit.entry.id === "https-address")?.entry)
      .toMatchObject({ page: "devices", anchor: "more-ways" });
    await render({}, { anchor: "more-ways" });
    expect($("[data-settings-block=more-ways] [data-route-row=https]")).not.toBeNull();
  });
});

describe("one way back for each kind of trouble", () => {
  const actionsOf = (id: string) => [...document.querySelectorAll(`[data-device-details='${id}'] [data-device-action]`)].map((one) => one.getAttribute("data-device-action"));
  it("offers only Try again while a server can't be reached, and says to check it is on", async () => {
    await render();
    expect($("[data-device-row='place:vps'] [data-row-action=retry]")?.textContent).toBe("Try again");
    await click("[data-device-node='place:vps']");
    expect(actionsOf("place:vps")).toContain("retry");
    expect(actionsOf("place:vps")).not.toContain("pair-again");
    expect($("[data-device-details='place:vps'] [data-device-unreachable]")?.textContent).toBe("Check that Hetzner box is on and online, then choose Try again.");
  });

  it("offers only Pair again once its sign-in is gone", async () => {
    vpsState = "signedOut";
    await render();
    expect($("[data-device-row='place:vps'] [data-row-action]")?.getAttribute("data-row-action")).toBe("pair-again");
    await click("[data-device-node='place:vps']");
    expect(actionsOf("place:vps")).toContain("pair-again");
    expect(actionsOf("place:vps")).not.toContain("retry");
  });

  it("offers neither while it is online", async () => {
    vpsState = "connected";
    await render();
    expect($("[data-device-row='place:vps'] [data-row-action]")).toBeNull();
    await click("[data-device-node='place:vps']");
    expect(actionsOf("place:vps").filter((type) => type === "retry" || type === "pair-again")).toEqual([]);
  });
});

describe("Add a computer's words", () => {
  it("says why the private network is needed before it is on", async () => {
    install("signed-out");
    await render();
    await click("[data-add-group=computers]");
    expect($("[data-add-network-why]")?.textContent).toContain("only through Tailscale");
  });

  it("gives the link first, with the address and code folded under it", async () => {
    await render();
    await click("[data-network-action]");
    await click("[data-add-group=computers]");
    const panel = $("[data-pair-panel=computer]")!;
    expect(panel.textContent).toContain("choose ＋ then Connect to another computer, and paste this link.");
    expect(panel.textContent).not.toContain("connects computers too");
    expect($("[data-pair-type-instead] [data-pairing-code]")?.textContent).toBe("7KQ2-M9XD-H4TP");
    const toggle = $<HTMLButtonElement>("[data-pair-type-instead] button[aria-expanded]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)?.hidden).toBe(true);
    expect(document.querySelector("[data-pair-type-instead] details, [data-pair-type-instead] summary")).toBeNull();
    await click("[data-pair-type-instead] button[aria-expanded]");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)?.hidden).toBe(false);
  });
});

describe("the inline server form's one error", () => {
  const openForm = async () => { await render(); await click("[data-add-device]"); await click("[data-add-kind=server]"); };
  it("puts an address problem under the address, with no code field until the server is found", async () => {
    await openForm();
    workspaces.probe.mockImplementation(async () => ({ outcome: "problem", problem: "unreachable", host: "maus.example.org" }));
    await type("[data-own-server-link]", "https://maus.example.org");
    await wait(500);
    const problem = $("[data-connect-problem]")!;
    expect(problem.getAttribute("data-connect-problem")).toBe("address");
    expect(document.querySelectorAll("[data-connect-problem]")).toHaveLength(1);
    const field = $<HTMLInputElement>("[data-own-server-link]")!;
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(problem.id);
    expect(field.className).not.toContain("shadow-[inset_0_0_0_1px_var(--color-danger)]");
    expect($("[data-own-server-code]")).toBeNull();
  });

  it("asks for the code once the server is found, and puts a code problem under the code", async () => {
    await openForm();
    workspaces.probe.mockImplementation(async (_address: string, code: string) => (code
      ? { outcome: "problem", problem: "oldCode", host: "maus.example.org" }
      : { outcome: "found", label: "Garage NUC", version: "0.1.180", transport: "https" }));
    await type("[data-own-server-link]", "https://maus.example.org");
    await wait(500);
    expect($("[data-own-server-code]")).not.toBeNull();
    await type("[data-own-server-code]", "123456");
    await wait(500);
    expect($("[data-connect-problem]")?.getAttribute("data-connect-problem")).toBe("code");
    expect($("[data-own-server-code]")?.getAttribute("aria-invalid")).toBe("true");
    expect($("[data-own-server-link]")?.hasAttribute("aria-invalid")).toBe(false);
  });
});

describe("a server bots reach over SSH, in its details", () => {
  it("labels every field, says its SSH name and what the limits do, and keeps Remove apart in red", async () => {
    config = { ...config, vps: gpu };
    await render();
    await click("[data-device-node='vps:gpu']");
    const editor = $("[data-device-details='vps:gpu'] [data-vps-server=gpu]")!;
    const labels = [...editor.querySelectorAll("label")].map((label) => label.textContent);
    expect(labels).toEqual(["Name", "Memory for each bot (GB)", "Processor cores for each bot"]);
    for (const label of editor.querySelectorAll("label")) expect(document.getElementById(label.htmlFor)?.tagName).toBe("INPUT");
    expect(editor.querySelector("[data-vps-ssh-name]")?.textContent).toBe("SSH name: gpu");
    expect(editor.querySelector("[data-vps-limits-line]")?.textContent).toContain("Left empty, it gets 4 GB and 2 cores.");
    expect(editor.querySelector("button[data-danger]")?.textContent).toBe("Remove");
    expect($("[data-device-details='vps:gpu']")?.textContent).not.toContain("Name and limits");
  });
});

describe("the map above the list", () => {
  afterEach(() => overrideDeviceMap(null));

  it("opens a node's row below, with its details open and focus on its row, and nothing over the page", async () => {
    overrideDeviceMap(true);
    await render();
    const map = $("[data-settings-block=map]")!;
    expect(map.getAttribute("role")).toBe("group");
    expect(map.getAttribute("aria-label")).toBe("Your devices and how they connect");
    expect(map.compareDocumentPosition($("[data-settings-block=add]")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect([...map.querySelectorAll("[data-map-node]")].map((node) => node.getAttribute("data-map-node")))
      .toEqual(["here", "phone:iphone", "phone:pixel", "place:home", "place:vps"]);
    expect(map.querySelector("[data-map-node='place:vps']")?.getAttribute("aria-label")).toBe("Hetzner box, Your own server, Can’t reach it, Over the internet");
    await click("[data-map-node='place:vps']");
    await wait(20);
    expect($("[data-device-details='place:vps']")).not.toBeNull();
    expect(document.activeElement).toBe($("[data-device-node='place:vps']"));
    expect([...map.querySelectorAll("button, a, input, [role=switch]")].every((control) => control.hasAttribute("data-map-node")), "the map has no actions of its own").toBe(true);
    expect(layers()).toBe(0);
  });

  it("puts the private network on the hub, draws an away device's line dashed, and says it all in one line for a narrow window", async () => {
    overrideDeviceMap(true);
    await render();
    expect($("[data-map-node=here] [data-map-network]")).not.toBeNull();
    expect($("[data-map-node=here]")?.getAttribute("aria-label")).toContain("Private network: Not set up");
    expect($("[data-map-node='phone:pixel']")?.getAttribute("data-map-line")).toBe("away");
    expect($("[data-map-node='phone:iphone']")?.getAttribute("data-map-line")).toBe("on");
    expect($("[data-map-summary]")?.textContent).toBe("2 phones · 2 Clouds and your own servers");
  });

  it("with nothing else connected, draws the hub alone and says so", async () => {
    overrideDeviceMap(true);
    companion = { ...companion, devices: [], connectedDeviceIds: [] };
    saved = [{ id: "local", kind: "local", name: "This computer" }];
    await render();
    expect([...document.querySelectorAll("[data-map-node]")].map((node) => node.getAttribute("data-map-node"))).toEqual(["here"]);
    expect($("[data-map-empty]")?.textContent).toBe("Nothing else is connected yet");
    expect($("[data-map-summary]")?.textContent).toBe("Nothing else is connected yet");
  });

  it("draws nothing while it is turned off", async () => {
    overrideDeviceMap(false);
    await render();
    expect($("[data-settings-block=map]")).toBeNull();
    expect($("[data-map-node]")).toBeNull();
    expect($("[data-device-node='place:vps']")).not.toBeNull();
  });
});
