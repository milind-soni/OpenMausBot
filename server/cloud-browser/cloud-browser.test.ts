// The Cloud's browser sandbox, against a fake Admin relay and provider (testing/fake-computer.ts): no real provider is
// called and no billable resource is made.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import type { AppConfig } from "../config.ts";
import { ComputerIdleTimer } from "../computer-idle.ts";
import { DOWNLOAD_NOTE, downloadNote, LOCAL_SCHEME_REFUSAL, localSchemeRefusal } from "./guards.ts";
import { CLOUD_BROWSER_IDLE_MS, createCloudBrowser, type CloudBrowserDeps } from "./index.ts";
import { CLOUD_BROWSER_BACKOFF_MS, createCloudBrowserRails } from "./rails.ts";
import { BROWSER_SANDBOX_CHROMES, BROWSER_SANDBOX_OWNER, browserSandboxCreateBody, profileKey, providerOps } from "./remote.ts";
import { RELAY_KEY, RELAY_TOKEN, startFakeComputer, type FakeComputer } from "./testing/fake-computer.ts";

let fake: FakeComputer;
let dir: string;
let clock: number;
let used: Array<[string, number]>;
let engineClosed: string[];
let held: boolean;
let browsers: ReturnType<typeof createCloudBrowser>[];

beforeEach(async () => {
  fake = await startFakeComputer();
  // MausBot Cloud's included credential, pointed at the fake relay: the only way a browser sandbox is ever made.
  vi.stubEnv("OMB_CLOUD_BOAT_URL", `${fake.base}/api/v1`);
  vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", RELAY_KEY);
  vi.stubEnv("OMB_CLOUD_BROWSER", undefined);
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
  const { budget, awakeMinutes, ...rest } = overrides;
  const created = createCloudBrowser({
    dataDir: dir,
    ops: () => providerOps(() => ({}) as AppConfig),
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
const deletes = () => fake.requests.filter((one) => one.method === "DELETE");

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
    expect(fake.requests.length, "no relay call per action").toBe(before);
    expect(fake.requests.filter((one) => one.path.endsWith("/commands")), "no shell command is ever sent").toEqual([]);
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

  it("two calls opening one session at once share the one open: a session never splits across two browsers", async () => {
    fake.state = "archived";
    const cloud = browser();
    const [first, second] = await Promise.all([cloud.open(request()), cloud.open(request())]);
    expect(urlOf(second)).toBe(urlOf(first));
    expect(fake.launches()).toBe(1);
    expect(fake.resumes()).toBe(1);
    expect(cloud.report().sessions).toEqual({ sandbox: 1, home: 0 });
  });

  it("asks the relay before making anything, and makes the sandbox the first time a bot needs a browser: small, marked as the browser's, named, one start", async () => {
    fake.exists = false;
    const cloud = browser();
    urlOf(await cloud.open(request()));
    const probe = fake.requests.findIndex((one) => one.path.endsWith("/browser-sandbox"));
    const create = fake.requests.findIndex((one) => one.method === "POST" && one.path === "/api/v1/sandboxes");
    expect(probe).toBeGreaterThan(-1);
    expect(probe).toBeLessThan(create);
    expect(fake.requests[create]?.body).toEqual({ noEnv: true, type: "small", purpose: "browser" });
    expect(browserSandboxCreateBody()).toEqual({ noEnv: true, type: "small", purpose: "browser" });
    expect(fake.requests.find((one) => one.method === "PATCH")?.body?.name).toMatch(/^ogb-[a-f0-9]{12}-browser-[a-f0-9]{6}$/);
    expect(cloud.report().resumes).toBe(1);
  });

  it("on an Admin from before the browser sandbox, makes nothing at all and stays in the home for a week", async () => {
    fake.exists = false;
    fake.oldRelay = true;
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "old-relay" });
    expect(fake.creates()).toBe(0);
    clock += 6 * 24 * 60 * 60_000;
    const asked = fake.requests.length;
    expect(await cloud.open(request())).toEqual({ home: "old-relay" });
    expect(fake.requests.length).toBe(asked);
    clock += 24 * 60 * 60_000;
    fake.oldRelay = false;
    urlOf(await cloud.open(request()));
  });

  it("deletes at once a box a create made without the browser's mark", async () => {
    fake.exists = false;
    // The probe answers, but the create comes back unmarked (an Admin rolled back between the two).
    const realProbe = providerOps(() => ({}) as AppConfig);
    const ops = { ...realProbe, probe: async () => { fake.oldRelay = true; return { kind: "available" as const, boxId: null }; } };
    const guarded = browser({ ops: () => ops });
    expect(await guarded.open(request())).toEqual({ home: "old-relay" });
    expect(fake.creates()).toBe(1);
    expect(deletes()).toHaveLength(1);
    expect(fake.exists).toBe(false);
  });

  it("holds every start while the relay says the fleet's browser starts are spent, until its reset, without one start sent", async () => {
    fake.state = "archived";
    fake.available = false;
    fake.unavailableReason = "fleet_starts";
    fake.unavailableUntil = new Date(Date.UTC(2026, 10, 25)).toISOString();
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "unavailable" });
    expect(await cloud.open(request())).toEqual({ home: "unavailable" });
    expect(fake.resumes() + fake.creates()).toBe(0);
    expect(fake.requests.filter((one) => one.path.endsWith("/browser-sandbox"))).toHaveLength(1);
    expect(cloud.report().held).toBe("unavailable");
    clock = Date.UTC(2026, 10, 25, 0, 0, 1);
    fake.available = true;
    urlOf(await cloud.open(request()));
  });

  it("replaces a sandbox the provider reports broken: deleted first, a fresh one made and counted", async () => {
    fake.state = "error";
    const cloud = browser();
    urlOf(await cloud.open(request()));
    expect(deletes()).toHaveLength(1);
    expect(fake.creates()).toBe(1);
    expect(cloud.report().resumes).toBe(1);
  });

  it("wakes a stopped sandbox with exactly one resume, then reads only", async () => {
    fake.state = "archived";
    const cloud = browser();
    urlOf(await cloud.open(request()));
    expect(fake.resumes()).toBe(1);
    expect(fake.creates()).toBe(0);
    expect(cloud.report().resumes).toBe(1);
  });

  it("an awake sandbox needs no start and no question to the relay", async () => {
    urlOf(await browser().open(request()));
    expect(fake.requests.filter((one) => one.path.endsWith("/browser-sandbox"))).toEqual([]);
    expect(fake.resumes() + fake.creates()).toBe(0);
  });

  it("gives each bot its own profile and Chrome, carries up to three at once, and keeps a fourth in the home", async () => {
    fake.state = "archived";
    const cloud = browser();
    const bots = ["scout", "writer", "chief", "fourth"];
    const opened = await Promise.all(bots.slice(0, BROWSER_SANDBOX_CHROMES).map((bot) => cloud.open(request(bot))));
    expect(fake.resumes(), "bots opening together share one wake").toBe(1);
    for (const [i, bot] of bots.slice(0, 3).entries()) expect(await act(urlOf(opened[i]!), 1)).toEqual([`echo:${profileKey(bot)}:{"id":0}`]);
    expect(new Set(fake.profiles())).toEqual(new Set(bots.slice(0, 3).map(profileKey)));
    expect(profileKey("scout")).toMatch(/^[a-f0-9]{16}$/);
    expect(await cloud.open(request("fourth"))).toEqual({ home: "sandbox-full" });
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
    expect(fake.quits().at(-1), "the other bot's Chrome keeps running").toBe(`quit:${profileKey("writer")}`);
    expect(used.at(-1)).toEqual([BROWSER_SANDBOX_OWNER, CLOUD_BROWSER_IDLE_MS]);
    await cloud.closeIdle();
    expect(engineClosed).toEqual(["bot-writer", "bot-scout"]);
    expect(fake.quits().at(-1)).toBe("quit-all");
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

  it("treats the relay's busy answer as the account's limit for the day", async () => {
    fake.state = "archived";
    fake.startStatus = 429;
    fake.startBody = { ok: false, code: "rate_limited", message: "Cloud computers are busy right now." };
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "account-limit" });
    expect(await cloud.open(request())).toEqual({ home: "account-limit" });
    expect(fake.resumes()).toBe(1);
  });

  it("a session the caller rules out (a shared profile, another person's, a person's own key) makes no relay call", async () => {
    const cloud = browser();
    expect(await cloud.open(request("scout", "not-eligible"))).toEqual({ home: "not-eligible" });
    expect(fake.requests).toEqual([]);
  });

  it("with no protected way to reach the door's port, stays in the home for the rest of the day without another start", async () => {
    fake.unprotected = true;
    fake.state = "archived";
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "no-route" });
    expect(fake.upgrades, "an unprotected URL is never dialed").toEqual([]);
    expect(fake.quits()).toEqual([`quit:${profileKey("scout")}`]);
    expect(used.at(-1)).toEqual([BROWSER_SANDBOX_OWNER, 1_000]);
    const asked = fake.requests.length;
    expect(await cloud.open(request())).toEqual({ home: "no-route" });
    expect(fake.requests.length).toBe(asked);
  });

  it("a Chrome that does not start counts as a failure and opens in the home", async () => {
    fake.chromeStarts = false;
    expect(await browser().open(request())).toEqual({ home: "start-failed" });
    expect(fake.upgrades).toEqual([]);
  });

  it("OMB_CLOUD_BROWSER=home keeps every browser in the home without one relay call, and deletes the sandbox after a day of it", async () => {
    vi.stubEnv("OMB_CLOUD_BROWSER", "home");
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "lever" });
    expect(cloud.report()).toMatchObject({ fallbacks: { lever: 1 } });
    expect(fake.requests).toEqual([]);
    clock += 24 * 60 * 60_000 + 1;
    cloud.report();
    await vi.waitFor(() => expect(fake.exists).toBe(false));
    expect(deletes()).toHaveLength(1);
    cloud.report();
    expect(deletes(), "at most once an hour").toHaveLength(1);
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

