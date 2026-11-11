// The desktop window onto My Cloud, in a real headless Chrome, with main's own handlers: the home window
// (electron/home-window.mjs), its IPC, the startup screen, the permission rule, and main.mjs's own chat-link delivery,
// against the two real servers of cloud-send-fixture.ts. Chrome stands in for Electron: each window is a Chrome tab
// driven over the DevTools protocol, the real preload runs in every page it loads (its ipcRenderer reaches main's
// handlers over loopback), webRequest's onCompleted is Chrome's own response events, and the permission handler's answer
// is set on Chrome per origin as each page loads. My Cloud's page and this computer's are the real renderer from source
// (Vite), each served at its own origin: My Cloud's through an edge that adds the Cloud's own headers, this computer's
// asking this computer's real, frozen server which page it serves. A team's Cloud is the same Cloud-mode server behind a
// third edge at its own origin (for opening, a Team Cloud is a My Cloud), paired through a fake Admin's team pairing
// route on this harness's own server, so main's team path (home-places.mjs, the session's teams as saved places) runs
// as it does in the app. With `profiles`, This Mac is there too: main's real profile swap (clean-workspace.mjs) restarts
// this computer's server on the profile's folder at the same address, the window's rail is its own page in a second tab
// with main's rail handlers (cloud-rail.mjs), and this computer is really lent to My Cloud (computer-sharing.mjs over
// lending-target.mjs) on the window's own session.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { appPermissionHandlers } from "../../electron/app-permissions.mjs";
import capabilities from "../../electron/capabilities.cjs";
import { chatLinkFrom } from "../../electron/chat-link.mjs";
import { createCleanWorkspace } from "../../electron/clean-workspace.mjs";
import { createLocalProfiles, createProfileRegistry } from "../../electron/local-profiles.mjs";
import { parsePairingGrant, withCloudHome } from "../../electron/cloud-home.mjs";
import { installCloudRail, railPlaces } from "../../electron/cloud-rail.mjs";
import { createComputerSharing } from "../../electron/computer-sharing.mjs";
import { createLendingTarget } from "../../electron/lending-target.mjs";
import { createCloudPowerGate } from "../../electron/cloud-power.mjs";
import environments from "../../electron/environments.cjs";
import { createHomePlaces } from "../../electron/home-places.mjs";
import { openStartPlace } from "../../electron/start-place.mjs";
import { createHomeWindow, installHomeWindowIpc, HOME_SCREEN_PATH } from "../../electron/home-window.mjs";
import { createStartupScreen } from "../../electron/startup-screen.mjs";
import { packageUrlFromDeepLink } from "../../electron/package-link.mjs";
import { WELCOME_VERSION } from "../../electron/onboarding-record.mjs";
import { SPOTLIGHTS } from "../../src/lib/first-conversation.ts";
import { TOUR_STEPS } from "../../src/lib/guided-tour.ts";
import { NOTICES } from "../../src/lib/notices.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import type { CloudSendFixture } from "./cloud-send-fixture.ts";
import { REPO_ROOT } from "./preview-fixture.ts";

const PRELOAD = readFileSync(join(REPO_ROOT, "electron", "preload.cjs"), "utf8");
const MAIN = readFileSync(join(REPO_ROOT, "electron", "main.mjs"), "utf8").replace(/\r\n/g, "\n");
const SPLASH_ICON = join(REPO_ROOT, "electron", "resources", "app-icon.png");
export const ACCOUNT_ID = "acct-fixture";
/** The renderer's own routes to its server; the same keys as vite.config.ts, so none of its own targets is kept. */
const PROXIED = ["/api", "/.well-known/openmausbot/environment"];

type Cdp = Awaited<ReturnType<typeof connectCdp>>;
type Handler = (params: any, sessionId?: string) => void;

