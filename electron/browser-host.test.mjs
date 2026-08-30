import http from "node:http";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createBrowserHost } = require("./browser-host.cjs");

const MASTER = "a".repeat(64);
let hosts = [];
let capabilityCounter = 0;

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.stop()));
  hosts = [];
});

function harness() {
  const calls = [];
  let held = false;
  let epoch = 0;
  let agentEpoch = 0;
  let clock = Date.now();
  let screenshotImpl = null;
  const pins = [];
  const manager = {
    size: () => 1,
    isHumanControlled: (botId, profile) => held && botId === "bot-a" && profile === "work",
    controlLease: () => ({ held, epoch, agentEpoch }),
    cancelAgentActions: (botId) => {
      calls.push(["cancelAgentActions", botId]);
      agentEpoch += 1;
    },
    setCapabilityActive: (botId, profile, active) => pins.push([botId, profile, active]),
    state: (botId, profile) => {
      calls.push(["state", botId, profile]);
      return { botId, profile, url: "https://example.com/path?access_token=secret#part", title: "Example" };
    },
    navigate: (botId, url, profile) => {
      calls.push(["navigate", botId, url, profile]);
      return { url, title: "Loaded", text: `Browser: ${url}`, elements: [], notes: [] };
    },
    screenshot: (botId, profile) => {
      calls.push(["screenshot", botId, profile]);
      if (screenshotImpl) return screenshotImpl();
      return { png: "eA==", format: "jpeg" };
    },
  };
  const host = createBrowserHost({ manager: () => manager, token: MASTER, now: () => clock });
  hosts.push(host);
  return {
    host,
    manager,
    calls,
    pins,
    now: () => clock,
    advanceTime: (milliseconds) => { clock += milliseconds; },
    setHeld: (value) => {
      if (held !== value) epoch += 1;
      held = value;
    },
    setScreenshotImpl: (impl) => { screenshotImpl = impl; },
  };
}

