import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BUILT_IN_BROWSER_SYSTEM_PROMPT, browserEngineStatus, clearBrowserSessionState, closeBrowserSession, runningBrowserSessionNames } from "../browser-engine.ts";
import { CHROME_BROWSER_SYSTEM_PROMPT } from "../browser/prompt.ts";
import { TOOL_LIST } from "../browser/tools.ts";
import { browserEgress } from "../browser/egress/registry.ts";
import { REDDIT_REFUSAL } from "../browser/egress/reddit.ts";
import type { Audience } from "../audience.ts";
import { DATA_DIR, type AppConfig } from "../config.ts";
import type { Store } from "../store.ts";
import { TurnResources, type TurnOwner } from "../turn-resources.ts";
import { BrowserRuntime } from "../browser-runtime.ts";
import { LentChromeDoors, type ChromeLender } from "../browser/lent-chrome.ts";
import { audienceBrowserSuffix } from "../browser/audience.ts";
import { chromeLauncher } from "../browser/chrome/launcher.ts";
import type { CdpSession, Params } from "../browser/cdp/connection.ts";
import { FileChoosers } from "../browser/cdp/files.ts";
import { uploadableFiles } from "../browser-upload.ts";
import { createBrowserHost, type BrowserHostDeps } from "./browser.ts";

vi.mock("../browser-engine.ts", async (original) => {
  const actual = await original<typeof import("../browser-engine.ts")>();
  return {
    ...actual,
    browserEngineStatus: vi.fn(actual.browserEngineStatus),
    clearBrowserSessionState: vi.fn(async () => true),
    closeBrowserSession: vi.fn(async () => true),
    runningBrowserSessionNames: vi.fn(async () => []),
  };
});
vi.mock("../browser-processes.ts", async (original) => ({
  ...await original<typeof import("../browser-processes.ts")>(),
  orphanedBrowsers: vi.fn(async () => []),
}));

type Host = ReturnType<typeof createBrowserHost>;
const hosts: Host[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.browserRuntime.closeAll())); });

const turn = { threadId: "thread-1", generation: "gen-1" };

function setup(engine: "chrome" | "agent-browser" | undefined, { cloudHome = false, device, lendRefusal, holder, audienceOf, bots: botIds = ["scout"], browserBox, lentChrome, turnResources }: {
  cloudHome?: boolean; device?: BrowserHostDeps["device"]; lendRefusal?: BrowserHostDeps["lendRefusal"]; holder?: (resource: string) => TurnOwner | undefined;
  audienceOf?: BrowserHostDeps["audienceOf"]; bots?: string[]; browserBox?: BrowserHostDeps["browserBox"];
  lentChrome?: BrowserHostDeps["lentChrome"]; turnResources?: BrowserHostDeps["turnResources"];
} = {}) {
  const cfg = {
    features: { browser: true },
    ...(engine ? { browserEngine: { engine } } : {}),
    browserProfiles: [
      { id: "work", name: "Work", partitionId: "p-work" },
      { id: "mine", name: "Mine", browser: "chrome", partitionId: "p-mine" },
    ],
  } as unknown as AppConfig;
  const bots = botIds.map((id) => ({ id, name: id, browser: true }));
  const minted: unknown[] = [];
  const host = createBrowserHost({
    cfg,
    store: () => ({ bots, bot: (id: string) => bots.find((bot) => bot.id === id), botByThread: () => bots[0] }) as unknown as Pick<Store, "bots" | "bot" | "botByThread">,
    turnResources: turnResources ?? { free: () => true, holder: holder ?? (() => undefined), onClaim: () => () => {} },
    activeInternalGenerationByThread: new Map([[turn.threadId, turn.generation]]),
    mintInternalCapability: (capability) => { minted.push(capability); return "capability-token"; },
    DESKTOP_MANAGED: !cloudHome,
    CLOUD_HOME: cloudHome ? { machineId: "m-1" } : null,
    PORT: 4100,
    device,
    lendRefusal,
    audienceOf,
    browserBox,
    lentChrome,
  });
  hosts.push(host);
  return { cfg, host, minted, bots };
}

describe("the bots' browser host and the engine memory guard", () => {
  it("hands the guard the browsers each thread's turn starts or holds", () => {
    const told: unknown[] = [];
    const host = createBrowserHost({
      cfg: { features: { browser: true } } as unknown as AppConfig,
      store: () => ({ bots: [], bot: () => undefined, botByThread: () => undefined }) as unknown as Pick<Store, "bots" | "bot" | "botByThread">,
      turnResources: { free: () => true, holder: () => undefined, onClaim: () => () => {} },
      activeInternalGenerationByThread: new Map(),
      mintInternalCapability: () => "capability-token",
      DESKTOP_MANAGED: false,
      CLOUD_HOME: { machineId: "m-1" },
      PORT: 4100,
      engineMemory: { useBrowsers: (browsers) => { told.push(browsers); } },
    });
    hosts.push(host);
    expect(told).toEqual([host.engineBrowsers]);
  });
});

