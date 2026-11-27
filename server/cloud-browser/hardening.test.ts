// What the home keeps from a browser sandbox it does not control: the sign-ins it writes back, the addresses a call opens,
// a deleted bot's profile in a sandbox that sleeps, and a sandbox that can never resume. Only the fake relay and provider
// (testing/fake-computer.ts) and temporary folders: never a real sandbox or provider.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { signInsBackupFile } from "../browser-engine.ts";
import { decryptBrowserState, readSignIns, signOutOfSites, writeSignIns } from "../browser-sites.ts";
import { RuntimeRouter } from "../browser/engines.ts";
import type { BrowserRuntime } from "../browser-runtime.ts";
import type { ChromeEngine } from "../browser/engines.ts";
import { SIGN_IN_SYNC_MS, type SignInStore } from "./companion.ts";
import { addressGuard, PRIVATE_ADDRESS_REFUSAL } from "./guards.ts";
import { CLOUD_BROWSER_IDLE_MS, createCloudBrowser, REOPENED_NOTE, type CloudBrowserDeps } from "./index.ts";
import { createCloudBrowserRails } from "./rails.ts";
import { profileKey, providerOps } from "./remote.ts";
import type { SavedCookie } from "./sign-ins.ts";
import { MASS_REMOVAL_MIN, MAX_COOKIE_BYTES, MAX_SIGN_IN_BYTES, mergeAtOpen, mergeInSession, openMerge, prints, writeBack } from "./sync.ts";
import { RELAY_KEY, startFakeComputer, type FakeComputer } from "./testing/fake-computer.ts";

let fake: FakeComputer;
let dir: string;
let clock: number;
let used: Array<[string, number]>;
let lines: string[];
let browsers: ReturnType<typeof createCloudBrowser>[];

beforeEach(async () => {
  fake = await startFakeComputer();
  vi.stubEnv("OMB_CLOUD_BOAT_URL", `${fake.base}/api/v1`);
  vi.stubEnv("OMB_CLOUD_BOAT_TOKEN", RELAY_KEY);
  vi.stubEnv("OMB_CLOUD_BROWSER", undefined);
  dir = mkdtempSync(join(tmpdir(), "cloud-browser-hardening-"));
  clock = Date.UTC(2026, 10, 27, 10, 0, 0);
  used = [];
  lines = [];
  browsers = [];
});

