// The Cloud's browser sandbox, against a fake provider (testing/fake-computer.ts): no real provider is called and no
// billable resource is made.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import type { AppConfig } from "../config.ts";
import { ComputerIdleTimer } from "../computer-idle.ts";
import { CLOUD_BROWSER_IDLE_MS, createCloudBrowser, type CloudBrowserDeps } from "./index.ts";
import { CLOUD_BROWSER_BACKOFF_MS, createCloudBrowserRails } from "./rails.ts";
import {
  BROWSER_SANDBOX_CHROMES, BROWSER_SANDBOX_OWNER, browserSandboxCreateBody, COMPUTER_BROWSER_DIR, doorSource, launchCommand, profileKey, providerOps, quitCommand, QUIT_ALL_COMMAND,
} from "./remote.ts";
import { OWN_KEY, RELAY_TOKEN, startFakeComputer, type FakeComputer } from "./testing/fake-computer.ts";

let fake: FakeComputer;
let dir: string;
let clock: number;
let used: Array<[string, number]>;
let engineClosed: string[];
let held: boolean;
let browsers: ReturnType<typeof createCloudBrowser>[];

beforeEach(async () => {
  fake = await startFakeComputer();
  vi.stubEnv("OMB_BOAT_API", `${fake.base}/api/v1`);
  vi.stubEnv("OMB_CLOUD_BROWSER", undefined);
  vi.stubEnv("OMB_CLOUD_BOAT_URL", undefined);
  vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", undefined);
  dir = mkdtempSync(join(tmpdir(), "cloud-browser-"));
  clock = Date.UTC(2026, 10, 24, 10, 0, 0);
  used = [];
  engineClosed = [];
  held = false;
  browsers = [];
});

afterEach(async () => {
  for (const browser of browsers) browser.closeAll();
  vi.unstubAllEnvs();
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

function browser(overrides: Partial<CloudBrowserDeps> & { budget?: number; awakeMinutes?: number } = {}) {
  const now = () => clock;
  const cfg = { box: { token: OWN_KEY } } as AppConfig;
  const { budget, awakeMinutes, ...rest } = overrides;
  const created = createCloudBrowser({
    dataDir: dir,
    ops: () => providerOps(() => cfg),
    used: (owner, windowMs) => { used.push([owner, windowMs]); },
    closeEngine: async (closed) => { engineClosed.push(closed); },
    held: () => held,
    now,
    log: () => {},
    pollMs: 5,
    rails: createCloudBrowserRails({ dataDir: dir, now, ...(budget ? { budget } : {}), ...(awakeMinutes ? { awakeMinutes } : {}) }),
    ...rest,
  });
  browsers.push(created);
  return created;
}

const request = (botId = "scout", refusal: null | "not-eligible" = null) => ({ session: `bot-${botId}`, botId, refusal });

/** Opens a WebSocket through the session's address, as the browser engine does, and sends `count` messages over it. */
async function act(cdpUrl: string, count: number): Promise<string[]> {
  const socket = new WebSocket(cdpUrl);
  await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
  const answers: string[] = [];
  for (let i = 0; i < count; i++) {
    const answer = new Promise<string>((resolve) => socket.once("message", (data) => resolve(String(data))));
    socket.send(JSON.stringify({ id: i }));
    answers.push(await answer);
  }
  await new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.close(); });
  return answers;
}

const urlOf = (opened: { cdpUrl: string } | { home: string }): string => {
  if (!("cdpUrl" in opened)) throw new Error(`expected the sandbox, got ${opened.home}`);
  return opened.cdpUrl;
};