describe("the bots' browser host with browserEngine.engine set to chrome", () => {
  it("gives a bot's turn the browser MCP server over its own profile on the new engine", async () => {
    const { host, minted } = setup("chrome");
    const browser = await host.browserIntegration("scout", undefined, turn);
    expect(browser?.spec).toEqual({ command: "omb-cdp", args: ["bot:scout"], env: {} });
    expect(browser?.integration).toMatchObject({ command: process.execPath, env: { OMB_HARNESS_URL: "http://127.0.0.1:4100" } });
    expect(minted).toEqual([expect.objectContaining({ botId: "scout", browserSession: browser?.session, kind: "browser", ...turn })]);
    expect(host.usedBrowserSessions.get(browser!.session)).toEqual(browser?.spec);
  });

  it("puts a shared profile's bots on one profile and a temporary browser on its own", async () => {
    const { host } = setup("chrome");
    expect((await host.browserIntegration("scout", "work"))?.spec.args).toEqual(["shared:p-work"]);
    const guest = await host.browserIntegration("scout", "guest");
    expect(guest?.spec.args).toEqual([`temp:${guest?.session}`]);
  });

  it("lists the new browser's tools without starting Chrome", async () => {
    const { host } = setup("chrome");
    const browser = await host.browserIntegration("scout", undefined, turn);
    const listed = await host.browserRuntime.agentRpc(browser!.session, browser!.spec as never, "tools/list", {}) as { tools: Array<{ name: string }> };
    expect(listed.tools.map((tool) => tool.name)).toEqual(TOOL_LIST.map((tool) => tool.name));
  });

  it("keeps a profile on the person's own Chrome on agent-browser: its prompt, and no sites list from either", () => {
    const { host } = setup("chrome");
    expect(host.browserSystemPrompt(undefined)).toBe(CHROME_BROWSER_SYSTEM_PROMPT);
    expect(host.browserSystemPrompt("work")).toBe(CHROME_BROWSER_SYSTEM_PROMPT);
    expect(host.browserSystemPrompt("mine")).toBe(BUILT_IN_BROWSER_SYSTEM_PROMPT);
    expect(host.signedInSitesRefusal("mine")).toContain("your own Chrome");
    expect(host.signedInSitesRefusal("work")).toContain("does not list signed-in sites yet");
  });

  it("says in the status which engine runs the bots' browsers", () => {
    const { cfg, host } = setup("chrome");
    expect(host.engineSummary({ kind: "unavailable", reason: "agent-browser is not installed", myChrome: true })).toMatchObject({ engine: "chrome", myChrome: true });
    cfg.browserEngine = { engine: "agent-browser" };
    expect(host.engineSummary({ kind: "unavailable", reason: "agent-browser is not installed", myChrome: true })).toEqual({ kind: "unavailable", reason: "agent-browser is not installed", myChrome: true, engine: "agent-browser" });
  });

  it("forgets the new engine's sessions when the engine is switched back", async () => {
    const { cfg, host } = setup("chrome");
    const browser = await host.browserIntegration("scout", undefined, turn);
    cfg.browserEngine = { engine: "agent-browser" };
    host.browserEngineSwitched();
    expect(host.usedBrowserSessions.has(browser!.session)).toBe(false);
    expect(host.browserSystemPrompt(undefined)).toBe(BUILT_IN_BROWSER_SYSTEM_PROMPT);
  });
});

