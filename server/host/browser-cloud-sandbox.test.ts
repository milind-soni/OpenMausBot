// The bots' browser host on a personal Cloud, where a bot's browser opens in the Cloud's browser sandbox, against a fake
// provider (cloud-browser/testing/fake-computer.ts): the switch's lever, a desktop install, and the rules kept for it.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browserEngineStatus } from "../browser-engine.ts";
import { BrowserRuntime } from "../browser-runtime.ts";
import { BrowserUploadRefusal } from "../browser-upload.ts";
import { REDDIT_REFUSAL } from "../browser/egress/reddit.ts";
import { DATA_DIR, type AppConfig } from "../config.ts";
import type { Store } from "../store.ts";
import { OWN_KEY, startFakeComputer, type FakeComputer } from "../cloud-browser/testing/fake-computer.ts";
import { CLOUD_BROWSER_NO_UPLOAD, createBrowserHost, type BrowserHostDeps } from "./browser.ts";

vi.mock("../browser-engine.ts", async (original) => {
  const actual = await original<typeof import("../browser-engine.ts")>();
  return {
    ...actual,
    browserEngineStatus: vi.fn(actual.browserEngineStatus),
    prepareBrowserSessionState: vi.fn(async () => undefined),
    clearBrowserSessionState: vi.fn(async () => true),
    closeBrowserSession: vi.fn(async () => true),
    runningBrowserSessionNames: vi.fn(async () => []),
  };
});
vi.mock("../browser-processes.ts", async (original) => ({
  ...await original<typeof import("../browser-processes.ts")>(),
  orphanedBrowsers: vi.fn(async () => []),
}));

const botId = "scout";
const turn = { threadId: "thread-1", generation: "gen-1" };
let fake: FakeComputer;
type Host = ReturnType<typeof createBrowserHost>;
const hosts: Host[] = [];

beforeEach(async () => {
  // Each test starts the day afresh: the rails keep their counts in the data folder.
  rmSync(join(DATA_DIR, "cloud-browser"), { recursive: true, force: true });
  fake = await startFakeComputer();
  vi.stubEnv("OMB_BOAT_API", `${fake.base}/api/v1`);
  vi.stubEnv("OMB_CLOUD_BROWSER", undefined);
  vi.mocked(browserEngineStatus).mockReturnValue({ kind: "ready", binaryPath: "/usr/local/bin/agent-browser", version: "0.37.0", managed: false });
  vi.spyOn(BrowserRuntime.prototype, "agentRpc").mockImplementation(async (_session, _spec, _method, _params, beforeDispatch) => {
    beforeDispatch?.();
    return { content: [{ type: "text", text: "page" }] };
  });
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(async (host) => { host.browserSweep.closeAll(); await host.browserRuntime.closeAll(); }));
  vi.restoreAllMocks();
  vi.mocked(browserEngineStatus).mockReset();
  vi.unstubAllEnvs();
  await fake.close();
});

function setup({ desktop = false, cloudBrowser = true }: { desktop?: boolean; cloudBrowser?: boolean } = {}) {
  const cfg = { features: { browser: true }, box: { token: OWN_KEY } } as unknown as AppConfig;
  const bots = [{ id: botId, name: botId, browser: true }];
  const used: Array<[string, number]> = [];
  const deps: BrowserHostDeps = {
    cfg,
    store: () => ({ bots, bot: (id: string) => bots.find((bot) => bot.id === id), botByThread: () => bots[0] }) as unknown as Pick<Store, "bots" | "bot" | "botByThread">,
    turnResources: { free: () => true, holder: () => undefined, onClaim: () => () => {} },
    activeInternalGenerationByThread: new Map([[turn.threadId, turn.generation]]),
    mintInternalCapability: () => "capability-token",
    DESKTOP_MANAGED: desktop,
    CLOUD_HOME: desktop ? null : { machineId: "m-1" },
    PORT: 4100,
    ...(cloudBrowser ? { cloudBrowser: { used: (owner: string, windowMs: number) => { used.push([owner, windowMs]); } } } : {}),
  };
  const host = createBrowserHost(deps);
  hosts.push(host);
  return { host, used };
}

const OPEN = "agent_browser_open";

