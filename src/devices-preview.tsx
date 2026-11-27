// Dev-only gallery of Settings → Devices, served at /devices-preview.html; not in the packaged app. It mounts the real
// Settings window over a fake desktop bridge and answers every /api request itself, so nothing reaches a server.
// ?place=computer|cloud&devices=full|none|one|ten&bots=full|none|unknown|forbidden&tailscale=unknown|not-installed|no-cli|signed-out|needs-approval|magicdns|ready|unshared
//  &check=1 (presses the private network's button once loaded) &select=<device id> &add=choose|phone|computer|server|cloud
//  &skin=midnight|daylight&advanced=1&page=<Settings page id>&long=1 (long names)&connect=ok (a server link connects)
//  &join=phone|computer (a new device signs in a few seconds after a code shows)&tailscale=…|not-running|needs-permission
//  &code=1 (a phone code still open) &notice=1 (an update kept Same Wi-Fi on) &retired=1 (an older phone app's link ended)
//  &home=on|off (Always-on home on this computer) &vps=default (a default SSH server too; page=ai&advanced=1 shows the
//  Self-hosted VPS panel under AI's computers) &e2e=0 (an older phone link: a typed code beside the QR)
//  &map=0|1 (the picture above the list off or on, whatever SHOW_DEVICE_MAP says)
//  &updates=1 (Update all: the Mac mini and the Hetzner box can update, this app has one downloaded)
//  &updateAll=open|running|done (its dialog with the skipped list open; rows mid-run; rows near the end)
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { parseServerInput } from "../electron/server-address.mjs";
import { SettingsModal } from "@/components/SettingsModal";
import { overrideDeviceMap } from "@/components/devices/DeviceMap";
import type { CompanionState } from "@/lib/companion-types";
import { loadLocale } from "@/lib/i18n";
import { setAdvancedMode } from "@/lib/interface-mode";
import { applySkinChoice, SKIN_IDS, type SkinId } from "@/lib/skins";
import { initialState, StoreContext } from "@/state/store";
import "./styles.css";

const params = new URLSearchParams(location.search);
const place = params.get("place") === "cloud" ? "cloud" : "computer";
const shown = params.get("devices") ?? "full";
const full = shown === "full" || shown === "ten";
const ten = shown === "ten";
const tailscale = params.get("tailscale") ?? (full ? "ready" : "unknown");
const skin = params.get("skin") ?? "midnight";
const long = params.get("long") === "1";
const join = params.get("join");
const connectOk = params.get("connect") === "ok";
const homeParam = params.get("home");
const retired = params.get("retired") === "1";
applySkinChoice(SKIN_IDS.includes(skin as SkinId) ? (skin as SkinId) : "midnight");
setAdvancedMode(params.get("advanced") === "1");
overrideDeviceMap(params.get("map") === "0" ? false : params.get("map") === "1" ? true : null);
await loadLocale(params.get("lang") ?? "en");

