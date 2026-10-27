// Boots the real harness behind the real proxy: the bugs this design can have
// live in the seam between them.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProxyHandler } from "../src/proxy.ts";
import { MAX_SSE_EVENT_BYTES } from "../src/wire.ts";
import { createConnectedDeviceTracker } from "../src/connected-devices.ts";
import type { CompanionEndpoint } from "../src/endpoints.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/** Candidates from a fixed range below every platform's ephemeral range
 * (`listen(0)` lands in the 49152+ churn on macOS and Windows), each verified
 * by binding. `span` reserves consecutive ports. */
const freePorts = async (span = 1): Promise<number> => {
  const hold = (port: number): Promise<Server> =>
    new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve(server));
    });

  for (let attempt = 0; attempt < 40; attempt++) {
    const candidate = 20_000 + Math.floor(Math.random() * 9_000);
    const held: Server[] = [];
    let free = true;
    for (let i = 0; i < span; i++) {
      try {
        held.push(await hold(candidate + i));
      } catch {
        free = false;
        break;
      }
    }
    for (const server of held) await new Promise<void>((r) => server.close(() => r()));
    if (free) return candidate;
  }
  throw new Error(`could not find ${span} free consecutive ports`);
};

let HARNESS_PORT = 0;
let SIDECAR_PORT = 0;
let HARNESS = "";
let SIDECAR = "";

const TOKEN = "omb_test_token";
let harness: ChildProcess;
let sidecar: Server;
let home: string;
let stderr = "";
const connectedDevices = createConnectedDeviceTracker();