describe("a personal Cloud's bot browser opens in the Cloud's browser sandbox", () => {
  it("attaches the session's engine to the sandbox when a tool call opens it, and keeps the Cloud's rules", async () => {
    const { host, used } = setup();
    const atTurnStart = await host.browserIntegration(botId, undefined, turn);
    expect(atTurnStart?.spec.env.AGENT_BROWSER_CDP, "a turn's start never wakes the sandbox").toBeUndefined();
    expect(fake.requests).toEqual([]);
    const browser = (await host.browserIntegration(botId, undefined, undefined, "team", { opening: OPEN }))!;
    expect(browser.spec.env.AGENT_BROWSER_CDP).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9]{64}$/);
    expect(browser.spec.env.AGENT_BROWSER_RESTORE_SAVE).toBe("never");
    expect(used, "timed by the computers' idle path as the Cloud's sandbox, never as the bot's computer").toEqual([["browser", 3 * 60_000]]);
    // The live view and the next call see the same browser; nothing moves while it runs.
    host.usedBrowserSessions.clear();
    expect((await host.currentBrowserSpec(botId, undefined))?.spec.env.AGENT_BROWSER_CDP).toBe(browser.spec.env.AGENT_BROWSER_CDP);
    expect((await host.browserIntegration(botId, undefined, undefined, "team", { opening: OPEN }))?.spec.env.AGENT_BROWSER_CDP).toBe(browser.spec.env.AGENT_BROWSER_CDP);
    expect(fake.launches()).toBe(1);
    // Reddit stays refused in the sandbox, as in the home.
    expect(await host.browserRuntime.agentRpc(browser.session, browser.spec, "tools/call", { name: OPEN, arguments: { url: "https://www.reddit.com/" } }))
      .toEqual({ isError: true, content: [{ type: "text", text: REDDIT_REFUSAL }] });
    // An upload from the Cloud's disk says so in one line instead of failing on a missing file.
    await expect(host.uploadPaths([{ file: "/tmp/a.txt", name: "a.txt" }], browser.session, browser.spec)).rejects.toThrow(new BrowserUploadRefusal(CLOUD_BROWSER_NO_UPLOAD));
    expect(host.cloudBrowserBusy("browser")).toBe(true);
    expect(host.cloudBrowserBusy(botId)).toBe(false);
    expect(host.cloudBrowserReport()).toMatchObject({ sessions: { sandbox: 1, home: 0 } });
  });

  it("a closing call never opens the sandbox", async () => {
    const { host } = setup();
    await host.browserIntegration(botId, undefined, undefined, "team", { opening: "agent_browser_close" });
    expect(fake.requests).toEqual([]);
  });

  it("a temporary or shared profile opens in the home: the sandbox keeps one profile per bot", async () => {
    const { host } = setup();
    const browser = await host.browserIntegration(botId, "guest", undefined, "team", { opening: OPEN });
    expect(browser?.spec.env.AGENT_BROWSER_CDP).toBeUndefined();
    expect(fake.requests).toEqual([]);
    expect(host.cloudBrowserReport()).toMatchObject({ fallbacks: { "not-eligible": 1 } });
  });

  it("OMB_CLOUD_BROWSER=home: the session's spec is byte-identical to today's and no provider call is made", async () => {
    vi.stubEnv("OMB_CLOUD_BROWSER", "home");
    const { host } = setup();
    const before = await host.browserIntegration(botId, undefined, turn);
    const opened = await host.browserIntegration(botId, undefined, undefined, "team", { opening: OPEN });
    const today = setup({ cloudBrowser: false }).host;
    const withoutFeature = await today.browserIntegration(botId, undefined, undefined, "team", { opening: OPEN });
    expect(JSON.stringify(opened?.spec)).toBe(JSON.stringify(before?.spec));
    expect(JSON.stringify(opened?.spec)).toBe(JSON.stringify(withoutFeature?.spec));
    expect(fake.requests).toEqual([]);
    expect(fake.upgrades).toEqual([]);
  });

  it("on a desktop install everything about it is ignored", async () => {
    const { host } = setup({ desktop: true });
    const opened = await host.browserIntegration(botId, undefined, undefined, "team", { opening: OPEN });
    const today = setup({ desktop: true, cloudBrowser: false }).host;
    const withoutFeature = await today.browserIntegration(botId, undefined, undefined, "team", { opening: OPEN });
    expect(JSON.stringify(opened?.spec)).toBe(JSON.stringify(withoutFeature?.spec));
    expect(opened?.spec.env.AGENT_BROWSER_CDP).toBeUndefined();
    expect(host.cloudBrowserReport()).toBeNull();
    expect(host.cloudBrowserBusy(botId)).toBe(false);
    expect(fake.requests).toEqual([]);
  });

  it("when the sandbox cannot be reached, the session opens in the home exactly as today", async () => {
    fake.chromeStarts = false;
    const { host } = setup();
    const opened = await host.browserIntegration(botId, undefined, undefined, "team", { opening: OPEN });
    const today = setup({ cloudBrowser: false }).host;
    const withoutFeature = await today.browserIntegration(botId, undefined, undefined, "team", { opening: OPEN });
    expect(JSON.stringify(opened?.spec)).toBe(JSON.stringify(withoutFeature?.spec));
    expect(host.cloudBrowserReport()).toMatchObject({ sessions: { sandbox: 0, home: 1 }, fallbacks: { "start-failed": 1 } });
  });
});