const now = Date.now();
const hostOf = (address: string) => { try { return new URL(/:\/\//.test(address) ? address : `http://${address}`).host; } catch { return address; } };
const MIN = 60_000;
const ready = tailscale === "ready" || tailscale === "unshared";
const tailRoute = { on: ready || tailscale === "magicdns", since: now - 9e8, name: ready ? "ada-macbook.tail4c2e.ts.net" : null, computers: tailscale !== "unshared" };
let companion: CompanionState = {
  enabled: true, keepAwake: false, port: 8810, pairing: null, addresses: ["192.168.1.23"], lan: "192.168.1.23", hosts: ["192.168.1.23"],
  devices: full ? [
    { id: "iphone", name: "Ada’s iPhone 16", createdAt: now - 9e8, lastSeenAt: now - MIN, cloudDesktopAccess: false, e2eAt: now - 5e8, routes: "any", route: "wifi" },
    { id: "pixel", name: long ? "Theo’s Samsung Galaxy S24 Ultra (the family tablet stand)" : "Pixel 9", createdAt: now - 9e8, lastSeenAt: now - 26 * 60 * MIN, cloudDesktopAccess: true, browserControlAccess: true, ...(retired ? {} : { e2eAt: now - 5e8 }), routes: "local", route: null },
    ...(ten ? [
      { id: "ipad", name: "Ada’s iPad Pro", createdAt: now - 9e8, lastSeenAt: now - MIN, cloudDesktopAccess: false, e2eAt: now - 5e8, routes: "any" as const, route: "tailscale" as const },
      { id: "kid", name: "Theo’s Galaxy A54 with a very long name", createdAt: now - 9e8, lastSeenAt: now - 3 * 24 * 60 * MIN, cloudDesktopAccess: false, e2eAt: now - 5e8, routes: "local" as const, route: null },
    ] : []),
  ] : shown === "one" ? [{ id: "iphone", name: "Ada’s iPhone 16", createdAt: now - 9e8, lastSeenAt: now - MIN, cloudDesktopAccess: false, e2eAt: now - 5e8, routes: "any", route: "wifi" }] : [],
  connectedDeviceIds: full ? ["iphone", ...(ten ? ["ipad"] : [])] : shown === "one" ? ["iphone"] : [],
  routes: { wifi: { on: full || shown === "one", since: now - 9e8 }, relay: { on: full, since: now - 9e8 }, tailscale: tailRoute, https: { on: false, since: null } },
  tailnetShare: ready && tailscale !== "unshared" ? { on: true, origin: "http://ada-macbook.tail4c2e.ts.net:8799", https: false, problem: null } : undefined,
  e2e: { enabled: params.get("e2e") !== "0", relay: "connected", node: "relay1.openmausbot.com", descriptor: null },
  ...(params.get("code") === "1" ? { pairing: { code: "482913", token: "omb_pair_PreviewPreviewPreviewPreviewPreviewPreviewP", expiresAt: now + 10 * MIN } } : {}),
  ...(params.get("notice") === "1" ? { notices: ["wifi" as const] } : {}),
};
const alwaysOnHome = { available: true, on: homeParam === "on", platform: "darwin", openAtLogin: homeParam === "on", awake: homeParam === "on" ? "holding" as const : "off" as const, updates: "by-itself" as const };
const problem = ["not-installed", "no-cli", "signed-out", "needs-approval", "not-running", "needs-permission"].includes(tailscale) ? tailscale as CompanionState["tailscaleProblem"] : undefined;
const reply = async (next?: Partial<CompanionState>) => { companion = { ...companion, ...next }; return companion; };
const companionBridge = {
  state: () => reply(), start: () => reply(), stop: () => reply(), keepAwake: () => reply(), refreshTailscale: () => reply(),
  setTailscaleComputers: async () => (problem ? { ...companion, tailscaleProblem: problem } : reply({ routes: { ...companion.routes!, tailscale: { ...tailRoute, on: true, name: "ada-macbook.tail4c2e.ts.net", computers: true } }, tailnetShare: { on: true, origin: "http://ada-macbook.tail4c2e.ts.net:8799", https: false, problem: null } })),
  setTailscale: () => reply(), dismissNotice: () => reply(), renewPairing: () => reply(),
  setRoute: (route: "wifi" | "relay", on: boolean) => reply({ routes: { ...companion.routes!, [route]: { on, since: now } } }),
  pairing: (open: boolean) => {
    if (open && join === "phone") window.setTimeout(() => void reply({ pairing: null, devices: [...companion.devices, { id: "new-phone", name: "Ada’s Pixel 10", createdAt: Date.now(), lastSeenAt: Date.now(), cloudDesktopAccess: false, e2eAt: Date.now(), routes: "any", route: "wifi" }], connectedDeviceIds: [...(companion.connectedDeviceIds ?? []), "new-phone"] }), 2500);
    return reply({ pairing: open ? { code: "482913", token: "omb_pair_PreviewPreviewPreviewPreviewPreviewPreviewP", expiresAt: Date.now() + 10 * MIN } : null });
  },
  cloudDesktop: (id: string, on: boolean) => reply({ devices: companion.devices.map((device) => (device.id === id ? { ...device, cloudDesktopAccess: on } : device)) }),
  browserControl: (id: string, on: boolean) => reply({ devices: companion.devices.map((device) => (device.id === id ? { ...device, browserControlAccess: on } : device)) }),
  routes: (id: string, routes: "any" | "local") => reply({ devices: companion.devices.map((device) => (device.id === id ? { ...device, routes } : device)) }),
  revoke: (id: string) => reply({ devices: companion.devices.filter((device) => device.id !== id) }),
};
const environments: Array<{ id: string; kind: "local" | "remote"; name: string; origin?: string; home?: boolean; color?: string }> = full ? [
  { id: "local", kind: "local" as const, name: "This computer" },
  { id: "home", kind: "remote" as const, name: "Ada’s Cloud", origin: "https://ada.mausbot.cloud", home: true, color: "violet" },
  { id: "mini", kind: "remote" as const, name: long ? "Studio Mac mini in the back office (rendering and nightly builds)" : "Studio Mac mini", origin: "http://studio-mini.tail4c2e.ts.net:8799" },
  { id: "vps", kind: "remote" as const, name: "Hetzner box", origin: "https://maus.example.com" },
  ...(ten ? [{ id: "lan", kind: "remote" as const, name: "Office NUC", origin: "http://192.168.1.40:8799" }] : []),
] : [{ id: "local", kind: "local" as const, name: "This computer" }];
const statuses = full ? [
  { id: "home", state: "connected", since: now - 9e8, version: "0.1.180", behind: false, install: null },
  { id: "mini", state: "connected", since: now - 9e8, version: "0.1.171", behind: true, install: "global" },
  { id: "vps", state: params.get("vpsState") ?? "cantReach", since: now - 40 * MIN, version: "0.1.180", behind: false, install: "docker" },
] : [];
const lendViews: Record<string, DesktopLendView> = {
  mini: { name: "Studio Mac mini", lendable: true, on: true, connected: true, paused: false },
  vps: { name: "Hetzner box", lendable: true, on: false, connected: false, paused: false },
};
const updates = params.get("updates") === "1" || params.has("updateAll");
const updateAllShot = params.get("updateAll");
const failedRun = { why: "run", status: { mode: "button", current: "0.1.171", available: true, activeTurns: 0, run: { outcome: "rolled-back", from: "0.1.171", at: now - 3 * MIN } } };
const updateView = updateAllShot === "running" ? { running: true, rows: {
  vps: { phase: "restarting", since: now - MIN, latest: "0.1.175" },
  lan: { phase: "updating", since: now - MIN, latest: "0.1.175" },
  app: { phase: "waiting", since: now - 3 * MIN },
} } : updateAllShot === "done" ? { running: true, rows: {
  vps: { phase: "done", since: now - MIN, latest: "0.1.175", version: "0.1.175" },
  lan: { phase: "failed", since: now - MIN, latest: "0.1.175", failure: failedRun },
  app: { phase: "restarting", since: now - 10_000 },
} } : { running: false, rows: {} };
const updateSurvey = {
  servers: [
    { id: "mini", plan: { updates: false, why: "by-hand", current: "0.1.171", latest: "0.1.175", command: "npm install -g openmausbot@0.1.175" } },
    { id: "vps", plan: { updates: true, current: "0.1.170", latest: "0.1.175", activeTurns: 1 } },
    { id: "lan", plan: { updates: true, current: "0.1.171", latest: "0.1.175", activeTurns: 0 } },
  ],
  app: { version: "0.1.182", handoff: false }, view: updateView,
};
const ogb = {
  platform: "darwin",
  app: { version: "0.1.180" },
  ...(updates && place === "computer" ? {
    updater: { check: async () => {}, install: async () => {}, onState: (cb: (state: unknown) => void) => { cb({ status: "downloaded", version: "0.1.182", installMode: "restart" }); return () => {}; } },
    updateAll: { survey: async () => updateSurvey, start: async () => updateView, retry: async () => updateView, onState: () => () => {} },
  } : {}),
  ...(place === "computer" ? {
    companion: companionBridge,
    companionAccount: { state: async () => ({ available: true, status: "ready", email: "ada@example.com", ...(retired ? { tunnelRetired: true } : {}) }) },
    ...(homeParam ? { alwaysOnHome: { state: async () => alwaysOnHome, set: async (on: boolean) => Object.assign(alwaysOnHome, { on, openAtLogin: on, awake: on ? "holding" : "off" }) } } : {}),
    environments: { state: async () => ({ localOrigin: "http://127.0.0.1:8799", remote: false, packaged: true, activeId: "local", environments: [...environments] }), status: async () => statuses,
      switch: async () => {}, forget: async () => {}, retry: async () => {}, addFromLink: async () => {}, create: async () => ({ ok: true, state: null }), pickDir: async () => ({ ok: false }) },
    computerSharing: { servers: async () => (full ? [{ id: "mini", enabled: true, connected: true, paused: false }] : []) },
    // The one lend switch on a server's card (src/lib/use-lend-computer.ts): the Mac mini lends, the VPS doesn't yet.
    lendComputer: { state: async (id: string | null) => lendViews[id ?? ""] ?? lendViews.vps!, set: async (id: string | null, on: boolean) => (lendViews[id ?? ""] = { ...(lendViews[id ?? ""] as Extract<DesktopLendView, { lendable: true }>), on, connected: on }),
      allowScreen: async (id: string | null) => lendViews[id ?? ""]!, wish: async () => true },
    workspaces: { state: () => new Promise(() => {}), places: () => new Promise(() => {}), homeOffers: async () => [], onChanged: () => () => {},
      add: async (how: string, address?: string) => {
        if (how !== "link") return;
        if (!connectOk) return { outcome: "problem", problem: "unreachable", host: hostOf(address ?? "") };
        environments.push({ id: "new-server", kind: "remote", name: "Garage NUC", origin: address ?? "https://maus.example.org" });
        return { outcome: "connected" };
      },
      probe: async (address: string, code?: string) => {
        const parsed = parseServerInput(address, code ?? "");
        if (!parsed.ok) return { outcome: "problem", problem: parsed.problem, host: hostOf(address) };
        if (!connectOk) return { outcome: "problem", problem: "unreachable", host: hostOf(address) };
        const saved = environments.find((entry) => entry.origin && hostOf(entry.origin) === hostOf(address));
        return { outcome: "found", label: saved?.name ?? "Garage NUC", version: "0.1.180", transport: "https" };
      } },
  } : {}),
};
(globalThis as unknown as { ogb: unknown }).ogb = ogb;

const sessions = full ? [
  { id: "s-mini", label: "Studio Mac mini", scopes: ["admin", "client"], createdAt: now - 9e8, lastSeenAt: now - 2 * MIN, expiresAt: now + 9e8 },
  { id: "s-air", label: "Ada’s MacBook Air", scopes: ["admin", "client"], createdAt: now - 9e8, lastSeenAt: now - 3 * 60 * MIN, expiresAt: now + 9e8 },
  ...(place === "cloud" ? [{ id: "s-phone", label: "Safari on iPhone", scopes: ["admin", "client"], createdAt: now - 9e8, lastSeenAt: now - MIN, expiresAt: now + 9e8 }] : []),
] : [];
let pairingsOpen = 0;
const BOTS = [
  { id: "b1", name: "Scout", color: "green" }, { id: "b2", name: "Writer", color: "purple" }, { id: "b3", name: "Builder", color: "orange" },
  { id: "b4", name: "Ledger", color: "blue" }, { id: "b5", name: "Helper", color: "pink" },
];
const row = (botId: string, kind: string, computerId: string | null, state: string, extra: object = {}) => ({ botId, kind, computerId, name: null, state, stateAt: state === "unknown" ? null : now - MIN, ...extra });
const botMode = params.get("bots") ?? "full";
const botRows = !full || botMode === "none" ? [] : botMode === "unknown" ? [
  row("b1", "cloud", "cloud:b1", "unknown"), row("b2", "vps", "vps:gpu/omb-b2", "unknown", { vps: { serverId: "vps:gpu", alias: "gpu", container: "omb-b2" } }),
] : [
  row("b1", "local", "local", "ready"), row("b2", "local", "local", "ready"), row("b3", "cloud", "cloud:b3", "asleep"),
  row("b4", "vps", "vps:gpu/omb-b4", "ready", { vps: { serverId: "vps:gpu", alias: "gpu", container: "omb-b4" } }), row("b5", "browser", null, "unknown"),
  ...(ten ? [row("b5", "cloud", "cloud:b5", "ready")] : []),
];
const ANSWERS: Record<string, unknown> = {
  "/api/computers/bots": { now, rows: botRows },
  "/api/auth/session": { kind: "loopback", trust: "owner" },
  "/api/auth/sessions": { sessions, current: null },
  "/api/phones": { phones: full ? [{ key: "k1", registration: { installId: "i1", name: "Ada’s iPhone 16", platform: "ios", appVersion: "2.4.0", timeZone: "UTC", capabilities: { calendar: true, reminders: true, location: true } }, registeredAt: now - 9e8, seen: now - MIN, lastUsedAt: null, online: true, busy: false }] : [] },
  "/api/auth/pairing": { id: "p1", code: "7KQ2-M9XD-H4TP", expiresAt: now + 10 * MIN, url: "http://ada-macbook.tail4c2e.ts.net:8799/pair#code=7KQ2-M9XD-H4TP", hint: null },
};
const config = {
  profile: { name: "Ada", email: "ada@example.com" }, membership: { authority: "local", pairingCodes: true }, managedPolicy: null,
  vps: { configured: full, sshAlias: params.get("vps") === "default" ? "studio-gpu" : "", memoryGb: 8, cpus: 4,
    servers: full ? [{ name: "GPU box", sshAlias: "gpu" }, ...(ten ? [{ name: "Render farm", sshAlias: "farm" }] : [])] : [] },
  ...(place === "cloud" ? { cloudHome: true } : {}),
};
ANSWERS["/api/config"] = config;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
  if (path === "/api/shared-computers" && place === "cloud" && full) {
    return Response.json({ computers: [], known: [{ id: "l1", name: "Ada’s MacBook Pro", platform: "darwin", online: true, busy: false, lent: true, lastSeenAt: now, lastUsedAt: null, scopes: { folders: 1, terminal: true, screen: true, internet: false, chrome: false } }] });
  }
  if (path === "/api/computers/bots" && botMode === "forbidden") return Response.json({ error: "forbidden" }, { status: 403 });
  if (path === "/api/auth/pairing" && init?.method === "POST") {
    pairingsOpen = 1;
    if (join === "computer") window.setTimeout(() => { pairingsOpen = 0; sessions.push({ id: "s-new", label: "Ada’s Mac Studio", scopes: ["admin", "client"], createdAt: Date.now(), lastSeenAt: Date.now(), expiresAt: Date.now() + 9e8 }); }, 2500);
    return Response.json(ANSWERS["/api/auth/pairing"]);
  }
  if (path === "/api/auth/pairing" && init?.method === "DELETE") { pairingsOpen = 0; return Response.json({ ok: true }); }
  if (path === "/api/auth/pairing") return Response.json({ pairings: pairingsOpen ? [{ id: "p1" }] : [] });
  if (path === "/api/auth/sessions") return Response.json({ sessions, current: null });
  if (path in ANSWERS) return Response.json(ANSWERS[path]);
  return Response.json({ error: "not in the preview" }, { status: 404 });
};

const state = { ...initialState, bots: BOTS as never, config: config as never, appSettingsOpen: true, appSettingsSection: (params.get("page") ?? "devices") as "devices" };
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoreContext.Provider value={{ state, dispatch: () => {} } as never}>
      <div className="min-h-screen bg-app" />
      <SettingsModal />
    </StoreContext.Provider>
  </StrictMode>,
);

const click = (selector: string) => document.querySelector<HTMLElement>(selector)?.click();
const after = (ms: number, run: () => void) => window.setTimeout(run, ms);
if (params.get("check") === "1") after(900, () => click("[data-network-action]"));
if (updateAllShot === "open") after(900, () => { click("[data-update-all]"); after(200, () => click("[data-update-all-skipped]")); });
if (updateAllShot === "running" || updateAllShot === "done") after(900, () => {
  document.querySelector("[data-settings-block=group-computers]")?.scrollIntoView({ block: "start" });
  document.body.dataset.shotReady = "";
});
const select = params.get("select");
if (select) after(900, () => click(`[data-device-node="${select}"]`));
const add = params.get("add");
if (add) after(900, () => { click("[data-add-device]"); if (add !== "choose") after(200, () => click(`[data-add-kind="${add}"]`)); });
const group = params.get("addGroup");
if (group) after(900, () => click(`[data-add-group="${group}"]`));
