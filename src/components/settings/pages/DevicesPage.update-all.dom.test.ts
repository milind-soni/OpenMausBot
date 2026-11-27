// @vitest-environment happy-dom
// Update all on the Devices page over a fake desktop bridge: when its button shows, what its one confirm lists, what it
// asks main to start, and each row's state while main reports the run.
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateAllSurvey, UpdateAllView } from "../../../../electron/update-all-run.mjs";
import type { CompanionState } from "@/lib/companion-types";
import { setLocale } from "@/lib/i18n";
import { forgetSharedSession } from "@/lib/session-reuse";
import { initialState, StoreContext } from "@/state/store";
import type { UpdaterState } from "@/types/ogb";
import { fullContext } from "../settings-index";
import { SettingsShellContext, type SettingsShell } from "../settings-shell";
import { DevicesPage } from "./DevicesPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = Date.now();
const off = { on: false, since: null };

let host: HTMLDivElement;
let root: Root;
let survey: UpdateAllSurvey;
let updater: UpdaterState | null;
let pushView: ((view: UpdateAllView) => void) | null;
/** Main's view of the run, which every survey answer carries too. */
let current: UpdateAllView;
let updateAll: { survey: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn>; onState: ReturnType<typeof vi.fn> };
let companion: CompanionState;
let retired: boolean;

const idle: UpdateAllView = { running: false, rows: {} };
const saved = [
  { id: "local", kind: "local", name: "This computer" },
  { id: "home", kind: "remote", name: "Ada’s Cloud", origin: "https://ada.mausbot.cloud", home: true },
  { id: "vps", kind: "remote", name: "Hetzner box", origin: "https://maus.example.com" },
  { id: "nuc", kind: "remote", name: "Garage NUC", origin: "https://nuc.example.com" },
  { id: "npm", kind: "remote", name: "Office box", origin: "https://office.example.com" },
];

function install() {
  updateAll = {
    survey: vi.fn(async () => ({ ...survey, view: current })),
    start: vi.fn(async () => ({ running: true, rows: { vps: { phase: "updating", since: NOW, latest: "0.1.175" }, app: { phase: "waiting", since: NOW } } })),
    retry: vi.fn(async () => ({ running: true, rows: { vps: { phase: "updating", since: NOW, latest: "0.1.175" } } })),
    onState: vi.fn((cb: (view: UpdateAllView) => void) => { pushView = cb; return () => { pushView = null; }; }),
  };
  (window as unknown as { ogb: unknown }).ogb = {
    platform: "darwin", app: { version: "0.1.180" },
    companion: { state: async () => companion },
    companionAccount: { state: async () => ({ available: true, status: "ready", email: "ada@example.com", ...(retired ? { tunnelRetired: true } : {}) }) },
    environments: {
      state: async () => ({ localOrigin: "http://127.0.0.1:8799", remote: false, packaged: true, activeId: "local", environments: saved }),
      status: async () => ["vps", "nuc", "npm"].map((id) => ({ id, state: "connected", since: NOW, version: "0.1.170", behind: true, install: "docker" })),
      switch: vi.fn(), forget: vi.fn(), retry: vi.fn(),
    },
    ...(updater ? { updater: { check: vi.fn(), install: vi.fn(), onState: (cb: (state: UpdaterState) => void) => { cb(updater!); return () => {}; } } } : {}),
    updateAll,
  };
}

