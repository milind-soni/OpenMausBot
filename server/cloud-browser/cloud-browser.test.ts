// The Cloud's browser sandbox, against a fake Admin relay and provider (testing/fake-computer.ts): no real provider is
// called and no billable resource is made.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import type { AppConfig } from "../config.ts";
import { ComputerIdleTimer } from "../computer-idle.ts";
import { LOCAL_SCHEME_REFUSAL, localSchemeRefusal } from "./guards.ts";
import { SESSION_DOWNLOAD_BYTES, SIGN_IN_SYNC_MS, UPLOAD_MAX_BYTES, type SignInStore } from "./companion.ts";
import { cookieParam } from "./sign-ins.ts";
import { CLOUD_BROWSER_IDLE_MS, createCloudBrowser, OPEN_DEADLINE_MS, REOPENED_NOTE, SANDBOX_IDLE_TTL_SECONDS, TTL_REFRESH_MS, type CloudBrowserDeps } from "./index.ts";
import { CLOUD_BROWSER_BACKOFF_MS, createCloudBrowserRails } from "./rails.ts";
import { BROWSER_SANDBOX_CHROMES, BROWSER_SANDBOX_OWNER, browserSandboxCreateBody, profileKey, providerOps, ttlSecondsOf } from "./remote.ts";
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
    // A roomy disk, whatever this machine's own is.
    disk: () => ({ free: 100 * 1024 ** 3, total: 200 * 1024 ** 3 }),
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
    // The session's companion (sign-ins, downloads; its connection proves the path, no separate probe), and the engine's
    // own single connection for all five actions.
    expect(fake.upgrades).toHaveLength(2);
    expect(cloud.dialed("bot-scout")).toBe(2);
    for (const upgrade of fake.upgrades) {
      expect(upgrade.path).toMatch(new RegExp(`^/${key}/[a-f0-9]{48}$`));
      expect(upgrade.host).toBe(new URL(fake.base).host);
      expect(upgrade.origin).toBeUndefined();
      expect(upgrade.query, "the relay's token goes as the _port_auth cookie, never a ?_token= the edge would redirect").toBe("");
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
    expect(cloud.dialed("bot-scout"), "only the companion's own connection").toBe(1);
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
    // No size asked for: the Admin picks it by the Cloud's plan (small, or default on the bigger plans).
    expect(fake.requests[create]?.body).toEqual({ noEnv: true, purpose: "browser" });
    expect(browserSandboxCreateBody()).toEqual({ noEnv: true, purpose: "browser" });
    expect(fake.requests.find((one) => one.method === "PATCH")?.body?.name).toMatch(/^ogb-[a-f0-9]{12}-browser-[a-f0-9]{6}$/);
    expect(cloud.report().resumes).toBe(1);
  });

  it("on an Admin from before the browser sandbox, makes nothing at all, and asks again the next day or at the home's next start", async () => {
    fake.exists = false;
    fake.oldRelay = true;
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "old-relay" });
    expect(fake.creates()).toBe(0);
    clock += 60 * 60_000;
    const asked = fake.requests.length;
    expect(await cloud.open(request())).toEqual({ home: "old-relay" });
    expect(fake.requests.length, "not asked again the same day").toBe(asked);
    // The relay is updated meanwhile: a restarted home finds it at once.
    fake.oldRelay = false;
    urlOf(await browser().open(request("writer")));
    // And the running one, the next day.
    clock = Date.UTC(2026, 10, 25, 0, 0, 1);
    urlOf(await cloud.open(request()));
  });

  it("deletes at once a box a create made without the browser's mark", async () => {
    fake.exists = false;
    // The probe answers, but the create comes back unmarked (an Admin rolled back between the two).
    const realProbe = providerOps(() => ({}) as AppConfig);
    const ops = { ...realProbe, probe: async () => { fake.oldRelay = true; return { kind: "available" as const, boxId: null, chromes: null, caps: { resumes: null, awakeMinutes: null } }; } };
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

  it("when the relay says the fleet has as many sandboxes running as it allows, tries again after the back-off, not the next day", async () => {
    fake.state = "archived";
    fake.available = false;
    fake.unavailableReason = "fleet_running";
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "unavailable" });
    clock += CLOUD_BROWSER_BACKOFF_MS - 1;
    expect(await cloud.open(request())).toEqual({ home: "unavailable" });
    expect(fake.requests.filter((one) => one.path.endsWith("/browser-sandbox"))).toHaveLength(1);
    clock += 1;
    fake.available = true;
    urlOf(await cloud.open(request()));
    expect(fake.resumes()).toBe(1);
  });

  it("replaces a sandbox the provider reports broken: deleted first, a fresh one made and counted", async () => {
    fake.state = "error";
    const cloud = browser();
    urlOf(await cloud.open(request()));
    expect(deletes()).toHaveLength(1);
    expect(fake.creates()).toBe(1);
    expect(cloud.report().resumes).toBe(1);
  });

  it("with no machine free at the provider, opens in the home at once, never as a sandbox failure", async () => {
    fake.state = "archived";
    fake.startStatus = 503;
    fake.startBody = { ok: false, code: "no_ready_machine", message: "No machine is ready." };
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "no-machine" });
    expect(await cloud.open(request())).toEqual({ home: "no-machine" });
    expect(await cloud.open(request())).toEqual({ home: "no-machine" });
    expect(cloud.report().held, "no back-off: the next open may find a machine").toBeNull();
    expect(fake.resumes()).toBe(3);
  });

  it("pushes the provider's own auto-stop ahead while a browser is used, at most every 10 minutes, so it stops the sandbox only when unused", async () => {
    const cloud = browser();
    urlOf(await cloud.open(request()));
    const patches = () => fake.requests.filter((one) => one.method === "PATCH" && one.body?.ttlSeconds !== undefined).map((one) => one.body);
    clock += 60_000;
    cloud.touch("bot-scout");
    await cloud.closeIdle();
    expect(patches()).toEqual([{ ttlSeconds: SANDBOX_IDLE_TTL_SECONDS }]);
    expect(Number.isInteger(patches()[0]?.ttlSeconds), "the provider takes a non-number as an hour").toBe(true);
    clock += 60_000;
    cloud.touch("bot-scout");
    await cloud.closeIdle();
    expect(patches(), "at most every 10 minutes").toHaveLength(1);
    // A turn holds the browser for a long call: that is use too.
    held = true;
    clock += TTL_REFRESH_MS;
    await cloud.closeIdle();
    expect(patches()).toHaveLength(2);
    held = false;
    clock += TTL_REFRESH_MS;
    await cloud.closeIdle();
    expect(cloud.active("bot-scout"), "unused since: closed").toBeNull();
    expect(patches(), "unused since: the deadline is left to run out").toHaveLength(2);
  });

  it("closes a session whose attached engine sends keepalives forever: only a bot's call, a turn or a person counts as use", async () => {
    const cloud = browser();
    const cdpUrl = urlOf(await cloud.open(request()));
    // The engine stays attached after its turn ended without a close, and keeps the connection alive.
    const engine = new WebSocket(cdpUrl);
    await new Promise<void>((resolve, reject) => { engine.once("open", () => resolve()); engine.once("error", reject); });
    const keepalive = async () => { engine.send(JSON.stringify({ id: Math.random() })); await new Promise((resolve) => engine.once("message", resolve)); };
    const patchesBefore = fake.requests.filter((one) => one.method === "PATCH").length;
    for (let minute = 0; minute < 2; minute++) {
      clock += 60_000;
      await keepalive();
      await cloud.closeIdle();
    }
    // A bot's call at minute 2 is real use: the 3 minutes count from it.
    cloud.touch("bot-scout");
    for (let minute = 0; minute < 2; minute++) {
      clock += 60_000;
      await keepalive();
      await cloud.closeIdle();
    }
    expect(cloud.active("bot-scout"), "2 minutes after the last call").not.toBeNull();
    clock += 60_000;
    await keepalive();
    await cloud.closeIdle();
    expect(cloud.active("bot-scout"), "3 minutes after the last call, keepalives or not").toBeNull();
    expect(engineClosed).toEqual(["bot-scout"]);
    expect(fake.quits().at(-1)).toBe("quit-all");
    expect(used.at(-1)).toEqual([BROWSER_SANDBOX_OWNER, 1_000]);
    expect(fake.requests.filter((one) => one.method === "PATCH").length - patchesBefore, "keepalives never push the provider's deadline").toBeLessThanOrEqual(1);
    engine.terminate();
  });

  it("sets the home's session cookies again after the sandbox's Chrome restarted, and keeps what the profile held", async () => {
    const home = memorySignIns({ cookies: [SIGNED_IN], origins: [] });
    const cloud = browser({ signIns: home.store });
    urlOf(await cloud.open(request()));
    clock += CLOUD_BROWSER_IDLE_MS;
    await cloud.closeIdle();
    // A stop and a new machine: Chrome restarted, so its session cookie is gone; a persistent one made in the sandbox stays.
    const key = profileKey("scout");
    fake.cookies.set(key, [{ name: "kept", value: "k", domain: "kept.example", path: "/", expires: 2_000_000_000 }]);
    urlOf(await cloud.open(request()));
    expect(fake.cookies.get(key)?.map((cookie) => cookie.name).sort()).toEqual(["kept", "sid"]);
    // The one the sandbox kept and the home never saw went home too.
    expect((home.store.load("bot-scout") as { state: { cookies: Array<{ name: string }> } }).state.cookies.map((cookie) => cookie.name).sort()).toEqual(["kept", "sid"]);
  });

  it("stops the browser sandbox through the cloud computers' sleep without sending it a shell command", async () => {
    fake.requests.length = 0;
    const { sleepBoat } = await import("../boat.ts");
    await sleepBoat({} as AppConfig, BROWSER_SANDBOX_OWNER);
    expect(fake.requests.filter((one) => one.path.endsWith("/commands")), "no QUIESCE: its pre-stop hook closes its Chromes").toEqual([]);
    expect(fake.requests.filter((one) => one.path.endsWith("/stop"))).toHaveLength(1);
  });

  it("takes back a sandbox that is still stopping: one resume, no start counted, no question to the relay", async () => {
    fake.state = "archiving";
    const cloud = browser();
    urlOf(await cloud.open(request()));
    expect(fake.resumes()).toBe(1);
    expect(cloud.report().resumes, "the kept machine is no start").toBe(0);
    expect(fake.requests.filter((one) => one.path.endsWith("/browser-sandbox"))).toEqual([]);
  });

  it("when the take-back comes too late, sends one real resume, counted like any", async () => {
    fake.state = "archiving";
    fake.takeBackFails = true;
    const cloud = browser();
    urlOf(await cloud.open(request()));
    expect(fake.resumes()).toBe(2);
    expect(cloud.report().resumes).toBe(1);
  });

  it("never keeps a call waiting past the open deadline: a sandbox stuck coming up opens the home's browser, and is ready for the next call", async () => {
    expect(OPEN_DEADLINE_MS).toBe(12_000);
    fake.state = "archived";
    fake.stall.set("/browser", 600);
    const cloud = browser({ openDeadlineMs: 150 });
    const started = Date.now();
    expect(await cloud.open(request())).toEqual({ home: "slow" });
    expect(Date.now() - started, "answered at the deadline, not when the sandbox was").toBeLessThan(550);
    expect(cloud.report().fallbacks).toMatchObject({ slow: 1 });
    // It went on coming up meanwhile, timed by the idle path from its start: the next call finds it awake.
    await vi.waitFor(() => expect(fake.launches()).toBe(1));
    await vi.waitFor(() => expect(cloud.busy(BROWSER_SANDBOX_OWNER)).toBe(false));
    // Given up during the launch: nothing more was spent on the abandoned call: no connection, no carry, its Chrome quit.
    expect(fake.upgrades).toEqual([]);
    expect(fake.commands, "no cookie carried").toEqual([]);
    expect(fake.quits()).toEqual([`quit:${profileKey("scout")}`]);
    expect(used[0]).toEqual([BROWSER_SANDBOX_OWNER, CLOUD_BROWSER_IDLE_MS]);
    expect(cloud.active("bot-scout"), "this call stayed in the home: its session is not on the sandbox").toBeNull();
    urlOf(await cloud.open(request()));
    expect(fake.resumes(), "the next call needs no start").toBe(1);
  });

  it("times a sandbox from the moment its start was sent, even when the wake then fails", async () => {
    fake.state = "archived";
    fake.startStatus = 500;
    fake.startBody = { ok: false, message: "resume failed" };
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "start-failed" });
    expect(used[0], "armed at the start, never left untimed").toEqual([BROWSER_SANDBOX_OWNER, CLOUD_BROWSER_IDLE_MS]);
  });

  it("treats an older Admin's 403 not_available on the probe as the old relay too", async () => {
    fake.exists = false;
    fake.oldRelay = true;
    fake.oldRelayAnswer = 403;
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "old-relay" });
    expect(fake.creates()).toBe(0);
  });

  it("tells the bot's next call that the browser was reopened after its session in the sandbox closed, here or in the home", async () => {
    const cloud = browser();
    urlOf(await cloud.open(request()));
    clock += CLOUD_BROWSER_IDLE_MS;
    await cloud.closeIdle();
    expect(cloud.takeNotes("bot-scout")).toEqual([REOPENED_NOTE]);
    expect(cloud.takeNotes("bot-scout"), "said once").toEqual([]);
    // A session that ended because its sandbox stopped: the same line, whatever opens next.
    urlOf(await cloud.open(request()));
    fake.state = "archived";
    await cloud.failed("bot-scout");
    expect(cloud.takeNotes("bot-scout")).toEqual([REOPENED_NOTE]);
  });

  it("erases a deleted bot's profile in the sandbox, ends its session without writing its sign-ins home, and keeps the erase for the next wake when asleep", async () => {
    const home = memorySignIns({ cookies: [SIGNED_IN], origins: [] });
    const cloud = browser({ signIns: home.store });
    urlOf(await cloud.open(request()));
    fake.cookies.set(profileKey("scout"), [{ name: "late", value: "x", domain: "late.example", path: "/" }]);
    await cloud.erase("scout");
    expect(fake.erased).toEqual([profileKey("scout")]);
    expect(home.writes, "the deleted bot's cookies never go back to the home").toEqual([]);
    expect(cloud.takeNotes("bot-scout")).toEqual([]);
    // Asleep: kept, and done at the next wake for anyone.
    clock += CLOUD_BROWSER_IDLE_MS;
    await cloud.closeIdle();
    fake.state = "archived";
    await cloud.erase("writer");
    expect(fake.erased).toEqual([profileKey("scout")]);
    expect(fake.resumes(), "a deletion never wakes the sandbox").toBe(0);
    urlOf(await cloud.open(request("chief")));
    expect(fake.erased).toEqual([profileKey("scout"), profileKey("writer")]);
  });

  it("logs why a session in the sandbox closed: its real idle time, a deleted bot, a stopped sandbox", async () => {
    const lines: string[] = [];
    const cloud = browser({ log: (line) => lines.push(line) });
    urlOf(await cloud.open(request()));
    clock += CLOUD_BROWSER_IDLE_MS + 60_000;
    await cloud.closeIdle();
    expect(lines.at(-1)).toBe("browser bot-scout: closed in the Cloud's browser sandbox: 4 minutes unused");
    urlOf(await cloud.open(request()));
    await cloud.erase("scout");
    expect(lines).toContain("browser bot-scout: closed in the Cloud's browser sandbox: its bot was deleted");
    urlOf(await cloud.open(request("writer")));
    fake.state = "archived";
    await cloud.failed("bot-writer");
    expect(lines.at(-1)).toBe("browser bot-writer: closed in the Cloud's browser sandbox: its browser sandbox is archived");
  });

  it("carries the home's cookies in batches, not one call each", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ ...SIGNED_IN, name: `c${i}` }));
    const cloud = browser({ signIns: memorySignIns({ cookies: many, origins: [] }).store });
    urlOf(await cloud.open(request()));
    expect(fake.commands.filter((one) => one.method === "Storage.setCookies")).toHaveLength(3);
    expect(fake.cookies.get(profileKey("scout"))).toHaveLength(250);
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

  it("gives each bot its own profile and Chrome, carries up to two at once, and keeps a third in the home", async () => {
    fake.state = "archived";
    const cloud = browser();
    const bots = ["scout", "writer", "chief"];
    const opened = await Promise.all(bots.slice(0, BROWSER_SANDBOX_CHROMES).map((bot) => cloud.open(request(bot))));
    expect(fake.resumes(), "bots opening together share one wake").toBe(1);
    expect(BROWSER_SANDBOX_CHROMES, "one heavy page measured 954 MB on a 4 GB sandbox").toBe(2);
    for (const [i, bot] of bots.slice(0, 2).entries()) expect(await act(urlOf(opened[i]!), 1)).toEqual([`echo:${profileKey(bot)}:{"id":0}`]);
    expect(new Set(fake.profiles())).toEqual(new Set(bots.slice(0, 2).map(profileKey)));
    expect(profileKey("scout")).toMatch(/^[a-f0-9]{16}$/);
    expect(await cloud.open(request("chief"))).toEqual({ home: "sandbox-full" });
  });

  it("carries as many bots' Chromes as the relay says this Cloud's sandbox takes", async () => {
    fake.state = "archived";
    fake.chromes = 3;
    const cloud = browser();
    // The relay says it at the wake, so from the first open on.
    for (const bot of ["scout", "writer", "chief"]) urlOf(await cloud.open(request(bot)));
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
    clock += CLOUD_BROWSER_IDLE_MS;
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

  it("treats the relay's busy answer (a minute or hour window) as a back-off of minutes, not the rest of the day", async () => {
    fake.state = "archived";
    fake.startStatus = 429;
    fake.startBody = { ok: false, code: "rate_limited", message: "Cloud computers are busy right now." };
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "backoff" });
    expect(await cloud.open(request())).toEqual({ home: "backoff" });
    expect(fake.resumes()).toBe(1);
    clock += CLOUD_BROWSER_BACKOFF_MS;
    fake.startStatus = 200;
    fake.startBody = { ok: true };
    urlOf(await cloud.open(request()));
  });

  it("takes this Cloud's caps from the relay's answer, not its own table", async () => {
    fake.state = "archived";
    fake.caps = { resumesPerDay: 1, awakeMinutesPerDay: 720 };
    const cloud = browser();
    urlOf(await cloud.open(request()));
    expect(cloud.report()).toMatchObject({ budget: 1, awakeMinutesCap: 720 });
    clock += CLOUD_BROWSER_IDLE_MS;
    await cloud.closeIdle();
    fake.state = "archived";
    expect(await cloud.open(request())).toEqual({ home: "budget" });
  });

  it("ends a session whose sandbox stopped under it (a cap, the maximum age, an outage), so the next call opens again instead of failing", async () => {
    const cloud = browser();
    urlOf(await cloud.open(request()));
    expect(await cloud.failed("bot-scout"), "still there: the call's own failure").toBe(false);
    expect(cloud.active("bot-scout")).not.toBeNull();
    // The Admin stopped it (its minutes cap) while a turn held the browser.
    fake.state = "archived";
    expect(await cloud.failed("bot-scout")).toBe(true);
    expect(cloud.active("bot-scout")).toBeNull();
    expect(engineClosed).toEqual(["bot-scout"]);
    urlOf(await cloud.open(request()));
    expect(fake.resumes()).toBe(1);
  });

  it("stamps the provider deadline's push only when it moved, and tries a failed one again at the next sweep", async () => {
    const cloud = browser();
    urlOf(await cloud.open(request()));
    const pushes = () => fake.requests.filter((one) => one.method === "PATCH" && one.body?.ttlSeconds !== undefined).length;
    fake.patchStatus = 500;
    clock += 60_000;
    cloud.touch("bot-scout");
    await cloud.closeIdle();
    expect(pushes()).toBe(1);
    clock += 30_000;
    await cloud.closeIdle();
    expect(pushes(), "tried again soon").toBe(2);
    fake.patchStatus = 200;
    clock += 30_000;
    await cloud.closeIdle();
    expect(pushes()).toBe(3);
    clock += 30_000;
    cloud.touch("bot-scout");
    await cloud.closeIdle();
    expect(pushes(), "moved: not again for 10 minutes").toBe(3);
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

  it("keeps every browser in the home for the day when the sandbox could not take the policy that blocks file://", async () => {
    fake.policy = false;
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "no-policy" });
    expect(fake.upgrades, "never dialed").toEqual([]);
    expect(fake.quits()).toEqual([`quit:${profileKey("scout")}`]);
    const asked = fake.requests.length;
    expect(await cloud.open(request("writer"))).toEqual({ home: "no-route" });
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
});

