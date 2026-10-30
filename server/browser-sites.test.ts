// No real engine, Chrome or user profile: the state file agent-browser saves, and a fake Chrome DevTools socket.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { browserRestoreKey } from "./browser-engine.ts";
import { connectCdp, decryptBrowserState, encryptBrowserState, listSignedInSites, signOutOfSites, signedInSites, type BrowserSitesTarget, type CdpEvent } from "./browser-sites.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const KEY = "a".repeat(64);
// Saved by agent-browser 0.37.0 itself (`--restore`, this key) after a page
// set cookies on .wikipedia.org, en.wikipedia.org and www.example.com and
// localStorage on https://example.com. It proves the at-rest format.
const SAVED_BY_ENGINE = Buffer.from([
  "v0VwcRCnddysYKlP8Vi4nfVk54WehcGyQcgqAQQq7KjjwF2lh1JU2URYi8akIgVEfbTzxULoojyvlIvCjcy4eoMt9SVqDzpRlk5j",
  "7z9IYJPB3mN9cuqsnSeq4VeGPYRbxrAiDJ0eRNw9q83hOIbntxq7O/IktkpuLh0UA2XEMwGn4ATvYRKzcSZbbWbVzd5+RiNjpLd4",
  "LQ1v9AvlgpJq1cp9d4wpYXjgSI2sbSiL64+IRy+/Pj8WjkfaUZgUBW74OT/F5eSv8QGJLmpSf/96lTbj08NK59rhcWVDjsG8fD7Y",
  "PLQPdzRdzgrcBFvLF5RJhw8B+5CNgYLQEViQhgt7C7Q2up+o1/9fT7/EyNmMs6f5dQI/JQId1nuKMaaU7YCKoUeQS9o3g+q5Clzg",
  "bD+RbwMlRbAlklnhF4NdGYbGI3KoAUp1H2uqbCVaUw4oEHmipmTJtRrfsmE19Y1M0e4ofvjkkUgsHWSVV46cpY7Gm1mtUPq9EfeF",
  "zUQNLbfOMRvaQuvIsfUss68w05u2/z6ARoRIxrTCN0f1K5QW8tBNEhgYkWZ2GpsJNmBDUsAvxtquZDezf++Gc1Uxil5NfKRE6OFB",
  "YeWo3dV3v8a+IOXRpdI0mkX6HZ1qu8orsMssOvB2zJtvl5gG+brsYeOHbkKhIbd8uWidrCJ9bn3IHKINU4H9QH1dRfPU9qvTOOCi",
  "HYNliv+MjDalXH/NHMPdqAS2pKVubuL2bj50MeJ+QAZcxvbivBuQLdJjdLYziPg1fJlcDA4KTNlD49HpP6eBXB79o4kdAxdse4aK",
  "xUY101QD3iSFulmEL8GkmfbSlRNcubBXlXnxQ3yU6WOAWBJtSYix7T8RCQw5/A0m7CsBeGWbKtHmUvIkS49ikXgZHnjnj3ahWqTv",
  "53XJgsMnVuGac3ZRPZXwXx8miWvpkw9p4mQze0TYk/D/ZYpgNxrWTzf5buJqnvnQ96h/5/zyRGkvnECdKlchBIUa7fNxFi6oCic8",
  "yxkoif+dOBvJvJx5RG4oHgiJhSNxaEdYcS2TFjnjFaVsp9Mv+bbCzZPM8nCaokW2vAO7oVD0sIWyH46Rr7vP6e8C4Z1O4l4NFMZy",
  "CvpTQWl5FmbWUW6AHhZcdQnM9sjT6voTVjQEW6vVVG4T1slwj3KtdiFxUWEMCJ1axQlDgo+kmXIjOk5d2fpVT4YqtoXOW2pxH/2A",
  "uA==",
].join(""), "base64");

const scratch: string[] = [];
const servers: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

function profile(session = "work") {
  const home = mkdtempSync(join(tmpdir(), "omb-browser-sites-"));
  scratch.push(home);
  const directory = join(home, ".agent-browser", "sessions");
  mkdirSync(directory, { recursive: true });
  const current = join(directory, `${browserRestoreKey(session)}-${session}.json.enc`);
  const target: BrowserSitesTarget = { binaryPath: "/fake/agent-browser", session, env: { HOME: home, USERPROFILE: home }, encryptionKey: KEY };
  const saved = (path = current) => JSON.parse(decryptBrowserState(readFileSync(path), KEY));
  return { home, directory, current, target, saved };
}

const stopped = { engine: async () => null };