async function connectCdp(url: string) {
  const socket = new WebSocket(url);
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const listeners = new Map<string, Set<Handler>>();
  let next = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method) for (const listener of listeners.get(message.method) ?? []) listener(message.params, message.sessionId);
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message)); else waiting.resolve(message.result);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Fixture Chrome connection failed")), { once: true });
  });
  return {
    request(method: string, params: unknown = {}, sessionId?: string): Promise<any> {
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture Chrome ${method} timed out`)); }, 60_000);
        pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    on(method: string, listener: Handler) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method)!.add(listener);
      return () => listeners.get(method)!.delete(listener);
    },
    close() { for (const waiting of pending.values()) waiting.reject(new Error("closed")); socket.close(); },
  };
}

let ids = 100;
/** One Electron window, as a Chrome tab: the part of BrowserWindow and its webContents main and the startup screen use. */
export class TabWindow extends EventEmitter {
  readonly cdp: Cdp;
  readonly targetId: string;
  readonly sessionId: string;
  readonly webContents: EventEmitter & Record<string, any>;
  url = "about:blank";
  destroyed = false;
  visible = false;
  loads = 0;
  private readyShown = false;

  constructor(cdp: Cdp, targetId: string, sessionId: string) {
    super();
    this.cdp = cdp; this.targetId = targetId; this.sessionId = sessionId;
    const contents = new EventEmitter() as EventEmitter & Record<string, any>;
    contents.id = ids++;
    contents.mainFrame = { url: "" };
    Object.defineProperty(contents.mainFrame, "url", { get: () => this.url });
    contents.getURL = () => this.url;
    contents.isDestroyed = () => this.destroyed;
    contents.isLoadingMainFrame = () => false;
    contents.focus = () => {};
    contents.send = (channel: string, ...args: unknown[]) => { void this.evaluate(`window.__ogbEmit?.(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`).catch(() => {}); };
    contents.executeJavaScript = (code: string) => this.evaluate(code);
    contents.reload = () => { void cdp.request("Page.reload", {}, sessionId).catch(() => {}); };
    this.webContents = contents;
    cdp.on("Page.frameNavigated", ({ frame }, from) => {
      if (from !== sessionId || frame.parentId) return;
      this.url = `${frame.url}${frame.urlFragment ?? ""}`;
      contents.emit("did-navigate", {}, this.url);
    });
    cdp.on("Page.navigatedWithinDocument", ({ url }, from) => { if (from === sessionId) this.url = url; });
    cdp.on("Page.loadEventFired", (_params, from) => {
      if (from !== sessionId) return;
      this.loads++;
      contents.emit("did-finish-load");
      contents.emit("did-stop-loading");
      if (!this.readyShown) { this.readyShown = true; this.emit("ready-to-show"); }
    });
    cdp.on("Network.loadingFailed", ({ type, errorText, canceled }, from) => {
      if (from !== sessionId || type !== "Document" || canceled) return;
      contents.emit("did-fail-load", {}, -2, errorText, this.url, true);
    });
  }

  static async open(cdp: Cdp, init?: string): Promise<TabWindow> {
    const { targetId } = await cdp.request("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.request("Target.attachToTarget", { targetId, flatten: true });
    for (const domain of ["Page.enable", "Runtime.enable", "Network.enable"]) await cdp.request(domain, {}, sessionId);
    if (init) await cdp.request("Page.addScriptToEvaluateOnNewDocument", { source: init }, sessionId);
    return new TabWindow(cdp, targetId, sessionId);
  }

  async evaluate<T = any>(expression: string): Promise<T> {
    const value = await this.cdp.request("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, this.sessionId);
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
    return value.result.value as T;
  }

  async loadURL(url: string): Promise<void> {
    const answer = await this.cdp.request("Page.navigate", { url }, this.sessionId);
    if (answer.errorText) throw new Error(answer.errorText);
  }

  async screenshot(file: string): Promise<void> {
    const shot = await this.cdp.request("Page.captureScreenshot", { format: "png" }, this.sessionId);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, Buffer.from(shot.data, "base64"));
  }

  setMenu() {}
  show() { this.visible = true; this.emit("show"); }
  showInactive() { this.show(); }
  hide() { this.visible = false; }
  focus() {}
  isVisible() { return this.visible; }
  isMinimized() { return false; }
  minimize() {}
  maximize() {}
  setSkipTaskbar() {}
  isDestroyed() { return this.destroyed; }
  close() { this.destroy(); }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    void this.cdp.request("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
    this.emit("closed");
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => { let text = ""; req.on("data", (chunk) => { text += chunk; }); req.on("end", () => resolve(text)); });
}

/** Electron's preload in a Chrome page: the real preload.cjs, its `require("electron")` and argv given by this harness. */
function preloadStandIn(ipcBase: string, localOrigin: string, tab = "window"): string {
  return `(() => {
  if (!/^https?:/.test(location.protocol)) return;
  try { localStorage.setItem("omb-analytics-opt-out", "1"); localStorage.setItem("omb-email-gate", "skipped"); localStorage.setItem("omb-advanced-mode", "0");
    for (const notice of ${JSON.stringify(NOTICES)}) localStorage.setItem(notice, "1"); } catch {}
  const listeners = new Map();
  window.__ogbEmit = (channel, ...args) => { for (const listener of [...(listeners.get(channel) ?? [])]) listener({}, ...args); };
  let sent = 0;
  const call = async (channel, args) => {
    const response = await fetch(${JSON.stringify(ipcBase)} + "/__ipc/" + channel + "?tab=${tab}&seq=" + (++sent), { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ args }) });
    const answer = await response.json();
    if (!response.ok) throw new Error(answer.error);
    return answer.value;
  };
  const ipcRenderer = {
    invoke: (channel, ...args) => call(channel, args),
    send: (channel, ...args) => { void call(channel, args).catch(() => {}); },
    sendSync: (channel, ...args) => {
      const request = new XMLHttpRequest();
      request.open("POST", ${JSON.stringify(ipcBase)} + "/__ipc-sync/" + channel + "?tab=${tab}", false);
      request.setRequestHeader("content-type", "text/plain");
      request.send(JSON.stringify({ args }));
      try { return JSON.parse(request.responseText).value; } catch { return undefined; }
    },
    on: (channel, listener) => { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel).add(listener); },
    removeListener: (channel, listener) => { listeners.get(channel)?.delete(listener); },
  };
  const electron = { contextBridge: { exposeInMainWorld: (key, value) => { window[key] = value; } }, ipcRenderer, webUtils: { getPathForFile: () => "" } };
  const process = { platform: "darwin", argv: ["--omb-local-origin=${localOrigin}", "--omb-company-desktop=1"] };
  (function (require, process) {
${PRELOAD}
  })(() => electron, process);
})();`;
}

export interface HomeWorld {
  /** My Cloud as this window reaches it, and this computer's own page. */
  cloudOrigin: string;
  localOrigin: string;
  /** A team's Cloud: the same Cloud-mode server at its own origin. */
  teamOrigin: string;
  /** Another saved server, for a page that is neither. */
  otherOrigin: string;
  window: TabWindow;
  /** The startup screen of the last launch, while it is up. */
  splash: TabWindow | null;
  home: ReturnType<typeof createHomeWindow>;
  /** A launch of the app: the startup screen, then show() as main's launch does. */
  launch(): Promise<void>;
  /** The MausBot Cloud sign-in main reads: its state, and the power word of a Cloud that sleeps. */
  account: { state: Record<string, any>; power: { state: "awake" | "asleep" | "waking"; since: number; sleeps: true } | null; wakeMs: number; wakes: number; signIns: string[] };
  /** Down: every request on the way to My Cloud fails, the window's and main's alike; `teamDown`: the team's Cloud only;
   * `nameMissing`: My Cloud's name isn't found (a resolver kept the answer it got while My Cloud was set up). */
  network: { down: boolean; teamDown: boolean; nameMissing: boolean };
  /** False: the move hasn't happened, so My Cloud is a saved server this window opens when asked (no journal, no freeze). */
  moved: boolean;
  /** How often the window's Electron session had its host cache cleared. */
  hostCache: { cleared: number };
  /** The fake Admin: each team pairing it signed, by team id; `removed`: teams whose pairing it refuses (404), as for a
   * member removed while the session still lists the team. */
  admin: { teamPairings: string[]; removed: Set<string> };
  /** Main's places (home-places.mjs) and its saved servers, as the app keeps them. */
  places: ReturnType<typeof createHomePlaces>;
  environments(): { environments: any[]; activeId: string };
  /** The switcher's entries as main's native menu would list them (environments.cjs). */
  menu(): Array<{ label?: string; sublabel?: string; checked?: boolean }>;
  /** The MausBot Cloud sign-in changed: main's own two steps (the places follow the session, then the window). */
  sync(): Promise<void>;
  /** With `profiles`: the window's rail as its own page, main's list for it, the profile swap and this computer's lending. */
  rail: TabWindow | null;
  railList(): ReturnType<typeof railPlaces>;
  clean: ReturnType<typeof createCleanWorkspace> | null;
  lending: ReturnType<typeof createComputerSharing> | null;
  /** The folder this computer's server runs on now. */
  running(): string;
  /** With `profiles`: the workspaces of this computer's own as main keeps them (local-profiles.mjs), and the Trash a
   * removed one goes to. */
  registry: ReturnType<typeof createProfileRegistry> | null;
  readonly profiles: ReturnType<typeof createLocalProfiles> | null;
  trashDir: string;
  /** A sheet of the rail's is open: its view covers the window. */
  railCovers(): boolean;
  setSize(width: number, height: number): Promise<void>;
  /** The OS's light or dark look, which both pages follow. */
  theme(dark: boolean): Promise<void>;
  /** The app quits and opens again: this computer's server stopped as a quit stops it and started on the data folder, then
   * `whileClosed` (what changes while the app is closed), and a new home window that knows nothing of the last run opens the
   * place remembered from it, as a launch does. */
  restartApp(whileClosed?: () => unknown): Promise<void>;
  /** Each request My Cloud's edge passed on, in order. */
  cloudRequests: Array<{ path: string; at: number }>;
  /** main.mjs's own chat-link delivery, as a link from the OS reaches it. */
  openLink(link: string): boolean;
  /** What main's permission handler decided for the last pages, by origin. */
  notifications: Map<string, boolean>;
  /** The window's session cookie on My Cloud. */
  cloudCookies(): Promise<Array<{ name: string; value: string }>>;
  close(): Promise<void>;
}

/** Both sides past their welcome, so a page opens straight on its chats. */
export async function welcomed(fx: CloudSendFixture): Promise<void> {
  const onboarding = { completedAt: new Date().toISOString(), version: WELCOME_VERSION, hintsSeen: [...TOUR_STEPS.map((step) => step.id), ...SPOTLIGHTS] };
  await fx.local("PATCH", "/api/config", { onboarding, language: "en" });
  await fx.onCloud("PATCH", "/api/config", { onboarding: { ...onboarding, hintsSeen: [...onboarding.hintsSeen, "cloud-welcome-done", "cloud-setup-hidden"] }, language: "en" });
}

async function vite(port: number, host: string, plugin: (server: ViteDevServer) => void, proxy: Record<string, unknown>): Promise<ViteDevServer> {
  const server = await createViteServer({
    root: REPO_ROOT, logLevel: "warn", clearScreen: false,
    server: { host, port, strictPort: true, proxy: proxy as never, hmr: { port: port + 1 } },
    plugins: [{ name: "one-workspace-edge", configureServer: plugin }],
  });
  await server.listen();
  return server;
}

/** `chrome`: the pinned Chrome for Testing; `ports`: two free pairs (each Vite server takes its port and the next). */
export async function launchHomeWorld(fx: CloudSendFixture, { chrome, ports, versionEveryMs = 1_000, quietMs = 1_500, profiles = false }: {
  chrome: string; ports: [number, number, number, number]; versionEveryMs?: number; quietMs?: number; profiles?: boolean;
}): Promise<HomeWorld> {
  const [cloudPort, localPort, ipcPort, teamPort] = ports;
  const cloudOrigin = `http://localhost:${cloudPort}`;
  const localOrigin = `http://127.0.0.1:${localPort}`;
  const ipcBase = `http://127.0.0.1:${ipcPort}`;
  // Its own host, not another localhost port: a browser's cookies are per host, and the team's session must be its own.
  const teamOrigin = `http://[::1]:${teamPort}`;
  const otherOrigin = ipcBase;
  const network = { down: false, teamDown: false, nameMissing: false };
  const moves = { moved: true };
  const hostCache = { cleared: 0 };
  const admin: HomeWorld["admin"] = { teamPairings: [], removed: new Set() };
  const cloudRequests: HomeWorld["cloudRequests"] = [];
  const notifications = new Map<string, boolean>();
  const account: HomeWorld["account"] = {
    state: { status: "connected", account: { id: ACCOUNT_ID, email: "person@example.test" }, entitlement: { plan: "pro", status: "active", expiresAt: null, version: 1 },
      machine: { status: "ready", origin: cloudOrigin } },
    power: null, wakeMs: 1_500, wakes: 0, signIns: [],
  };
  const cleanup: Array<() => Promise<unknown> | unknown> = [];
  let windowRef: TabWindow | null = null, homeRef: ReturnType<typeof createHomeWindow> | null = null, responded: ((details: any) => void) | null = null;
  let railRef: TabWindow | null = null, railHandlers: ReturnType<typeof installCloudRail> | null = null;
  let railCovers = false;
  const size = { width: 1280, height: 800 };

  // My Cloud's edge: the renderer from source, and its API on the real Cloud-mode server with the edge's own headers.
  const cloudEdge = await vite(cloudPort, "localhost", (server) => {
    server.middlewares.use((req, res, next) => {
      if (network.down || network.nameMissing) { req.socket.destroy(); return; }
      if ((req.url ?? "").startsWith("/api/") || (req.url ?? "").startsWith("/.well-known/")) cloudRequests.push({ path: (req.url ?? "").split("?")[0]!, at: Date.now() });
      next();
    });
  }, Object.fromEntries(PROXIED.map((path) => [path, {
    target: fx.cloudBase, ws: true, headers: fx.edge,
    configure: (proxy: EventEmitter) => {
      proxy.on("proxyRes", (proxyRes: IncomingMessage) => {
        const cookies = proxyRes.headers["set-cookie"];
        if (cookies) proxyRes.headers["set-cookie"] = cookies.map((cookie) => cookie.replace(/;\s*Secure/giu, ""));
      });
    },
  }])));
  cleanup.push(() => cloudEdge.close());
  // The team's Cloud: the same server, its own origin (so its own cookie, its own page).
  const teamEdge = await vite(teamPort, "::1", (server) => {
    server.middlewares.use((req, _res, next) => { if (network.teamDown) { req.socket.destroy(); return; } next(); });
  }, Object.fromEntries(PROXIED.map((path) => [path, {
    target: fx.cloudBase, ws: true, headers: fx.edge,
    configure: (proxy: EventEmitter) => {
      proxy.on("proxyRes", (proxyRes: IncomingMessage) => {
        const cookies = proxyRes.headers["set-cookie"];
        if (cookies) proxyRes.headers["set-cookie"] = cookies.map((cookie) => cookie.replace(/;\s*Secure/giu, ""));
      });
    },
  }])));
  cleanup.push(() => teamEdge.close());

  // This computer's page: the same renderer, and its real server, as the desktop's owner, decides which page it serves.
  const localEdge = await vite(localPort, "127.0.0.1", (server) => {
    server.middlewares.use(async (req, res, next) => {
      const path = (req.url ?? "/").split("?")[0]!;
      const page = req.method === "GET" && !path.startsWith("/api/") && !path.startsWith("/@") && !path.startsWith("/src/") && !path.startsWith("/node_modules/")
        && !/\.[A-Za-z0-9]+$/u.test(path) && (req.headers.accept ?? "").includes("text/html");
      if (!page) return next();
      const real = await fetch(`${fx.desktopBase}${req.url}`, { redirect: "manual" }).catch(() => null);
      if (real && real.status >= 300 && real.status < 400) {
        res.statusCode = real.status;
        res.setHeader("location", real.headers.get("location") ?? HOME_SCREEN_PATH);
        res.end();
        return;
      }
      next();
    });
  }, Object.fromEntries(PROXIED.map((path) => [path, { target: fx.desktopBase, ws: true, headers: { "x-openmausbot-desktop-owner": fx.ownerCapability } }])));
  cleanup.push(() => localEdge.close());

  // Main's ipcMain, reached by the preload's ipcRenderer.
  const handlers = new Map<string, (...args: any[]) => unknown>();
  /** The last invoke each tab's page sent that main has started on. */
  const started = new Map<string, number>();
  const syncHandlers = new Map<string, (event: any) => void>();
  const ipcMain = { handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler); }, on: (channel: string, listener: (event: any) => void) => { syncHandlers.set(channel, listener); } };
  const ipc: Server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("access-control-allow-origin", "*");
    const [path = "", query = ""] = (req.url ?? "").split("?");
    const sync = /^\/__ipc-sync\/([\w:.-]+)$/.exec(path), asked = /^\/__ipc\/([\w:.-]+)$/.exec(path);
    const reply = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    // The fake Admin's team pairing: only for a team the session lists, answered as the Admin answers (docs/team-cloud.md).
    const teamPairing = /^\/api\/cloud\/desktop\/teams\/([^/]+)\/pairing$/.exec(req.url ?? "");
    if (teamPairing) {
      const id = decodeURIComponent(teamPairing[1]!);
      const listed = req.method === "POST" && req.headers.authorization === "Bearer omc_fixture" && account.state.status === "connected" && (account.state.teams ?? []).some((team: any) => team.id === id) && !admin.removed.has(id);
      if (!listed) return reply(404, { error: "not_found" });
      admin.teamPairings.push(id);
      const grant = await fx.grant("OpenMausBot app (Team Cloud)");
      return reply(200, { cloudContractVersion: 1, origin: teamOrigin, code: grant.code, pairingUrl: `${teamOrigin}/pair#code=${grant.code}`, expiresAt: grant.expiresAt, credential: "omb_pair_fixture" });
    }
    if (!sync && !asked) { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>Another server</title><p>Another server</p>"); return; }
    const { args = [] } = JSON.parse((await readBody(req)) || "{}") as { args?: unknown[] };
    const params = new URLSearchParams(query), tab = params.get("tab") ?? "window", seq = Number(params.get("seq") ?? 0);
    // Electron hands a page's invokes to main in the order the page sent them; separate HTTP requests may arrive in any.
    for (let waits = 0; asked && seq > 1 && (started.get(tab) ?? 0) < seq - 1 && waits < 40; waits++) await new Promise((resolve) => setTimeout(resolve, 50));
    if (asked) started.set(tab, seq);
    const win = tab === "rail" && railRef ? railRef : windowRef!;
    const event: Record<string, any> = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    if (sync) {
      const listener = syncHandlers.get(sync[1]!);
      if (listener) listener(event);
      return reply(200, { value: event.returnValue ?? null });
    }
    const channel = asked![1]!;
    const handler = handlers.get(channel) ?? STAND_INS[channel];
    if (!handler) return reply(400, { error: `${channel} is not wired in this harness` });
    try { reply(200, { value: (await handler(event, ...args)) ?? null }); }
    catch (error) { reply(400, { error: error instanceof Error ? error.message : String(error) }); }
  });
  await new Promise<void>((resolve) => ipc.listen(ipcPort, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => ipc.close(resolve)));
  // Channels of the page this harness does not drive, answered as main answers a page that has nothing to say.
  const STAND_INS: Record<string, (...args: any[]) => unknown> = {
    "desktop:capabilities": (event) => capabilities.desktopCapabilities({ remote: new URL(event.senderFrame.url).origin !== localOrigin, platform: "darwin", env: {}, packaged: true, localConnection: { mode: "unavailable", reason: "fixture" } }),
    "workspaces:state": (event) => ({ ...environments.workspaceSummary(envState), ...(homeAlone() && homeRef!.homePage(event) ? { home: true } : {}),
      ...(clean?.profile() && new URL(event.senderFrame.url).origin === localOrigin ? { profile: clean.profile(), ...(localProfiles?.name(clean.profile()!) ? { profileName: localProfiles.name(clean.profile()!) } : {}) } : {}) }),
    "workspaces:menu": () => null,
    "workspaces:line": (event) => (clean?.active() && new URL(event.senderFrame.url).origin === localOrigin ? (clean.profile() ? { kind: "profile", ...(localProfiles?.name(clean.profile()!) ? { name: localProfiles.name(clean.profile()!) } : {}) } : { kind: "clean" }) : homePlaces.line()),
    "rail:offer": () => ({ available: true, hidden: false }),
    // chrome-rail.mjs: while a sheet of the rail's is open, its view covers the window, see-through but for the sheet.
    "rail:expand": async (_event, covering) => {
      railCovers = covering === true;
      if (railRef) await cdp.request("Emulation.setDeviceMetricsOverride", { width: railCovers ? size.width : 36, height: size.height, deviceScaleFactor: 2, mobile: false }, railRef.sessionId);
    },
    "rail:draws-frame": () => null,
    "desktop-notices:state": () => ({ seen: [...NOTICES], cloud: false }),
    "desktop-notices:seen": () => null,
    "cloud-plan:state": () => ({ status: "paid", tier: "pro", home: true }),
    "cloud-send:notice": () => ({ ready: false, bots: [], updatedBots: [], skills: 0, logins: 0, onePassword: false, settings: 0, signature: "", dismissed: false, running: false, last: null, whole: null }),
    "update:get-state": () => ({ status: "idle" }),
    "perm:status": () => ({ mic: "unsupported", pageMic: "refused" }),
  };

  // Chrome, its two tabs' worth of windows.
  const profile = mkdtempSync(join(tmpdir(), "omb-one-workspace-chrome-"));
  cleanup.push(() => rmSync(profile, { recursive: true, force: true }));
  const browser: ChildProcess = spawn(chrome, ["--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--password-store=basic", "--use-mock-keychain", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], {
    env: { PATH: process.env.PATH, HOME: profile, USERPROFILE: profile }, stdio: "ignore",
  });
  cleanup.unshift(() => waitForExit(browser, { signal: "SIGTERM" }));
  const portFile = join(profile, "DevToolsActivePort");
  for (let tries = 0; !existsSync(portFile) && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 100));
  const [devPort, endpoint] = readFileSync(portFile, "utf8").trim().split("\n");
  const cdp = await connectCdp(`ws://127.0.0.1:${devPort}${endpoint}`);
  cleanup.unshift(() => cdp.close());
  const init = preloadStandIn(ipcBase, localOrigin);
  const win = await TabWindow.open(cdp, init);
  windowRef = win;
  cdp.on("Network.responseReceived", ({ response, type }, from) => {
    if (from !== win.sessionId || type === "Document") return;
    responded?.({ url: response.url, statusCode: response.status, webContentsId: win.webContents.id });
  });

  // Main's own handlers. Saved servers and places as main keeps them, in memory here.
  let envState: { environments: any[]; activeId: string } = { environments: [], activeId: environments.LOCAL_ID };
  let envIds = 0;
  const makeId = () => `env-${++envIds}`;
  const persist = (next: typeof envState) => { envState = next; railHandlers?.changed(); };
  let placeRecord: unknown = null;
  const homePlaces = createHomePlaces({ store: { read: () => placeRecord, write: (value) => { placeRecord = value; } }, environments: () => envState, persist, makeId, homeOrigin: () => homeRef?.cloudOrigin() ?? null });
  const homeAlone = () => Boolean(homeRef?.cloudOrigin()) && !environments.otherPlaces(envState, homeRef!.cloudOrigin());
  /** main.mjs's activateCloud / activateTeam / back to this computer, as its `go` does them. */
  const activate = (origin: string | null, place: any) => {
    if (place?.kind === "team") {
      const next = environments.withTeam(envState, place, makeId);
      persist(environments.withActive(next, next.environments.find((entry: any) => entry.origin === place.origin).id));
    } else if (origin) {
      const next = withCloudHome(envState, { status: "ready", origin }, makeId);
      persist(environments.withActive(next, next.environments.find((entry: any) => entry.origin === origin).id));
    } else if (environments.activeEnvironment(envState)) persist(environments.withActive(envState, environments.LOCAL_ID));
  };
  const power = createCloudPowerGate({ power: () => account.power });
  const appPermissions = appPermissionHandlers({ rendererOrigin: () => localOrigin, mainContents: () => win.webContents, cloudHomeOrigin: () => cloudOrigin,
    homeOrigin: () => homeRef?.placeOrigin() ?? null });
  win.webContents.on("did-navigate", (_event: unknown, url: string) => {
    const origin = new URL(url).origin;
    if (!/^https?:/.test(url)) return;
    const allowed = appPermissions.check(win.webContents, "notifications", origin, { isMainFrame: true }) === true;
    notifications.set(origin, allowed);
    void cdp.request("Browser.setPermission", { permission: { name: "notifications" }, setting: allowed ? "granted" : "denied", origin }).catch(() => {});
  });
  const pairHome = async () => {
    if (account.state.status !== "connected" || network.down) throw new Error("My Cloud is not ready to connect yet.");
    const grant = await fx.grant("OpenMausBot app (Cloud)");
    return { ...grant, origin: cloudOrigin };
  };
  /** The real client's `pairTeam` shape against the fake Admin's route: the Admin's answer, read as the app reads it. */
  const pairTeam = async (teamId: string) => {
    if (network.down) throw new TypeError("fetch failed");
    const response = await fetch(`${ipcBase}/api/cloud/desktop/teams/${encodeURIComponent(teamId)}/pairing`, { method: "POST", headers: { authorization: "Bearer omc_fixture" } });
    if (!response.ok) throw Object.assign(new Error("Cloud request failed."), { status: response.status, ...(response.status === 404 ? { gone: true } : {}) });
    const grant = parsePairingGrant(await response.json(), teamOrigin, Date.now());
    if (!grant) throw new Error("Invalid Cloud pairing response.");
    return grant;
  };
  const client = {
    state: () => account.state,
    power: () => account.power,
    async wakeHome() {
      account.wakes++;
      await new Promise((resolve) => setTimeout(resolve, account.wakeMs));
      if (account.power) account.power = { ...account.power, state: "awake", since: Date.now() };
      power.changed();
      return "awake";
    },
    setWaking: () => {},
    pairHome,
    pairTeam,
    async signInAgain() { account.signIns.push("again"); },
    async begin() { account.signIns.push("begin"); },
  };
  // The window's session's fetch: its cookies go along, and a cookie the answer sets is the window's from then on.
  const cookieFetch = async (url: string, init: RequestInit = {}) => {
    if (network.down || (network.teamDown && url.startsWith(teamOrigin)) || (network.nameMissing && url.startsWith(cloudOrigin))) throw new TypeError("fetch failed");
    const { cookies } = await cdp.request("Network.getCookies", { urls: [url] }, win.sessionId);
    const cookie = (cookies as Array<{ name: string; value: string }>).map((entry) => `${entry.name}=${entry.value}`).join("; ");
    const response = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), ...(cookie ? { cookie } : {}) } });
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
      const at = pair.indexOf("="), path = attributes.find((part) => /^path=/i.test(part))?.slice(5) || "/";
      if (at <= 0) continue;
      const name = pair.slice(0, at), cookieUrl = new URL(url).origin + path;
      // A cookie the answer clears (Max-Age=0) is deleted, never kept with an empty value, as Electron's session does.
      if (attributes.some((part) => /^max-age=(0|-\d+)$/i.test(part))) await cdp.request("Network.deleteCookies", { name, url: cookieUrl }, win.sessionId);
      else await cdp.request("Network.setCookie", { name, value: pair.slice(at + 1), url: cookieUrl, path, httpOnly: attributes.some((part) => /^httponly$/i.test(part)) }, win.sessionId);
    }
    return response;
  };
  const world = {
    splash: null as TabWindow | null,
  };
  // main.mjs's cleanWorkspace: its swap is switchLocalEnvironmentTo's, one server at a time at the same address, then the
  // window onto this computer's page with LOCAL_ID active.
  let running = fx.desktopDataDir;
  const clean = profiles ? createCleanWorkspace({
    dataDir: () => fx.desktopDataDir, running: () => running,
    swap: async (dir: string) => {
      // A workspace's first config as the app writes it, with the fixture's AIs only, so nothing on this machine's PATH is used.
      const config = join(dir, "config.json");
      if (dir !== fx.desktopDataDir && existsSync(config)) {
        const seeded = JSON.parse(readFileSync(config, "utf8"));
        if (!seeded.instances) writeFileSync(config, JSON.stringify({ ...seeded, instances: JSON.parse(readFileSync(join(fx.desktopDataDir, "config.json"), "utf8")).instances }));
      }
      await fx.relaunch({ kill: false, ...(dir === fx.desktopDataDir ? {} : { dataDir: dir }) });
      running = dir;
      persist(environments.withActive(envState, environments.LOCAL_ID));
      homeRef?.cancel();
      await win.loadURL(`${localOrigin}/`).catch(() => {});
      return { ok: true };
    },
    changed: () => lending?.cloudChanged(),
  }) : null;
  const ownCopy = async (route: string, init?: RequestInit) => fetch(`${fx.desktopBase}${route}`, { ...init, headers: { "x-openmausbot-desktop-owner": fx.ownerCapability } });
  const makeHome = () => createHomeWindow({
    ...(clean ? { clean } : {}),
    journal: () => (moves.moved ? { v: 1, phase: "done", cloud: { origin: cloudOrigin, account: ACCOUNT_ID, machine: cloudOrigin }, doneAt: Date.now() } : null),
    frozen: async () => (moves.moved ? (await (clean ? clean.realCopy(ownCopy) : ownCopy)("/api/move/freeze")).json() : { frozen: false }),
    // The window's Electron session: its own resolver and host cache, for My Cloud's name.
    hosts: () => ({
      clearHostResolverCache: async () => { hostCache.cleared++; },
      resolveHost: async (host: string) => {
        if (network.nameMissing && host === new URL(cloudOrigin).hostname) throw new Error("net::ERR_NAME_NOT_RESOLVED");
        return { endpoints: [{ address: "127.0.0.1", family: "ipv4" }] };
      },
    }),
    account: () => client as never,
    window: () => (win.destroyed ? null : win) as never,
    ensureWindow: () => {},
    localOrigin: () => localOrigin,
    cookieFetch: cookieFetch as typeof fetch,
    power,
    go: (url: string, origin: string | null, place: unknown) => { activate(origin, place); return win.loadURL(url).catch(() => {}); },
    remembered: homePlaces.remembered, remember: homePlaces.remember, left: homePlaces.left, drop: homePlaces.drop,
    showLocal: (leaving: boolean) => {
      if (!leaving && /^https?:/.test(win.url)) return undefined;
      if (leaving && environments.activeEnvironment(envState)) persist(environments.withActive(envState, environments.LOCAL_ID));
      return win.loadURL(`${localOrigin}/`).catch(() => {});
    },
    splash: () => (world.splash && !world.splash.destroyed ? { status: (text: string) => startup?.status(text) } : null),
    publish: (view: unknown) => { if (new URL(win.url.startsWith("http") ? win.url : "about:blank").origin === localOrigin) win.webContents.send("home:state-changed", view); },
    versionEveryMs, quietMs,
    log: () => {},
  });
  // A launch of the app: its home window as main makes it, knowing nothing of the last run.
  const launchHome = () => {
    const made = makeHome();
    homeRef = made;
    installHomeWindowIpc({ ipcMain, homeWindow: made, cloudPage: (event: any) => (made.homePage(event) ? "cloud" : null) });
    return made;
  };
  let home = launchHome();
  responded = (details) => homeRef!.responded(details);
  win.webContents.on("did-navigate", (_event: unknown, url: string) => homeRef!.navigated(url));
  win.webContents.on("did-fail-load", (_event: unknown, _code: number, _description: string, url: string) => homeRef!.failed(url));
  cleanup.unshift(() => homeRef!.close());

  // main.mjs's own delivery of a link the OS opened: queued, then sent to the page that is home.
  const start = MAIN.indexOf("/** To this computer's page, or to My Cloud's once it is home");
  const end = MAIN.indexOf('app.on("open-url"', start);
  const linkContext = vm.createContext({
    homeWindow: home, rendererOrigin: () => localOrigin, activeRemote: () => null, environmentsState: { environments: [], activeId: "local" },
    showHome: () => homeRef!.show(), workspaceMenuAction: (action: () => unknown) => action(), switchEnvironment: () => {}, LOCAL_ID: "local",
    mainWindow: win, desktopTray: null, startupScreen: null, BrowserWindow: { getAllWindows: () => [win] }, activateExistingWindow: () => true,
    chatLinkFrom, packageUrlFromDeepLink, pendingChatLink: null, pendingPackageInstallUrl: null, URL,
  });
  vm.runInContext(`${MAIN.slice(start, end)}; this.queueChatLink = queueChatLink; this.deliverChatLink = deliverChatLink;`, linkContext);
  win.webContents.on("did-stop-loading", () => linkContext.deliverChatLink(win));

  // main.mjs's rail: its list (railList, with railProfiles) and handlers, for the rail's own page in a tab of its own, as
  // wide as the window's rail view.
  // main.mjs's localProfiles: the registry beside the profiles' folders, the Trash a folder of the fixture's own, and what
  // the server that runs still does asked as main asks it.
  const trashDir = join(fx.root, "Trash");
  const registry = profiles ? createProfileRegistry({ dataDir: () => fx.desktopDataDir }) : null;
  const makeLocal = () => (clean && registry ? createLocalProfiles({ registry, clean, dataDir: () => fx.desktopDataDir,
    home: () => (homeRef!.cloudOrigin() ? "cloud" : clean.marker().frozen ? null : "local"),
    window: { openProfile: (id: string) => homeRef!.openProfile(id), profile: () => homeRef!.profile(), showCloud: () => homeRef!.show({ place: "cloud" }) },
    showLocal: () => { homeRef!.cancel(); persist(environments.withActive(envState, environments.LOCAL_ID)); return win.loadURL(`${localOrigin}/`).catch(() => {}); },
    onLocal: () => /^https?:/.test(win.url) && new URL(win.url).origin === localOrigin,
    busy: async () => { const said = await (await ownCopy("/api/move/freeze")).json(); return typeof said?.busy === "string" ? { name: said.busy, what: said.what } : null; },
    trash: async (dir: string) => { mkdirSync(trashDir, { recursive: true }); renameSync(dir, join(trashDir, `${Date.now()}-${dir.split(/[\\/]/).pop()}`)); },
    reserved: () => "This Mac", remember: homePlaces.remember, changed: () => railHandlers?.changed() }) : null);
  let localProfiles = makeLocal();
  const railList = () => {
    const settling = localProfiles?.settling() ?? null;
    return railPlaces({ saved: envState, home: homeRef!.cloudOrigin(), mine: cloudOrigin, state: account.state,
      profiles: localProfiles?.places({ activeLocal: envState.activeId === environments.LOCAL_ID }) ?? [], computerSettling: settling && settling.id === null ? settling.name : null });
  };
  let lending: ReturnType<typeof createComputerSharing> | null = null;
  if (profiles) {
    railRef = await TabWindow.open(cdp, preloadStandIn(ipcBase, localOrigin, "rail"));
    await cdp.request("Emulation.setDeviceMetricsOverride", { width: 36, height: 800, deviceScaleFactor: 2, mobile: false }, railRef.sessionId);
    await cdp.request("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, railRef.sessionId);
    railHandlers = installCloudRail({
      ipcMain, guard: (handler: any) => handler, trusted: () => true, lists: (event: any) => event.sender === railRef!.webContents, beside: () => true,
      places: railList, account: () => null, clipboard: { writeText: () => {} }, openCloud: async () => {},
      add: { choices: () => ({ cloud: false, link: true, address: false }), run: () => {} },
      targets: () => [win.webContents, railRef!.webContents],
      // main.mjs's switchEnvironment: This computer (its own copy, or back from a workspace), or My Cloud shown again.
      open: async (id: string) => {
        if (id === environments.LOCAL_ID && clean!.profile()) { await (homeRef!.cloudOrigin() ? localProfiles!.open(clean!.profile()!) : localProfiles!.computer()); railHandlers?.changed(); return; }
        homeRef!.cancel();
        if (id === environments.LOCAL_ID) { persist(environments.withActive(envState, environments.LOCAL_ID)); await win.loadURL(`${localOrigin}/`).catch(() => {}); return; }
        const entry = envState.environments.find((candidate: any) => candidate.id === id);
        if (entry?.origin === homeRef!.cloudOrigin()) return homeRef!.show({ place: "cloud" }).then(() => railHandlers?.changed());
        throw new Error("This harness opens My Cloud and this computer's own places only");
      },
      openProfile: async (id: string) => {
        const opened = await localProfiles!.open(id);
        railHandlers?.changed();
        if (opened === false) throw new Error("This computer's own place didn't open.");
      },
      local: { creatable: () => localProfiles!.creatable(), create: (input: any) => localProfiles!.create(input), rename: (id: string, name: string) => localProfiles!.rename(id, name),
        recolor: (id: string, color: string | null) => localProfiles!.recolor(id, color), remove: (id: string) => localProfiles!.remove(id), cancel: () => localProfiles!.cancel() } as never,
    });
    win.webContents.on("did-navigate", () => railHandlers?.changed());
    await railRef.loadURL(`${localOrigin}/rail`);
    // This computer, lent to My Cloud on the window's own session, as main's sharingController lends it.
    const lentHome = mkdtempSync(join(tmpdir(), "omb-profile-lent-"));
    cleanup.push(() => rmSync(lentHome, { recursive: true, force: true }));
    const target = createLendingTarget({ account: () => client as never, clean, environments: () => envState.environments });
    lending = createComputerSharing({
      file: join(lentHome, "computer-sharing.json"), home: lentHome, fetch: cookieFetch as typeof fetch, environments: () => envState.environments,
      cloud: target.cloud, myCloud: target.environment, ownClouds: target.places, screen: () => false, cuaConnection: async () => null,
      linkHeaders: async (env: { origin: string }) => ({ cookie: ((await cdp.request("Network.getCookies", { urls: [env.origin] }, win.sessionId)).cookies as Array<{ name: string; value: string }>)
        .map((entry) => `${entry.name}=${entry.value}`).join("; ") }),
    });
    cleanup.unshift(() => lending?.close());
  }

  let startup: ReturnType<typeof createStartupScreen> | null = null;
  return {
    rail: railRef, railList, clean, lending, running: () => running, registry, trashDir,
    get profiles() { return localProfiles; },
    railCovers: () => railCovers,
    async setSize(width: number, height: number) {
      Object.assign(size, { width, height });
      await cdp.request("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false }, win.sessionId);
      if (railRef) await cdp.request("Emulation.setDeviceMetricsOverride", { width: railCovers ? width : 36, height, deviceScaleFactor: 2, mobile: false }, railRef.sessionId);
    },
    async theme(dark: boolean) {
      for (const tab of [win, railRef].filter(Boolean) as TabWindow[]) {
        await cdp.request("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] }, tab.sessionId);
        // The app follows the OS's look once its skin is System; a page reads that choice as it loads.
        if (await tab.evaluate("localStorage.getItem('omb-skin') === 'system'").catch(() => true)) continue;
        await tab.evaluate("localStorage.setItem('omb-skin', 'system')").catch(() => {});
        await cdp.request("Page.reload", {}, tab.sessionId).catch(() => {});
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    },
    async restartApp(whileClosed?: () => unknown) {
      homeRef!.close();
      // A quit stops this computer's server as main's before-quit does, and the next launch starts it on the data folder.
      await fx.relaunch({ kill: false });
      running = fx.desktopDataDir;
      await whileClosed?.();
      home = launchHome();
      localProfiles = makeLocal();
      await openStartPlace({ home, places: homePlaces, profiles: localProfiles, server: async () => false });
      if (railRef) await railRef.loadURL(`${localOrigin}/rail`);
    },
    cloudOrigin, localOrigin, teamOrigin, otherOrigin, window: win, get home() { return homeRef!; }, account, network, admin, cloudRequests, notifications, hostCache,
    get moved() { return moves.moved; },
    set moved(value: boolean) { moves.moved = value; },
    places: homePlaces, environments: () => envState,
    menu: () => environments.workspaceMenuTemplate(envState, { onSwitch() {}, onConnect() {}, onForget() {}, homeOrigin: homeRef!.cloudOrigin() }),
    async sync() { homePlaces.sync(account.state); await homeRef!.changed(); },
    get splash() { return world.splash; },
    async launch() {
      const splashTab = await TabWindow.open(cdp);
      world.splash = splashTab;
      // The startup screen makes its own window: here, the tab made for it.
      class SplashWindow extends TabWindow { constructor() { super(cdp, splashTab.targetId, splashTab.sessionId); world.splash = this; } }
      splashTab.removeAllListeners();
      startup = createStartupScreen({ BrowserWindow: SplashWindow as never, iconPath: SPLASH_ICON, platform: "darwin", isQuitting: () => false, onQuit: () => {}, onFinished: () => { startup = null; } });
      await startup.ready;
      startup.attach(win as never, { maximized: false });
      await homeRef!.show();
    },
    openLink: (link) => linkContext.queueChatLink(link),
    async cloudCookies() { return (await cdp.request("Network.getCookies", { urls: [cloudOrigin] }, win.sessionId)).cookies; },
    async close() { for (const step of cleanup) await Promise.resolve().then(step).catch(() => {}); },
  };
}

export function shotsDir(fallback: string): string {
  const dir = process.env.OMB_ONE_WORKSPACE_SHOTS ?? join(fallback, "shots");
  mkdirSync(dir, { recursive: true });
  return dir;
}