afterEach(async () => {
  for (const browser of browsers) browser.closeAll();
  vi.unstubAllEnvs();
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

function browser(overrides: Partial<CloudBrowserDeps> & { budget?: number } = {}) {
  const now = () => clock;
  const { budget, ...rest } = overrides;
  const created = createCloudBrowser({
    dataDir: dir,
    ops: () => providerOps(() => ({}) as AppConfig),
    used: (owner, windowMs) => { used.push([owner, windowMs]); },
    closeEngine: async () => undefined,
    held: () => false,
    now,
    log: (line) => lines.push(line),
    pollMs: 5,
    rails: createCloudBrowserRails({ dataDir: dir, now, ...(budget ? { budget } : {}) }),
    disk: () => ({ free: 100 * 1024 ** 3, total: 200 * 1024 ** 3 }),
    ...rest,
  });
  browsers.push(created);
  return created;
}

const request = (botId = "scout") => ({ session: `bot-${botId}`, botId, refusal: null });
const urlOf = (opened: { cdpUrl: string } | { home: string }): string => {
  if (!("cdpUrl" in opened)) throw new Error(`expected the sandbox, got ${opened.home}`);
  return opened.cdpUrl;
};
const deletes = () => fake.requests.filter((one) => one.method === "DELETE");

/** The home's saved sign-ins in memory, as the restore file holds them; `writes` is what each save was given. */
function memorySignIns(initial: { cookies: unknown[]; origins: unknown[] } | null) {
  let saved = initial;
  let modified = initial ? 1_000 : 0;
  const writes: unknown[][] = [];
  const store: SignInStore = {
    load: () => (saved === null ? null : { state: saved, modified }),
    save: (_session, cookies) => { writes.push(cookies); saved = { cookies, origins: saved?.origins ?? [] }; modified += 1; return modified; },
  };
  return { store, writes, cookies: () => (saved?.cookies ?? []) as SavedCookie[] };
}

const cookie = (name: string, domain: string, value = "v"): SavedCookie => ({ name, value, domain, path: "/", secure: true });
/** A home signed in on many sites, as a bot that browses daily is. */
const manySites = (count: number) => Array.from({ length: count }, (_, i) => cookie(`sid${i}`, `site${i}.example`, `value${i}`));
/** The sandbox Chrome's cookies for a profile, as a page (or whoever controls that Chrome) left them. */
const holds = (key: string, cookies: SavedCookie[]) => fake.cookies.set(key, cookies.map((one) => ({ ...one }) as Record<string, unknown>));
/** What Chrome hands back for a cookie it holds: its own shape, as the fake reports it. */
const asChrome = (one: SavedCookie) => ({ ...one, size: 1, session: true, expires: -1 });

/** Ends the session cleanly, so its sign-ins are written back. */
async function closeSession(cloud: ReturnType<typeof browser>) {
  clock += CLOUD_BROWSER_IDLE_MS;
  await cloud.closeIdle();
}

describe("what the sandbox writes back into the home's sign-ins", () => {
  it("a normal session's write-back is exactly what it was before these bounds", () => {
    const home = [cookie("sid", ".example.com", "s1"), cookie("keep", "keep.example", "home"), cookie("gone", "gone.example")];
    const baseline = home.map(asChrome);
    const current = [asChrome(cookie("sid", ".example.com", "s2")), asChrome(cookie("keep", "keep.example", "home")), asChrome(cookie("new", "new.example", "n"))];
    const last = { home: prints(home), sandbox: prints(baseline) };
    for (const state of [last, null]) {
      expect(JSON.stringify(writeBack(home, baseline, current, state))).toBe(JSON.stringify(mergeInSession(home, baseline, current, state)));
      expect(JSON.stringify(openMerge(home, current, state))).toBe(JSON.stringify(mergeAtOpen(home, current, state)));
    }
    // A site's own sign-out removes its few cookies, even from a small home.
    const signedOut = baseline.filter((one) => one.name !== "gone");
    expect(writeBack(home, baseline, signedOut, last)).toEqual(mergeInSession(home, baseline, signedOut, last));
  });

  it("a normal session through the sandbox saves byte for byte what the old merge gives", async () => {
    const start = [cookie("sid", ".example.com", "s1"), cookie("keep", "keep.example", "home")];
    const home = memorySignIns({ cookies: start, origins: [] });
    const cloud = browser({ signIns: home.store });
    urlOf(await cloud.open(request()));
    const key = profileKey("scout");
    const baseline = (fake.cookies.get(key) ?? []).map((one) => asChrome(one as unknown as SavedCookie));
    const changed = [{ name: "sid", value: "s2", domain: ".example.com", path: "/", secure: true }, { name: "new", value: "n", domain: "new.example", path: "/" }];
    fake.cookies.set(key, changed);
    const expected = mergeInSession(start, baseline, changed.map((one) => asChrome(one as SavedCookie)), { home: prints(start), sandbox: prints(baseline) }).merged;
    await closeSession(cloud);
    expect(home.writes).toHaveLength(1);
    expect(JSON.stringify(home.writes[0])).toBe(JSON.stringify(expected));
  });

  it("refuses an empty cookie list that would wipe the home: the home keeps its set, says so once, and carries it back in at the next open", async () => {
    const home = memorySignIns({ cookies: manySites(20), origins: [] });
    const cloud = browser({ signIns: home.store });
    urlOf(await cloud.open(request()));
    const key = profileKey("scout");
    expect(fake.cookies.get(key)).toHaveLength(20);
    fake.cookies.set(key, []);
    await closeSession(cloud);
    expect(home.writes, "nothing written: the home's copy is exactly as it was").toEqual([]);
    expect(home.cookies()).toEqual(manySites(20));
    expect(lines.filter((line) => line.includes("kept the home's sign-ins"))).toEqual([
      "browser bot-scout: kept the home's sign-ins as they were: the browser sandbox's cookies would have removed 20 of them at once",
    ]);
    // The next open finds the sandbox without them, and the home's copy goes in again.
    urlOf(await cloud.open(request()));
    expect(fake.cookies.get(key)).toHaveLength(20);
  });

  it("a refused session says so once, and writes nothing while the removal stands", async () => {
    const home = memorySignIns({ cookies: manySites(30), origins: [] });
    // A long turn holds the browser: its sign-ins are written home every 10 minutes while it stays open.
    const cloud = browser({ signIns: home.store, held: () => true });
    urlOf(await cloud.open(request()));
    const key = profileKey("scout");
    holds(key, [cookie("attacker", "site0.example")]);
    clock += SIGN_IN_SYNC_MS;
    await cloud.closeIdle();
    clock += SIGN_IN_SYNC_MS;
    await cloud.closeIdle();
    expect(cloud.active("bot-scout"), "the session goes on").not.toBeNull();
    await cloud.close("bot-scout");
    expect(home.writes).toEqual([]);
    expect(lines.filter((line) => line.includes("kept the home's sign-ins"))).toHaveLength(1);
  });

  it("removes a handful, or half of a small home, as before: the bound is more than half and more than a handful", () => {
    const home = manySites(MASS_REMOVAL_MIN * 4);
    const baseline = home.map(asChrome);
    const last = { home: prints(home), sandbox: prints(baseline) };
    const fewer = (removed: number) => baseline.slice(removed);
    expect(writeBack(home, baseline, fewer(MASS_REMOVAL_MIN * 2), last), "half, not more").not.toHaveProperty("refused");
    expect(writeBack(home, baseline, fewer(MASS_REMOVAL_MIN * 2 + 1), last)).toEqual({ refused: "mass-removal", removed: MASS_REMOVAL_MIN * 2 + 1 });
    const small = manySites(MASS_REMOVAL_MIN);
    expect(writeBack(small, small.map(asChrome), [], { home: prints(small), sandbox: prints(small) }), "all of a handful").not.toHaveProperty("refused");
  });

  it("never brings home a cookie no real Chrome holds, and keeps the home's value of one replaced by such a cookie", async () => {
    const home = memorySignIns({ cookies: [cookie("sid", ".example.com", "s1")], origins: [] });
    const cloud = browser({ signIns: home.store });
    urlOf(await cloud.open(request()));
    const huge = "x".repeat(MAX_COOKIE_BYTES);
    holds(profileKey("scout"), [cookie("sid", ".example.com", huge), cookie("new", "new.example", huge), cookie("fine", "fine.example", "ok")]);
    await closeSession(cloud);
    expect(home.cookies().map((one) => [one.name, one.value])).toEqual([["sid", "s1"], ["fine", "ok"]]);
  });

  it("never grows the home's copy past its cap, at a write-back or at an open", () => {
    const home = [cookie("sid", ".example.com")];
    const big = Array.from({ length: Math.ceil(MAX_SIGN_IN_BYTES / 4_000) + 1 }, (_, i) => asChrome(cookie(`c${i}`, `s${i}.example`, "y".repeat(3_990))));
    expect(writeBack(home, home.map(asChrome), [...home.map(asChrome), ...big], { home: prints(home), sandbox: prints(home) })).toEqual({ refused: "too-large", removed: 0 });
    expect(openMerge(home, big, null)).toEqual({ merged: home, fromSandbox: 0 });
  });

  it("keeps the copy a write-back replaces as one encrypted backup, which a sign-out removes too", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-sign-ins-backup-"));
    try {
      const directory = join(home, ".agent-browser", "sessions");
      const key = "a".repeat(64);
      writeSignIns(directory, "bot-scout", key, [cookie("first", "a.example")]);
      const backup = join(directory, signInsBackupFile("bot-scout"));
      expect(existsSync(backup), "nothing to keep before the first write").toBe(false);
      writeSignIns(directory, "bot-scout", key, [cookie("second", "b.example")]);
      expect(readFileSync(backup).toString("utf8")).not.toContain("first");
      expect(JSON.parse(decryptBrowserState(readFileSync(backup), key)).cookies).toEqual([cookie("first", "a.example")]);
      expect(readSignIns(directory, "bot-scout", key), "the restore file is the new copy").toMatchObject({ state: { cookies: [cookie("second", "b.example")] } });
      await signOutOfSites({ binaryPath: "/fake/agent-browser", session: "bot-scout", env: { HOME: home, USERPROFILE: home }, encryptionKey: key }, null, { engine: async () => null });
      expect(existsSync(backup)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the addresses a call in the sandbox may open", () => {
  const open = (url: string) => ({ name: "agent_browser_open", arguments: { url } });
  const answers: Record<string, string[]> = { "public.example": ["93.184.215.14"], "rebind.example": ["93.184.215.14", "10.0.0.5"], "loop.example": ["127.0.0.1"] };
  const resolve = vi.fn(async (host: string) => answers[host] ?? Promise.reject(new Error("ENOTFOUND")));

  it("refuses loopback, link-local, private, metadata and reserved addresses however they are written", async () => {
    const guard = addressGuard(resolve);
    for (const url of ["http://127.0.0.1:9222/json/list", "127.1:9222", "http://2130706433/", "http://0x7f.1/", "http://[::1]:9222/", "http://[::ffff:127.0.0.1]/",
      "http://169.254.169.254/latest/meta-data/", "http://100.100.100.200/", "http://[fd00:ec2::254]/", "http://10.1.2.3/", "https://192.168.0.1/", "http://172.16.0.9/",
      "http://100.64.0.1/", "http://[fdaa::1]/", "http://[fe80::1]/", "http://0.0.0.0:8080/", "ws://127.0.0.1:39231/x"]) {
      expect(await guard(open(url)), url).toBe(PRIVATE_ADDRESS_REFUSAL);
    }
  });

  it("refuses names that are never a public site, and names the home resolves to such an address", async () => {
    const guard = addressGuard(resolve);
    for (const url of ["http://localhost:9222/", "https://LOCALHOST./", "http://app.localhost/", "http://metadata.google.internal/computeMetadata/v1/", "http://metadata/",
      "http://router/", "http://printer.local/", "http://db.internal/", "https://rebind.example/", "https://loop.example/"]) {
      expect(await guard(open(url)), url).toBe(PRIVATE_ADDRESS_REFUSAL);
    }
    expect(await guard({ name: "agent_browser_tab_new", arguments: { options: { url: "http://127.0.0.1/" } } }), "however deep").toBe(PRIVATE_ADDRESS_REFUSAL);
  });

  it("opens public sites, and never refuses text a page is given", async () => {
    const guard = addressGuard(resolve);
    expect(await guard(open("https://public.example/path"))).toBeNull();
    expect(await guard(open("public.example"))).toBeNull();
    expect(await guard(open("https://93.184.215.14/"))).toBeNull();
    expect(await guard(open("about:blank"))).toBeNull();
    expect(await guard({ name: "agent_browser_fill", arguments: { selector: "#q", text: "http://127.0.0.1:9222" } })).toBeNull();
    expect(await guard({ name: "agent_browser_snapshot", arguments: {} })).toBeNull();
  });

  it("goes ahead when the home cannot resolve a name, or not in time, and asks its resolver once a minute per name", async () => {
    let now = 0;
    const slow = vi.fn((host: string) => (host === "slow.example" ? new Promise<string[]>(() => {}) : resolve(host)));
    const guard = addressGuard(slow, () => now, 20);
    expect(await guard(open("https://unknown.example/"))).toBeNull();
    expect(await guard(open("https://slow.example/"))).toBeNull();
    await guard(open("https://rebind.example/a"));
    await guard(open("https://rebind.example/b"));
    expect(slow.mock.calls.filter(([host]) => host === "rebind.example")).toHaveLength(1);
    now += 60_000;
    await guard(open("https://rebind.example/c"));
    expect(slow.mock.calls.filter(([host]) => host === "rebind.example")).toHaveLength(2);
  });

  it("is asked only for a session it checks, before the call reaches the engine", async () => {
    const reached: unknown[] = [];
    const old = { agentRpc: vi.fn(async (_session: string, _spec: unknown, _method: string, params: unknown) => { reached.push(params); return "agent-browser"; }) };
    const guard = addressGuard(resolve);
    const runtime = new RuntimeRouter(old as unknown as BrowserRuntime, {} as ChromeEngine, { vet: (session, _spec, params) => (session === "sandbox" ? guard(params) : null) });
    const spec = { command: "/opt/agent-browser", args: [], env: {} };
    expect(await runtime.agentRpc("sandbox", spec, "tools/call", open("http://127.0.0.1:9222/json"))).toEqual({ isError: true, content: [{ type: "text", text: PRIVATE_ADDRESS_REFUSAL }] });
    expect(reached).toEqual([]);
    expect(await runtime.agentRpc("home", spec, "tools/call", open("http://127.0.0.1:3000/"))).toBe("agent-browser");
    expect(await runtime.agentRpc("sandbox", spec, "tools/call", open("https://public.example/"))).toBe("agent-browser");
  });
});

describe("a deleted bot's profile in a sandbox that sleeps", () => {
  /** Opens each bot's browser once (its profile and sign-ins in the sandbox), then lets the sandbox sleep. */
  async function profiles(cloud: ReturnType<typeof browser>, bots: string[]) {
    for (const bot of bots) urlOf(await cloud.open(request(bot)));
    await closeSession(cloud);
    fake.state = "archived";
  }

  it("deletes the whole sandbox when the last bot with a profile in it is deleted, without waking it", async () => {
    const cloud = browser({ signIns: memorySignIns(null).store });
    await profiles(cloud, ["scout"]);
    await cloud.erase("scout");
    await cloud.erased();
    expect(deletes()).toHaveLength(1);
    expect(fake.resumes(), "never woken for it").toBe(0);
    expect(lines).toContain("browser sandbox: deleted: no bot with a browser profile is left in it");
    // The next browser makes a fresh sandbox; nothing is left to erase.
    urlOf(await cloud.open(request("writer")));
    expect(fake.creates()).toBe(1);
    expect(fake.erased).toEqual([]);
  });

  it("wakes the sandbox once to erase it while other bots keep profiles there, and lets it sleep again", async () => {
    const cloud = browser({ signIns: memorySignIns(null).store });
    await profiles(cloud, ["scout", "writer"]);
    used = [];
    await cloud.erase("scout");
    await cloud.erased();
    expect(fake.erased).toEqual([profileKey("scout")]);
    expect(fake.resumes()).toBe(1);
    expect(deletes()).toEqual([]);
    expect(used.at(-1), "asked to sleep once the erase is done").toEqual(["browser", 1_000]);
    expect(cloud.busy("browser")).toBe(false);
  });

  it("when no start may be sent now, keeps the erase for the next wake", async () => {
    const cloud = browser({ signIns: memorySignIns(null).store, budget: 1 });
    fake.state = "archived";
    urlOf(await cloud.open(request("scout")));
    urlOf(await cloud.open(request("writer")));
    await closeSession(cloud);
    fake.state = "archived";
    await cloud.erase("scout");
    await cloud.erased();
    expect(fake.resumes(), "the day's one start was spent").toBe(1);
    expect(fake.erased).toEqual([]);
    clock += 24 * 60 * 60_000;
    urlOf(await cloud.open(request("writer")));
    expect(fake.erased).toEqual([profileKey("scout")]);
  });

  it("a bot that never had a profile there wakes nothing and deletes nothing", async () => {
    const cloud = browser({ signIns: memorySignIns(null).store });
    await profiles(cloud, ["scout"]);
    await cloud.erase("writer");
    await cloud.erased();
    expect(fake.resumes()).toBe(0);
    expect(deletes()).toEqual([]);
  });
});

describe("a sandbox that can never resume", () => {
  it("is replaced at once by a fresh one under one counted start, with no back-off and no word to the bot but the reopened note", async () => {
    const cloud = browser({ signIns: memorySignIns({ cookies: [cookie("sid", ".example.com", "s1")], origins: [] }).store });
    urlOf(await cloud.open(request()));
    const first = fake.boxId;
    // Stopped under the session (a plan's sandbox that keeps nothing): the session ends, and its next call opens again.
    fake.state = "archived";
    fake.resumeGone = true;
    await cloud.failed("bot-scout");
    expect(cloud.takeNotes("bot-scout")).toEqual([REOPENED_NOTE]);
    urlOf(await cloud.open(request()));
    expect(fake.boxId).not.toBe(first);
    expect(deletes().map((one) => one.path)).toEqual([`/api/v1/sandboxes/${first}`]);
    expect(fake.resumes()).toBe(1);
    expect(fake.creates()).toBe(1);
    expect(cloud.report()).toMatchObject({ resumes: 1, held: null, fallbacks: {} });
    // The fresh, empty profile gets the home's copy.
    expect(fake.cookies.get(profileKey("scout"))).toEqual([expect.objectContaining({ name: "sid", value: "s1" })]);
    expect(cloud.takeNotes("bot-scout")).toEqual([]);
  });

  it("goes the same way when it is found still stopping", async () => {
    fake.state = "archiving";
    fake.resumeGone = true;
    const cloud = browser();
    urlOf(await cloud.open(request()));
    expect(deletes()).toHaveLength(1);
    expect(fake.creates()).toBe(1);
    expect(cloud.report()).toMatchObject({ resumes: 1, held: null });
  });

  it("every other refusal of a resume is what it was: a 410 without that code is a failed start", async () => {
    fake.state = "archived";
    fake.startStatus = 410;
    fake.startBody = { ok: false, error: { code: "gone", message: "Gone." } };
    const cloud = browser();
    expect(await cloud.open(request())).toEqual({ home: "start-failed" });
    expect(await cloud.open(request())).toEqual({ home: "start-failed" });
    expect(await cloud.open(request())).toEqual({ home: "backoff" });
    expect(deletes()).toEqual([]);
    expect(fake.creates()).toBe(0);
  });
});
