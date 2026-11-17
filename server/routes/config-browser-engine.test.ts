import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { browserEngineKind, type BrowserEngineConfig } from "../browser/config.ts";
import { DATA_DIR, loadConfig, saveConfig } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import { resolveRequestAuth } from "../request-auth.ts";
import { SessionRegistry } from "../sessions.ts";
import { Store } from "../store.ts";
import { dispatchRoutes } from "./table.ts";
import { createConfigRoutes, type ConfigRouteDeps } from "./config.ts";

const model: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const cleanup: Array<() => Promise<void>> = [];
const ownerToken = "config-browser-engine-owner";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

async function fixture(initial: BrowserEngineConfig, check?: () => Promise<null>) {
  const disposableHome = relative(realpathSync(tmpdir()), realpathSync(dirname(DATA_DIR)));
  if (!/^omb-test-home-[^\\/]+$/.test(disposableHome)) throw new Error("Browser config tests require the setup-created temporary home.");
  saveConfig({ browserEngine: { engine: "agent-browser", nativeDesktop: false, idleTimeoutMinutes: 10, ...initial }, features: { browser: true } });
  const cfg = loadConfig();
  const store = new Store(() => model);
  const bot = store.createBot({ name: "Scout" }, { seedMessages: false });
  bot.browser = true;
  const sessions = new SessionRegistry({ file: join(DATA_DIR, "config-browser-sessions.json") });
  let providerBusy = false;
  const switched: string[] = [];
  const deps = {
    cfg, store, sessions,
    registry: { forgetSnapshots: () => {} },
    browserCleanup: { hasPendingProfile: () => false },
    browserLive: { closeAll: () => {}, closeForSession: () => {} }, browserRuntime: { heldBy: () => null },
    usedBrowserSessions: new Map(),
    browserEngineSwitched: () => { switched.push(browserEngineKind(cfg)); },
    sharedComputers: { close: () => {} }, sharedComputerControl: { close: () => {} },
    hostedModels: false, cloudHome: false, sharedMembership: () => false, lendingEnabled: () => false,
    providerConfigs: () => ({}),
    localVmModeChangeBusy: { set: () => {} },
    providerConfigBusy: { get: () => providerBusy, set: (value: boolean) => { providerBusy = value; } },
    computerProviderConfigTransitions: new Set(),
    configStatus: () => ({ browserEngine: cfg.browserEngine }), configForAccess: (status: unknown) => status,
    revokeEngineCapabilities: () => {}, reloadProviders: async () => {}, broadcast: () => {},
    ...(check ? { postiz: { configCheck: check, configSaved: () => {} } } : {}),
  } as unknown as ConfigRouteDeps;
  const routes = [createConfigRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const gate = resolveRequestAuth(req, { sessions, cookieName: "config_session", streamPath: "/api/events", url, loopbackMutationToken: ownerToken });
      if (!gate.auth) return json(res, gate.status, { error: gate.error });
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: gate.auth, json, readBody })) {
        json(res, 404, { error: "No route" });
      }
    } catch (error) {
      json(res, Number((error as { status?: number }).status) || 500, { error: String(error) });
    }
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    sessions.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const patch = (browserEngine: BrowserEngineConfig) => fetch(`${base}/api/config`, {
    method: "PATCH", headers: { "content-type": "application/json", "x-openmausbot-desktop-owner": ownerToken },
    body: JSON.stringify({ browserEngine }),
  });
  return { bot, cfg, patch, switched, saved: () => readFileSync(join(DATA_DIR, "config.json"), "utf8"), providerBusy: () => providerBusy };
}

describe("browser engine changes through the config route", () => {
  it.each([
    { name: "Chrome to native", initial: { engine: "chrome", nativeDesktop: false }, patch: { engine: "chrome", nativeDesktop: true }, next: "native" },
    { name: "Chrome to native with only nativeDesktop", initial: { engine: "chrome", nativeDesktop: false }, patch: { nativeDesktop: true }, next: "native" },
    { name: "native to Chrome", initial: { engine: "chrome", nativeDesktop: true }, patch: { engine: "chrome", nativeDesktop: false }, next: "chrome" },
    { name: "native to Chrome with only nativeDesktop", initial: { engine: "chrome", nativeDesktop: true }, patch: { nativeDesktop: false }, next: "chrome" },
  ] as const)("blocks $name during a turn, then switches once after it stops", async ({ initial, patch, next }) => {
    const f = await fixture(initial);
    const before = f.saved();
    f.bot.busy = true;
    const refused = await f.patch(patch);
    expect(refused.status).toBe(409);
    expect(f.saved()).toBe(before);
    expect(f.switched).toEqual([]);
    expect(f.providerBusy()).toBe(false);

    f.bot.busy = false;
    const accepted = await f.patch(patch);
    expect(accepted.status).toBe(200);
    expect(browserEngineKind(f.cfg)).toBe(next);
    expect(browserEngineKind(loadConfig())).toBe(next);
    expect(f.switched).toEqual([next]);
    expect(f.providerBusy()).toBe(false);
    expect((await f.patch(patch)).status).toBe(200);
    expect(f.switched).toEqual([next]);
  });

  it.each([
    { name: "the current native choice", initial: { engine: "chrome", nativeDesktop: true }, patch: { engine: "chrome", nativeDesktop: true } },
    { name: "native idle timeout", initial: { engine: "chrome", nativeDesktop: true }, patch: { idleTimeoutMinutes: 7 } },
    { name: "Chrome's current choice", initial: { engine: "chrome", nativeDesktop: false }, patch: { engine: "chrome" } },
    { name: "an inactive native preference", initial: { engine: "agent-browser" }, patch: { nativeDesktop: true } },
  ] as const)("saves $name during a turn without switching its running browser", async ({ initial, patch }) => {
    const f = await fixture(initial);
    const beforeKind = browserEngineKind(f.cfg);
    f.bot.busy = true;
    expect((await f.patch(patch)).status).toBe(200);
    expect(browserEngineKind(f.cfg)).toBe(beforeKind);
    expect(f.switched).toEqual([]);
  });

  it("merges a retained native preference when a later patch selects Chrome", async () => {
    const f = await fixture({ engine: "agent-browser" });
    expect((await f.patch({ nativeDesktop: true })).status).toBe(200);
    expect(f.cfg.browserEngine).toMatchObject({ engine: "agent-browser", nativeDesktop: true });
    expect(f.switched).toEqual([]);
    expect((await f.patch({ engine: "chrome" })).status).toBe(200);
    expect(browserEngineKind(f.cfg)).toBe("native");
    expect(f.switched).toEqual(["native"]);
  });

  it("rechecks a turn that starts while the config request is awaiting a check", async () => {
    const entered = deferred(), resume = deferred();
    const f = await fixture({ engine: "chrome" }, async () => { entered.resolve(); await resume.promise; return null; });
    cleanup.push(async () => { resume.resolve(); });
    const before = f.saved();
    const pending = f.patch({ nativeDesktop: true });
    await entered.promise;
    f.bot.busy = true;
    resume.resolve();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(f.saved()).toBe(before);
    expect(f.switched).toEqual([]);
    expect(f.providerBusy()).toBe(false);
  });
});