describe("a personal Cloud's bot browsers in the Cloud's browser sandbox", () => {
  it("opens there and carries every action over one held connection, through the relay's token and the door's secret", async () => {
    const cloud = browser();
    const cdpUrl = urlOf(await cloud.open(request()));
    expect(cdpUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9]{64}$/);
    const key = profileKey("scout");
    expect(await act(cdpUrl, 5)).toEqual([0, 1, 2, 3, 4].map((id) => `echo:${key}:${JSON.stringify({ id })}`));
    // One probe before the session was committed, then the session's own single connection for all five actions.
    expect(fake.upgrades).toHaveLength(2);
    expect(cloud.dialed("bot-scout")).toBe(1);
    for (const upgrade of fake.upgrades) {
      expect(upgrade.path).toMatch(new RegExp(`^/${key}/[a-f0-9]{48}$`));
      expect(upgrade.host).toBe(new URL(fake.base).host);
      expect(upgrade.origin).toBeUndefined();
    }
    const before = fake.requests.length;
    await act(cdpUrl, 3);
    expect(fake.requests.length, "no provider call per action").toBe(before);
    expect(cloud.busy(BROWSER_SANDBOX_OWNER)).toBe(true);
    expect(cloud.busy("scout"), "never a bot's own computer").toBe(false);
    expect(cloud.report()).toMatchObject({ sessions: { sandbox: 1, home: 0 }, resumes: 0 });
  });

  it("refuses a connection to its address without the session's own token", async () => {
    const cloud = browser();
    const cdpUrl = urlOf(await cloud.open(request()));
    await expect(act(cdpUrl.replace(/[a-f0-9]{64}$/, "0".repeat(64)), 1)).rejects.toThrow();
    expect(cloud.dialed("bot-scout")).toBe(0);
  });

  it("makes the sandbox the first time a bot needs a browser: small, no environment, named, one start", async () => {
    fake.exists = false;
    const cloud = browser();
    urlOf(await cloud.open(request()));
    expect(fake.creates()).toBe(1);
    const create = fake.requests.find((one) => one.method === "POST" && one.path === "/api/v1/sandboxes");
    expect(create?.body).toEqual({ ttlSeconds: 7200, noEnv: true, type: "small" });
    expect(fake.requests.find((one) => one.method === "PATCH")?.body?.name).toMatch(/^ogb-[a-f0-9]{12}-browser-[a-f0-9]{6}$/);
    expect(cloud.report().resumes).toBe(1);
    // Through the Cloud's relay the create says what it is, so the plan's computers and hours never count it.
    expect(browserSandboxCreateBody(true)).toEqual({ ttlSeconds: 7200, noEnv: true, type: "small", purpose: "browser" });
  });

  it("through the Cloud's relay, keeps a sandbox only when the relay knows it is the browser's, and deletes one an older relay made", async () => {
    vi.stubEnv("OMB_CLOUD_BOAT_URL", `${fake.base}/api/v1`);
    vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", OWN_KEY);
    fake.exists = false;
    fake.knowsPurpose = false;
    const viaRelay = browser({ ops: () => providerOps(() => ({}) as AppConfig) });
    expect(await viaRelay.open(request())).toEqual({ home: "no-route" });
    expect(fake.requests.find((one) => one.method === "POST" && one.path === "/api/v1/sandboxes")?.body).toMatchObject({ purpose: "browser" });
    expect(fake.requests.filter((one) => one.method === "DELETE")).toHaveLength(1);
    expect(fake.exists).toBe(false);
    expect(await viaRelay.open(request()), "no second create that day").toEqual({ home: "no-route" });
    expect(fake.creates()).toBe(1);
  });

  it("through a relay that knows the browser sandbox, makes it and opens there", async () => {
    vi.stubEnv("OMB_CLOUD_BOAT_URL", `${fake.base}/api/v1`);
    vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", OWN_KEY);
    fake.exists = false;
    urlOf(await browser({ ops: () => providerOps(() => ({}) as AppConfig) }).open(request()));
    expect(fake.requests.filter((one) => one.method === "DELETE")).toEqual([]);
  });

  it("wakes a stopped sandbox with exactly one resume, then reads only", async () => {
    fake.state = "archived";
    const cloud = browser();
    urlOf(await cloud.open(request()));
    expect(fake.resumes()).toBe(1);
    expect(fake.creates()).toBe(0);
    expect(cloud.report().resumes).toBe(1);
  });

  it("gives each bot its own profile and Chrome, carries up to three at once, and keeps a fourth in the home", async () => {
    fake.state = "archived";
    const cloud = browser();
    const bots = ["scout", "writer", "chief", "fourth"];
    const opened = await Promise.all(bots.slice(0, BROWSER_SANDBOX_CHROMES).map((bot) => cloud.open(request(bot))));
    expect(fake.resumes(), "bots opening together share one wake").toBe(1);
    for (const [i, bot] of bots.slice(0, 3).entries()) expect(await act(urlOf(opened[i]!), 1)).toEqual([`echo:${profileKey(bot)}:{"id":0}`]);
    expect(new Set(fake.profiles())).toEqual(new Set(bots.slice(0, 3).map(profileKey)));
    expect(await cloud.open(request("fourth"))).toEqual({ home: "sandbox-full" });
  });

  it("keeps one profile per bot on the sandbox's disk, clearing a lock only when no Chrome of its own runs", () => {
    const key = profileKey("scout");
    expect(key).not.toBe(profileKey("writer"));
    const command = launchCommand(key, "a".repeat(48));
    expect(command).toContain(`K="$D/${key}"; P="$K/profile"`);
    expect(command).toContain('--user-data-dir="$P"');
    const guard = command.indexOf('if ! pgrep -f -- "--user-data-dir=$P"'), clear = command.indexOf('rm -f "$P/SingletonLock"');
    expect(guard).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(guard);
    expect(command).toMatch(/env -i HOME="\$HOME" PATH="[^"]+" setsid nohup "\$B"/);
    expect(quitCommand(key)).toContain(`P="${COMPUTER_BROWSER_DIR}/${key}/profile"`);
    expect(QUIT_ALL_COMMAND).toContain(`pkill -TERM -f -- "--user-data-dir=$D/"`);
    expect(() => launchCommand("../../etc", "a".repeat(48))).toThrow();
    expect(() => launchCommand(key, "not hex; rm -rf /")).toThrow();
  });

  it("reuses a bot's profile after the sandbox slept", async () => {
    const cloud = browser();
    await cloud.open(request());
    clock += CLOUD_BROWSER_IDLE_MS;
    await cloud.closeIdle();
    fake.state = "archived";
    urlOf(await cloud.open(request()));
    expect(fake.profiles()).toEqual([profileKey("scout"), profileKey("scout")]);
    expect(fake.resumes()).toBe(1);
  });

  it("closes a browser after 3 minutes without activity; the last one lets the sandbox sleep through the computers' idle path", async () => {
    const cloud = browser();
    const scout = urlOf(await cloud.open(request("scout")));
    urlOf(await cloud.open(request("writer")));
    await act(scout, 1);
    clock += CLOUD_BROWSER_IDLE_MS - 1;
    await cloud.closeIdle();
    expect(engineClosed).toEqual([]);
    held = true;
    clock += 1;
    await cloud.closeIdle();
    expect(engineClosed, "a browser a turn holds stays").toEqual([]);
    held = false;
    await cloud.close("bot-writer");
    expect(fake.requests.at(-1)?.command, "the other bot's Chrome keeps running").toBe(quitCommand(profileKey("writer")));
    expect(used.at(-1)).toEqual([BROWSER_SANDBOX_OWNER, CLOUD_BROWSER_IDLE_MS]);
    await cloud.closeIdle();
    expect(engineClosed).toEqual(["bot-writer", "bot-scout"]);
    expect(fake.requests.at(-1)?.command).toBe(QUIT_ALL_COMMAND);
    expect(cloud.busy(BROWSER_SANDBOX_OWNER)).toBe(false);
    expect(used.at(-1)).toEqual([BROWSER_SANDBOX_OWNER, 1_000]);
  });

  it("spends at most the day's start budget (creates and resumes), then opens in the home without sending another", async () => {
    fake.exists = false;
    const cloud = browser({ budget: 2 });
    for (let i = 0; i < 2; i++) {
      urlOf(await cloud.open(request()));
      clock += CLOUD_BROWSER_IDLE_MS;
      await cloud.closeIdle();
      fake.state = "archived";
    }
    expect(await cloud.open(request())).toEqual({ home: "budget" });
    expect(fake.creates() + fake.resumes()).toBe(2);
    expect(cloud.report()).toMatchObject({ resumes: 2, fallbacks: { budget: 1 } });
    clock += 24 * 60 * 60_000;
    urlOf(await cloud.open(request()));
    expect(fake.resumes()).toBe(2);
  });

  it("stops after two failed starts in a row: 15 minutes in the home with no start sent, then tries again", async () => {
    fake.state = "archived";
    fake.startStatus = 500;
    fake.startBody = { ok: false, message: "resume failed" };
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "start-failed" });
    expect(await cloud.open(request())).toEqual({ home: "start-failed" });
    expect(await cloud.open(request())).toEqual({ home: "backoff" });
    clock += CLOUD_BROWSER_BACKOFF_MS - 1;
    expect(await cloud.open(request())).toEqual({ home: "backoff" });
    expect(fake.resumes()).toBe(2);
    fake.startStatus = 200;
    fake.startBody = { ok: true };
    clock += 1;
    urlOf(await cloud.open(request()));
    expect(fake.resumes()).toBe(3);
    expect(cloud.report().resumes, "refused resumes count too").toBe(3);
  });

  it("opens in the home once the relay says the sandbox's minutes are used up, until they reset, never as an error", async () => {
    fake.state = "archived";
    fake.startStatus = 429;
    const resetsAt = new Date(Date.UTC(2026, 10, 25)).toISOString();
    fake.startBody = { ok: false, code: "limit_reached", message: "used up", error: { code: "limit_reached", reason: "hours_used", limit: 240, used: 240, resetsAt } };
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "hours-used" });
    expect(await cloud.open(request())).toEqual({ home: "hours-used" });
    expect(fake.resumes()).toBe(1);
    clock = Date.parse(resetsAt);
    fake.startStatus = 200;
    fake.startBody = { ok: true };
    urlOf(await cloud.open(request()));
  });

  it("counts the sandbox's awake minutes itself and stops opening there past the day's cap, without cutting a running browser", async () => {
    const cloud = browser({ awakeMinutes: 5 });
    const scout = urlOf(await cloud.open(request("scout")));
    clock += 5 * 60_000;
    expect(await cloud.open(request("writer"))).toEqual({ home: "minutes-used" });
    expect(cloud.active("bot-scout")).toBe(scout);
    expect(cloud.report()).toMatchObject({ awakeMinutes: 5, awakeMinutesCap: 5, held: "minutes-used" });
    clock = Date.UTC(2026, 10, 25, 0, 0, 0);
    expect(cloud.report().awakeMinutes, "a new day counts from midnight").toBe(0);
  });

  it("holds every start until the next day when the account's starts are used up, with no retries", async () => {
    fake.state = "archived";
    fake.startStatus = 429;
    fake.startBody = { ok: false, error: { code: "limit_reached", reason: "too_many_starts", window: "day" } };
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "account-limit" });
    clock += 6 * 60 * 60_000;
    expect(await cloud.open(request())).toEqual({ home: "account-limit" });
    expect(fake.resumes()).toBe(1);
    clock = Date.UTC(2026, 10, 25, 0, 0, 1);
    fake.startStatus = 200;
    fake.startBody = { ok: true };
    urlOf(await cloud.open(request()));
  });

  it("treats the relay's busy answer, or the provider's own 429, as the account's limit for the day", async () => {
    fake.state = "archived";
    fake.startStatus = 429;
    fake.startBody = { ok: false, code: "rate_limited", message: "Cloud computers are busy right now." };
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "account-limit" });
    expect(await cloud.open(request())).toEqual({ home: "account-limit" });
    expect(fake.resumes()).toBe(1);
  });

  it("a session the caller rules out (a shared profile, another person's) makes no provider call", async () => {
    const cloud = browser();
    expect(await cloud.open(request("scout", "not-eligible"))).toEqual({ home: "not-eligible" });
    expect(fake.requests).toEqual([]);
  });

  it("with no way to reach the door's port, stays in the home for the rest of the day without another start", async () => {
    fake.hostRoute = false;
    fake.state = "archived";
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "no-route" });
    expect(fake.quits()).toBe(1);
    expect(used.at(-1)).toEqual([BROWSER_SANDBOX_OWNER, 1_000]);
    const asked = fake.requests.length;
    expect(await cloud.open(request())).toEqual({ home: "no-route" });
    expect(fake.requests.length).toBe(asked);
  });

  it("uses the URL the sandbox printed when the provider's port route is refused", async () => {
    fake.hostRoute = false;
    fake.printUrl = true;
    urlOf(await browser().open(request()));
  });

  it("a Chrome that does not start counts as a failure and opens in the home", async () => {
    fake.chromeStarts = false;
    expect(await browser().open(request())).toEqual({ home: "start-failed" });
    expect(fake.upgrades).toEqual([]);
  });

  it("OMB_CLOUD_BROWSER=home keeps every browser in the home without one provider call, and deletes the sandbox after a day of it", async () => {
    vi.stubEnv("OMB_CLOUD_BROWSER", "home");
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "lever" });
    expect(cloud.report()).toMatchObject({ fallbacks: { lever: 1 } });
    expect(fake.requests).toEqual([]);
    clock += 24 * 60 * 60_000 + 1;
    cloud.report();
    await vi.waitFor(() => expect(fake.exists).toBe(false));
    expect(fake.requests.filter((one) => one.method === "DELETE")).toHaveLength(1);
    cloud.report();
    expect(fake.requests.filter((one) => one.method === "DELETE"), "at most once an hour").toHaveLength(1);
  });

  it("a sandbox an earlier run left awake gets its idle window on the Admin's first health poll, not at start", async () => {
    const first = browser();
    urlOf(await first.open(request()));
    first.closeAll();
    used = [];
    const again = browser();
    expect(used).toEqual([]);
    again.report();
    expect(used).toEqual([[BROWSER_SANDBOX_OWNER, CLOUD_BROWSER_IDLE_MS]]);
    again.report();
    expect(used).toHaveLength(1);
  });

  it("keeps its day's counts and holds across a restart", async () => {
    fake.state = "archived";
    fake.startStatus = 429;
    fake.startBody = { ok: false, error: { code: "limit_reached", reason: "too_many_starts", window: "day" } };
    await browser().open(request());
    const again = browser();
    expect(await again.open(request())).toEqual({ home: "account-limit" });
    expect(fake.resumes()).toBe(1);
    expect(again.report()).toMatchObject({ resumes: 1, fallbacks: { "account-limit": 2 } });
  });

  it("the relay URL and the door's secret never reach the log", async () => {
    const lines: string[] = [];
    await browser({ log: (line) => lines.push(line) }).open(request());
    expect(lines.join("\n")).not.toContain(RELAY_TOKEN);
    expect(lines.join("\n")).not.toMatch(/[a-f0-9]{48}/);
  });
});