beforeEach(() => {
  setLocale("en");
  forgetSharedSession();
  pushView = null;
  current = idle;
  retired = false;
  updater = { status: "downloaded", version: "0.1.182", installMode: "restart" };
  companion = {
    enabled: true, keepAwake: false, port: 8810, pairing: null,
    devices: [{ id: "pixel", name: "Pixel 9", createdAt: NOW, lastSeenAt: NOW, cloudDesktopAccess: false, route: null }],
    connectedDeviceIds: [], routes: { wifi: { on: true, since: NOW }, relay: off, tailscale: off, https: off },
  };
  survey = {
    servers: [
      { id: "vps", plan: { updates: true, current: "0.1.170", latest: "0.1.175", activeTurns: 1 } },
      { id: "nuc", plan: { updates: false, why: "admin-only", current: "0.1.170", latest: "0.1.175" } },
      { id: "npm", plan: { updates: false, why: "by-hand", command: "npm install -g openmausbot@0.1.175" } },
    ],
    app: null, view: idle,
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(input, "http://127.0.0.1").pathname;
    if (path === "/api/auth/session") return Response.json({ kind: "loopback", trust: "owner" });
    if (path === "/api/auth/sessions") return Response.json({ sessions: [], current: null });
    if (path === "/api/phones") return Response.json({ phones: [] });
    if (path === "/api/computers/bots") return Response.json({ now: NOW, rows: [] });
    if (path === "/api/auth/pairing") return Response.json({ pairings: [] });
    if (path === "/api/config") return Response.json({ membership: { authority: "local", pairingCodes: true } });
    return Response.json({ error: "no route" }, { status: 404 });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  delete (window as unknown as { ogb?: unknown }).ogb;
  vi.unstubAllGlobals();
});

const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)];
const click = async (selector: string) => { await act(async () => $(selector)!.click()); await settle(); };

function WithHeader({ shell }: { shell: SettingsShell }) {
  const [action, setAction] = useState<ReactNode | null>(null);
  return createElement(SettingsShellContext.Provider, { value: { ...shell, setHeaderAction: setAction } },
    createElement("header", { "data-settings-header": "" }, action), createElement(DevicesPage));
}
async function render(over: Partial<SettingsShell["ctx"]> = {}) {
  install();
  const shell: SettingsShell = { ctx: fullContext({ advanced: false, ...over }), place: { name: "This computer", kind: "computer", color: null, named: false }, page: "devices", anchor: null, go: vi.fn() };
  const state = { ...initialState, config: { profile: { email: "ada@example.com" }, managedPolicy: null } as never, bots: [] as never };
  act(() => root.render(createElement(StoreContext.Provider, { value: { state, dispatch: vi.fn() } as never }, createElement(WithHeader, { shell }))));
  await settle();
}