describe("what the memory guard sees of a bot's browser", () => {
  it("counts a browser a bot's turn may start, but not one it can't use or the person's own Chrome", () => {
    const { host, bots } = setup(undefined, { cloudHome: true });
    const bot = bots[0] as { browser: boolean; browserProfile?: string };
    expect(host.engineBrowsers.starts("thread-1")).toBe(true);
    bot.browser = false;
    expect(host.engineBrowsers.starts("thread-1")).toBe(false);
    const desktop = setup(undefined);
    (desktop.bots[0] as { browserProfile?: string }).browserProfile = "mine";
    expect(desktop.host.engineBrowsers.starts("thread-1")).toBe(false);
  });

  it("counts a temporary browser before its first call without making its session", () => {
    const { host, bots } = setup(undefined, { cloudHome: true });
    (bots[0] as { browserProfile?: string }).browserProfile = "guest";
    expect(host.engineBrowsers.starts("thread-1")).toBe(true);
    expect(host.temporaryBrowserSessions.size).toBe(0);
  });

  it("closes nothing for a stopped turn whose bot's browser is not running", async () => {
    const { host } = setup(undefined, { cloudHome: true });
    await host.browserIntegration("scout", undefined, turn);
    vi.mocked(closeBrowserSession).mockClear();
    host.engineBrowsers.stopped("thread-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closeBrowserSession).not.toHaveBeenCalled();
  });
});

describe("the person's lent computer's connection, for a bot's browser on My Cloud", () => {
  it("is offered only while the last turn to hold that browser may use the lent computer", () => {
    const configure = vi.spyOn(browserEgress, "configure");
    const holders = new Map<string, TurnOwner>();
    const upstream = { open: async () => ({ refused: "port" as const }) };
    setup(undefined, { cloudHome: true, device: () => upstream, lendRefusal: (turn) => (turn.threadId === "owner-thread" ? null : "someone-else"), holder: (resource) => holders.get(resource) });
    const device = configure.mock.lastCall![0].device!;
    configure.mockRestore();
    expect(device("bot-1"), "a browser no turn has held is the person's own").toBe(upstream);
    holders.set("browser:bot-1", { threadId: "guest-thread", generation: "g1" });
    expect(device("bot-1"), "held by a turn that may not use the lent computer").toBeNull();
    holders.delete("browser:bot-1");
    expect(device("bot-1"), "its pages stay off the computer after that turn ends").toBeNull();
    expect(device("bot-2"), "another browser keeps its own verdict").toBe(upstream);
    holders.set("browser:bot-1", { threadId: "owner-thread", generation: "g2" });
    expect(device("bot-1")).toBe(upstream);
    holders.delete("browser:bot-1");
    expect(device("bot-1"), "and on it after the person's own turn ends").toBe(upstream);
  });

  it("is never offered to a browser a turn holds when the host can't tell who may use the lent computer", () => {
    const configure = vi.spyOn(browserEgress, "configure");
    const upstream = { open: async () => ({ refused: "port" as const }) };
    setup(undefined, { cloudHome: true, device: () => upstream, holder: () => ({ threadId: "t", generation: "g" }) });
    const device = configure.mock.lastCall![0].device!;
    configure.mockRestore();
    expect(device("bot-1")).toBeNull();
  });
});

describe("My Chrome on My Cloud, through the person's lent Chrome", () => {
  const lender: ChromeLender = { name: "Mac", device: "Mac", online: true };
  const DOOR = /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f]{64}$/;
  const OWNER = turn;
  const GUEST = { threadId: "guest-thread", generation: "gen-b" };
  const SNAPSHOT = { name: "agent_browser_snapshot", arguments: {} };
  const SOMEONE_ELSE = "Someone else wrote in this conversation, so it can't use your Chrome.";
  type Answer = { isError?: boolean; content: Array<{ type: string; text: string }> };
  afterEach(async () => {
    await Promise.all(hosts.map((host) => host.browserSweep.closeAll()));
    vi.restoreAllMocks();
    vi.mocked(browserEngineStatus).mockReset();
  });

  /**
   * A personal Cloud home whose bot "scout" uses the My Chrome profile "mine"; `lend` changes which computer lends Chrome.
   * agent-browser is a stub that runs beforeDispatch, as the real one does, and then `engine`: what reaches the daemon.
   */
  function onMyCloud(found: ChromeLender | null, lendRefusal: BrowserHostDeps["lendRefusal"] = (holder) => (holder.threadId === GUEST.threadId ? "someone-else" : null)) {
    vi.mocked(browserEngineStatus).mockReturnValue({ kind: "ready", binaryPath: "/usr/local/bin/agent-browser", version: "0.37.0", managed: false });
    const engine = vi.fn(async (): Promise<unknown> => ({ content: [{ type: "text", text: "page" }] }));
    vi.spyOn(BrowserRuntime.prototype, "agentRpc").mockImplementation(async (_session, _spec, _method, _params, beforeDispatch) => {
      beforeDispatch?.();
      return engine();
    });
    let current = found;
    const resources = new TurnResources();
    const route = vi.fn(() => null);
    const made = setup(undefined, { cloudHome: true, lendRefusal, turnResources: resources, lentChrome: { route, lender: () => current } });
    made.cfg.browserProfiles = [{ id: "mine", name: "Mine", browser: "chrome" }] as AppConfig["browserProfiles"];
    (made.bots[0] as { browserProfile?: string }).browserProfile = "mine";
    /** A tool call as the browser route makes it: beforeDispatch claims the browser for the calling turn. */
    const call = async (browser: { session: string; spec: { command: string; env: Record<string, string> } }, caller: TurnOwner, params: unknown = SNAPSHOT) =>
      (await made.host.browserRuntime.agentRpc(browser.session, browser.spec as never, "tools/call", params, () => {
        if (!resources.claim(`browser:${browser.session}`, caller)) throw new Error("another thread is using this browser");
      })) as Answer;
    return { ...made, resources, route, engine, call, lend: (next: ChromeLender | null) => { current = next; } };
  }
  /** What the door answers a client that has its token. */
  async function knock(url: string): Promise<string> {
    const { port, pathname } = new URL(url);
    const socket = connect(Number(port), "127.0.0.1");
    socket.write(`GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    let answer = "";
    for await (const chunk of socket) answer += String(chunk);
    return answer.split("\r\n")[0]!;
  }

  it("on My Cloud a My Chrome profile attaches through the lent computer's door", async () => {
    const egress = vi.spyOn(browserEgress, "open");
    const { host, lend } = onMyCloud(lender);
    expect(host.myChromeAvailable()).toBe(true);
    const browser = await host.browserIntegration("scout", "mine", turn);
    expect(browser?.spec.env.AGENT_BROWSER_CDP).toMatch(DOOR);
    expect(browser?.spec.env).not.toHaveProperty("AGENT_BROWSER_AUTO_CONNECT");
    host.usedBrowserSessions.clear();
    expect((await host.currentBrowserSpec("scout", "mine"))?.spec.env.AGENT_BROWSER_CDP, "the live view's spec names the same door").toBe(browser?.spec.env.AGENT_BROWSER_CDP);
    expect(egress, "the person's Chrome is outside the egress gate").not.toHaveBeenCalled();
    lend(null);
    expect(host.myChromeAvailable()).toBe(false);
  });

  it("a conversation that may not lend loses the Chrome connection and is told why", async () => {
    const drop = vi.spyOn(LentChromeDoors.prototype, "drop");
    const { host, resources, route, engine, call } = onMyCloud(lender);
    const browser = (await host.browserIntegration("scout", "mine", turn))!;
    expect(resources.claim(`browser:${browser.session}`, OWNER)).toBe(true);
    expect(drop, "the person's own turn keeps the connection").not.toHaveBeenCalled();
    resources.release(OWNER);
    expect(resources.claim(`browser:${browser.session}`, GUEST)).toBe(true);
    expect(drop).toHaveBeenCalledWith(browser.session);
    expect(await call(browser, GUEST)).toEqual({ isError: true, content: [{ type: "text", text: expect.stringContaining(SOMEONE_ELSE) }] });
    expect(await knock(browser.spec.env.AGENT_BROWSER_CDP!), "agent-browser's reconnect is refused too").toBe("HTTP/1.1 403 Forbidden");
    expect(route).not.toHaveBeenCalled();
    expect(engine).not.toHaveBeenCalled();
  });

  it("a guest's first call is refused before it reaches the engine", async () => {
    const drop = vi.spyOn(LentChromeDoors.prototype, "drop");
    const { host, engine, call } = onMyCloud(lender);
    const browser = (await host.browserIntegration("scout", "mine", turn))!;
    expect(await call(browser, GUEST)).toEqual({ isError: true, content: [{ type: "text", text: expect.stringContaining(SOMEONE_ELSE) }] });
    expect(drop, "its claim dropped any connection the person's turn left open").toHaveBeenCalledWith(browser.session);
    expect(engine).not.toHaveBeenCalled();
  });

  it("a conversation refused over a memory change is pointed to Memory, not to a new conversation", async () => {
    const { host, engine, call } = onMyCloud(lender, (holder) => (holder.threadId === GUEST.threadId ? "memory-changed" : null));
    const browser = (await host.browserIntegration("scout", "mine", turn))!;
    const answer = await call(browser, GUEST);
    expect(answer).toEqual({ isError: true, content: [{ type: "text", text: "This bot's memory was changed in a conversation you didn't write. Review it in Memory to use your Chrome again." }] });
    expect(answer.content[0]!.text).not.toContain(SOMEONE_ELSE);
    expect(engine).not.toHaveBeenCalled();
  });

  it("the owner's call after a guest's turn reaches the engine", async () => {
    const { host, resources, route, engine, call } = onMyCloud(lender);
    const browser = (await host.browserIntegration("scout", "mine", turn))!;
    expect((await call(browser, GUEST)).isError).toBe(true);
    resources.release(GUEST);
    expect(await call(browser, OWNER)).toEqual({ content: [{ type: "text", text: "page" }] });
    expect(engine).toHaveBeenCalledOnce();
    expect(await knock(browser.spec.env.AGENT_BROWSER_CDP!), "agent-browser's reconnect is let through to the route").toBe("HTTP/1.1 503 Service Unavailable");
    expect(route).toHaveBeenCalledOnce();
  });

  it("an offline or missing lender is explained to the owner before the call reaches the engine", async () => {
    const { host, lend, call, engine } = onMyCloud({ ...lender, online: false });
    const browser = (await host.browserIntegration("scout", "mine", turn))!;
    expect(await call(browser, OWNER)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("is lent but offline") }] });
    lend(null);
    expect(await call(browser, OWNER)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("lends its Chrome by itself") }] });
    expect(engine).not.toHaveBeenCalled();
  });

  it("a guest learns nothing about the owner's computer: offline or not lending, it hears only the someone-else sentence", async () => {
    const { host, lend, call, engine } = onMyCloud({ ...lender, online: false });
    const browser = (await host.browserIntegration("scout", "mine", turn))!;
    expect(await call(browser, GUEST)).toEqual({ isError: true, content: [{ type: "text", text: expect.stringContaining(SOMEONE_ELSE) }] });
    lend(null);
    expect(await call(browser, GUEST)).toEqual({ isError: true, content: [{ type: "text", text: expect.stringContaining(SOMEONE_ELSE) }] });
    expect(engine).not.toHaveBeenCalled();
  });

  it("with no computer lending Chrome, a My Chrome profile still uses the door and never the built-in browser", async () => {
    const egress = vi.spyOn(browserEgress, "open");
    const { cfg, host, call, engine } = onMyCloud(null);
    expect(host.myChromeAvailable(), "the dialog's own answer").toBe(false);
    const browser = (await host.browserIntegration("scout", "mine", turn))!;
    expect(browser.spec.env.AGENT_BROWSER_CDP).toMatch(DOOR);
    host.usedBrowserSessions.clear();
    expect((await host.currentBrowserSpec("scout", "mine"))?.spec.env.AGENT_BROWSER_CDP).toBe(browser.spec.env.AGENT_BROWSER_CDP);
    cfg.browserEngine = { engine: "chrome" };
    expect((await host.browserIntegration("scout", "mine", turn))?.spec.env.AGENT_BROWSER_CDP, "nor the new engine's").toBe(browser.spec.env.AGENT_BROWSER_CDP);
    expect(egress).not.toHaveBeenCalled();
    expect(await call(browser, OWNER)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("lends its Chrome by itself") }] });
    expect(engine).not.toHaveBeenCalled();
  });

  it("a call that failed at the lent computer says why after agent-browser's own error", async () => {
    const cdpError = { isError: true, content: [{ type: "text", text: "CDP WebSocket connect failed: 503" }] };
    const { host, engine, call } = onMyCloud(lender);
    engine.mockResolvedValue(cdpError);
    const browser = (await host.browserIntegration("scout", "mine", turn))!;
    expect(await call(browser, OWNER), "nothing is known yet").toEqual(cdpError);
    expect(await knock(browser.spec.env.AGENT_BROWSER_CDP!), "the link is gone though the computer was online").toBe("HTTP/1.1 503 Service Unavailable");
    const answer = await call(browser, OWNER);
    expect(answer.content).toHaveLength(2);
    expect(answer.content[0]).toEqual(cdpError.content[0]);
    expect(answer.content[1]!.text).toContain("Mac is lent but offline");
  });

  it("a door refused while a guest held the browser tells the owner nothing about someone else", async () => {
    const cdpError = { isError: true, content: [{ type: "text", text: "CDP WebSocket connect failed: 403" }] };
    const { host, resources, engine, call } = onMyCloud(lender);
    engine.mockResolvedValue(cdpError);
    const browser = (await host.browserIntegration("scout", "mine", turn))!;
    expect((await call(browser, GUEST)).isError).toBe(true);
    expect(await knock(browser.spec.env.AGENT_BROWSER_CDP!), "agent-browser reconnecting while the guest holds it").toBe("HTTP/1.1 403 Forbidden");
    resources.release(GUEST);
    expect(await call(browser, OWNER)).toEqual(cdpError);
  });

  it("a profile switched back to the built-in browser keeps its session but none of the lent Chrome's answers", async () => {
    const { cfg, host, engine, call } = onMyCloud(null);
    const browser = (await host.browserIntegration("scout", "mine", turn))!;
    expect(await knock(browser.spec.env.AGENT_BROWSER_CDP!), "the door has a problem to tell").toBe("HTTP/1.1 503 Service Unavailable");
    cfg.browserProfiles = [{ id: "mine", name: "Mine" }] as AppConfig["browserProfiles"];
    expect(host.currentBrowserSession("scout", "mine")).toBe(browser.session);
    const builtIn = { session: browser.session, spec: host.browserSessionSpec("/usr/local/bin/agent-browser", browser.session, "mine") };
    expect(builtIn.spec.env).not.toHaveProperty("AGENT_BROWSER_CDP");
    const failed = { isError: true, content: [{ type: "text", text: "Element not found" }] };
    engine.mockResolvedValue(failed);
    expect(await call(builtIn, GUEST), "neither the someone-else nor the not-lent answer, and no guidance after").toEqual(failed);
    expect(await call(builtIn, GUEST, { name: "agent_browser_open", arguments: { url: "https://www.reddit.com/" } }), "the Cloud's egress rule still applies").toEqual({ isError: true, content: [{ type: "text", text: REDDIT_REFUSAL }] });
    expect(engine).toHaveBeenCalledOnce();
  });

  describe("a browser left running before this server opened the session's door, as after a restart", () => {
    const folders: string[] = [];
    afterEach(() => {
      vi.unstubAllEnvs();
      for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
    });
    function leftover(session: string | null) {
      const folder = mkdtempSync(join(tmpdir(), "omb-host-leftover-"));
      folders.push(folder);
      mkdirSync(join(folder, "agent-browser"));
      if (session) writeFileSync(join(folder, "agent-browser", `${session}.pid`), "0");
      vi.stubEnv("XDG_RUNTIME_DIR", folder);
    }

    it("is closed once, and no call gets the new door until it is", async () => {
      const { host } = onMyCloud(lender);
      const session = host.currentBrowserSession("scout", "mine");
      leftover(session);
      let finish = (_closed: boolean) => {};
      vi.mocked(closeBrowserSession).mockClear().mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
      let settled = false;
      const both = Promise.all([host.browserIntegration("scout", "mine", turn), host.browserIntegration("scout", "mine", turn)]).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled, "both callers wait for the close").toBe(false);
      finish(true);
      const [first, second] = await both;
      expect(first?.spec.env.AGENT_BROWSER_CDP).toMatch(DOOR);
      expect(second?.spec.env.AGENT_BROWSER_CDP).toBe(first?.spec.env.AGENT_BROWSER_CDP);
      expect(vi.mocked(closeBrowserSession).mock.calls.map(([, env]) => env.AGENT_BROWSER_SESSION)).toEqual([session]);
      await host.browserIntegration("scout", "mine", turn);
      expect(closeBrowserSession, "the door this server opened is not closed again").toHaveBeenCalledOnce();
    });

    it("closes nothing when no browser was running", async () => {
      const { host } = onMyCloud(lender);
      leftover(null);
      vi.mocked(closeBrowserSession).mockClear();
      expect((await host.browserIntegration("scout", "mine", turn))?.spec.env.AGENT_BROWSER_CDP).toMatch(DOOR);
      expect(closeBrowserSession).not.toHaveBeenCalled();
    });
  });

  it("the summary says which computer lends Chrome, or that one can", () => {
    const { cfg, host, lend } = onMyCloud(lender);
    expect(host.lentChromeSummary()).toEqual({ myChromeOn: lender });
    cfg.browserEngine = { engine: "chrome" };
    expect(host.engineSummary({ kind: "engine", version: "0.37.0", myChrome: true }), "My Chrome stays on agent-browser").toMatchObject({ engine: "chrome", myChromeOn: lender });
    lend(null);
    expect(host.lentChromeSummary()).toEqual({ myChromeLendable: true });
    expect(setup(undefined).host.lentChromeSummary(), "the desktop host").toEqual({});
  });
});

describe("how long an unused browser stays open", () => {
  it("is three minutes on a Cloud home and ten on a desktop, unless config.json sets it", () => {
    const cloud = setup(undefined, { cloudHome: true });
    expect(cloud.host.browserIdleMs()).toBe(3 * 60_000);
    cloud.cfg.browserEngine = { idleTimeoutMinutes: 20 };
    expect(cloud.host.browserIdleMs()).toBe(20 * 60_000);
    expect(setup(undefined).host.browserIdleMs()).toBe(10 * 60_000);
  });
});

describe("the bots' browser host by default", () => {
  it("keeps agent-browser's prompt and status", () => {
    const { host } = setup(undefined);
    expect(host.browserSystemPrompt(undefined)).toBe(BUILT_IN_BROWSER_SYSTEM_PROMPT);
    expect(host.signedInSitesRefusal("work")).toBeNull();
    expect(host.engineSummary({ kind: "engine", version: "0.37.0", myChrome: true })).toEqual({ kind: "engine", version: "0.37.0", myChrome: true, engine: "agent-browser" });
  });
});

describe("a deleted bot's browser", () => {
  const PATH_ENGINE = "/usr/local/bin/agent-browser";
  const MANAGED_ENGINE = "/data/.openmausbot/tools/agent-browser";
  const folders: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });
  /** agent-browser on PATH, as the Cloud image installs it; with `managed`, also the one OpenMausBot installed. */
  function engines({ managed = false }: { managed?: boolean } = {}) {
    vi.mocked(browserEngineStatus).mockImplementation((options) => (options?.managedOnly && !managed
      ? { kind: "unavailable", reason: "not installed", installable: true }
      : { kind: "ready", binaryPath: options?.managedOnly ? MANAGED_ENGINE : PATH_ENGINE, version: "0.37.0", managed: options?.managedOnly === true }));
    vi.mocked(clearBrowserSessionState).mockClear().mockResolvedValue(true);
    vi.mocked(closeBrowserSession).mockClear().mockResolvedValue(true);
  }
  function daemons(sessions: string[]) {
    const folder = mkdtempSync(join(tmpdir(), "omb-host-sweep-"));
    folders.push(folder);
    mkdirSync(join(folder, "agent-browser"));
    for (const session of sessions) writeFileSync(join(folder, "agent-browser", `${session}.pid`), "0");
    vi.stubEnv("XDG_RUNTIME_DIR", folder);
    vi.mocked(runningBrowserSessionNames).mockResolvedValue(sessions);
  }
  const deleted = { type: "openmausbot:browser-bot-deleted" as const, requestId: "00000000-0000-4000-8000-000000000000", botId: "gone" };
  const closed = () => vi.mocked(closeBrowserSession).mock.calls.map(([binary, env]) => `${binary} ${env.AGENT_BROWSER_SESSION}`);

  it("on a Cloud home, is closed and its sign-ins erased with the image's agent-browser", async () => {
    engines();
    const { host } = setup(undefined, { cloudHome: true });
    expect(await host.eraseDeletedBrowser(deleted)).toBe(true);
    expect(vi.mocked(clearBrowserSessionState).mock.calls.map(([binary, session]) => `${binary} ${session}`)).toEqual([`${PATH_ENGINE} bot-gone`]);
    vi.mocked(clearBrowserSessionState).mockResolvedValue(false);
    expect(await host.eraseDeletedBrowser(deleted)).toBe(false);
  });

  it("elsewhere, is erased only with the agent-browser OpenMausBot installed, and otherwise just closed", async () => {
    engines();
    const { host } = setup(undefined);
    expect(await host.eraseDeletedBrowser(deleted)).toBe(true);
    expect(clearBrowserSessionState).not.toHaveBeenCalled();
    expect(closed()).toEqual([`${PATH_ENGINE} bot-gone`]);
    engines({ managed: true });
    expect(await host.eraseDeletedBrowser(deleted)).toBe(true);
    expect(vi.mocked(clearBrowserSessionState).mock.calls.map(([binary, session]) => `${binary} ${session}`)).toEqual([`${MANAGED_ENGINE} bot-gone`]);
  });

  it("on a Cloud home, is closed by the minute's sweep even after this run used it, and nobody else's browser is", async () => {
    engines();
    daemons(["bot-gone", "default", "work-own"]);
    const { host } = setup(undefined, { cloudHome: true });
    host.usedBrowserSessions.set("bot-gone", { command: PATH_ENGINE, env: {} });
    host.browserSweep.start();
    await vi.waitFor(() => expect(closed()).toContain(`${PATH_ENGINE} bot-gone`));
    expect(closed()).toEqual([`${PATH_ENGINE} bot-gone`]);
    await host.browserSweep.closeAll();
  });

  it("on a Team Cloud, is erased for every audience it had: each member's, each group chat's and the team's", async () => {
    engines();
    forgetAudiences();
    const { host } = setup(undefined, { cloudHome: true, audienceOf: teamAudiences });
    host.currentBrowserSession("gone", undefined, "member:p_ada");
    host.currentBrowserSession("gone", undefined, "room:launch");
    expect(await host.eraseDeletedBrowser(deleted)).toBe(true);
    expect(vi.mocked(clearBrowserSessionState).mock.calls.map(([, session]) => session)).toEqual(["bot-gone", `bot-gone${ADA}`, `bot-gone${ROOM}`]);
    vi.mocked(clearBrowserSessionState).mockClear();
    // After a restart too: which audiences had browsers is kept on disk.
    const again = setup(undefined, { cloudHome: true, audienceOf: teamAudiences });
    expect(await again.host.eraseDeletedBrowser({ ...deleted, type: "openmausbot:browser-profile-deleted", botId: undefined, partitionId: "p-work" })).toBe(true);
    expect(vi.mocked(clearBrowserSessionState).mock.calls.map(([, session]) => session)).toEqual(["p-work", `p-work${ADA}`, `p-work${ROOM}`]);
  });

  it("on a Team Cloud, keeps each member's browser of a live bot open between turns, and closes a deleted bot's", async () => {
    engines();
    forgetAudiences();
    daemons([`bot-scout${ADA}`, `bot-gone${ADA}`]);
    const { host } = setup(undefined, { cloudHome: true, audienceOf: teamAudiences });
    host.currentBrowserSession("scout", undefined, "member:p_ada");
    for (const session of [`bot-scout${ADA}`, `bot-gone${ADA}`]) host.usedBrowserSessions.set(session, { command: PATH_ENGINE, env: {} });
    host.browserSweep.start();
    await vi.waitFor(() => expect(closed()).toContain(`${PATH_ENGINE} bot-gone${ADA}`));
    expect(closed()).toEqual([`${PATH_ENGINE} bot-gone${ADA}`]);
    await host.browserSweep.closeAll();
  });

  afterEach(() => forgetAudiences());

  it("off a Cloud home, is left to the deletion, as anything else under the same HOME", async () => {
    engines();
    daemons(["bot-gone", "default"]);
    const { host } = setup(undefined);
    host.browserSweep.start();
    await vi.waitFor(() => expect(runningBrowserSessionNames).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed()).toEqual([]);
    await host.browserSweep.closeAll();
  });
});

const teamAudiences = (threadId: string): Audience => ({ "ada-chat": "member:p_ada", "cleo-chat": "member:p_cleo", "room-chat": "room:launch" } as Record<string, Audience>)[threadId] ?? "team";
const at = (threadId: string) => ({ threadId, generation: "gen-1" });
const AUDIENCES_FILE = join(DATA_DIR, "browser", "audiences.json");
const ADA = audienceBrowserSuffix("member:p_ada"), CLEO = audienceBrowserSuffix("member:p_cleo"), ROOM = audienceBrowserSuffix("room:launch");
function forgetAudiences() { rmSync(AUDIENCES_FILE, { force: true }); }

describe("a Team Cloud's browsers, one per audience", () => {
  afterEach(forgetAudiences);

  it("gives each member's private chat, a group chat and the team's chat a profile of its own", async () => {
    const { host, minted } = setup("chrome", { audienceOf: teamAudiences });
    const browsers = await Promise.all(["ada-chat", "cleo-chat", "room-chat", "main-chat"].map((thread) => host.browserIntegration("scout", undefined, at(thread))));
    expect(browsers.map((browser) => browser?.spec.args), "one profile per audience; the team's keeps the bot's own").toEqual([
      [`bot:scout${ADA}`], [`bot:scout${CLEO}`], [`bot:scout${ROOM}`], ["bot:scout"],
    ]);
    expect(browsers.map((browser) => browser?.session)).toEqual([`bot-scout${ADA}`, `bot-scout${CLEO}`, `bot-scout${ROOM}`, "bot-scout"]);
    expect(minted.map((capability) => (capability as { browserSession: string }).browserSession), "each turn's tools reach its own audience's browser").toEqual(browsers.map((browser) => browser?.session));
    // The live view and the agent name the same browser.
    expect(host.currentBrowserSession("scout", undefined, "member:p_ada")).toBe(browsers[0]!.session);
    expect(host.browserSessionsOf("scout", undefined).sort()).toEqual(browsers.map((browser) => browser!.session).sort());
  });

  it("splits a shared profile and a temporary browser by audience too", async () => {
    const { host } = setup("chrome", { audienceOf: teamAudiences });
    expect((await host.browserIntegration("scout", "work", at("ada-chat")))?.spec.args).toEqual([`shared:p-work${ADA}`]);
    expect((await host.browserIntegration("scout", "work", at("room-chat")))?.spec.args).toEqual([`shared:p-work${ROOM}`]);
    expect((await host.browserIntegration("scout", "work", at("main-chat")))?.spec.args).toEqual(["shared:p-work"]);
    const ada = await host.browserIntegration("scout", "guest", at("ada-chat"));
    const cleo = await host.browserIntegration("scout", "guest", at("cleo-chat"));
    expect(ada?.session).not.toBe(cleo?.session);
    expect(await host.browserIntegration("scout", "guest", at("ada-chat"))).toMatchObject({ session: ada?.session });
    await host.forgetTemporaryBrowser("scout");
    expect(host.temporaryBrowserSessions.size, "a deleted bot's temporary browsers go for every audience").toBe(0);
  });

  it("names a shared profile's saved sign-ins by audience on agent-browser too", () => {
    const { host } = setup(undefined, { audienceOf: teamAudiences });
    expect(host.currentBrowserSession("scout", "work", "member:p_ada")).toBe(`p-work${ADA}`);
    expect(host.currentBrowserSession("scout", "work", "room:launch")).toBe(`p-work${ROOM}`);
    expect(host.currentBrowserSession("scout", "work", "team")).toBe("p-work");
    expect(host.currentBrowserSession("scout", undefined, "member:p_ada")).toBe(`bot-scout${ADA}`);
  });

  it("names every browser as before off a team, whoever's conversation it is", async () => {
    const { host } = setup("chrome");
    const browser = await host.browserIntegration("scout", undefined, at("ada-chat"));
    expect(browser?.spec.args).toEqual(["bot:scout"]);
    expect(browser?.session).toBe("bot-scout");
    expect((await host.browserIntegration("scout", "work", at("ada-chat")))?.spec.args).toEqual(["shared:p-work"]);
    expect(host.browserSessionsOf("scout", undefined)).toEqual(["bot-scout"]);
    expect(existsSync(AUDIENCES_FILE), "nothing is written off a team").toBe(false);
  });

  it("remembers on disk which audiences have a browser", async () => {
    const { host } = setup("chrome", { audienceOf: teamAudiences });
    await host.browserIntegration("scout", undefined, at("ada-chat"));
    expect(JSON.parse(readFileSync(AUDIENCES_FILE, "utf8"))).toEqual({ suffixes: [ADA] });
  });
});

describe("a Team Cloud's boxed browsers and the files a turn uploads", () => {
  afterEach(() => chromeLauncher.boxWith(() => null));

  it.each([null, "report.txt", "Report.txt"])("gives Chrome on Windows a private copy of a workspace file (name: %s)", async (name) => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), "omb-host-upload-windows-")));
    try {
      const file = join(work, "report.txt");
      writeFileSync(file, "report");
      const { host } = setup("chrome");
      vi.stubGlobal("process", { ...process, platform: "win32" });
      const [staged] = await host.uploadPaths([{ file, name }], "bot-scout", { command: "omb-cdp", args: ["bot:scout"], env: {} });
      vi.unstubAllGlobals();
      expect(staged!.startsWith(join(DATA_DIR, "browser-uploads"))).toBe(true);
      expect(readFileSync(staged!, "utf8")).toBe("report");
    } finally {
      vi.unstubAllGlobals();
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32").each([false, true])("keeps workspace bytes through a symlink swap while Chrome waits for a picker (boxed: %s)", async (boxed) => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), "omb-host-upload-")));
    try {
      const secret = join(work, "secret.txt");
      const workspace = join(work, "workspace");
      mkdirSync(workspace);
      const source = join(workspace, "report.txt");
      writeFileSync(source, "report");
      writeFileSync(secret, "outside secret");
      const checked = uploadableFiles([source], [workspace]);
      if ("error" in checked) throw new Error(checked.error);
      const box = { bwrap: "/usr/bin/bwrap", options: ["--unshare-pid"], seccomp: null };
      const { host } = setup("chrome", { cloudHome: true, ...(boxed ? { browserBox: () => box } : {}) });
      const paths = await host.uploadPaths(checked.files.map((file) => ({ file, name: null })), "bot-scout", { command: "omb-cdp", args: ["bot:scout"], env: {} });
      const choosers = new FileChoosers();
      let opened!: (params: Params) => void;
      const uploaded: Array<{ method: string; files: unknown; bytes: string[] }> = [];
      const session = {
        on: (_method: string, listener: (params: Params) => void) => { opened = listener; return () => {}; },
        send: async (method: string, params: Params) => { uploaded.push({ method, files: params.files, bytes: (params.files as string[]).map((path) => readFileSync(path, "utf8")) }); return {}; },
      } as unknown as CdpSession;
      choosers.watch(session);
      const answering = choosers.answer(paths);
      rmSync(source);
      symlinkSync(secret, source);
      opened({ frameId: "F", backendNodeId: 7, mode: "selectSingle" });
      await answering;
      expect(uploaded).toEqual([{ method: "DOM.setFileInputFiles", files: [expect.stringMatching(/browser-uploads/)], bytes: ["report"] }]);
      expect(paths[0]).not.toBe(source);
      expect(readFileSync(paths[0]!, "utf8")).toBe("report");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("are copied into that browser's own profile, the one folder of the disk its box shows Chrome", async () => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), "omb-host-upload-")));
    const file = join(work, "report.txt");
    writeFileSync(file, "report");
    const box = { bwrap: "/usr/bin/bwrap", options: ["--unshare-pid"], seccomp: null };
    const boxed = setup(undefined, { cloudHome: true, browserBox: () => box }).host;
    const session = `bot-scout${ADA}`;
    const [linked] = await boxed.uploadPaths([{ file, name: null }], session, { command: "agent-browser", env: {} });
    expect(linked!.startsWith(join(DATA_DIR, "agent-browser-profiles"))).toBe(true);
    expect(readFileSync(linked!, "utf8")).toBe("report");
    const plain = setup(undefined, { cloudHome: true }).host;
    expect(await plain.uploadPaths([{ file, name: null }], session, { command: "agent-browser", env: {} }), "unboxed, the file is given as it is").toEqual([file]);
    rmSync(work, { recursive: true, force: true });
  });
});
