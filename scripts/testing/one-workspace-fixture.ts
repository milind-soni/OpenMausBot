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
// as it does in the app.
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { appPermissionHandlers } from "../../electron/app-permissions.mjs";
import capabilities from "../../electron/capabilities.cjs";
import { chatLinkFrom } from "../../electron/chat-link.mjs";
import { parsePairingGrant, withCloudHome } from "../../electron/cloud-home.mjs";
import { createCloudPowerGate } from "../../electron/cloud-power.mjs";
import environments from "../../electron/environments.cjs";
import { createHomePlaces } from "../../electron/home-places.mjs";
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
function preloadStandIn(ipcBase: string, localOrigin: string): string {
  return `(() => {
  if (!/^https?:/.test(location.protocol)) return;
  try { localStorage.setItem("omb-analytics-opt-out", "1"); localStorage.setItem("omb-email-gate", "skipped"); localStorage.setItem("omb-advanced-mode", "0");
    for (const notice of ${JSON.stringify(NOTICES)}) localStorage.setItem(notice, "1"); } catch {}
  const listeners = new Map();
  window.__ogbEmit = (channel, ...args) => { for (const listener of [...(listeners.get(channel) ?? [])]) listener({}, ...args); };
  const call = async (channel, args) => {
    const response = await fetch(${JSON.stringify(ipcBase)} + "/__ipc/" + channel, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ args }) });
    const answer = await response.json();
    if (!response.ok) throw new Error(answer.error);
    return answer.value;
  };
  const ipcRenderer = {
    invoke: (channel, ...args) => call(channel, args),
    send: (channel, ...args) => { void call(channel, args).catch(() => {}); },
    sendSync: (channel, ...args) => {
      const request = new XMLHttpRequest();
      request.open("POST", ${JSON.stringify(ipcBase)} + "/__ipc-sync/" + channel, false);
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
export async function launchHomeWorld(fx: CloudSendFixture, { chrome, ports, versionEveryMs = 1_000, quietMs = 1_500 }: {
  chrome: string; ports: [number, number, number, number]; versionEveryMs?: number; quietMs?: number;
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
  const syncHandlers = new Map<string, (event: any) => void>();
  const ipcMain = { handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler); }, on: (channel: string, listener: (event: any) => void) => { syncHandlers.set(channel, listener); } };
  const ipc: Server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("access-control-allow-origin", "*");
    const sync = /^\/__ipc-sync\/([\w:.-]+)$/.exec(req.url ?? ""), asked = /^\/__ipc\/([\w:.-]+)$/.exec(req.url ?? "");
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
    const win = windowRef!;
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
    "workspaces:state": (event) => ({ ...environments.workspaceSummary(envState), ...(homeAlone() && homeRef!.homePage(event) ? { home: true } : {}) }),
    "workspaces:menu": () => null,
    "workspaces:line": () => homePlaces.line(),
    "desktop-notices:state": () => ({ seen: [...NOTICES], cloud: false }),
    "desktop-notices:seen": () => null, "desktop-notices:shown": () => false,
    "cloud-plan:state": () => ({ status: "paid", tier: "pro", home: true }),
    "cloud-send:notice": () => ({ ready: false, bots: [], updatedBots: [], skills: 0, logins: 0, onePassword: false, settings: 0, signature: "", dismissed: false, running: false, last: null, whole: null }),
    "update:get-state": () => ({ status: "idle" }),
    "perm:status": () => ({ mic: "unsupported", pageMic: "refused" }),
    "cloud-lending:state": () => null,
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
  const persist = (next: typeof envState) => { envState = next; };
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
  const home = createHomeWindow({
    journal: () => (moves.moved ? { v: 1, phase: "done", cloud: { origin: cloudOrigin, account: ACCOUNT_ID, machine: cloudOrigin }, doneAt: Date.now() } : null),
    frozen: async () => (moves.moved ? (await fetch(`${fx.desktopBase}/api/move/freeze`, { headers: { "x-openmausbot-desktop-owner": fx.ownerCapability } })).json() : { frozen: false }),
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
    showLocal: (leaving: boolean) => (leaving || !/^https?:/.test(win.url) ? win.loadURL(`${localOrigin}/`).catch(() => {}) : undefined),
    splash: () => (world.splash && !world.splash.destroyed ? { status: (text: string) => startup?.status(text) } : null),
    publish: (view: unknown) => { if (new URL(win.url.startsWith("http") ? win.url : "about:blank").origin === localOrigin) win.webContents.send("home:state-changed", view); },
    versionEveryMs, quietMs,
    log: () => {},
  });
  homeRef = home;
  installHomeWindowIpc({ ipcMain, homeWindow: home, cloudPage: (event: any) => (home.homePage(event) ? "cloud" : null) });
  responded = (details) => home.responded(details);
  win.webContents.on("did-navigate", (_event: unknown, url: string) => home.navigated(url));
  win.webContents.on("did-fail-load", (_event: unknown, _code: number, _description: string, url: string) => home.failed(url));
  cleanup.unshift(() => home.close());

  // main.mjs's own delivery of a link the OS opened: queued, then sent to the page that is home.
  const start = MAIN.indexOf("/** To this computer's page, or to My Cloud's once it is home");
  const end = MAIN.indexOf('app.on("open-url"', start);
  const linkContext = vm.createContext({
    homeWindow: home, rendererOrigin: () => localOrigin, activeRemote: () => null, environmentsState: { environments: [], activeId: "local" },
    showHome: () => home.show(), workspaceMenuAction: (action: () => unknown) => action(), switchEnvironment: () => {}, LOCAL_ID: "local",
    mainWindow: win, desktopTray: null, startupScreen: null, BrowserWindow: { getAllWindows: () => [win] }, activateExistingWindow: () => true,
    chatLinkFrom, packageUrlFromDeepLink, pendingChatLink: null, pendingPackageInstallUrl: null, URL,
  });
  vm.runInContext(`${MAIN.slice(start, end)}; this.queueChatLink = queueChatLink; this.deliverChatLink = deliverChatLink;`, linkContext);
  win.webContents.on("did-stop-loading", () => linkContext.deliverChatLink(win));

  let startup: ReturnType<typeof createStartupScreen> | null = null;
  return {
    cloudOrigin, localOrigin, teamOrigin, otherOrigin, window: win, home, account, network, admin, cloudRequests, notifications, hostCache,
    get moved() { return moves.moved; },
    set moved(value: boolean) { moves.moved = value; },
    places: homePlaces, environments: () => envState,
    menu: () => environments.workspaceMenuTemplate(envState, { onSwitch() {}, onConnect() {}, onForget() {}, homeOrigin: home.cloudOrigin() }),
    async sync() { homePlaces.sync(account.state); await home.changed(); },
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
      await home.show();
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