describe("a profile's signed-in sites, from its saved session", () => {
  it("lists each site with saved cookies or storage, read from the file agent-browser saved", async () => {
    const { current, target } = profile();
    writeFileSync(current, SAVED_BY_ENGINE);
    expect(await listSignedInSites(target, stopped)).toEqual({
      running: false,
      sites: [
        { site: "example.com", cookies: 1, storage: 1 },
        { site: "wikipedia.org", cookies: 2, storage: 0 },
      ],
    });
  });

  it("reads the spelling a profile used before its restore key while the current one is missing", async () => {
    const { directory, target } = profile();
    writeFileSync(join(directory, "work-work.json.enc"), SAVED_BY_ENGINE);
    expect((await listSignedInSites(target, stopped)).sites.map((site) => site.site)).toEqual(["example.com", "wikipedia.org"]);
  });

  it("groups hosts under the widest one the browser stores for, never under a public suffix", () => {
    const cookie = (domain: string) => ({ name: "sid", value: "1", domain, path: "/" });
    expect(signedInSites(
      [cookie(".google.com"), cookie("accounts.google.com"), cookie("mail.google.com"), cookie("www.bbc.co.uk"), cookie("app.example.org"), cookie("127.0.0.1")],
      [{ origin: "https://docs.google.com", localStorage: [{ name: "a", value: "b" }] }, { origin: "https://empty.example.org", localStorage: [] }],
    )).toEqual([
      { site: "127.0.0.1", cookies: 1, storage: 0 },
      { site: "app.example.org", cookies: 1, storage: 0 },
      { site: "google.com", cookies: 3, storage: 1 },
      { site: "www.bbc.co.uk", cookies: 1, storage: 0 },
    ]);
  });

  it("an unreadable file restores nothing, so it lists nothing", async () => {
    const { current, target } = profile();
    writeFileSync(current, encryptBrowserState(JSON.stringify({ cookies: [{ name: "a", value: "b", domain: "x.test", path: "/" }], origins: [] }), "b".repeat(64)));
    expect(await listSignedInSites(target, stopped)).toEqual({ running: false, sites: [] });
  });
});

describe("signing a stopped browser out", () => {
  it("removes one site's cookies and storage and leaves every other site", async () => {
    const { current, directory, target, saved } = profile();
    writeFileSync(current, SAVED_BY_ENGINE);
    writeFileSync(join(directory, "work-work.json.enc"), SAVED_BY_ENGINE);
    writeFileSync(`${current}.previous`, SAVED_BY_ENGINE);
    const result = await signOutOfSites(target, "wikipedia.org", stopped);
    expect(result).toEqual({ running: false, sites: [{ site: "example.com", cookies: 1, storage: 1 }] });
    for (const path of [current, join(directory, "work-work.json.enc")]) {
      const state = saved(path);
      expect(state.cookies.map((cookie: { domain: string }) => cookie.domain)).toEqual(["www.example.com"]);
      expect(state.origins.map((origin: { origin: string }) => origin.origin)).toEqual(["https://example.com"]);
      expect(state.cookies[0]).toMatchObject({ name: "sid", value: "s1", path: "/", httpOnly: true, secure: true });
    }
    expect(existsSync(`${current}.previous`)).toBe(false);
  });

  it("signs out of every site in every saved copy", async () => {
    const { current, directory, target, saved } = profile();
    writeFileSync(current, SAVED_BY_ENGINE);
    writeFileSync(join(directory, "work-work.json"), JSON.stringify({ cookies: [{ name: "old", value: "1", domain: "old.test", path: "/" }], origins: [] }));
    expect(await signOutOfSites(target, null, stopped)).toEqual({ running: false, sites: [] });
    expect(saved()).toEqual({ cookies: [], origins: [] });
    expect(JSON.parse(readFileSync(join(directory, "work-work.json"), "utf8"))).toEqual({ cookies: [], origins: [] });
  });

  it("changes nothing for a site that is not listed, such as a whole top-level domain", async () => {
    const { current, target } = profile();
    writeFileSync(current, SAVED_BY_ENGINE);
    for (const site of ["org", "com", "nobody.test"]) {
      expect((await signOutOfSites(target, site, stopped)).sites).toHaveLength(2);
      expect(readFileSync(current).equals(SAVED_BY_ENGINE)).toBe(true);
    }
  });

  it("leaves other profiles' saved sessions alone", async () => {
    const { directory, current, target } = profile();
    const other = join(directory, `${browserRestoreKey("work-client")}-work-client.json.enc`);
    writeFileSync(current, SAVED_BY_ENGINE);
    writeFileSync(other, SAVED_BY_ENGINE);
    await signOutOfSites(target, null, stopped);
    expect(readFileSync(other).equals(SAVED_BY_ENGINE)).toBe(true);
  });
});

