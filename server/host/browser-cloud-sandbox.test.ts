// The bots' browser host on a personal Cloud, where a bot's browser opens in the Cloud's browser sandbox, against a fake
// provider (cloud-browser/testing/fake-computer.ts): the switch's lever, a desktop install, and the rules kept for it.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browserEngineStatus } from "../browser-engine.ts";
import { BrowserRuntime } from "../browser-runtime.ts";
import { REDDIT_REFUSAL } from "../browser/egress/reddit.ts";
import { DATA_DIR, type AppConfig } from "../config.ts";
import type { Store } from "../store.ts";
import { RELAY_KEY, startFakeComputer, type FakeComputer } from "../cloud-browser/testing/fake-computer.ts";
import { LOCAL_SCHEME_REFUSAL, PRIVATE_ADDRESS_REFUSAL } from "../cloud-browser/guards.ts";
import { createBrowserHost, type BrowserHostDeps } from "./browser.ts";

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
  vi.stubEnv("OMB_CLOUD_BOAT_URL", `${fake.base}/api/v1`);
  vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", RELAY_KEY);
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

function setup({ desktop = false, cloudBrowser = true, ownKey = false, turnHolds = false }: { desktop?: boolean; cloudBrowser?: boolean; ownKey?: boolean; turnHolds?: boolean } = {}) {
  const cfg = { features: { browser: true }, ...(ownKey ? { box: { token: "boat_persons-own-key" } } : {}) } as unknown as AppConfig;
  const bots = [{ id: botId, name: botId, browser: true }];
  const used: Array<[string, number]> = [];
  const deps: BrowserHostDeps = {
    cfg,
    store: () => ({ bots, bot: (id: string) => bots.find((bot) => bot.id === id), botByThread: () => bots[0] }) as unknown as Pick<Store, "bots" | "bot" | "botByThread">,
    turnResources: { free: () => !turnHolds, holder: () => undefined, onClaim: () => () => {} },
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
    // Files and the browser's own pages are never opened there: every bot's Chrome there runs as one user.
    expect(await host.browserRuntime.agentRpc(browser.session, browser.spec, "tools/call", { name: OPEN, arguments: { url: "file:///home/user/.omb-browser/" } }))
      .toEqual({ isError: true, content: [{ type: "text", text: LOCAL_SCHEME_REFUSAL }] });
    // Reddit stays refused in the sandbox, as in the home.
    expect(await host.browserRuntime.agentRpc(browser.session, browser.spec, "tools/call", { name: OPEN, arguments: { url: "https://www.reddit.com/" } }))
      .toEqual({ isError: true, content: [{ type: "text", text: REDDIT_REFUSAL }] });
    // An upload from the Cloud's disk goes to the sandbox first, and the page gets its path there.
    const scratch = mkdtempSync(join(tmpdir(), "upload-"));
    try {
      writeFileSync(join(scratch, "a.txt"), "hello");
      const paths = await host.uploadPaths([{ file: join(scratch, "a.txt"), name: "notes.txt" }], browser.session, browser.spec);
      expect(paths).toEqual([expect.stringMatching(/^\/home\/user\/\.omb-browser\/\.uploads\/[a-f0-9]{16}\/notes\.txt$/)]);
      expect(fake.files.get(paths[0]!)?.toString()).toBe("hello");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    expect(host.cloudBrowserBusy("browser")).toBe(true);
    expect(host.cloudBrowserBusy(botId)).toBe(false);
    expect(host.cloudBrowserReport()).toMatchObject({ sessions: { sandbox: 1, home: 0 } });
  });

  it("a Cloud on the person's own provider key never gets a sandbox: it would bill their key with no cap", async () => {
    const { host } = setup({ ownKey: true });
    const browser = await host.browserIntegration(botId, undefined, undefined, "team", { opening: OPEN });
    expect(browser?.spec.env.AGENT_BROWSER_CDP).toBeUndefined();
    expect(fake.requests).toEqual([]);
    expect(host.cloudBrowserReport()).toMatchObject({ fallbacks: { "own-key": 1 } });
  });

  it("a closing call never opens the sandbox", async () => {
    const { host } = setup();
    await host.browserIntegration(botId, undefined, undefined, "team", { opening: "agent_browser_close" });
    expect(fake.requests).toEqual([]);
  });

  it("a call the sandbox's guards refuse never wakes it: it is refused, and nothing opens", async () => {
    const { host } = setup();
    for (const url of ["http://127.0.0.1:9222/json/list", "file:///home/user/.omb-browser/"]) {
      const call = { name: OPEN, arguments: { url } };
      const browser = (await host.browserIntegration(botId, undefined, undefined, "team", { opening: OPEN, params: call }))!;
      expect(browser.spec.env.AGENT_BROWSER_CDP, url).toBeUndefined();
      const answer = await host.browserRuntime.agentRpc(browser.session, browser.spec, "tools/call", call) as { isError?: boolean; content: Array<{ text: string }> };
      expect(answer.isError, url).toBe(true);
      expect([PRIVATE_ADDRESS_REFUSAL, LOCAL_SCHEME_REFUSAL]).toContain(answer.content[0]!.text);
    }
    expect(fake.requests, "no relay call: nothing woken").toEqual([]);
    expect(BrowserRuntime.prototype.agentRpc, "nothing reached the engine").not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "tools/call", expect.anything(), expect.anything());
    // A public site opens the sandbox as before.
    const browser = (await host.browserIntegration(botId, undefined, undefined, "team", { opening: OPEN, params: { name: OPEN, arguments: { url: "https://93.184.215.14/" } } }))!;
    expect(browser.spec.env.AGENT_BROWSER_CDP).toMatch(/^ws:\/\/127\.0\.0\.1:/);
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

/** A stand-in for agent-browser's MCP server: one process per engine client, as the runtime starts it. It lists the same tools
 * wherever the browser runs, and says in each answer where its browser is (attached to the sandbox, or the home's own). */
const FAKE_ENGINE = `#!/usr/bin/env node
const lines = require("node:readline").createInterface({ input: process.stdin });
const where = process.env.AGENT_BROWSER_CDP ? "sandbox" : "home";
lines.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result;
  if (m.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} } };
  else if (m.method === "tools/list") result = { tools: [{ name: "agent_browser_get_url", inputSchema: { type: "object" } }, { name: "agent_browser_open", inputSchema: { type: "object" } }] };
  else if (m.params.name === "agent_browser_fail") result = { isError: true, content: [{ type: "text", text: "Target closed" }] };
  else result = { content: [{ type: "text", text: where + ":" + m.params.name }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});
`;

describe.skipIf(process.platform === "win32")("a turn's first browser call after its tools/list, in a fresh process", () => {
  let engineDir: string;
  beforeEach(() => {
    vi.mocked(BrowserRuntime.prototype.agentRpc).mockRestore();
    engineDir = mkdtempSync(join(tmpdir(), "fake-engine-"));
    const binary = join(engineDir, "agent-browser");
    writeFileSync(binary, FAKE_ENGINE);
    chmodSync(binary, 0o755);
    vi.mocked(browserEngineStatus).mockReturnValue({ kind: "ready", binaryPath: binary, version: "0.37.0", managed: false });
  });
  afterEach(() => { rmSync(engineDir, { recursive: true, force: true }); });

  it("opens the sandbox on the first call, under the same tools as the list, and goes back to the home's browser after the sandbox's closed", async () => {
    const { host } = setup();
    // The turn starts, and its browser MCP server lists the tools: no tool call yet, so nothing opens anywhere.
    const atStart = (await host.browserIntegration(botId, undefined, turn))!;
    const listed = await host.browserRuntime.agentRpc(atStart.session, atStart.spec, "tools/list", {});
    expect(atStart.spec.env.AGENT_BROWSER_CDP).toBeUndefined();
    // The first tool call opens the sandbox; it must reach the engine, not be refused for the changed launch settings.
    const first = (await host.browserIntegration(botId, undefined, undefined, "team", { opening: "agent_browser_get_url" }))!;
    expect(first.spec.env.AGENT_BROWSER_CDP).toBeDefined();
    const answer = await host.browserRuntime.agentRpc(first.session, first.spec, "tools/call", { name: "agent_browser_get_url", arguments: {} });
    expect(answer).not.toHaveProperty("isError", true);
    expect(JSON.stringify(answer)).toContain("sandbox:agent_browser_get_url");
    // The tool list is the same in the sandbox as in the home.
    expect(await host.browserRuntime.agentRpc(first.session, first.spec, "tools/list", {})).toEqual(listed);
    // Back in the home (the operator's lever, or the sandbox unavailable): the next call is not refused either.
    vi.stubEnv("OMB_CLOUD_BROWSER", "home");
    // The sandbox's session ends (here with every door at once); the engine client started for it is left behind.
    host.browserSweep.closeAll();
    const back = (await host.browserIntegration(botId, undefined, undefined, "team", { opening: "agent_browser_get_url" }))!;
    expect(back.spec.env.AGENT_BROWSER_CDP).toBeUndefined();
    const again = await host.browserRuntime.agentRpc(back.session, back.spec, "tools/call", { name: "agent_browser_get_url", arguments: {} });
    expect(JSON.stringify(again)).toContain("home:agent_browser_get_url");
  });
});

describe.skipIf(process.platform === "win32")("what keeps a session on the browser sandbox open, on the host's real rules", () => {
  let engineDir: string;
  beforeEach(() => {
    vi.mocked(BrowserRuntime.prototype.agentRpc).mockRestore();
    engineDir = mkdtempSync(join(tmpdir(), "fake-engine-"));
    const binary = join(engineDir, "agent-browser");
    writeFileSync(binary, FAKE_ENGINE);
    chmodSync(binary, 0o755);
    vi.mocked(browserEngineStatus).mockReturnValue({ kind: "ready", binaryPath: binary, version: "0.37.0", managed: false });
  });
  afterEach(() => { vi.useRealTimers(); rmSync(engineDir, { recursive: true, force: true }); });

  it("a turn that made one call and goes on for hours does not keep the sandbox awake: 3 minutes after its last call the session closes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // The turn holds the browser for its whole life once it made a call, as the real route claims it.
    const { host } = setup({ turnHolds: true });
    const browser = (await host.browserIntegration(botId, undefined, undefined, "team", { opening: "agent_browser_get_url" }))!;
    await host.browserRuntime.agentRpc(browser.session, browser.spec, "tools/call", { name: "agent_browser_get_url", arguments: {} });
    expect(host.cloudBrowserBusy("browser")).toBe(true);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await host.cloudBrowserSweep();
    expect(host.cloudBrowserBusy("browser"), "2 minutes after the call").toBe(true);
    vi.setSystemTime(Date.now() + 60_000 + 1);
    await host.cloudBrowserSweep();
    expect(host.cloudBrowserBusy("browser"), "3 minutes after the call, the turn's hold notwithstanding").toBe(false);
  });

  it("a failed call on a sandbox that stopped under the session ends it, so the next call opens again", async () => {
    const { host } = setup();
    const browser = (await host.browserIntegration(botId, undefined, undefined, "team", { opening: "agent_browser_get_url" }))!;
    await host.browserRuntime.agentRpc(browser.session, browser.spec, "tools/call", { name: "agent_browser_get_url", arguments: {} });
    fake.state = "archived";
    const failed = await host.browserRuntime.agentRpc(browser.session, browser.spec, "tools/call", { name: "agent_browser_fail", arguments: {} });
    expect(failed).toHaveProperty("isError", true);
    expect(host.cloudBrowserBusy("browser")).toBe(false);
    const next = (await host.browserIntegration(botId, undefined, undefined, "team", { opening: "agent_browser_get_url" }))!;
    expect(JSON.stringify(await host.browserRuntime.agentRpc(next.session, next.spec, "tools/call", { name: "agent_browser_get_url", arguments: {} }))).toContain("sandbox:");
    expect(fake.resumes()).toBe(1);
  });
});