async function manage(host, operation, body = {}, master = MASTER) {
  const response = await fetch(`${host.url}/v1/capabilities/${operation}`, {
    method: "POST",
    headers: { authorization: `Bearer ${master}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function register(host, botId = "bot-a", profile = "work", token) {
  const scoped = token ?? (++capabilityCounter).toString(16).padStart(64, "0");
  const result = await manage(host, "register", { token: scoped, botId, profile, expiresAt: Date.now() + 60_000 });
  expect(result.response.status).toBe(200);
  return scoped;
}

async function request(host, operation, { botId = "bot-a", profile = "work", token, body = {} } = {}) {
  const scoped = token ?? await register(host, botId, profile);
  const response = await fetch(`${host.url}/v1/bots/${botId}/${operation}`, {
    method: "POST",
    headers: { authorization: `Bearer ${scoped}`, "content-type": "application/json" },
    body: JSON.stringify({ ...body, profile }),
  });
  return { response, body: await response.json() };
}

describe("browser loopback host", () => {
  it("registers only master-authorized per-turn capabilities and revokes them", async () => {
    const { host, pins, now, advanceTime } = harness();
    await host.start();
    const scoped = "b".repeat(64);
    expect((await manage(host, "register", {
      token: scoped,
      botId: "bot-a",
      profile: "work",
      expiresAt: Date.now() + 60_000,
    }, "c".repeat(64))).response.status).toBe(401);
    expect((await manage(host, "register", {
      token: scoped,
      botId: "bot-a",
      profile: "work",
      expiresAt: Date.now() + 60_000,
    })).response.status).toBe(200);
    expect((await request(host, "state", { token: scoped })).response.status).toBe(200);
    expect((await manage(host, "register", {
      token: scoped,
      botId: "bot-b",
      profile: "work",
      expiresAt: Date.now() + 60_000,
    })).response.status).toBe(409);
    expect((await manage(host, "revoke", { token: scoped })).response.status).toBe(200);
    expect(pins).toContainEqual(["bot-a", "work", false]);
    expect((await request(host, "state", { token: scoped })).response.status).toBe(401);

    const migrated = await register(host, "bot-a", "Work");
    expect((await request(host, "state", { token: migrated, profile: "Work" })).response.status).toBe(200);
    expect(pins).toContainEqual(["bot-a", "Work", true]);

    const expiring = "d".repeat(64);
    expect((await manage(host, "register", {
      token: expiring,
      botId: "bot-a",
      profile: "work",
      expiresAt: now() + 5,
    })).response.status).toBe(200);
    advanceTime(10);
    expect((await request(host, "state", { token: expiring })).response.status).toBe(401);

    const clearable = await register(host);
    expect(pins).toContainEqual(["bot-a", "work", true]);
    expect((await manage(host, "clear")).response.status).toBe(200);
    expect((await request(host, "state", { token: clearable })).response.status).toBe(401);
  });

  it("atomically replaces an earlier capability for the same bot", async () => {
    const { host, calls } = harness();
    await host.start();
    const oldToken = await register(host, "bot-a", "work");
    const nextToken = await register(host, "bot-a", "personal");
    expect((await request(host, "state", { token: oldToken })).response.status).toBe(401);
    expect((await request(host, "state", { token: nextToken, profile: "personal" })).response.status).toBe(200);
    expect(calls).toContainEqual(["cancelAgentActions", "bot-a"]);
  });

  it("accepts only the capability scoped to the exact route bot and body profile", async () => {
    const { host, calls } = harness();
    await host.start();

    const health = await fetch(`${host.url}/v1/health`, { headers: { authorization: `Bearer ${MASTER}` } });
    expect(health.status).toBe(200);

    const own = await request(host, "state");
    expect(own.response.status).toBe(200);
    expect(own.body).toMatchObject({ profile: "work", url: "https://example.com/path" });
    expect(own.body.url).not.toContain("secret");
    expect(calls).toContainEqual(["state", "bot-a", "work"]);

    expect((await request(host, "state", { token: MASTER })).response.status).toBe(401);
    const workToken = await register(host, "bot-a", "work");
    expect((await request(host, "state", { botId: "bot-b", token: workToken })).response.status).toBe(401);
    expect((await request(host, "state", { profile: "personal", token: workToken })).response.status).toBe(401);

    const missingProfile = await fetch(`${host.url}/v1/bots/bot-a/state`, {
      method: "POST",
      headers: { authorization: `Bearer ${await register(host, "bot-a", "")}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(missingProfile.status).toBe(400);
  });

  it("does not expose page data through a scoped token while the user has control", async () => {
    const { host, setHeld, calls } = harness();
    await host.start();
    setHeld(true);
    for (const operation of ["state", "screenshot", "navigate"]) {
      const result = await request(host, operation, { body: operation === "navigate" ? { url: "https://example.com" } : {} });
      expect(result.response.status).toBe(409);
      expect(result.body.error).toMatch(/held by the user/i);
    }
    const otherProfile = await request(host, "state", { profile: "personal" });
    expect(otherProfile.response.status).toBe(409);
    expect(calls.filter(([operation]) => operation !== "cancelAgentActions")).toEqual([]);
  });

  it("discards a read that overlaps a fast take-control and hand-back", async () => {
    const { host, setHeld, setScreenshotImpl } = harness();
    await host.start();
    let finish;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    setScreenshotImpl(() => {
      markStarted();
      return new Promise((resolve) => { finish = resolve; });
    });
    const pending = request(host, "screenshot");
    await started;
    setHeld(true);
    setHeld(false);
    finish({ png: "c2VjcmV0", format: "jpeg" });
    const result = await pending;
    expect(result.response.status).toBe(409);
    expect(result.body).toEqual({ error: "Browser control changed while the request was running — retry after the user hands it back" });
  });

  it("cancels and discards an in-flight request when its capability is revoked", async () => {
    const { host, setScreenshotImpl, calls } = harness();
    await host.start();
    const scoped = await register(host);
    let finish;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    setScreenshotImpl(() => {
      markStarted();
      return new Promise((resolve) => { finish = resolve; });
    });
    const pending = request(host, "screenshot", { token: scoped });
    await started;
    expect((await manage(host, "revoke", { token: scoped })).response.status).toBe(200);
    finish({ png: "c2VjcmV0", format: "jpeg" });
    const result = await pending;
    expect(result.response.status).toBe(409);
    expect(result.body.error).toMatch(/turn ended/);
    expect(calls).toContainEqual(["cancelAgentActions", "bot-a"]);
  });

  it("decodes JSON only after joining split UTF-8 bytes", async () => {
    const { host, calls } = harness();
    await host.start();
    const profile = "work";
    const body = Buffer.from(JSON.stringify({ profile, url: "https://example.com/search?q=maus🐭" }));
    const emojiStart = body.indexOf(Buffer.from("🐭"));
    const scoped = await register(host, "bot-a", profile);

    const result = await new Promise((resolve, reject) => {
      const target = new URL(`${host.url}/v1/bots/bot-a/navigate`);
      const req = http.request({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          authorization: `Bearer ${scoped}`,
          "content-type": "application/json",
          "content-length": body.length,
        },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      req.on("error", reject);
      req.write(body.subarray(0, emojiStart + 1));
      setImmediate(() => {
        req.end(body.subarray(emojiStart + 1));
      });
    });

    expect(result.status).toBe(200);
    expect(calls).toContainEqual(["navigate", "bot-a", "https://example.com/search?q=maus🐭", "work"]);
    // Structured browser responses omit the convenience text channel and
    // scrub query/fragment tokens before leaving Electron.
    expect(result.body).toEqual({ url: "https://example.com/search", title: "Loaded", elements: [], notes: [] });
  });
});