const device = async (
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; headers: Headers }> => {
  const token = opts.token === undefined ? TOKEN : opts.token;
  const res = await fetch(`${SIDECAR}${path}`, {
    method,
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
  }
  return { status: res.status, body, headers: res.headers };
};

/** fetch will not set a Host header */
const CONTROL_TOKEN = "fixture-control-token";
const controlHeaders = { "x-openmausbot-control-token": CONTROL_TOKEN };

const withHost = (port: number, host: string, path = "/api/health", headers: Record<string, string> = {}) =>
  new Promise<number>((resolve, reject) => {
    const r = request({ hostname: "127.0.0.1", port, path, headers: { host, ...controlHeaders, ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on("error", reject);
    r.end();
  });

beforeAll(async () => {
  // One call for all three (harness, its webhook receiver one above, the
  // sidecar): a second call could hand back the first call's released ports.
  const base = await freePorts(3);
  HARNESS_PORT = base;
  SIDECAR_PORT = base + 2;
  HARNESS = `http://127.0.0.1:${HARNESS_PORT}`;
  SIDECAR = `http://127.0.0.1:${SIDECAR_PORT}`;

  home = mkdtempSync(join(tmpdir(), "companion-test-"));
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(
    join(home, ".openmausbot", "config.json"),
    JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }),
  );

  harness = spawn(process.execPath, [join(ROOT, "server", "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(HARNESS_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  harness.stderr!.on("data", (c) => (stderr += c));

  // Cold Windows and macOS runners are slow to start a type-stripping Node.
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      // A bare fetch to a port that accepts but never answers hangs forever.
      if ((await fetch(`${HARNESS}/api/health`, { signal: AbortSignal.timeout(2_000) })).ok) break;
    } catch {
    }
    if (Date.now() > deadline) throw new Error(`harness never came up:\n${stderr}`);
    if (harness.exitCode !== null) throw new Error(`harness exited ${harness.exitCode}:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  sidecar = createServer(
    createProxyHandler({
      harnessPort: HARNESS_PORT,
      authenticate: (t) => (t === TOKEN ? { id: "d1", cloudDesktopAccess: true, browserControlAccess: false } : null),
      redeem: (code, deviceName) =>
        code === "424242"
          ? { token: TOKEN, device: { id: "d1", name: String(deviceName) } }
          : { error: "that code is not right" },
      serverName: () => "Test computer",
      connected: connectedDevices.open,
    }),
  );
  // A bind failure emits `error` and never calls back.
  await new Promise<void>((resolve, reject) => {
    sidecar.once("error", reject);
    sidecar.listen(SIDECAR_PORT, "127.0.0.1", () => resolve());
  });
}, 90_000);

afterAll(async () => {
  await new Promise<void>((r) => (sidecar ? sidecar.close(() => r()) : r()));
  await waitForExit(harness, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("the sidecar in front of an unmodified harness", () => {
  it("reaches the harness with a Host the harness itself would refuse", async () => {
    // Asserts only that the sidecar answers, whatever the harness's own Host
    // policy.
    expect(await withHost(SIDECAR_PORT, "macbook.tail1234.ts.net:8800", "/api/bots", {
      authorization: `Bearer ${TOKEN}`,
    })).toBe(200);
    expect(await withHost(SIDECAR_PORT, "192.168.1.42:8800", "/api/bots", {
      authorization: `Bearer ${TOKEN}`,
    })).toBe(200);
  });

  it("refuses anything carrying an Origin, before looking at the token", async () => {
    const { status } = await device("GET", "/api/bots", { headers: { origin: "https://evil.example" } });
    expect(status).toBe(403);
    const local = await device("GET", "/api/bots", { headers: { origin: `http://127.0.0.1:${HARNESS_PORT}` } });
    expect(local.status).toBe(403);
  });

  it("rejects an event stream revoked while upstream headers are pending", async () => {
    let valid = true;
    let sendHeaders = () => {};
    let signalUpstream = () => {};
    const upstreamReached = new Promise<void>((resolve) => {
      signalUpstream = resolve;
    });
    const delayedHarness = createServer((_req, res) => {
      sendHeaders = () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: {}\n\n");
      };
      signalUpstream();
    });
    await new Promise<void>((resolve) => delayedHarness.listen(0, "127.0.0.1", resolve));
    const delayedHarnessPort = (delayedHarness.address() as { port: number }).port;
    const connections = createConnectedDeviceTracker();
    const delayedProxy = createServer(createProxyHandler({
      harnessPort: delayedHarnessPort,
      authenticate: () => valid ? { id: "phone-delayed", cloudDesktopAccess: false, browserControlAccess: false } : null,
      redeem: () => ({ error: "not pairing" }),
      serverName: () => "Test computer",
      connected: connections.open,
    }));
    await new Promise<void>((resolve) => delayedProxy.listen(0, "127.0.0.1", resolve));
    const delayedProxyPort = (delayedProxy.address() as { port: number }).port;

    try {
      const responsePending = fetch(`http://127.0.0.1:${delayedProxyPort}/api/events`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      await upstreamReached;
      valid = false;
      connections.disconnect("phone-delayed");
      sendHeaders();

      const response = await responsePending;
      expect(response.status).toBe(401);
      expect(connections.ids()).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => delayedProxy.close(() => resolve()));
      await new Promise<void>((resolve) => delayedHarness.close(() => resolve()));
    }
  });

  it("requires a paired token", async () => {
    const unauthenticated = await device("GET", "/api/bots", { token: null });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("cache-control")).toContain("no-store");
    expect(unauthenticated.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect((await device("GET", "/api/bots", { token: "omb_wrong" })).status).toBe(401);
    expect((await device("GET", "/api/bots")).status).toBe(200);
  });

  it("serves a minimal, non-cacheable companion health identity", async () => {
    const health = await device("GET", "/api/health", { token: null });
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ app: "openmausbot" });
    expect(health.headers.get("cache-control")).toBe("private, no-store");
    expect(health.headers.get("cdn-cache-control")).toBe("no-store");
    expect(JSON.stringify(health.body)).not.toContain("pid");
    expect(JSON.stringify(health.body)).not.toContain("static");
  });

  it("refuses what a device has no business doing, by default", async () => {
    expect((await device("PUT", "/api/config", { body: { xai: { apiKey: "x" } } })).status).toBe(403);
    expect((await device("GET", "/api/devices")).status).toBe(403);
    expect((await device("GET", "/api/companion")).status).toBe(403);
    expect((await device("POST", "/api/local-computer/start")).status).toBe(403);
    expect((await device("GET", "/api/internal/peers")).status).toBe(404);
    expect((await device("GET", "/")).status).toBe(404);
    expect((await device("GET", "/api/config")).status).toBe(200);

    const { body } = await device("GET", "/api/bots");
    const botId = body.bots[0].id;
    expect((await device("PATCH", `/api/bots/${botId}`, { body: { autoApprove: true } })).status).toBe(403);
    expect((await device("PATCH", `/api/groups/not-a-room`, { body: { unread: false } })).status).toBe(404);
  });

  it("lets a device answer an approval, and manage its own chats", async () => {
    // The harness's own "no such pending request" proves the route arrived.
    const { body } = await device("GET", "/api/bots");
    const bot = body.bots[0];

    for (const [method, path, payload] of [
      ["POST", `/api/threads/${bot.threadId}/respond`, { requestId: "nope", behavior: "allow" }],
      ["POST", `/api/bots/${bot.id}/messages`, { text: "hello from a test" }],
      ["POST", `/api/bots/${bot.id}/interrupt`, undefined],
      ["POST", `/api/bots/${bot.id}/read`, undefined],
    ] as const) {
      const res = await device(method, path, payload ? { body: payload } : {});
      expect(res.status, `${method} ${path} was blocked by the sidecar`).not.toBe(403);
      expect(res.status, `${method} ${path} never reached the harness`).not.toBe(404);
    }
  });

  it("saves a paired device's bot appearance and returns it to other clients", async () => {
    const { body } = await device("GET", "/api/bots");
    const bot = body.bots[0];
    const appearance = { color: "teal", mascotBody: "star", mascotExpression: "happy" };
    const saved = await device("PATCH", `/api/bots/${bot.id}`, { body: appearance });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.bot).toMatchObject(appearance);

    const refreshed = await device("GET", "/api/bots");
    expect(refreshed.body.bots.find((candidate: { id: string }) => candidate.id === bot.id))
      .toMatchObject(appearance);
    const host = await fetch(`${HARNESS}/api/bots`).then((response) => response.json()) as { bots: Array<{ id: string }> };
    expect(host.bots.find((candidate: { id: string }) => candidate.id === bot.id))
      .toMatchObject(appearance);
  });

  it("refuses unauthenticated appearance saves and protected fields without changing the bot", async () => {
    const { body } = await device("GET", "/api/bots");
    const bot = body.bots[0];
    const path = `/api/bots/${bot.id}`;
    const appearance = { color: "coral", mascotBody: "diamond", mascotExpression: "sleeping" };
    for (const token of [null, "omb_wrong"]) {
      expect((await device("PATCH", path, { token, body: appearance })).status).toBe(401);
    }
    for (const protectedPatch of [
      { autoApprove: true },
      { approvalMode: "full" },
      { soul: "not permitted" },
      { computer: "local" },
      { modelSelection: { instanceId: "ghost", model: "other" } },
      { unexpected: true },
    ]) {
      const refused = await device("PATCH", path, { body: { ...appearance, ...protectedPatch } });
      expect(refused.status, JSON.stringify(protectedPatch)).toBe(403);
      expect(refused.body.error).toContain(Object.keys(protectedPatch)[0]);
      expect(refused.body.error).toContain("host computer");
      const refreshed = await device("GET", "/api/bots");
      expect(refreshed.body.bots.find((candidate: { id: string }) => candidate.id === bot.id)).toEqual(bot);
    }
  });

  it("refuses a new bot's protected settings from a paired device without making the bot", async () => {
    const ids = async () => ((await device("GET", "/api/bots")).body.bots as Array<{ id: string }>).map((bot) => bot.id);
    const before = await ids();
    const settings: Array<[string, unknown]> = [
      ["approvalMode", "full"], ["approvalMode", "ask"], ["alwaysAllow", ["Bash(*)"]], ["chiefOfStaff", true], ["computer", "local"],
      ["cwd", "/"], ["peers", []], ["approvePeerComms", false], ["mcpServers", ["github"]], ["browserProfile", "guest"],
      ["toolScope", { allow: ["native:*"] }], ["composio", true], ["browser", true],
    ];
    const fields: Array<[string, unknown]> = [
      ["section", "Ops"], ["preset", "chief-of-staff"], ["visibility", { audience: "members" }], ["reportsTo", "someone@example.test"], ["unexpected", true],
    ];
    for (const [field, body] of [
      ...settings.map(([field, value]) => [field, { name: "From the phone", settings: { [field]: value } }] as const),
      ...fields.map(([field, value]) => [field, { name: "From the phone", [field]: value }] as const),
    ]) {
      const refused = await device("POST", "/api/bots", { body });
      expect(refused.status, JSON.stringify(body)).toBe(403);
      expect(refused.body.error).toContain(field);
      expect(refused.body.error).toContain("host computer");
    }
    expect(await ids()).toEqual(before);

    const made = await device("POST", "/api/bots", {
      body: { name: "From the phone", settings: { soul: "Plans trips.", color: "teal", mascotBody: "star" } },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.bot).toMatchObject({ name: "From the phone", color: "teal", mascotBody: "star" });
  });

  it("saves the avatar panel's reset and shape choices from a paired device", async () => {
    const { body } = await device("GET", "/api/bots");
    const bot = body.bots[0];
    const path = `/api/bots/${bot.id}`;
    const shape = await device("PATCH", path, { body: { color: "purple", avatarCrop: "square", avatarZoom: 1.5, avatarFocusX: 0.25, avatarFocusY: 0.75 } });
    expect(shape.status, JSON.stringify(shape.body)).toBe(200);
    expect(shape.body.bot).toMatchObject({ color: "purple", avatarCrop: "square", avatarZoom: 1.5, avatarFocusX: 0.25, avatarFocusY: 0.75 });

    const reset = await device("PATCH", path, { body: { avatarCrop: "mascot", color: "green", mascotExpression: null, mascotBody: "cursor" } });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    const host = await fetch(`${HARNESS}/api/bots`).then((response) => response.json()) as { bots: Array<{ id: string }> };
    expect(host.bots.find((candidate) => candidate.id === bot.id))
      .toMatchObject({ avatarCrop: "mascot", color: "green", mascotBody: "cursor" });
    expect((await device("PATCH", path, { body: { avatarUrl: "/etc/passwd" } })).status).toBe(400);
  });

  it("refuses appearance values clients cannot draw without changing the bot", async () => {
    const { body } = await device("GET", "/api/bots");
    const bot = body.bots[0];
    for (const invalid of [
      { color: "#168aad" },
      { color: "<script>" },
      { color: { nested: true } },
      { mascotExpression: 12345 },
      { mascotExpression: "x".repeat(81) },
      { mascotBody: "nope" },
      { pinned: [1, 2] },
      { avatarCrop: "triangle" },
      { avatarFocusX: "left" },
    ]) {
      const refused = await device("PATCH", `/api/bots/${bot.id}`, { body: invalid });
      expect(refused.status, JSON.stringify(invalid)).toBe(400);
      expect(refused.body.error).toContain(Object.keys(invalid)[0]);
      const refreshed = await device("GET", "/api/bots");
      expect(refreshed.body.bots.find((candidate: { id: string }) => candidate.id === bot.id)).toEqual(bot);
    }
  });

  it("does not let a device suppress the companion marker to change protected fields", async () => {
    const { body } = await device("GET", "/api/bots");
    const bot = body.bots[0];
    const refused = await device("PATCH", `/api/bots/${bot.id}`, {
      headers: { "x-openmausbot-companion": "0" },
      body: { color: "coral", autoApprove: true },
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain("autoApprove");
    const refreshed = await device("GET", "/api/bots");
    expect(refreshed.body.bots.find((candidate: { id: string }) => candidate.id === bot.id)).toEqual(bot);
  });

  it("files bots through only the narrow atomic organizer route", async () => {
    const listed = await device("GET", "/api/bots");
    const first = listed.body.bots[0];
    const second = (await device("POST", "/api/bots")).body.bot;

    const partial = await device("POST", "/api/sidebar-sections", {
      body: { name: "Mobile", botIds: [first.id, "missing"] },
    });
    expect(partial.status).toBe(404);
    const afterFailure = await device("GET", "/api/bots");
    expect(afterFailure.body.bots.find((bot: { id: string }) => bot.id === first.id)?.section)
      .toBe(first.section);

    const filed = await device("POST", "/api/sidebar-sections", {
      body: { name: "  Mobile  ", botIds: [first.id, second.id, first.id] },
    });
    expect(filed.status).toBe(200);
    expect(filed.body.section).toBe("Mobile");
    expect(filed.body.bots.map((bot: { id: string }) => bot.id)).toEqual([first.id, second.id]);
    expect(filed.body.bots.every((bot: { section?: string }) => bot.section === "Mobile")).toBe(true);

    const cleared = await device("POST", "/api/sidebar-sections", {
      body: { name: "", botIds: [first.id] },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.bots[0].section).toBeUndefined();

    const smuggled = await device("POST", "/api/sidebar-sections", {
      body: { name: "Unsafe", botIds: [first.id], autoApprove: true },
    });
    expect(smuggled.status).toBe(400);
  });

  it("creates a bot through companion pairing without host defaults or settings access", async () => {
    const before = (await device("GET", "/api/bots")).body.bots;
    const created = await device("POST", "/api/bots");
    expect(created.status).toBe(201);
    const id = created.body.bot.id;
    expect(before.some((bot: { id: string }) => bot.id === id)).toBe(false);
    const after = (await device("GET", "/api/bots")).body.bots;
    expect(after).toHaveLength(before.length + 1);
    expect(after.some((bot: { id: string }) => bot.id === id)).toBe(true);
    expect((await device("GET", "/api/bot-defaults")).status).toBe(404);
    expect((await device("PATCH", `/api/bots/${id}`, { body: { soul: "not permitted" } })).status).toBe(403);
  });

  it("only remembers an always-allow key carried by a pending card", async () => {
    const { body } = await device("GET", "/api/bots");
    const bot = body.bots[0];
    const attempt = await device("POST", `/api/bots/${bot.id}/always-allow`, {
      body: { allowKey: "Bash" },
    });
    expect(attempt.status).toBe(409);

    const refreshed = await device("GET", "/api/bots");
    expect(refreshed.body.bots.find((candidate: any) => candidate.id === bot.id).alwaysAllow ?? []).not.toContain("Bash");
  });

  it("never passes the provider session cursors through", async () => {
    const listed = await device("GET", "/api/bots");
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain("resumeCursors");
    for (const bot of listed.body.bots) {
      expect(bot).not.toHaveProperty("resumeCursors");
      for (const task of bot.tasks ?? []) expect(task).not.toHaveProperty("resumeCursors");
    }

    // Whether the harness sent any is not asserted: versions differ, and the
    // sidecar scrubs either way.
  });

  it("streams events through, terminated and scrubbed, keeping the resume cursor", async () => {
    const controller = new AbortController();
    const res = await fetch(`${SIDECAR}/api/events`, {
      headers: { accept: "text/event-stream", authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(connectedDevices.ids()).toEqual(["d1"]);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const nextEvent = async (want: (event: string) => boolean): Promise<string | null> => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        let boundary = buffered.indexOf("\n\n");
        while (boundary >= 0) {
          const event = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          if (want(event)) return event;
          boundary = buffered.indexOf("\n\n");
        }
        if (Date.now() > deadline) return null;
        const { value, done } = await reader.read();
        if (done) return null;
        buffered += decoder.decode(value, { stream: true });
      }
    };

    try {
      // A transform that normalises whitespace loses the blank-line
      // terminator and parses to nothing.
      const hello = await nextEvent((e) => e.includes('"kind":"hello"'));
      expect(hello).not.toBeNull();
      expect(JSON.parse(hello!.replace(/^data:\s*/, ""))).toMatchObject({ kind: "hello" });

      // Broadcast frames carry `id:`, the resume cursor.
      const { body } = await device("GET", "/api/bots");
      const botId = body.bots[0].id;
      await device("POST", `/api/bots/${botId}/read`);

      const frame = await nextEvent((e) => e.startsWith("id: "));
      expect(frame).not.toBeNull();
      expect(frame).toMatch(/^id: [0-9a-f]+:\d+\n/);
      expect(frame).not.toContain("resumeCursors");
    } finally {
      controller.abort();
      const cleanupDeadline = Date.now() + 2_000;
      while (connectedDevices.ids().length && Date.now() < cleanupDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(connectedDevices.ids()).toEqual([]);
    }
  });

  it("says the harness is down rather than hanging, when it is", async () => {
    const orphan = createServer(
      createProxyHandler({
        harnessPort: 1,
        authenticate: () => ({ cloudDesktopAccess: true, browserControlAccess: false }),
        redeem: () => ({ error: "no" }),
        serverName: () => "Test computer",
      }),
    );
    await new Promise<void>((r) => orphan.listen(0, "127.0.0.1", r));
    const port = (orphan.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/bots`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toContain("not running");
    } finally {
      await new Promise<void>((r) => orphan.close(() => r()));
    }
  });

  it("gives up on a harness that accepts a connection and then goes quiet", async () => {
    const mute = createServer(() => {
    });
    await new Promise<void>((r) => mute.listen(0, "127.0.0.1", r));
    const mutePort = (mute.address() as { port: number }).port;
    const stalled = createServer(
      createProxyHandler({
        harnessPort: mutePort,
        authenticate: () => ({ cloudDesktopAccess: true, browserControlAccess: false }),
        redeem: () => ({ error: "no" }),
        serverName: () => "Test computer",
        headersTimeoutMs: 300,
      }),
    );
    await new Promise<void>((r) => stalled.listen(0, "127.0.0.1", r));
    const port = (stalled.address() as { port: number }).port;
    try {
      const started = Date.now();
      const res = await fetch(`http://127.0.0.1:${port}/api/bots`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(504);
      expect(((await res.json()) as { error: string }).error).toContain("did not respond");
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      mute.closeAllConnections?.();
      await new Promise<void>((r) => mute.close(() => r()));
      await new Promise<void>((r) => stalled.close(() => r()));
    }
  });

  it("hangs up on the harness when the device disappears", async () => {
    let upstreamClosed: () => void;
    let upstreamReached: () => void;
    const closed = new Promise<void>((r) => (upstreamClosed = r));
    const reached = new Promise<void>((r) => (upstreamReached = r));
    const slow = createServer((_req, res) => {
      res.on("error", () => {
      });
      res.on("close", () => upstreamClosed());
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"bots":[');
      upstreamReached();
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
    const slowPort = (slow.address() as { port: number }).port;
    const relay = createServer(
      createProxyHandler({
        harnessPort: slowPort,
        authenticate: () => ({ cloudDesktopAccess: true, browserControlAccess: false }),
        redeem: () => ({ error: "no" }),
        serverName: () => "Test computer",
      }),
    );
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
    const port = (relay.address() as { port: number }).port;
    const abort = new AbortController();
    try {
      // Not awaited: a JSON response is buffered whole, so it has no headers
      // until the stub ends, and the stub never ends.
      const pending = fetch(`http://127.0.0.1:${port}/api/bots`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: abort.signal,
      }).catch(() => {
      });
      await reached;
      abort.abort();
      await closed;
      await pending;
    } finally {
      abort.abort();
      slow.closeAllConnections?.();
      await new Promise<void>((r) => slow.close(() => r()));
      await new Promise<void>((r) => relay.close(() => r()));
    }
  }, 20_000);

  it("ends a stream whose event never terminates, rather than buffering it", async () => {
    const OVER_CEILING = MAX_SSE_EVENT_BYTES + 512 * 1024;
    const flood = createServer((_req, res) => {
      res.on("error", () => {
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: ");
      const blob = "x".repeat(64 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < OVER_CEILING) {
          sent += blob.length;
          if (!res.write(blob)) return void res.once("drain", pump);
        }
      };
      pump();
    });
    await new Promise<void>((r) => flood.listen(0, "127.0.0.1", r));
    const floodPort = (flood.address() as { port: number }).port;
    const relay = createServer(
      createProxyHandler({
        harnessPort: floodPort,
        authenticate: () => ({ cloudDesktopAccess: true, browserControlAccess: false }),
        redeem: () => ({ error: "no" }),
        serverName: () => "Test computer",
      }),
    );
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
    const port = (relay.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("");
    } finally {
      flood.closeAllConnections?.();
      await new Promise<void>((r) => flood.close(() => r()));
      await new Promise<void>((r) => relay.close(() => r()));
    }
  }, 20_000);
});

describe("live companion endpoint refresh", () => {
  it("requires a valid paired bearer and reflects hosted add/remove without restart", async () => {
    let endpoints: Array<CompanionEndpoint & { internal?: string }> = [
      {
        kind: "lan",
        priority: 200,
        url: "http://192.168.1.42:8810",
        internal: "must never cross the boundary",
      },
    ];
    const endpointServer = createServer(
      createProxyHandler({
        // No harness on port 1: a 200 proves the sidecar answered locally.
        harnessPort: 1,
        authenticate: (token) => token === TOKEN ? { cloudDesktopAccess: false, browserControlAccess: false } : null,
        redeem: () => ({ error: "not used" }),
        serverName: () => "Test computer",
        endpoints: () => endpoints,
      }),
    );
    await new Promise<void>((resolve) => endpointServer.listen(0, "127.0.0.1", resolve));
    const port = (endpointServer.address() as { port: number }).port;
    const load = (token?: string) =>
      fetch(`http://127.0.0.1:${port}/api/companion/endpoints`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });

    try {
      expect((await load()).status).toBe(401);
      expect((await load("wrong-token")).status).toBe(401);

      const direct = await load(TOKEN);
      expect(direct.status).toBe(200);
      expect(await direct.json()).toEqual({
        serverName: "Test computer",
        endpoints: [{ kind: "lan", priority: 200, url: "http://192.168.1.42:8810" }],
      });
      expect(direct.headers.get("cache-control")).toBe("private, no-store");

      endpoints = [
        { kind: "hosted", priority: 0, url: "https://c-opaque.openmausbot.test" },
        { kind: "lan", priority: 200, url: "http://192.168.1.42:8810" },
      ];
      expect(await (await load(TOKEN)).json()).toEqual({
        serverName: "Test computer",
        endpoints,
      });

      endpoints = [{ kind: "lan", priority: 200, url: "http://192.168.1.42:8810" }];
      expect(await (await load(TOKEN)).json()).toEqual({
        serverName: "Test computer",
        endpoints,
      });

      endpoints = Array.from({ length: 12 }, (_unused, index) => ({
        kind: "lan" as const,
        priority: 200 + index,
        url: `http://192.168.1.${index + 1}:8810`,
        internal: `private-${index}`,
      }));
      const bounded = await (await load(TOKEN)).json() as {
        endpoints: CompanionEndpoint[];
        serverName: string;
      };
      expect(bounded.endpoints).toHaveLength(8);
      expect(
        bounded.endpoints.every(
          (endpoint) => Object.keys(endpoint).sort().join(",") === "kind,priority,url",
        ),
      ).toBe(true);
      expect(JSON.stringify(bounded)).not.toContain("private-");
    } finally {
      await new Promise<void>((resolve) => endpointServer.close(() => resolve()));
    }
  });
});

describe("pairing, end to end", () => {
  it("turns a QR credential into a working device token", async () => {
    const { DeviceRegistry } = await import("../src/devices.ts");
    const { createControlServer } = await import("../src/control.ts");

    const registry = new DeviceRegistry();
    const connections = createConnectedDeviceTracker();
    const paired = createServer(
      createProxyHandler({
        harnessPort: HARNESS_PORT,
        authenticate: (t) => registry.authenticate(t ?? undefined),
        redeem: (code, deviceName, pairRequestId) => registry.redeem(code, deviceName, pairRequestId),
        serverName: () => "Ada's computer",
        hosts: () => ["macbook.tail1234.ts.net", "192.168.1.42", "openmausbot-abcd1234.local"],
        endpoints: () => [
          { url: "https://device-123.companion.example", kind: "hosted", priority: 0 },
          { url: "http://192.168.1.42:8810", kind: "lan", priority: 200 },
        ],
        connected: connections.open,
      }),
    );
    await new Promise<void>((r) => paired.listen(0, "127.0.0.1", r));
    const port = (paired.address() as { port: number }).port;
    const control = createControlServer({
      devices: registry,
      controlToken: () => CONTROL_TOKEN,
      companionPort: port,
      discovery: () => ({ advertising: false, name: "OpenMausBot" }),
      connectedDeviceIds: connections.ids,
      disconnectDevice: connections.disconnect,
    });
    await new Promise<void>((r) => control.listen(0, "127.0.0.1", r));
    const controlPort = (control.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const ctl = `http://127.0.0.1:${controlPort}`;

    try {
      expect((await fetch(`${base}/api/bots`)).status).toBe(401);

      const opened = (await (await fetch(`${ctl}/pairing`, { method: "POST", headers: controlHeaders })).json()) as {
        code: string;
        token: string;
      };
      expect(opened.code).toMatch(/^\d{6}$/);
      expect(opened.token).toMatch(/^omb_pair_[A-Za-z0-9_-]{43}$/);

      const wrong = await fetch(`${base}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "000000", deviceName: "Impostor" }),
      });
      expect(wrong.status).toBe(401);

      const pairRequestId = "4c825d5b-cf40-4db7-aac5-2455f805a8ec";
      const pairBody = JSON.stringify({
        credential: opened.token,
        deviceName: "Ada's iPhone",
        pairRequestId,
      });
      const res = await fetch(`${base}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: pairBody,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        token: string;
        serverName: string;
        hosts: string[];
        endpoints: Array<{ url: string; kind: string; priority: number }>;
      };
      expect(body.serverName).toBe("Ada's computer");
      expect(body.token).toMatch(/^omb_/);
      expect(body.hosts).toEqual(["macbook.tail1234.ts.net", "192.168.1.42", "openmausbot-abcd1234.local"]);
      expect(body.endpoints).toEqual([
        { url: "https://device-123.companion.example", kind: "hosted", priority: 0 },
        { url: "http://192.168.1.42:8810", kind: "lan", priority: 200 },
      ]);

      // A lost first response: the same request via a fallback address gets
      // the token already committed.
      const replay = await fetch(`${base}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: pairBody,
      });
      expect(replay.status).toBe(201);
      expect((await replay.json() as { token: string }).token).toBe(body.token);

      const bots = await fetch(`${base}/api/bots`, { headers: { authorization: `Bearer ${body.token}` } });
      expect(bots.status).toBe(200);
      expect(await bots.text()).not.toContain("resumeCursors");

      const eventStream = await new Promise<IncomingMessage>((resolve, reject) => {
        const streamRequest = request(`${base}/api/events`, {
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${body.token}`,
          },
        }, resolve);
        streamRequest.on("error", reject);
        streamRequest.end();
      });
      eventStream.resume();
      const eventStreamClosed = new Promise<void>((resolve) => eventStream.once("close", resolve));

      const state = (await (await fetch(`${ctl}/state`, { headers: controlHeaders })).json()) as {
        devices: Array<{ id: string; name: string }>;
        connectedDeviceIds: string[];
      };
      expect(state.devices.map((d) => d.name)).toContain("Ada's iPhone");
      // By name: `devices[0]` is load order.
      const ada = state.devices.find((d) => d.name === "Ada's iPhone")!;
      expect(state.connectedDeviceIds).toContain(ada.id);
      const revoked = await fetch(`${ctl}/devices/${ada.id}`, { method: "DELETE", headers: controlHeaders });
      expect(revoked.status).toBe(200);
      expect((await revoked.json() as { connectedDeviceIds: string[] }).connectedDeviceIds).not.toContain(ada.id);
      await eventStreamClosed;
      expect((await fetch(`${base}/api/bots`, { headers: { authorization: `Bearer ${body.token}` } })).status).toBe(401);
    } finally {
      await new Promise<void>((r) => paired.close(() => r()));
      await new Promise<void>((r) => control.close(() => r()));
    }
  });

  it("keeps the control surface off the network", async () => {
    const { DeviceRegistry } = await import("../src/devices.ts");
    const { createControlServer } = await import("../src/control.ts");
    const control = createControlServer({
      devices: new DeviceRegistry(),
      controlToken: () => CONTROL_TOKEN,
      companionPort: 8800,
      discovery: () => ({ advertising: false, name: "OpenMausBot" }),
    });
    await new Promise<void>((r) => control.listen(0, "127.0.0.1", r));
    const port = (control.address() as { port: number }).port;
    try {
      expect(await withHost(port, "macbook.tail1234.ts.net:8801", "/state")).toBe(403);
      expect(await withHost(port, `127.0.0.1:${port}`, "/state")).toBe(200);
    } finally {
      await new Promise<void>((r) => control.close(() => r()));
    }
  });

  it("understands an IPv6 loopback Host", async () => {
    const { DeviceRegistry } = await import("../src/devices.ts");
    const { createControlServer, hostOf } = await import("../src/control.ts");

    expect(hostOf("[::1]:8811")).toBe("::1");
    expect(hostOf("127.0.0.1:8811")).toBe("127.0.0.1");
    expect(hostOf("localhost")).toBe("localhost");
    expect(hostOf("[::1")).toBe("[::1");

    const control = createControlServer({
      devices: new DeviceRegistry(),
      controlToken: () => CONTROL_TOKEN,
      companionPort: 8800,
      discovery: () => ({ advertising: false, name: "OpenMausBot" }),
    });
    await new Promise<void>((r) => control.listen(0, "127.0.0.1", r));
    const port = (control.address() as { port: number }).port;
    try {
      expect(await withHost(port, `[::1]:${port}`, "/state")).toBe(200);
      expect(await withHost(port, "[::1].evil.example", "/state")).toBe(403);

      expect(await withHost(port, "::1", "/state")).toBe(403);
      expect(await withHost(port, ":8811", "/state")).toBe(403);
      expect(await withHost(port, "[]:8811", "/state")).toBe(403);
    } finally {
      await new Promise<void>((r) => control.close(() => r()));
    }
  });

  it("refuses a write from a page the person happened to be reading", async () => {
    const { DeviceRegistry } = await import("../src/devices.ts");
    const { createControlServer } = await import("../src/control.ts");
    const registry = new DeviceRegistry();
    const control = createControlServer({
      devices: registry,
      controlToken: () => CONTROL_TOKEN,
      companionPort: 8800,
      discovery: () => ({ advertising: false, name: "OpenMausBot" }),
    });
    await new Promise<void>((r) => control.listen(0, "127.0.0.1", r));
    const port = (control.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const evil = await fetch(`${base}/pairing`, {
        method: "POST",
        headers: { origin: "https://evil.example", ...controlHeaders },
      });
      expect(evil.status).toBe(403);
      expect(registry.pairing()).toBe(null);

      // A page served from the control port itself, as a bot's browser would open it, has no token.
      const tokenless = await fetch(`${base}/pairing`, { method: "POST", headers: { origin: base } });
      expect(tokenless.status).toBe(403);
      expect(registry.pairing()).toBe(null);

      // Browsers send Origin on any write, so the control page's own must pass.
      const ours = await fetch(`${base}/pairing`, {
        method: "POST",
        headers: { origin: base, ...controlHeaders },
      });
      expect(ours.status).toBe(201);
      expect(registry.pairing()).not.toBe(null);

      const stolen = await fetch(`${base}/devices/whatever`, {
        method: "DELETE",
        headers: { origin: "https://evil.example", ...controlHeaders },
      });
      expect(stolen.status).toBe(403);
    } finally {
      await new Promise<void>((r) => control.close(() => r()));
    }
  });

  it("refuses a cross-origin request even though its Host is loopback", async () => {
    const { DeviceRegistry } = await import("../src/devices.ts");
    const { createControlServer } = await import("../src/control.ts");
    const registry = new DeviceRegistry();
    const control = createControlServer({
      devices: registry,
      controlToken: () => CONTROL_TOKEN,
      companionPort: 8800,
      discovery: () => ({ advertising: false, name: "OpenMausBot" }),
    });
    await new Promise<void>((r) => control.listen(0, "127.0.0.1", r));
    const port = (control.address() as { port: number }).port;
    const host = `127.0.0.1:${port}`;
    try {
      for (const origin of ["https://evil.example", "http://127.0.0.1.evil.example", "null"]) {
        expect(await withHost(port, host, "/state", { origin })).toBe(403);
      }
      expect(registry.pairing()).toBeNull();

      // Only the exact authority passes: `localhost` is some other program's page.
      expect(await withHost(port, host, "/state", { origin: `http://localhost:${port}` })).toBe(403);

      expect(await withHost(port, host, "/state", { origin: `http://${host}` })).toBe(200);
      expect(await withHost(port, host, "/state")).toBe(200);
    } finally {
      await new Promise<void>((r) => control.close(() => r()));
    }
  });
});

describe("revoking a capability mid-stream", () => {
  it("closes a browser-live stream the device already has open", async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: ready\ndata: {\"viewerId\":\"v1\"}\n\n");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const handler = createProxyHandler({
      harnessPort: upstreamPort,
      authenticate: () => ({ id: "phone-1", cloudDesktopAccess: false, browserControlAccess: true }),
      redeem: () => null,
      endpoints: () => [],
    } as never);
    const relay = createServer(handler);
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
    const relayPort = (relay.address() as { port: number }).port;

    const response = await fetch(
      `http://127.0.0.1:${relayPort}/api/bots/b1/browser/live`,
      { headers: { authorization: "Bearer t" } },
    );
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    await reader.read();

    handler.disconnectDevice?.("phone-1");

    // The reader may end cleanly or throw "terminated"; either means the
    // connection is gone.
    let ended = false;
    try {
      while (!(await reader.read()).done) { /* drain */ }
      ended = true;
    } catch {
      ended = true;
    }
    expect(ended).toBe(true);

    relay.close();
    upstream.close();
  });
});