describe("the sandbox's door, run as it runs there", () => {
  let chrome: Server;
  let folder: string;
  afterEach(() => { chrome?.close(); rmSync(folder, { recursive: true, force: true }); });

  it("lets a request with a profile's secret through to that profile's Chrome as a local DevTools connection, and nothing else", async () => {
    folder = mkdtempSync(join(tmpdir(), "door-"));
    const seen: Array<{ url: string | undefined; host: string | undefined; origin: string | undefined }> = [];
    const wss = new WebSocketServer({ noServer: true });
    chrome = createServer();
    chrome.on("upgrade", (req, socket, head) => {
      seen.push({ url: req.url, host: req.headers.host, origin: req.headers.origin });
      wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => ws.send(`chrome:${String(data)}`)));
    });
    await new Promise<void>((resolve) => chrome.listen(0, "127.0.0.1", resolve));
    const chromePort = (chrome.address() as { port: number }).port;
    const key = profileKey("scout"), secret = "b".repeat(48);
    mkdirSync(join(folder, key, "profile"), { recursive: true });
    writeFileSync(join(folder, key, "secret"), secret);
    writeFileSync(join(folder, key, "profile", "DevToolsActivePort"), `${chromePort}\n/devtools/browser/abc-123\n`);
    writeFileSync(join(folder, "door.mjs"), doorSource());
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const doorPort = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const door = spawn(process.execPath, [join(folder, "door.mjs"), folder, String(doorPort)], { stdio: "ignore" });
    try {
      const open = async (path: string) => {
        for (let tries = 0; ; tries++) {
          const socket = new WebSocket(`ws://127.0.0.1:${doorPort}${path}`, { headers: { Origin: "https://evil.example", Host: "sandbox-39231.on.example" } });
          try {
            await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
            return socket;
          } catch (error) {
            if (tries > 40 || !String(error).includes("ECONNREFUSED")) throw error;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      };
      const socket = await open(`/${key}/${secret}?_token=t`);
      const answer = new Promise<string>((resolve) => socket.once("message", (data) => resolve(String(data))));
      socket.send("hello");
      expect(await answer).toBe("chrome:hello");
      socket.close();
      expect(seen).toEqual([{ url: "/devtools/browser/abc-123", host: `127.0.0.1:${chromePort}`, origin: undefined }]);
      await expect(open(`/${key}/${"c".repeat(48)}`)).rejects.toThrow(/404/);
      await expect(open(`/${profileKey("writer")}/${secret}`)).rejects.toThrow(/404/);
      expect(seen).toHaveLength(1);
    } finally {
      door.kill();
    }
  });
});

describe("a computer's idle window with a browser's shorter one", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("a shorter window never cuts a longer one another use asked for, and a plain touch is unchanged", async () => {
    vi.useFakeTimers();
    const slept: number[] = [];
    const timer = new ComputerIdleTimer(10_000, () => false, async () => { slept.push(Date.now()); });
    const start = Date.now();
    timer.touch();
    timer.touch(1_000);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(slept).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(slept).toEqual([start + 10_000]);
    const short = new ComputerIdleTimer(10_000, () => false, async () => { slept.push(Date.now()); });
    const at = Date.now();
    short.touch(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(slept.at(-1)).toBe(at + 3_000);
    timer.cancel();
    short.cancel();
  });
});