/** The home's saved sign-ins, held in memory as the restore file would hold them. */
function memorySignIns(initial: { cookies: unknown[]; origins: unknown[] } | null | "unreadable") {
  let saved = initial;
  let modified = initial ? 1_000 : 0;
  const writes: unknown[][] = [];
  const store: SignInStore = {
    load: () => (saved === null || saved === "unreadable" ? saved : { state: saved, modified }),
    save: (_session, cookies) => { writes.push(cookies); saved = { cookies, origins: saved && saved !== "unreadable" ? saved.origins : [] }; modified += 1; return modified; },
  };
  return { store, writes, change(next: { cookies: unknown[]; origins: unknown[] } | "unreadable") { saved = next; modified += 10; } };
}

const SIGNED_IN = { name: "sid", value: "s1", domain: ".example.com", path: "/", expires: -1, size: 5, httpOnly: true, secure: true, session: true, sameSite: "Lax" };

describe("a bot's sign-ins between the home and its sandbox profile", () => {
  it("carries the home's saved sign-ins in on the first use, over the session's own connection, and not again while they are unchanged", async () => {
    const home = memorySignIns({ cookies: [SIGNED_IN], origins: [{ origin: "https://example.com", localStorage: [{ name: "token", value: "t" }] }] });
    const cloud = browser({ signIns: home.store });
    urlOf(await cloud.open(request()));
    expect(fake.cookies.get(profileKey("scout"))).toEqual([{ name: "sid", value: "s1", domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    expect(fake.commands.filter((one) => one.method === "DOMStorage.setDOMStorageItem").map((one) => one.params)).toEqual([
      { storageId: { securityOrigin: "https://example.com", isLocalStorage: true }, key: "token", value: "t" },
    ]);
    expect(fake.cookies.get(profileKey("writer")), "never another bot's profile").toBeUndefined();
    clock += CLOUD_BROWSER_IDLE_MS;
    await cloud.closeIdle();
    const setsBefore = fake.commands.filter((one) => one.method === "Storage.setCookies").length;
    urlOf(await cloud.open(request()));
    expect(fake.commands.filter((one) => one.method === "Storage.setCookies").length, "unchanged at home: not carried again").toBe(setsBefore);
  });

  it("opens in the home, never signed out, when the home's sign-ins cannot be read now, and carries them next time", async () => {
    const home = memorySignIns("unreadable");
    const cloud = browser({ signIns: home.store });
    expect(await cloud.open(request())).toEqual({ home: "sign-ins" });
    expect(cloud.active("bot-scout")).toBeNull();
    expect(cloud.report().fallbacks).toMatchObject({ "sign-ins": 1 });
    home.change({ cookies: [SIGNED_IN], origins: [] });
    urlOf(await cloud.open(request()));
    expect(fake.cookies.get(profileKey("scout"))).toHaveLength(1);
  });

  it("writes the sandbox's sign-ins back to the home on a clean close, so a browser that falls back to the home is signed in too", async () => {
    const home = memorySignIns(null);
    const cloud = browser({ signIns: home.store });
    urlOf(await cloud.open(request()));
    // The person signs in on a site in the sandbox.
    fake.cookies.set(profileKey("scout"), [{ name: "auth", value: "new", domain: "mail.example", path: "/", secure: true }]);
    clock += CLOUD_BROWSER_IDLE_MS;
    await cloud.closeIdle();
    expect(home.writes).toHaveLength(1);
    expect(home.writes[0]).toEqual([expect.objectContaining({ name: "auth", value: "new", domain: "mail.example" })]);
    // Written back, not carried in again on the next open.
    const sets = fake.commands.filter((one) => one.method === "Storage.setCookies").length;
    urlOf(await cloud.open(request()));
    expect(fake.commands.filter((one) => one.method === "Storage.setCookies").length).toBe(sets);
  });

  it("a sign-in made in the home while the sandbox was unavailable is carried in on the next sandbox use", async () => {
    const home = memorySignIns({ cookies: [SIGNED_IN], origins: [] });
    const cloud = browser({ signIns: home.store });
    urlOf(await cloud.open(request()));
    clock += CLOUD_BROWSER_IDLE_MS;
    await cloud.closeIdle();
    home.change({ cookies: [SIGNED_IN, { ...SIGNED_IN, name: "fallback", domain: "shop.example" }], origins: [] });
    urlOf(await cloud.open(request()));
    expect(fake.cookies.get(profileKey("scout"))?.map((cookie) => cookie.name)).toContain("fallback");
  });

  it("a sign-out in the home stays a sign-out: the home's newer copy replaces the sandbox's cookies, and nothing old is written back", async () => {
    const home = memorySignIns({ cookies: [SIGNED_IN], origins: [] });
    const cloud = browser({ signIns: home.store });
    urlOf(await cloud.open(request()));
    clock += CLOUD_BROWSER_IDLE_MS;
    await cloud.closeIdle();
    // The person uses "Sign out of all sites" in Settings: the home's copy is now empty, and newer.
    home.change({ cookies: [], origins: [] });
    urlOf(await cloud.open(request()));
    expect(fake.cookies.get(profileKey("scout")), "the sandbox's old cookie is gone").toEqual([]);
    const writes = home.writes.length;
    clock += CLOUD_BROWSER_IDLE_MS;
    await cloud.closeIdle();
    expect(home.writes.length, "nothing changed in the session, so nothing is written back").toBe(writes);
    expect(home.store.load("bot-scout")).toMatchObject({ state: { cookies: [] } });
  });

  it("a replaced sandbox gets the home's copy carried in, and a profile that lost its cookies never empties the home", async () => {
    const home = memorySignIns({ cookies: [SIGNED_IN], origins: [] });
    const cloud = browser({ signIns: home.store });
    urlOf(await cloud.open(request()));
    clock += CLOUD_BROWSER_IDLE_MS;
    await cloud.closeIdle();
    // The same sandbox, its profile emptied (Chrome lost its cookies): the home's copy is not newer, so nothing is carried,
    // and the close writes back only what the session itself changed.
    fake.cookies.set(profileKey("scout"), []);
    urlOf(await cloud.open(request()));
    clock += CLOUD_BROWSER_IDLE_MS;
    await cloud.closeIdle();
    expect(home.store.load("bot-scout")).toMatchObject({ state: { cookies: [expect.objectContaining({ name: "sid" })] } });
    // A new sandbox (the provider broke the old one): its empty profile gets the home's copy.
    fake.state = "error";
    urlOf(await cloud.open(request()));
    expect(fake.boxId).not.toBe("bx_23456789");
    expect(fake.cookies.get(profileKey("scout"))).toEqual([expect.objectContaining({ name: "sid", value: "s1" })]);
  });

  it("writes back only the cookies the session changed: one the session never touched stays as the home has it", async () => {
    const home = memorySignIns({ cookies: [SIGNED_IN, { ...SIGNED_IN, name: "keep", domain: "keep.example", value: "home" }], origins: [] });
    const cloud = browser({ signIns: home.store });
    urlOf(await cloud.open(request()));
    const key = profileKey("scout");
    // In the session: one cookie changed, one signed out of, one new.
    fake.cookies.set(key, [{ name: "sid", value: "s2", domain: ".example.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
      { name: "new", value: "n", domain: "new.example", path: "/" }]);
    clock += CLOUD_BROWSER_IDLE_MS;
    await cloud.closeIdle();
    const saved = (home.store.load("bot-scout") as { state: { cookies: Array<{ name: string; value: string }> } }).state.cookies;
    expect(saved.map((cookie) => [cookie.name, cookie.value]).sort()).toEqual([["new", "n"], ["sid", "s2"]]);
  });

  it("skips a cookie Chrome refuses instead of failing the carry, never counts it against the sandbox, and does not carry the same copy again", async () => {
    const broken = { ...SIGNED_IN, name: "bad", domain: "bad.example", sameSite: "None", secure: false };
    const lines: string[] = [];
    const home = memorySignIns({ cookies: [SIGNED_IN, broken], origins: [] });
    const cloud = browser({ signIns: home.store, log: (line) => lines.push(line) });
    urlOf(await cloud.open(request()));
    expect(fake.cookies.get(profileKey("scout"))?.map((cookie) => cookie.name)).toEqual(["sid"]);
    expect(lines.join("\n")).toContain("1 refused by Chrome");
    expect(cloud.report().held).toBeNull();
    clock += CLOUD_BROWSER_IDLE_MS;
    await cloud.closeIdle();
    const carries = fake.commands.filter((one) => one.method === "Storage.clearCookies").length;
    urlOf(await cloud.open(request()));
    expect(fake.commands.filter((one) => one.method === "Storage.clearCookies").length, "the same copy is not carried again").toBe(carries);
  });

  it("when Chrome takes nothing of the home's copy, opens in the home, never as a sandbox failure, and wakes the sandbox for it again only once the copy changes", async () => {
    fake.failing.add("Storage.clearCookies");
    const home = memorySignIns({ cookies: [SIGNED_IN], origins: [] });
    const cloud = browser({ signIns: home.store });
    expect(await cloud.open(request())).toEqual({ home: "sign-ins" });
    expect(cloud.report().held, "no back-off for anyone").toBeNull();
    fake.state = "archived";
    const asked = fake.requests.length;
    expect(await cloud.open(request())).toEqual({ home: "sign-ins" });
    expect(fake.requests.length, "no wake for the same refused copy").toBe(asked);
    fake.failing.clear();
    home.change({ cookies: [SIGNED_IN], origins: [] });
    urlOf(await cloud.open(request()));
  });

  it("writes a long session's changed sign-ins home every 10 minutes, so an unclean end loses minutes at most", async () => {
    const home = memorySignIns(null);
    const cloud = browser({ signIns: home.store });
    const cdpUrl = urlOf(await cloud.open(request()));
    // A long turn holds the browser all along.
    held = true;
    clock += SIGN_IN_SYNC_MS;
    await act(cdpUrl, 1);
    await cloud.closeIdle();
    expect(home.writes, "nothing changed yet").toEqual([]);
    fake.cookies.set(profileKey("scout"), [{ name: "auth", value: "a", domain: "mail.example", path: "/" }]);
    clock += SIGN_IN_SYNC_MS;
    await act(cdpUrl, 1);
    await cloud.closeIdle();
    expect(home.writes).toEqual([[expect.objectContaining({ name: "auth" })]]);
    expect(cloud.active("bot-scout"), "the session goes on").toBe(cdpUrl);
  });

  it("sends ttlSeconds only as a whole number within the Admin's range", () => {
    expect(ttlSecondsOf(1200)).toBe(1200);
    expect(ttlSecondsOf(1199.6)).toBe(1200);
    expect(ttlSecondsOf(Number.NaN)).toBe(300);
    expect(ttlSecondsOf(10)).toBe(300);
    expect(ttlSecondsOf(1e9)).toBe(1800);
  });

  it("keeps a cookie's partition, saved as an object or as a site's text", () => {
    expect(cookieParam({ ...SIGNED_IN, partitionKey: "https://top.example" })).toMatchObject({ partitionKey: "https://top.example" });
    expect(cookieParam({ ...SIGNED_IN, partitionKey: { topLevelSite: "https://top.example", hasCrossSiteAncestor: false } }))
      .toMatchObject({ partitionKey: { topLevelSite: "https://top.example", hasCrossSiteAncestor: false } });
  });

  it("a sign-in the sandbox kept through a stop with no clean close (the auto-stop, the Admin's stop) reaches the home at the next open", async () => {
    const home = memorySignIns({ cookies: [SIGNED_IN], origins: [] });
    const cloud = browser({ signIns: home.store });
    urlOf(await cloud.open(request()));
    // The person signs in; the sandbox is stopped under the session (its pre-stop hook saved the cookie in the profile),
    // and the home's close finds the sandbox gone, so nothing is written home then.
    const key = profileKey("scout");
    const made = { name: "ttl3b", value: "1", domain: "mail.example", path: "/", expires: 2_000_000_000 };
    fake.cookies.set(key, [...fake.cookies.get(key) ?? [], made]);
    fake.state = "archived";
    await cloud.failed("bot-scout");
    expect(home.writes, "nothing went home at that close").toEqual([]);
    // The next open (a resume onto a new machine: the session cookie is gone, the persistent ones are on disk).
    fake.cookies.set(key, (fake.cookies.get(key) ?? []).filter((cookie) => cookie.expires !== undefined));
    urlOf(await cloud.open(request()));
    const saved = (home.store.load("bot-scout") as { state: { cookies: Array<{ name: string }> } }).state.cookies.map((cookie) => cookie.name).sort();
    expect(saved).toEqual(["sid", "ttl3b"]);
    expect(fake.cookies.get(key)?.map((cookie) => cookie.name).sort(), "and the sandbox has both").toEqual(["sid", "ttl3b"]);
  });

  it("a carry-in never deletes a newer sandbox cookie the home never saw, while a sign-out made in the home still wins", async () => {
    const other = { ...SIGNED_IN, name: "other", domain: "other.example" };
    const home = memorySignIns({ cookies: [SIGNED_IN, other], origins: [] });
    const cloud = browser({ signIns: home.store });
    urlOf(await cloud.open(request()));
    const key = profileKey("scout");
    fake.cookies.set(key, [...fake.cookies.get(key) ?? [], { name: "fresh", value: "f", domain: "fresh.example", path: "/", expires: 2_000_000_000 }]);
    fake.state = "archived";
    await cloud.failed("bot-scout");
    // Meanwhile, in the home, the person signs out of other.example: the home's copy changes, and is newer.
    home.change({ cookies: [SIGNED_IN], origins: [] });
    urlOf(await cloud.open(request()));
    expect(fake.cookies.get(key)?.map((cookie) => cookie.name).sort(), "fresh kept, other signed out").toEqual(["fresh", "sid"]);
    expect((home.store.load("bot-scout") as { state: { cookies: Array<{ name: string }> } }).state.cookies.map((cookie) => cookie.name).sort()).toEqual(["fresh", "sid"]);
  });

  it("a cookie Chrome dropped by itself after a carry-in (its per-site limit) is never deleted from the home, and the log says how many it took", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...SIGNED_IN, name: `c${i}`, domain: "capped.example", expires: 2_000_000_000, session: false }));
    const lines: string[] = [];
    const home = memorySignIns({ cookies: many, origins: [] });
    fake.cookieCap = 4;
    const cloud = browser({ signIns: home.store, log: (line) => lines.push(line) });
    urlOf(await cloud.open(request()));
    expect(lines.join("\n")).toContain("carried 4 of 6 saved cookies");
    // The person signs in somewhere else in the session; the close writes that back, and nothing of the 6 is lost.
    const key = profileKey("scout");
    fake.cookies.set(key, [...fake.cookies.get(key) ?? [], { name: "new", value: "n", domain: "new.example", path: "/", expires: 2_000_000_000 }]);
    clock += CLOUD_BROWSER_IDLE_MS;
    await cloud.closeIdle();
    const saved = (home.store.load("bot-scout") as { state: { cookies: Array<{ name: string }> } }).state.cookies.map((cookie) => cookie.name).sort();
    expect(saved).toEqual(["c0", "c1", "c2", "c3", "c4", "c5", "new"]);
    // And the next open does not carry the dropped ones again at every open.
    const sets = fake.commands.filter((one) => one.method === "Storage.clearCookies").length;
    urlOf(await cloud.open(request()));
    expect(fake.commands.filter((one) => one.method === "Storage.clearCookies").length).toBe(sets);
  });

  it("never puts a cookie value in the log", async () => {
    const lines: string[] = [];
    const cloud = browser({ signIns: memorySignIns({ cookies: [SIGNED_IN], origins: [] }).store, log: (line) => lines.push(line) });
    urlOf(await cloud.open(request()));
    clock += CLOUD_BROWSER_IDLE_MS;
    await cloud.closeIdle();
    expect(lines.join("\n")).not.toContain("s1");
  });
});