/** A fake running browser: the engine's `state save` and `get cdp-url`, and
 * a Chrome DevTools endpoint over one cookie jar and per-origin storage. */
async function fakeChrome(cookies: Array<Record<string, unknown>>, storage: Record<string, string> = {}, pages = [{ type: "page", targetId: "page-1", url: "https://en.wikipedia.org/wiki/Main_Page" }, { type: "page", targetId: "page-2", url: "https://www.example.com/" }]) {
  const jar = [...cookies];
  const stored = new Map(Object.entries(storage));
  const calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  server.on("connection", (socket) => socket.on("message", (data) => {
    const { id, method, params = {}, sessionId } = JSON.parse(String(data));
    calls.push({ method, params, sessionId });
    let result: Record<string, unknown> = {};
    if (method === "Target.getTargets") result = { targetInfos: [...pages, { type: "service_worker", targetId: "sw" }] };
    if (method === "Target.attachToTarget") result = { sessionId: `on-${params.targetId}` };
    if (method === "Network.getAllCookies") result = { cookies: jar };
    if (method === "Network.deleteCookies") {
      const index = jar.findIndex((cookie) => cookie.name === params.name && cookie.domain === params.domain && cookie.path === params.path);
      if (index >= 0) jar.splice(index, 1);
    }
    if (method === "Network.clearBrowserCookies") jar.length = 0;
    if (method === "Storage.clearDataForOrigin") stored.delete(String(params.origin));
    socket.send(JSON.stringify({ id, result, ...(sessionId ? { sessionId } : {}) }));
  }));
  await new Promise((ready) => server.on("listening", ready));
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/devtools/browser/fake`;
  const commands: string[][] = [];
  const engine = async (_target: BrowserSitesTarget, args: string[]) => {
    commands.push(args);
    if (args[0] === "get" && args[1] === "cdp-url") return { cdpUrl: url };
    if (args[0] === "state" && args[1] === "save") {
      const origins = [...stored].map(([origin, value]) => ({ origin, localStorage: [{ name: "token", value }], sessionStorage: [] }));
      writeFileSync(`${args[2]}.enc`, encryptBrowserState(JSON.stringify({ cookies: jar, origins }), KEY));
      return { path: `${args[2]}.enc`, saved: true };
    }
    throw new Error(`unexpected engine command ${args.join(" ")}`);
  };
  return { jar, stored, calls, commands, engine };
}

const cookie = (name: string, domain: string) => ({ name, value: "v", domain, path: "/", httpOnly: true, secure: true });

describe("signing a running browser out", () => {
  it("lists what the running browser holds now, as the engine saves it", async () => {
    const { current, target } = profile();
    writeFileSync(current, SAVED_BY_ENGINE);
    const chrome = await fakeChrome([cookie("SID", ".google.com"), cookie("sid", "www.example.com")], { "https://mail.google.com": "t" });
    expect(await listSignedInSites(target, { engine: chrome.engine })).toEqual({
      running: true,
      sites: [{ site: "google.com", cookies: 1, storage: 1 }, { site: "www.example.com", cookies: 1, storage: 0 }],
    });
    expect(chrome.calls).toEqual([]);
  });

  it("deletes one site's cookies live, clears its storage and tabs, rewrites the saved file, and leaves the rest", async () => {
    const { current, target, saved } = profile();
    writeFileSync(current, SAVED_BY_ENGINE);
    const chrome = await fakeChrome(
      [cookie("sid", ".wikipedia.org"), cookie("sid", "en.wikipedia.org"), cookie("sid", "www.example.com"), cookie("SID", ".google.com")],
      { "https://en.wikipedia.org": "w", "https://example.com": "e" },
    );
    const result = await signOutOfSites(target, "wikipedia.org", { engine: chrome.engine });
    expect(result).toEqual({ running: true, sites: [{ site: "example.com", cookies: 1, storage: 1 }, { site: "google.com", cookies: 1, storage: 0 }] });
    expect(chrome.jar.map((entry) => entry.domain)).toEqual(["www.example.com", ".google.com"]);
    expect(chrome.calls.filter((call) => call.method === "Network.deleteCookies").map((call) => call.params))
      .toEqual([{ name: "sid", domain: ".wikipedia.org", path: "/" }, { name: "sid", domain: "en.wikipedia.org", path: "/" }]);
    expect(chrome.calls.some((call) => call.method === "Network.clearBrowserCookies")).toBe(false);
    const cleared = chrome.calls.filter((call) => call.method === "Storage.clearDataForOrigin").map((call) => String(call.params.origin));
    expect(cleared).toEqual(expect.arrayContaining(["https://wikipedia.org", "https://en.wikipedia.org"]));
    expect(cleared.some((origin) => origin.includes("example.com"))).toBe(false);
    expect([...chrome.stored.keys()]).toEqual(["https://example.com"]);
    expect(chrome.calls.filter((call) => call.method === "Runtime.evaluate").map((call) => call.sessionId)).toEqual(["on-page-1"]);
    expect(saved().cookies.map((entry: { domain: string }) => entry.domain)).toEqual(["www.example.com"]);
  });

  it("signs out of all: clears every cookie and origin live and empties the saved file", async () => {
    const { current, target, saved } = profile();
    writeFileSync(current, SAVED_BY_ENGINE);
    const chrome = await fakeChrome([cookie("sid", ".wikipedia.org"), cookie("sid", "www.example.com")], { "https://example.com": "e" });
    expect(await signOutOfSites(target, null, { engine: chrome.engine })).toEqual({ running: true, sites: [] });
    expect(chrome.calls.filter((call) => call.method === "Network.clearBrowserCookies")).toHaveLength(1);
    expect(chrome.calls.filter((call) => call.method === "Storage.clearDataForOrigin").map((call) => call.params.origin))
      .toEqual(expect.arrayContaining(["https://wikipedia.org", "https://www.example.com", "https://example.com"]));
    expect(saved()).toEqual({ cookies: [], origins: [] });
  });

  it("starts a stopped browser with a kept profile to sign it out there too, then stops it again", async () => {
    const { home, current, target, saved } = profile();
    writeFileSync(current, SAVED_BY_ENGINE);
    const kept = join(home, "agent-browser-profiles", "work");
    mkdirSync(kept, { recursive: true });
    const chrome = await fakeChrome([cookie("sid", ".wikipedia.org"), cookie("sid", "www.example.com")]);
    let running = false;
    const lifecycle: string[] = [];
    const deps = {
      engine: async (given: BrowserSitesTarget, args: string[]) => running ? chrome.engine(given, args) : null,
      start: async () => { lifecycle.push("start"); running = true; return true; },
      stop: async () => { lifecycle.push("stop"); running = false; return true; },
    };
    const withProfile = { ...target, env: { ...target.env, AGENT_BROWSER_PROFILE: kept } };
    expect(await listSignedInSites(withProfile, deps)).toMatchObject({ running: false });
    expect(lifecycle).toEqual([]);
    expect(await signOutOfSites(withProfile, "wikipedia.org", deps)).toEqual({ running: false, sites: [{ site: "www.example.com", cookies: 1, storage: 0 }] });
    expect(lifecycle).toEqual(["start", "stop"]);
    expect(chrome.jar.map((entry) => entry.domain)).toEqual(["www.example.com"]);
    expect(saved().cookies.map((entry: { domain: string }) => entry.domain)).toEqual(["www.example.com"]);
    await signOutOfSites(target, "example.com", deps);
    expect(lifecycle).toEqual(["start", "stop"]);
  });

  it("only ever connects to the engine's own Chrome on this machine", async () => {
    const { target } = profile();
    const chrome = await fakeChrome([cookie("sid", "www.example.com")]);
    const engine = async (_target: BrowserSitesTarget, args: string[]) =>
      args[0] === "get" ? { cdpUrl: "ws://browser.example.net:9222/devtools/browser/x" } : chrome.engine(_target, args);
    await expect(signOutOfSites(target, null, { engine })).rejects.toThrow("DevTools address");
    expect(chrome.calls).toEqual([]);
  });
});

describe("the DevTools connection", () => {
  it("hands events to its listener, answers to their callers, and says when the browser closes it", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    server.on("connection", (socket) => socket.on("message", (data) => {
      const { id, sessionId } = JSON.parse(String(data));
      socket.send(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "child", targetInfo: { type: "iframe" } }, sessionId }));
      socket.send(JSON.stringify({ id, result: { ok: true } }));
      setTimeout(() => socket.close(), 10);
    }));
    await new Promise((ready) => server.on("listening", ready));
    const events: CdpEvent[] = [];
    let closed!: () => void;
    const gone = new Promise<void>((resolve) => { closed = resolve; });
    const cdp = await connectCdp(`ws://127.0.0.1:${(server.address() as { port: number }).port}/devtools/browser/x`, 2_000, { event: (event) => events.push(event), closed });
    await expect(cdp.send("Target.setAutoAttach", {}, "page")).resolves.toEqual({ ok: true });
    await gone;
    expect(events).toEqual([{ method: "Target.attachedToTarget", params: { sessionId: "child", targetInfo: { type: "iframe" } }, sessionId: "page" }]);
    await expect(cdp.send("Browser.getVersion")).rejects.toThrow();
  });
});