describe("Update all on the Devices page", () => {
  it("sits in the header beside Add a device while something would update, asking each server once without a fresh check", async () => {
    await render();
    const header = $("[data-settings-header]")!;
    expect(header.querySelector("[data-update-all]")?.textContent).toBe("Update all");
    expect(header.querySelector("[data-add-device]")).not.toBeNull();
    expect(updateAll.survey).toHaveBeenCalledWith(false);
    expect(updateAll.survey.mock.calls.every(([fresh]) => fresh === false)).toBe(true);
    // Nothing else on the page announces it: no card, banner or dialog until it is pressed.
    expect($$('[role="dialog"], [role="alertdialog"]')).toHaveLength(0);
    expect($("[data-update-all-state]")).toBeNull();
  });

  it("is not shown when nothing would update, nor on a page that is not this computer's", async () => {
    survey = { ...survey, servers: survey.servers.filter((entry) => entry.id !== "vps") };
    updater = { status: "idle" };
    await render();
    expect($("[data-update-all]")).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    survey = { ...survey, servers: [{ id: "vps", plan: { updates: true, current: "0.1.170", latest: "0.1.175", activeTurns: 0 } }] };
    await render({ here: false });
    expect($("[data-update-all]")).toBeNull();
  });

  it("shows for this app's own update alone", async () => {
    survey = { ...survey, servers: [] };
    await render();
    expect($("[data-update-all]")).not.toBeNull();
  });

  it("confirms once, listing each machine and what updates, this app last, the skipped ones folded with their reasons", async () => {
    retired = true;
    await render();
    await click("[data-update-all]");
    expect(updateAll.survey).toHaveBeenLastCalledWith(true);
    const dialog = $('[role="alertdialog"]')!;
    expect(dialog.querySelector("h2")?.textContent).toBe("Update 2 machines?");
    expect(dialog.textContent).toContain("A bot is answering in 1 chat right now.");
    const rows = $$("[data-update-all-row]").map((row) => [...row.querySelectorAll('[role="cell"]')].map((cell) => cell.textContent));
    expect(rows).toEqual([["Hetzner box", "To 0.1.175"], ["This computer", "This app, to 0.1.182 · restarts last"]]);
    const toggle = $("[data-update-all-skipped]")!;
    expect(toggle.textContent).toBe("4 skipped");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click("[data-update-all-skipped]");
    const skipped = Object.fromEntries($$("[data-update-all-skip]").map((line) => [line.getAttribute("data-update-all-skip"), line.textContent]));
    expect(skipped).toEqual({
      "place:home": "Ada’s Cloud · Updates by itself",
      "place:nuc": "Garage NUC · Sign in there as an admin",
      "place:npm": "Office box · Update it by handnpm install -g openmausbot@0.1.175",
      "phone:pixel": "Pixel 9 · Update from the app store",
    });
    expect(dialog.querySelectorAll("table, p table, details")).toHaveLength(0);
  });

  it("keeps Cancel usable while the fresh look runs, and says when it leaves nothing to update", async () => {
    await render();
    let answer: (value: UpdateAllSurvey) => void = () => {};
    updateAll.survey.mockImplementationOnce(() => new Promise<UpdateAllSurvey>((resolve) => { answer = resolve; }));
    await click("[data-update-all]");
    const buttons = () => [...$('[role="alertdialog"]')!.querySelectorAll("button")];
    expect(buttons().find((button) => button.textContent === "Cancel")?.disabled).toBe(false);
    expect(buttons().find((button) => button.textContent === "Checking…")?.disabled).toBe(true);
    await act(async () => answer({ ...survey, servers: survey.servers.filter((entry) => entry.id !== "vps"), view: current }));
    await settle();
    expect($('[role="alertdialog"] h2')?.textContent).toBe("Update 1 machine?");
    expect(buttons().find((button) => button.textContent === "Update")?.disabled).toBe(false);
  });

  it("starts the servers and this app on Update, with nothing on Cancel", async () => {
    await render();
    await click("[data-update-all]");
    const cancel = [...$('[role="alertdialog"]')!.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!;
  await act(async () => cancel.click());
  await settle();
    expect($('[role="alertdialog"]')).toBeNull();
    expect(updateAll.start).not.toHaveBeenCalled();
    await click("[data-update-all]");
    const confirm = [...$('[role="alertdialog"]')!.querySelectorAll("button")].find((button) => button.textContent === "Update")!;
    await act(async () => confirm.click());
    await settle();
    expect(updateAll.start).toHaveBeenCalledWith(["vps"], true);
  });

  it("shows each device's state on its row as main reports the run, with Try again on a failure", async () => {
    await render();
    const report = async (view: UpdateAllView) => { current = view; await act(async () => pushView!(view)); await settle(); };
    await report({ running: true, rows: { vps: { phase: "restarting", since: Date.now(), latest: "0.1.175" }, app: { phase: "waiting", since: Date.now() } } });
    expect($("[data-device-row='place:vps'] [data-update-all-state]")?.textContent).toBe("Restarting…");
    expect($("[data-device-row='here'] [data-update-all-state]")?.textContent).toBe("Restarts after the others");
    expect($("[data-update-all]")).toBeNull();
    await report({ running: true, rows: { vps: { phase: "done", since: Date.now(), latest: "0.1.175", version: "0.1.175" }, app: { phase: "restarting", since: Date.now() } } });
    expect($("[data-device-row='place:vps'] [data-update-all-state]")?.textContent).toBe("Updated to 0.1.175");
    await report({ running: false, rows: { vps: { phase: "failed", since: Date.now(), latest: "0.1.175", failure: { why: "not-back" } } } });
    const failed = $("[data-device-row='place:vps'] [data-update-all-state]")!;
    expect(failed.textContent).toContain("Failed: The server isn't back yet.");
    await act(async () => failed.querySelector<HTMLElement>("[data-update-all-retry]")!.click());
    await settle();
    expect(updateAll.retry).toHaveBeenCalledWith("vps");
  });
});
