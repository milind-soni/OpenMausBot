import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLOUD_CONNECTED_APPS_FILE, startCloudConnectedApps, type CloudConnectedAppsOptions } from "./cloud-connected-apps.ts";
import { connectionMode, connectorSetup, listToolkits, setManagedBrokerAccess } from "./composio.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const BROKER = "https://broker.example.test";
const OLD = "a".repeat(64);
const NEW = "b".repeat(64);
const NEWER = "c".repeat(64);

type Reply = Response | Error;
interface Call { method: string; path: string; authorization: string | null; body?: string }

/** A connected-apps service that answers each route from its own queue, the last reply repeating. */
function fakeBroker(routes: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const key = `${method} ${url.pathname}`;
    calls.push({ method, path: url.pathname, authorization: new Headers(init?.headers).get("authorization"), ...(init?.body ? { body: String(init.body) } : {}) });
    const queue = routes[key];
    if (!queue?.length) throw new Error(`unexpected ${key}`);
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (reply instanceof Error) throw reply;
    return reply.clone();
  }) as typeof fetch;
  return { calls, fetchImpl, registrations: () => calls.filter((call) => call.path === "/v1/installations").length };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const registered = (token: string, installationId = `install-${token.slice(0, 4)}`) => json(201, { installationId, token });

let dataDir: string;
let timers: { run: () => void; ms: number }[];
let lines: string[];
let applied: ({ url: string; token: string } | null)[];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "omb-cloud-connected-apps-"));
  timers = [];
  lines = [];
  applied = [];
});

afterEach(async () => {
  setManagedBrokerAccess(null);
  await removeTempDir(dataDir);
});

function start(fetchImpl: typeof fetch, over: Partial<CloudConnectedAppsOptions> = {}) {
  return startCloudConnectedApps({
    dataDir,
    brokerUrl: BROKER,
    fetchImpl,
    // The server's wiring: the one managed path, as the desktop app's message reaches it.
    apply: (access) => {
      applied.push(access);
      setManagedBrokerAccess(access);
    },
    log: (line) => lines.push(line),
    random: () => 0.5,
    setTimer: (run, ms) => {
      timers.push({ run, ms });
      return {};
    },
    clearTimer: () => {},
    ...over,
  });
}

const file = () => join(dataDir, CLOUD_CONNECTED_APPS_FILE);
const stored = () => JSON.parse(readFileSync(file(), "utf8"));
function store(token: string, brokerUrl = BROKER, extra: Record<string, unknown> = {}) {
  writeFileSync(file(), JSON.stringify({ version: 1, brokerUrl, installationId: "install-old", token, ...extra }), { mode: 0o600 });
}