describe("what a browser in the sandbox is kept from", () => {
  it("never opens a file, the browser's own pages or another local scheme, however the call names it", () => {
    for (const url of ["file:///home/user/.omb-browser/", " FILE:///etc/passwd", "chrome://settings", "view-source:https://a.example", "devtools://devtools", "chrome-extension://x/y"]) {
      expect(localSchemeRefusal({ name: "agent_browser_open", arguments: { url } }), url).toBe(LOCAL_SCHEME_REFUSAL);
    }
    expect(localSchemeRefusal({ name: "agent_browser_tab_new", arguments: { options: { url: "file:///tmp/x" } } })).toBe(LOCAL_SCHEME_REFUSAL);
    expect(localSchemeRefusal({ name: "agent_browser_open", arguments: { url: "https://example.com/file:x" } })).toBeNull();
    expect(localSchemeRefusal({ name: "agent_browser_snapshot", arguments: {} })).toBeNull();
  });

  it("says once, in the call's answer, that a download was not kept", () => {
    const answer = { content: [{ type: "text", text: "Navigation failed: net::ERR_ABORTED" }] };
    const noted = downloadNote(answer) as { content: Array<{ text: string }> };
    expect(noted.content.at(-1)?.text).toBe(DOWNLOAD_NOTE);
    expect(downloadNote(noted)).toBe(noted);
    const page = { content: [{ type: "text", text: "button \"Download the app\"" }] };
    expect(downloadNote(page), "a page's own words are not a download").toBe(page);
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
