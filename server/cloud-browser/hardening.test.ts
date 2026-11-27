// What the home keeps from a browser sandbox it does not control: the sign-ins it writes back, the addresses a call opens,
// a deleted bot's profile in a sandbox that sleeps, a sandbox that can never resume, and files of a sandbox that takes no
// direct connections. Only the fake relay and provider
// (testing/fake-computer.ts) and temporary folders: never a real sandbox or provider.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { signInsBackupFile } from "../browser-engine.ts";
import { backupSignIns, decryptBrowserState, readSignIns, restoreSignIns, signInBackups, signOutOfSites, writeSignIns } from "../browser-sites.ts";
import { createSignInBackupRoutes } from "../routes/browser-sign-in-backups.ts";
import { RuntimeRouter } from "../browser/engines.ts";
import type { BrowserRuntime } from "../browser-runtime.ts";
import type { ChromeEngine } from "../browser/engines.ts";
import { SIGN_IN_SYNC_MS, type SignInStore } from "./companion.ts";
import { INLINE_READ_MAX_BYTES, INLINE_WRITE_MAX_BYTES } from "../cloud-computer-files.ts";
import { addressGuard, PRIVATE_ADDRESS_REFUSAL, UNREADABLE_ADDRESS_REFUSAL } from "./guards.ts";
import { CLOUD_BROWSER_IDLE_MS, createCloudBrowser, REOPENED_NOTE, type CloudBrowserDeps } from "./index.ts";
import { createCloudBrowserRails } from "./rails.ts";
import { profileKey, providerOps } from "./remote.ts";
import type { SavedCookie } from "./sign-ins.ts";
import { agreed, MAX_COOKIE_BYTES, MAX_SIGN_IN_BYTES, mergeAtOpen, mergeInSession, openMerge, prints, writeBack } from "./sync.ts";
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
  const counts = { backups: 0 };
  const store: SignInStore = {
    load: () => (saved === null ? null : { state: saved, modified }),
    save: (_session, cookies) => { writes.push(cookies); saved = { cookies, origins: saved?.origins ?? [] }; modified += 1; return modified; },
    backup: () => { counts.backups += 1; },
  };
  return { store, writes, cookies: () => (saved?.cookies ?? []) as SavedCookie[], get backups() { return counts.backups; } };
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
      const back = writeBack(home, baseline, current, state);
      expect(JSON.stringify({ merged: back.merged, changed: back.changed })).toBe(JSON.stringify(mergeInSession(home, baseline, current, state)));
      expect(back.dropped).toEqual([]);
      const open = openMerge(home, current, state);
      expect(JSON.stringify({ merged: open.merged, fromSandbox: open.fromSandbox })).toBe(JSON.stringify(mergeAtOpen(home, current, state)));
      expect(open.dropped).toEqual([]);
    }
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

  it("honours a sign-out of a big site: its cookies are gone at home, never carried back in, and the session's new sign-ins come home", async () => {
    const big = Array.from({ length: 14 }, (_, i) => cookie(`s${i}`, ".bigsite.example", `b${i}`));
    const others = manySites(10);
    const home = memorySignIns({ cookies: [...big, ...others], origins: [] });
    const cloud = browser({ signIns: home.store });
    urlOf(await cloud.open(request()));
    const key = profileKey("scout");
    expect(fake.cookies.get(key)).toHaveLength(24);
    // The bot signs out of the big site (14 of the 24 cookies go) and signs in somewhere new.
    holds(key, [...others, cookie("fresh", "new.example", "n1")]);
    await closeSession(cloud);
    expect(home.cookies().map((one) => one.name).sort()).toEqual([...others.map((one) => one.name), "fresh"].sort());
    expect(lines.filter((line) => line.includes("left") && line.includes("out of the home's sign-ins"))).toEqual([]);
    // The next open carries nothing of the big site back into the sandbox.
    urlOf(await cloud.open(request()));
    expect((fake.cookies.get(key) ?? []).some((one) => one.domain === ".bigsite.example")).toBe(false);
    expect((fake.cookies.get(key) ?? []).map((one) => one.name)).toContain("fresh");
  });

  it("keeps one backup of the home's copy as each session opens, and none at a write-back", async () => {
    const home = memorySignIns({ cookies: manySites(3), origins: [] });
    const cloud = browser({ signIns: home.store, held: () => true });
    urlOf(await cloud.open(request()));
    expect(home.backups).toBe(1);
    holds(profileKey("scout"), manySites(2));
    clock += SIGN_IN_SYNC_MS;
    await cloud.closeIdle();
    expect(home.writes, "a periodic write-back went home").toHaveLength(1);
    expect(home.backups, "no backup at a write-back").toBe(1);
    await cloud.close("bot-scout");
    urlOf(await cloud.open(request()));
    expect(home.backups, "one per session").toBe(2);
    // A home with nothing saved yet has nothing to keep.
    const empty = memorySignIns(null);
    const other = browser({ signIns: empty.store });
    await cloud.close("bot-scout");
    urlOf(await other.open(request("writer")));
    expect(empty.backups).toBe(0);
  });

  it("keeps a week of backups, five at most, restores one, and removes them all at a sign-out", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-sign-ins-backup-"));
    try {
      const directory = join(root, ".agent-browser", "sessions");
      const key = "a".repeat(64);
      const day = 24 * 60 * 60_000;
      const start = Date.UTC(2026, 10, 1);
      writeSignIns(directory, "bot-scout", key, [cookie("first", "a.example")]);
      const firstId = backupSignIns(directory, "bot-scout", key, start)!;
      const backup = join(directory, signInsBackupFile("bot-scout", firstId));
      expect(readFileSync(backup).toString("utf8"), "encrypted").not.toContain("first");
      expect(JSON.parse(decryptBrowserState(readFileSync(backup), key)).cookies).toEqual([cookie("first", "a.example")]);
      // A session that wiped the sign-ins, then the owner puts them back.
      writeSignIns(directory, "bot-scout", key, []);
      expect(restoreSignIns(directory, "bot-scout", key, firstId, start + 1_000)).toBe(true);
      expect(readSignIns(directory, "bot-scout", key)).toMatchObject({ state: { cookies: [cookie("first", "a.example")] } });
      expect(signInBackups(directory, "bot-scout").map((one) => one.id), "the wiped copy was kept too, so the restore can be undone").toHaveLength(2);
      expect(restoreSignIns(directory, "bot-scout", key, "1234567890123")).toBe(false);
      // Older than a week, or past five: removed at the next backup.
      for (let i = 1; i <= 7; i++) backupSignIns(directory, "bot-scout", key, start + i * day);
      const kept = signInBackups(directory, "bot-scout");
      expect(kept).toHaveLength(5);
      expect(kept[0]!.takenAt).toBe(start + 7 * day);
      expect(kept.every((one) => one.takenAt >= start + 3 * day)).toBe(true);
      // Another session's backups are its own.
      writeSignIns(directory, "bot-scout-2", key, [cookie("x", "x.example")]);
      backupSignIns(directory, "bot-scout-2", key, start + 7 * day);
      await signOutOfSites({ binaryPath: "/fake/agent-browser", session: "bot-scout", env: { HOME: root, USERPROFILE: root }, encryptionKey: key }, null, { engine: async () => null });
      expect(signInBackups(directory, "bot-scout")).toEqual([]);
      expect(signInBackups(directory, "bot-scout-2")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the owner's routes list a bot's backups and restore one; nobody else's do", async () => {
    const restored: Array<[string, string]> = [];
    const route = createSignInBackupRoutes({
      isOwner: (auth) => (auth as unknown as { owner: boolean }).owner,
      backups: (botId) => (botId === "scout" ? [{ id: "1764200000000", takenAt: 1764200000000, bytes: 512 }] : null),
      restore: async (botId, id) => { restored.push([botId, id]); return botId === "scout" ? (id === "1764200000000" ? "restored" : "no-backup") : "no-bot"; },
    });
    const call = async (method: string, path: string, owner: boolean, body?: unknown) => {
      const replies: Array<{ status: number; body: unknown }> = [];
      await route({ req: {} as never, res: {} as never, url: new URL(`http://x${path}`), path, method, auth: { owner } as never,
        json: ((_res: unknown, status: number, sent: unknown) => { replies.push({ status, body: sent }); }) as never, readBody: (async () => body) as never });
      return replies[0];
    };
    expect(await call("GET", "/api/bots/scout/browser-sign-ins/backups", true)).toEqual({ status: 200, body: { backups: [{ id: "1764200000000", takenAt: "2025-11-26T23:33:20.000Z", bytes: 512 }] } });
    expect((await call("GET", "/api/bots/scout/browser-sign-ins/backups", false))?.status).toBe(403);
    expect((await call("POST", "/api/bots/scout/browser-sign-ins/restore", false, { backup: "1764200000000" }))?.status).toBe(403);
    expect(await call("POST", "/api/bots/scout/browser-sign-ins/restore", true, { backup: "1764200000000" })).toEqual({ status: 200, body: { ok: true } });
    expect((await call("POST", "/api/bots/scout/browser-sign-ins/restore", true, { backup: "nope" }))?.status).toBe(400);
    expect((await call("GET", "/api/bots/ghost/browser-sign-ins/backups", true))?.status).toBe(404);
    expect(restored).toEqual([["scout", "1764200000000"]]);
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

  /** Three hostile domains of 180 cookies of 4 KB each: past the cap together. */
  const flood = () => ["a", "b", "c"].flatMap((site) => Array.from({ length: 180 }, (_, i) => cookie(`f${i}`, `${site}.flood.example`, "y".repeat(4_000))));

  it("past the cap, leaves out the largest cookies of hosts the home never had, and still brings a real sign-in home", async () => {
    const start = [cookie("sid", ".example.com", "s1")];
    const home = memorySignIns({ cookies: start, origins: [] });
    const cloud = browser({ signIns: home.store });
    urlOf(await cloud.open(request()));
    const key = profileKey("scout");
    holds(key, [...start, cookie("session", "bank.example", "signed-in"), ...flood()]);
    await closeSession(cloud);
    const saved = home.cookies();
    expect(saved.map((one) => one.name)).toEqual(expect.arrayContaining(["sid", "session"]));
    const size = saved.reduce((sum, one) => sum + one.name.length + one.value.length, 0);
    expect(size).toBeLessThanOrEqual(MAX_SIGN_IN_BYTES);
    expect(saved.length, "only as many left out as the cap needs").toBeGreaterThan(500);
    expect(lines.filter((line) => line.includes("out of the home's sign-ins"))).toEqual([expect.stringMatching(/^browser bot-scout: left \d+ of the browser sandbox's cookies out of the home's sign-ins/)]);
  });

  it("never records a cookie it left out as agreed, so it is weighed again at the next open", () => {
    const home = [cookie("sid", ".example.com", "s1")];
    const sandbox = [...home, cookie("session", "bank.example", "signed-in"), ...flood()];
    const { merged, dropped } = openMerge(home, sandbox, null);
    expect(merged.map((one) => one.name)).toContain("session");
    expect(dropped.length).toBeGreaterThan(0);
    const recorded = agreed(sandbox, dropped);
    for (const id of dropped) expect(recorded[id]).toBeUndefined();
    expect(Object.keys(recorded).length).toBe(sandbox.length - dropped.length);
    // A home copy already past the cap is never made unwritable (a change that does not grow it goes through), and it is
    // never grown further.
    const bigHome = flood();
    const baseline = bigHome.map(asChrome);
    const shorter = [asChrome({ ...bigHome[0]!, value: "short" }), ...baseline.slice(1)];
    expect(writeBack(bigHome, baseline, shorter, null).merged[0]!.value).toBe("short");
    const grown = writeBack(bigHome, baseline, [...baseline, asChrome(cookie("new", "new.example", "n"))], null);
    expect(grown.merged.map((one) => one.name)).not.toContain("new");
    expect(grown.merged).toHaveLength(bigHome.length);
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
      "http://100.64.0.1/", "http://[fdaa::1]/", "http://[fe80::1]/", "http://0.0.0.0:8080/", "ws://127.0.0.1:39231/x", "http:127.0.0.1", "https:127.0.0.1/json", "localhost:9222"]) {
      expect(await guard(open(url)), url).toBe(PRIVATE_ADDRESS_REFUSAL);
    }
  });

  it("refuses names that are never a public site, and names the home resolves to such an address", async () => {
    const guard = addressGuard(resolve);
    for (const url of ["http://localhost:9222/", "https://LOCALHOST./", "http://app.localhost/", "http://metadata.google.internal/computeMetadata/v1/", "http://metadata/",
      "http://router/", "http://printer.local/", "http://db.internal/", "https://rebind.example/", "https://loop.example/", "http://metadata.goog/computeMetadata/v1/"]) {
      expect(await guard(open(url)), url).toBe(PRIVATE_ADDRESS_REFUSAL);
    }
    expect(await guard({ name: "agent_browser_tab_new", arguments: { options: { url: "http://127.0.0.1/" } } }), "however deep").toBe(PRIVATE_ADDRESS_REFUSAL);
    expect(await guard({ name: "agent_browser_batch", arguments: { steps: [{ a: { b: { c: { d: { e: { url: "http://169.254.169.254/" } } } } } }] } }), "deeper still").toBe(PRIVATE_ADDRESS_REFUSAL);
  });

  it("refuses a url it cannot read", async () => {
    const guard = addressGuard(resolve);
    for (const url of ["exa mple.com", "http://[::1", "https://"]) expect(await guard(open(url)), url).toBe(UNREADABLE_ADDRESS_REFUSAL);
  });

  it("opens public sites, and never refuses text a page is given", async () => {
    const guard = addressGuard(resolve);
    expect(await guard(open("https://public.example/path"))).toBeNull();
    expect(await guard(open("public.example"))).toBeNull();
    expect(await guard(open("https://93.184.215.14/"))).toBeNull();
    expect(await guard(open("http://[2606:4700:4700::1111]/")), "a public IPv6 address").toBeNull();
    expect(await guard(open("about:blank"))).toBeNull();
    expect(await guard({ name: "agent_browser_fill", arguments: { selector: "#q", text: "http://127.0.0.1:9222" } })).toBeNull();
    expect(await guard({ name: "agent_browser_snapshot", arguments: {} })).toBeNull();
  });

  it("goes ahead when the home cannot resolve a name, or not in time, and keeps every answer a minute, a late one too", async () => {
    let now = 0;
    let answerSlow: (addresses: string[]) => void = () => {};
    const slow = vi.fn((host: string) => (host === "slow.example" ? new Promise<string[]>((done) => { answerSlow = done; }) : resolve(host)));
    const guard = addressGuard(slow, () => now, 20);
    expect(await guard(open("https://unknown.example/"))).toBeNull();
    expect(await guard(open("https://unknown.example/again")), "a failed answer is kept").toBeNull();
    expect(slow.mock.calls.filter(([host]) => host === "unknown.example")).toHaveLength(1);
    expect(await guard(open("https://slow.example/")), "not answered in time: goes ahead").toBeNull();
    expect(await guard(open("https://slow.example/b")), "still unanswered: not waited for again").toBeNull();
    answerSlow(["10.0.0.7"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(await guard(open("https://slow.example/c")), "the late answer counts for the rest of the minute").toBe(PRIVATE_ADDRESS_REFUSAL);
    expect(slow.mock.calls.filter(([host]) => host === "slow.example")).toHaveLength(1);
    await guard(open("https://rebind.example/a"));
    await guard(open("https://rebind.example/b"));
    expect(slow.mock.calls.filter(([host]) => host === "rebind.example")).toHaveLength(1);
    now += 60_000;
    await guard(open("https://rebind.example/c"));
    expect(slow.mock.calls.filter(([host]) => host === "rebind.example")).toHaveLength(2);
  });

  it("asks for every name of a call at once", async () => {
    let asking = 0;
    let most = 0;
    const counting: Parameters<typeof addressGuard>[0] = async (host) => {
      asking += 1;
      most = Math.max(most, asking);
      await new Promise((done) => setImmediate(done));
      asking -= 1;
      return host === "loop.example" ? ["127.0.0.1"] : ["93.184.215.14"];
    };
    const guard = addressGuard(counting);
    expect(await guard({ name: "agent_browser_batch", arguments: { steps: [{ url: "https://one.example/" }, { url: "https://two.example/" }, { url: "https://loop.example/" }] } })).toBe(PRIVATE_ADDRESS_REFUSAL);
    expect(most).toBe(3);
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

  it("an open that comes while the sandbox is being deleted waits for it, then makes a fresh one: never resumes the one going", async () => {
    // The delete is held until the open has come: the open must wait for it.
    const real = providerOps(() => ({}) as AppConfig);
    let release: () => void = () => {};
    const gate = new Promise<void>((done) => { release = done; });
    let removing = false;
    const ops = { ...real, remove: async (id: string) => { removing = true; await gate; return real.remove(id); } };
    const cloud = browser({ signIns: memorySignIns(null).store, ops: () => ops });
    await profiles(cloud, ["scout"]);
    const first = fake.boxId;
    await cloud.erase("scout");
    await vi.waitFor(() => expect(removing).toBe(true));
    const opened = cloud.open(request("writer"));
    await new Promise((done) => setTimeout(done, 20));
    expect(fake.resumes(), "nothing sent while the delete is under way").toBe(0);
    release();
    urlOf(await opened);
    await cloud.erased();
    expect(deletes().map((one) => one.path)).toEqual([`/api/v1/sandboxes/${first}`]);
    expect(fake.resumes(), "the sandbox being deleted was never woken").toBe(0);
    expect(fake.creates()).toBe(1);
    expect(fake.boxId).not.toBe(first);
    expect(cloud.active("bot-writer")).not.toBeNull();
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

  it("today's control plane answers a resume of an ended sandbox 503 no_ready_machine: that browser opens in the home with nothing held against it, and the next open makes a fresh one", async () => {
    const cloud = browser();
    fake.state = "archived";
    fake.startStatus = 503;
    fake.startBody = { ok: false, error: { code: "no_ready_machine", message: "No machine is ready." } };
    expect(await cloud.open(request())).toEqual({ home: "no-machine" });
    // The relay then leaves the ended sandbox out of the list.
    fake.exists = false;
    fake.startStatus = 200;
    fake.startBody = { ok: true };
    const first = fake.boxId;
    urlOf(await cloud.open(request()));
    expect(fake.creates()).toBe(1);
    expect(cloud.report()).toMatchObject({ held: null, fallbacks: { "no-machine": 1 } });
    expect(deletes(), "nothing to delete: the relay ended it").toEqual([]);
    expect(first).toBeTruthy();
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

describe("files of a sandbox that takes no direct connections", () => {
  let folder: string;
  beforeEach(() => { folder = mkdtempSync(join(tmpdir(), "bot-folder-")); fake.inbound = "boat-only"; });
  afterEach(() => { rmSync(folder, { recursive: true, force: true }); });

  const downloadPath = (guid: string) => `/home/user/.omb-browser/.downloads/${profileKey("scout")}/${guid}`;
  const finish = (guid: string, name: string, bytes: Buffer) => {
    fake.files.set(downloadPath(guid), bytes);
    fake.emit(profileKey("scout"), "Browser.downloadWillBegin", { guid, suggestedFilename: name, url: "https://files.example/x" });
    fake.emit(profileKey("scout"), "Browser.downloadProgress", { guid, totalBytes: bytes.length, receivedBytes: bytes.length, state: "completed" });
  };
  const fileCalls = () => fake.requests.filter((one) => one.path.endsWith("/files")).map((one) => one.method);
  const tooLarge = (name: string, size: string) => `${name} (${size}) is too large to copy: this browser's sandbox takes no direct connections, so a file moves to it in one piece of at most about 1.5 MiB.`;

  it("brings a download over through the provider's JSON file read, byte for byte, and removes it from the sandbox", async () => {
    const cloud = browser({ folder: () => folder });
    urlOf(await cloud.open(request()));
    const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 256));
    finish("0f3e2a1b-guid", "report.pdf", bytes);
    await vi.waitFor(() => expect(existsSync(join(folder, "downloads", "report.pdf"))).toBe(true));
    expect(readFileSync(join(folder, "downloads", "report.pdf"))).toEqual(bytes);
    await vi.waitFor(() => expect(fake.files.has(downloadPath("0f3e2a1b-guid"))).toBe(false));
    expect(cloud.takeNotes("bot-scout")).toEqual([`Downloaded "report.pdf" into your working folder as ${join("downloads", "report.pdf")} (${bytes.length} bytes).`]);
    expect(fileCalls()).toEqual(["GET"]);
  });

  it("says plainly that a download over 5 MiB can't be brought over, and neither keeps it nor tries it again", async () => {
    const cloud = browser({ folder: () => folder });
    urlOf(await cloud.open(request()));
    finish("big-guid", "video.mp4", Buffer.alloc(INLINE_READ_MAX_BYTES + 1));
    await vi.waitFor(() => expect(cloud.takeNotes("bot-scout")).toEqual([`"video.mp4" was downloaded in the browser but could not be brought to your working folder: ${downloadPath("big-guid")} is too large to copy: this browser's sandbox takes no direct connections, so a file moves from it in one piece of at most 5 MiB.`]));
    await vi.waitFor(() => expect(fake.files.has(downloadPath("big-guid")), "removed from the sandbox").toBe(false));
    const before = fake.requests.length;
    await cloud.close("bot-scout");
    expect(fake.requests.slice(before).filter((one) => one.path.includes("/files")), "not tried again at close").toEqual([]);
    expect(existsSync(join(folder, "downloads", "video.mp4"))).toBe(false);
    expect(cloud.takeNotes("bot-scout"), "no line about it at close").toEqual([REOPENED_NOTE]);
  });

  it("a failure that may pass is kept and tried again at close, as before", async () => {
    let available = false;
    const cloud = browser({ folder: () => (available ? folder : null) });
    urlOf(await cloud.open(request()));
    finish("retry-guid", "data.csv", Buffer.from("a,b\n1,2\n"));
    await vi.waitFor(() => expect(cloud.takeNotes("bot-scout")).toEqual([expect.stringContaining("It is kept in the browser sandbox for a day and is tried again when this browser closes.")]));
    available = true;
    await cloud.close("bot-scout");
    expect(readFileSync(join(folder, "downloads", "data.csv"), "utf8")).toBe("a,b\n1,2\n");
  });

  it("gives a page a file through the provider's JSON file write, and refuses one over the cap in one line", async () => {
    const cloud = browser();
    urlOf(await cloud.open(request()));
    mkdirSync(join(folder, "in"), { recursive: true });
    const cv = Buffer.from("my cv \u0000\u00ff bytes");
    writeFileSync(join(folder, "in", "cv.pdf"), cv);
    const path = `/home/user/.omb-browser/.uploads/${profileKey("scout")}/cv.pdf`;
    expect(await cloud.upload("bot-scout", join(folder, "in", "cv.pdf"), null, cv.length)).toEqual({ path });
    expect(fake.files.get(path)).toEqual(cv);
    expect(fileCalls()).toEqual(["PUT"]);
    writeFileSync(join(folder, "in", "big.bin"), Buffer.alloc(INLINE_WRITE_MAX_BYTES + 1));
    expect(await cloud.upload("bot-scout", join(folder, "in", "big.bin"), null, INLINE_WRITE_MAX_BYTES + 1))
      .toEqual({ error: `big.bin could not be given to the browser: ${tooLarge("big.bin", "1.5 MiB")} Tell the person in one sentence and ask them to upload it themselves.` });
    expect(fileCalls(), "never sent").toEqual(["PUT"]);
  });

  it("the largest upload it sends fits the relay's 2 MiB request cap, and a 413 from the relay is the same plain line", async () => {
    fake.relayJsonMax = 2 * 1024 * 1024;
    const cloud = browser();
    urlOf(await cloud.open(request()));
    mkdirSync(join(folder, "in"), { recursive: true });
    writeFileSync(join(folder, "in", "fits.bin"), Buffer.alloc(INLINE_WRITE_MAX_BYTES, 7));
    expect(await cloud.upload("bot-scout", join(folder, "in", "fits.bin"), null, INLINE_WRITE_MAX_BYTES)).toEqual({ path: expect.stringContaining("fits.bin") });
    fake.relayJsonMax = 1024 * 1024;
    writeFileSync(join(folder, "in", "scan.pdf"), Buffer.alloc(1024 * 1024));
    expect(await cloud.upload("bot-scout", join(folder, "in", "scan.pdf"), null, 1024 * 1024))
      .toEqual({ error: `scan.pdf could not be given to the browser: ${tooLarge("scan.pdf", "1.0 MiB")} Tell the person in one sentence and ask them to upload it themselves.` });
    expect([...fake.files.keys()].some((key) => key.endsWith("scan.pdf"))).toBe(false);
  });

  it("while the relay does not open the JSON file calls to it, a download is refused plainly once and never tried again", async () => {
    fake.jsonFiles = false;
    const cloud = browser({ folder: () => folder });
    urlOf(await cloud.open(request()));
    finish("closed-guid", "report.pdf", Buffer.from("x"));
    await vi.waitFor(() => expect(cloud.takeNotes("bot-scout")).toEqual([`"report.pdf" was downloaded in the browser but could not be brought to your working folder: ${downloadPath("closed-guid")} could not be copied from this browser's sandbox (it answered 404): the sandbox takes no direct connections, and its files can't be copied another way here.`]));
    const before = fake.requests.length;
    await cloud.close("bot-scout");
    expect(fake.requests.slice(before).filter((one) => one.path.includes("/files")), "not tried again at close").toEqual([]);
    mkdirSync(join(folder, "in"), { recursive: true });
    writeFileSync(join(folder, "in", "a.txt"), "y");
    urlOf(await cloud.open(request()));
    expect(await cloud.upload("bot-scout", join(folder, "in", "a.txt"), null, 1)).toEqual({ error: expect.stringContaining("could not be copied to this browser's sandbox (it answered 404)") });
  });

  it("a sandbox that takes direct connections copies through its links only, as before", async () => {
    fake.inbound = "open";
    const cloud = browser({ folder: () => folder });
    urlOf(await cloud.open(request()));
    finish("link-guid", "a.txt", Buffer.from("x"));
    await vi.waitFor(() => expect(existsSync(join(folder, "downloads", "a.txt"))).toBe(true));
    mkdirSync(join(folder, "in"), { recursive: true });
    writeFileSync(join(folder, "in", "b.txt"), "y");
    await cloud.upload("bot-scout", join(folder, "in", "b.txt"), null, 1);
    expect(fileCalls()).toEqual([]);
  });
});