describe("a Cloud home's connected-apps installation", () => {
  it("registers once when it has none, keeps the token in a private file and turns connected apps on", async () => {
    const broker = fakeBroker({ "POST /v1/installations": [registered(NEW, "install-new")] });
    expect(connectionMode({})).toBe("unavailable");
    await start(broker.fetchImpl).settled();

    expect(broker.registrations()).toBe(1);
    expect(stored()).toEqual({ version: 1, brokerUrl: BROKER, installationId: "install-new", token: NEW });
    if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(applied.at(-1)).toEqual({ url: BROKER, token: NEW });
    expect(connectionMode({})).toBe("managed");
    expect(connectorSetup({}, true)).toBe("ready");
    expect(timers).toEqual([]);
    expect(lines.join("\n")).not.toContain(NEW);
  });

  it("reuses the token on the volume: serves it at once, checks it with /v1/me and never registers again", async () => {
    store(OLD);
    const broker = fakeBroker({ "GET /v1/me": [json(200, { installationId: "install-old" })] });
    const apps = start(broker.fetchImpl);
    // Before the check answers.
    expect(connectionMode({})).toBe("managed");
    await apps.settled();

    expect(broker.calls).toEqual([{ method: "GET", path: "/v1/me", authorization: `Bearer ${OLD}` }]);
    expect(stored().token).toBe(OLD);
    expect(applied).toEqual([{ url: BROKER, token: OLD }]);
    expect(timers).toEqual([]);
  });

  it("registers again only when the service refuses the token (401), and replaces it on the volume", async () => {
    store(OLD);
    const broker = fakeBroker({
      "GET /v1/me": [json(401, { error: "unauthorized" })],
      "POST /v1/installations": [registered(NEW, "install-new")],
    });
    await start(broker.fetchImpl).settled();

    expect(broker.calls.map((call) => call.path)).toEqual(["/v1/me", "/v1/installations"]);
    expect(stored()).toMatchObject({ installationId: "install-new", token: NEW });
    expect(applied).toEqual([{ url: BROKER, token: OLD }, { url: BROKER, token: NEW }]);
    expect(connectionMode({})).toBe("managed");
  });

  it("keeps a held token through an outage of the check, so a broker hiccup never strands connected accounts", async () => {
    for (const outage of [json(503, { error: "service unavailable" }), json(429, { error: "slow down" }), new TypeError("fetch failed")]) {
      store(OLD);
      const broker = fakeBroker({ "GET /v1/me": [outage] });
      await start(broker.fetchImpl).settled();
      expect(broker.registrations()).toBe(0);
      expect(stored().token).toBe(OLD);
      expect(connectionMode({})).toBe("managed");
    }
    expect(timers).toEqual([]);
  });

  it("boots with the service down, never throws, and retries with backoff until it registers", async () => {
    const broker = fakeBroker({
      "POST /v1/installations": [
        new TypeError("fetch failed"),
        json(429, { error: "too many registration attempts" }),
        json(503, { error: "registration is temporarily closed" }),
        registered(NEW),
      ],
    });
    const apps = start(broker.fetchImpl);
    await apps.settled();
    expect(applied).toEqual([null]);
    expect(connectionMode({})).toBe("unavailable");
    expect(connectorSetup({}, true)).toBe("service-unavailable");
    expect(existsSync(file())).toBe(false);

    // 30 s, 1 min, 2 min, each with the jitter random() = 0.5 adds (a tenth).
    for (const expected of [33_000, 66_000, 132_000]) {
      expect(timers).toHaveLength(1);
      const timer = timers.shift()!;
      expect(timer.ms).toBe(expected);
      timer.run();
      await apps.settled();
    }
    expect(timers).toEqual([]);
    expect(broker.registrations()).toBe(4);
    expect(stored().token).toBe(NEW);
    expect(connectionMode({})).toBe("managed");
    expect(lines.filter((line) => line.startsWith("connected-apps registration failed"))).toHaveLength(3);
  });

  it("drops a refused token it could not replace, and tries again later", async () => {
    store(OLD);
    const broker = fakeBroker({
      "GET /v1/me": [json(401, { error: "unauthorized" })],
      "POST /v1/installations": [json(503, { error: "registration is temporarily closed" }), registered(NEWER)],
    });
    const apps = start(broker.fetchImpl);
    await apps.settled();
    expect(existsSync(file())).toBe(false);
    expect(applied).toEqual([{ url: BROKER, token: OLD }, null]);
    expect(timers).toHaveLength(1);
    timers.shift()!.run();
    await apps.settled();
    expect(broker.calls.map((call) => call.path)).toEqual(["/v1/me", "/v1/installations", "/v1/installations"]);
    expect(stored().token).toBe(NEWER);
  });

  // A read-only folder refuses the write; Windows has no such mode, and root ignores it.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("never uses a token it could not save: it would be another installation after a restart", async () => {
    chmodSync(dataDir, 0o500);
    try {
      const broker = fakeBroker({ "POST /v1/installations": [registered(NEW)] });
      await start(broker.fetchImpl).settled();
      expect(broker.registrations()).toBe(1);
      expect(applied).toEqual([null]);
      expect(connectionMode({})).toBe("unavailable");
      expect(timers).toHaveLength(1);
    } finally {
      chmodSync(dataDir, 0o700);
    }
    expect(existsSync(file())).toBe(false);
  });

  it("leaves a file it does not understand as it is, and registers nothing", async () => {
    writeFileSync(file(), JSON.stringify({ version: 2, installations: {} }));
    const broker = fakeBroker({});
    await start(broker.fetchImpl).settled();
    expect(broker.calls).toEqual([]);
    expect(stored()).toEqual({ version: 2, installations: {} });
    expect(applied).toEqual([null]);
    expect(timers).toHaveLength(1);
  });

  it("registers nothing while the file cannot be read, so a passing fault never mints a second installation", async () => {
    mkdirSync(file());
    const broker = fakeBroker({});
    await start(broker.fetchImpl).settled();
    expect(broker.calls).toEqual([]);
    expect(lines.join("\n")).toMatch(/could not be read/);
    expect(timers).toHaveLength(1);
  });

  it("sends a token only to the service that issued it", async () => {
    store(OLD, "https://other-broker.example.test");
    const broker = fakeBroker({ "POST /v1/installations": [registered(NEW)] });
    await start(broker.fetchImpl).settled();
    expect(broker.calls.some((call) => call.authorization?.includes(OLD))).toBe(false);
    expect(stored()).toMatchObject({ brokerUrl: BROKER, token: NEW });
  });

  it("a Composio project key the owner saved still wins over the included service", async () => {
    store(OLD);
    await start(fakeBroker({ "GET /v1/me": [json(200, {})] }).fetchImpl).settled();
    expect(connectionMode({ composio: { apiKey: "ak_owner_project" } })).toBe("self-hosted");
    expect(connectionMode({ composio: { apiKey: "" } })).toBe("managed");
  });

  it("stops retrying once the server shuts down", async () => {
    let cleared = 0;
    const apps = start(fakeBroker({ "POST /v1/installations": [new TypeError("fetch failed")] }).fetchImpl, { clearTimer: () => { cleared += 1; } });
    await apps.settled();
    apps.stop();
    expect(cleared).toBe(1);
    timers.shift()!.run();
    await apps.settled();
    expect(applied).toEqual([null]);
  });

  it("serves the full catalog through the included service, not the short list", async () => {
    store(OLD);
    await start(fakeBroker({ "GET /v1/me": [json(200, {})] }).fetchImpl).settled();
    const catalogCalls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      catalogCalls.push(`${url} ${new Headers(init?.headers).get("authorization")}`);
      return json(200, {
        items: ["outlook", "linkedin", "calendly", "gmail"].map((slug) => ({ slug, name: slug, meta: { description: slug, logo: "" } })),
        total_items: 4, current_page: 1, total_pages: 1,
      });
    });
    try {
      const { cards, source } = await listToolkits({});
      expect(source).toBe("api");
      expect(cards.map((card) => card.slug)).toEqual(expect.arrayContaining(["outlook", "linkedin", "calendly"]));
      expect(catalogCalls).toEqual([`${BROKER}/v1/catalog Bearer ${OLD}`]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("a paid Cloud's grant", () => {
  const GRANT = `v1.omb-machine-1.${"g".repeat(43)}`;
  const grantCalls = (calls: Call[]) => calls.filter((call) => call.path === "/v1/installation/cloud");

  it("presents the Admin's grant with the installation's token, once", async () => {
    store(OLD);
    const broker = fakeBroker({
      "GET /v1/me": [json(200, { installationId: "install-old" })],
      "PUT /v1/installation/cloud": [json(200, { plan: "cloud", eventsPerDay: 2000 })],
    });
    await start(broker.fetchImpl, { cloudGrant: GRANT }).settled();
    expect(broker.calls).toEqual([
      { method: "GET", path: "/v1/me", authorization: `Bearer ${OLD}` },
      { method: "PUT", path: "/v1/installation/cloud", authorization: `Bearer ${OLD}`, body: JSON.stringify({ grant: GRANT }) },
    ]);
    expect(applied).toEqual([{ url: BROKER, token: OLD }]);
    expect(timers).toEqual([]);
    expect(lines).toContain("connected apps: Cloud plan confirmed");
    expect(lines.join("\n")).not.toContain(GRANT);
  });

  it("presents it for the new token after registering again", async () => {
    store(OLD);
    const broker = fakeBroker({
      "GET /v1/me": [json(401, { error: "unauthorized" })],
      "POST /v1/installations": [registered(NEW, "install-new")],
      "PUT /v1/installation/cloud": [json(200, {})],
    });
    await start(broker.fetchImpl, { cloudGrant: GRANT }).settled();
    expect(grantCalls(broker.calls).map((call) => call.authorization)).toEqual([`Bearer ${NEW}`]);
  });

  it("keeps connected apps on while the service cannot take the grant, retries with backoff, and stops at a refusal", async () => {
    store(OLD);
    const broker = fakeBroker({
      "GET /v1/me": [json(200, {})],
      "PUT /v1/installation/cloud": [json(503, { error: "service unavailable" }), new TypeError("fetch failed"), json(404, { error: "not found" })],
    });
    const apps = start(broker.fetchImpl, { cloudGrant: GRANT });
    await apps.settled();
    expect(connectionMode({})).toBe("managed");
    for (const expected of [33_000, 66_000]) {
      expect(timers.map((timer) => timer.ms)).toEqual([expected]);
      timers.shift()!.run();
      await apps.settled();
    }
    expect(timers).toEqual([]);
    expect(grantCalls(broker.calls)).toHaveLength(3);
    expect(lines.at(-1)).toBe("connected apps: the service did not take this Cloud's grant (HTTP 404)");
    expect(applied).toEqual([{ url: BROKER, token: OLD }]);
  });
});