describe("downloads and uploads of a browser in the sandbox", () => {
  let folder: string;
  beforeEach(() => { folder = mkdtempSync(join(tmpdir(), "bot-folder-")); });
  afterEach(() => { rmSync(folder, { recursive: true, force: true }); });

  const downloadPath = (guid: string) => `/home/user/.omb-browser/.downloads/${profileKey("scout")}/${guid}`;
  const finish = async (guid: string, name: string, bytes: Buffer) => {
    fake.files.set(downloadPath(guid), bytes);
    fake.emit(profileKey("scout"), "Browser.downloadWillBegin", { guid, suggestedFilename: name, url: "https://files.example/x" });
    fake.emit(profileKey("scout"), "Browser.downloadProgress", { guid, totalBytes: bytes.length, receivedBytes: bytes.length, state: "completed" });
  };

  it("sends each finished download to the bot's working folder with its bytes, removes it from the sandbox, and tells the bot", async () => {
    const cloud = browser({ folder: () => folder });
    urlOf(await cloud.open(request()));
    expect(fake.commands.find((one) => one.method === "Browser.setDownloadBehavior")?.params)
      .toEqual({ behavior: "allowAndName", downloadPath: `/home/user/.omb-browser/.downloads/${profileKey("scout")}`, eventsEnabled: true });
    const bytes = Buffer.from("%PDF-1.7 report bytes");
    await finish("0f3e2a1b-guid", "report.pdf", bytes);
    await vi.waitFor(() => expect(existsSync(join(folder, "downloads", "report.pdf"))).toBe(true));
    expect(readFileSync(join(folder, "downloads", "report.pdf"))).toEqual(bytes);
    await vi.waitFor(() => expect(fake.files.has(downloadPath("0f3e2a1b-guid"))).toBe(false));
    expect(cloud.takeNotes("bot-scout")).toEqual([`Downloaded "report.pdf" into your working folder as ${join("downloads", "report.pdf")} (${bytes.length} bytes).`]);
    expect(cloud.takeNotes("bot-scout")).toEqual([]);
    // A second file of the same name is kept beside it, as a browser names a second copy.
    await finish("1a2b3c4d-guid", "report.pdf", Buffer.from("second"));
    await vi.waitFor(() => expect(existsSync(join(folder, "downloads", "report (2).pdf"))).toBe(true));
  });

  it("cancels a download over the in-home browser's size limit and says so", async () => {
    const cloud = browser({ folder: () => folder });
    urlOf(await cloud.open(request()));
    fake.emit(profileKey("scout"), "Browser.downloadWillBegin", { guid: "big-guid", suggestedFilename: "huge.iso" });
    fake.emit(profileKey("scout"), "Browser.downloadProgress", { guid: "big-guid", totalBytes: 2 * 1024 ** 3, receivedBytes: 10, state: "inProgress" });
    await vi.waitFor(() => expect(fake.commands.some((one) => one.method === "Browser.cancelDownload" && one.params.guid === "big-guid")).toBe(true));
    expect(cloud.takeNotes("bot-scout")).toEqual([`"huge.iso" was not downloaded: it is over 1 GiB, the most a browser download keeps.`]);
  });

  it("keeps a download it could not bring over in the sandbox, says so, and tries it again when the browser closes", async () => {
    let available = false;
    const cloud = browser({ folder: () => (available ? folder : null) });
    urlOf(await cloud.open(request()));
    await finish("retry-guid", "data.csv", Buffer.from("a,b\n1,2\n"));
    await vi.waitFor(() => expect(cloud.takeNotes("bot-scout")).toEqual([expect.stringContaining(`"data.csv" was downloaded in the browser but could not be brought to your working folder`)]));
    expect(fake.files.has(downloadPath("retry-guid")), "kept in the sandbox").toBe(true);
    available = true;
    await cloud.close("bot-scout");
    expect(readFileSync(join(folder, "downloads", "data.csv"), "utf8")).toBe("a,b\n1,2\n");
    expect(fake.files.has(downloadPath("retry-guid"))).toBe(false);
  });

  it("keeps a download in the sandbox when the Cloud's disk would be left with less than 1 GiB or 10% free", async () => {
    const cloud = browser({ folder: () => folder, disk: () => ({ free: 1.5 * 1024 ** 3, total: 10 * 1024 ** 3 }) });
    urlOf(await cloud.open(request()));
    fake.files.set(downloadPath("full-guid"), Buffer.alloc(16));
    fake.emit(profileKey("scout"), "Browser.downloadWillBegin", { guid: "full-guid", suggestedFilename: "movie.mp4" });
    fake.emit(profileKey("scout"), "Browser.downloadProgress", { guid: "full-guid", totalBytes: 600 * 1024 ** 2, receivedBytes: 600 * 1024 ** 2, state: "completed" });
    await vi.waitFor(() => expect(cloud.takeNotes("bot-scout").join("\n")).toContain("the Cloud's disk is too full for it"));
    expect(fake.files.has(downloadPath("full-guid"))).toBe(true);
  });

  it("brings at most 2 GiB of downloads into the Cloud per session", async () => {
    const cloud = browser({ folder: () => folder, disk: () => ({ free: 100 * 1024 ** 3, total: 200 * 1024 ** 3 }) });
    urlOf(await cloud.open(request()));
    fake.files.set(downloadPath("huge-guid"), Buffer.alloc(8));
    fake.emit(profileKey("scout"), "Browser.downloadWillBegin", { guid: "huge-guid", suggestedFilename: "a.bin" });
    fake.emit(profileKey("scout"), "Browser.downloadProgress", { guid: "huge-guid", totalBytes: SESSION_DOWNLOAD_BYTES + 1, receivedBytes: 10, state: "inProgress" });
    await vi.waitFor(() => expect(fake.commands.some((one) => one.method === "Browser.cancelDownload")).toBe(true));
  });

  it("a last retry's line at close reaches the session's next call", async () => {
    let available = false;
    const cloud = browser({ folder: () => (available ? folder : null) });
    urlOf(await cloud.open(request()));
    await finish("late-guid", "late.txt", Buffer.from("x"));
    await vi.waitFor(() => expect(cloud.takeNotes("bot-scout")).toHaveLength(1));
    await cloud.close("bot-scout");
    expect(cloud.takeNotes("bot-scout")).toEqual([REOPENED_NOTE, expect.stringContaining(`"late.txt" was downloaded in the browser but could not be brought`)]);
    expect(cloud.takeNotes("bot-scout")).toEqual([]);
    available = true;
  });

  it("gives a page a file from the Cloud by copying it into the sandbox first, and refuses a large one in one line", async () => {
    const cloud = browser();
    urlOf(await cloud.open(request()));
    mkdirSync(join(folder, "in"), { recursive: true });
    writeFileSync(join(folder, "in", "cv.pdf"), "my cv");
    const given = await cloud.upload("bot-scout", join(folder, "in", "cv.pdf"), "Résumé.pdf", 5);
    const path = `/home/user/.omb-browser/.uploads/${profileKey("scout")}/Résumé.pdf`;
    expect(given).toEqual({ path });
    expect(fake.files.get(path)?.toString()).toBe("my cv");
    expect(await cloud.upload("bot-scout", join(folder, "in", "cv.pdf"), null, UPLOAD_MAX_BYTES + 1))
      .toEqual({ error: "cv.pdf is over 50 MiB, which this browser can't take from the Cloud yet. Tell the person in one sentence and ask them to upload it themselves." });
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
