// The sidecar in front of a real harness.
//
// These boot the actual server and talk to it through the actual proxy,
// because every bug this design can have lives in the seam between them and
// none of them are visible to a unit test. In particular: SSE arriving but
// never terminating an event, a resume cursor being dropped on the way
// through, and the harness's loopback gate rejecting a proxied request.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProxyHandler } from "../src/proxy.ts";
import { createConnectedDeviceTracker } from "../src/connected-devices.ts";
import type { CompanionEndpoint } from "../src/endpoints.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/** Ports nothing is listening on.
 *
 * Two requirements here pull against each other. The port has to be
 * *verified* free — picking at random and hoping fails whenever something
 * else is on it, and the failure reads as a bug in the code under test rather
 * than as bad luck. And it must not come from the operating system's own
 * ephemeral range, because a port the kernel hands out is a port the kernel
 * hands out again: anything opening an outbound socket between this probe
 * closing and the harness binding can take it.
 *
 * `listen(0)` — the obvious way to ask for a free port — gives exactly the
 * wrong half of that. It lands at 49152+ on macOS and Windows, which is that
 * churn, and it turned a rare collision into a reliable one. Only Linux
 * survived, its range starting higher up and quieter.
 *
 * So: candidates from a fixed range below every platform's dynamic range,
 * each verified by binding it, retried when taken. `span` reserves that many
 * consecutive ports — the harness opens a webhook receiver one above itself. */
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
        free = false; // taken — somewhere else, then
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

/** a request as a device makes it: a token, and a Host that is not loopback */
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
    /* not JSON */
  }
  return { status: res.status, body, headers: res.headers };
};

/** raw request with a chosen Host header — fetch will not let us set one */
const withHost = (port: number, host: string, path = "/api/health", headers: Record<string, string> = {}) =>
  new Promise<number>((resolve, reject) => {
    const r = request({ hostname: "127.0.0.1", port, path, headers: { host, ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on("error", reject);
    r.end();
  });

beforeAll(async () => {
  // Three in a row, from one call: the harness, its webhook receiver one
  // above it, and the sidecar above that.
  //
  // One call rather than two, because two are not independent the way they
  // look. Each verifies its ports by binding and then releases them for the
  // real thing to take, so by the time a second call runs, the first call's
  // ports are free again — and free is exactly what it goes looking for. It
  // can hand back a port already spoken for, which is the collision this
  // helper exists to rule out.
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

  // Generous, because a cold Windows or macOS runner is much slower than a
  // laptop at starting a Node process that strips types as it loads.
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      // With a deadline of its own. A bare fetch to a port where something
      // accepts but never answers hangs forever, and the loop below never
      // gets to notice its own deadline — which is how a boot failure ends up
      // reported as "hook timed out" with nothing else to go on.
      if ((await fetch(`${HARNESS}/api/health`, { signal: AbortSignal.timeout(2_000) })).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`harness never came up:\n${stderr}`);
    if (harness.exitCode !== null) throw new Error(`harness exited ${harness.exitCode}:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  sidecar = createServer(
    createProxyHandler({
      harnessPort: HARNESS_PORT,
      authenticate: (t) => (t === TOKEN ? { id: "d1", cloudDesktopAccess: true } : null),
      redeem: (code, deviceName) =>
        code === "424242"
          ? { token: TOKEN, device: { id: "d1", name: String(deviceName) } }
          : { error: "that code is not right" },
      serverName: () => "Test computer",
      connected: connectedDevices.open,
    }),
  );
  // Not `listen(port, host, resolve)` alone: a bind failure emits `error` and
  // never calls back, so the hook would sit there until the runner's timeout
  // and report nothing about why.
  await new Promise<void>((resolve, reject) => {
    sidecar.once("error", reject);
    sidecar.listen(SIDECAR_PORT, "127.0.0.1", () => resolve());
  });
}, 90_000);

afterAll(async () => {
  await new Promise<void>((r) => (sidecar ? sidecar.close(() => r()) : r()));
  harness?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (!harness || harness.exitCode !== null) return resolve();
    harness.on("close", () => resolve());
    // SIGKILL, then keep waiting for `close`. Resolving in the same tick as
    // the signal — which is what this did — starts deleting the home
    // directory out from under a process that has not died yet, and the
    // delete is what fails. A loaded CI runner loses that race; a laptop
    // wins it every time, which is why it reads as a phantom.
    setTimeout(() => harness.kill("SIGKILL"), 5_000).unref?.();
    // and a floor, so a process that somehow survives SIGKILL cannot hang
    // the suite instead
    setTimeout(resolve, 10_000).unref?.();
  });
  rmSync(home, { recursive: true, force: true });
});

describe("the sidecar in front of an unmodified harness", () => {
  it("reaches the harness with a Host the harness itself would refuse", async () => {
    // The premise of the whole design. Current upstream rejects a
    // non-loopback Host outright (DNS rebinding); a phone's Host is a LAN
    // address or a tailnet name and can never satisfy that. The sidecar
    // speaks to loopback as itself, so the device's Host never travels.
    //
    // Written so it passes against an older harness too: what is being
    // asserted is that the *sidecar* answers, whatever the harness's own
    // policy happens to be.
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
    // even a loopback origin, which the harness itself would allow
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
      authenticate: () => valid ? { id: "phone-delayed", cloudDesktopAccess: false } : null,
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
    // settings and credentials stay on the machine
    expect((await device("PUT", "/api/config", { body: { xai: { apiKey: "x" } } })).status).toBe(403);
    expect((await device("GET", "/api/devices")).status).toBe(403);
    expect((await device("GET", "/api/companion")).status).toBe(403);
    expect((await device("POST", "/api/local-computer/start")).status).toBe(403);
    // the internal peer-comms API does not exist off-machine
    expect((await device("GET", "/api/internal/peers")).status).toBe(404);
    // nor does the desktop UI
    expect((await device("GET", "/")).status).toBe(404);
    // but reading config is fine — it is booleans, not keys
    expect((await device("GET", "/api/config")).status).toBe(200);

    // General-purpose PATCH routes can change execution policy, connected
    // apps, working directories and computer targets. The phone gets narrow
    // verbs instead, so a stolen device token cannot smuggle those fields.
    const { body } = await device("GET", "/api/bots");
    const botId = body.bots[0].id;
    expect((await device("PATCH", `/api/bots/${botId}`, { body: { autoApprove: true } })).status).toBe(404);
    expect((await device("PATCH", `/api/groups/not-a-room`, { body: { unread: false } })).status).toBe(404);
  });

  it("lets a device answer an approval, and manage its own chats", async () => {
    // The approval path is the product: a card raised on the computer,
    // answered on the phone, and the bot carries on. What is checked here is
    // that the allowlist carries these routes to the harness at all — the
    // harness's own "no such pending request" is proof it arrived, and is a
    // far better signal than a 403 from the sidecar would be.
    //
    // Worth pinning separately from sending a message, because these are the
    // routes a default-deny allowlist is most likely to omit by accident.
    const { body } = await device("GET", "/api/bots");
    const bot = body.bots[0];

    for (const [method, path, payload] of [
      ["POST", `/api/threads/${bot.threadId}/respond`, { requestId: "nope", behavior: "allow" }],
      ["POST", `/api/bots/${bot.id}/messages`, { text: "hello from a test" }],
      ["POST", `/api/bots/${bot.id}/interrupt`, undefined],
      ["POST", `/api/bots/${bot.id}/read`, undefined],
    ] as const) {
      const res = await device(method, path, payload ? { body: payload } : {});
      // whatever the harness decides, the sidecar must not be the one saying no
      expect(res.status, `${method} ${path} was blocked by the sidecar`).not.toBe(403);
      expect(res.status, `${method} ${path} never reached the harness`).not.toBe(404);
    }
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

    // Whether the harness sent any is deliberately NOT asserted: some
    // versions leak them, some do not, and the sidecar scrubs either way.
    // Asserting on the harness's behaviour here would make this test pass
    // or fail on which harness happens to be checked out. That the scrubber
    // is not a no-op is pinned in wire.test.ts, against a payload built to
    // contain them.
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
    /** read until `want` finds a complete event, or give up */
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
      // The blank-line terminator is the thing worth asserting: an SSE
      // transform that normalises whitespace produces a stream that parses
      // to nothing while looking perfectly healthy at both ends.
      const hello = await nextEvent((e) => e.includes('"kind":"hello"'));
      expect(hello).not.toBeNull();
      expect(JSON.parse(hello!.replace(/^data:\s*/, ""))).toMatchObject({ kind: "hello" });

      // A broadcast frame, which is the one that carries `id:` — the resume
      // cursor. Rewriting the payload must not disturb it.
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
        authenticate: () => ({ cloudDesktopAccess: true }),
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

  // A harness that is *down* is the easy case — the connection is refused and
  // the phone hears about it immediately. A harness that accepts the socket
  // and then says nothing is the case with no natural end: `http.request` has
  // no deadline for the headers phase, so without one the phone waits on a
  // spinner until the person kills the app.
  it("gives up on a harness that accepts a connection and then goes quiet", async () => {
    const mute = createServer(() => {
      /* accepted, and deliberately never answered */
    });
    await new Promise<void>((r) => mute.listen(0, "127.0.0.1", r));
    const mutePort = (mute.address() as { port: number }).port;
    const stalled = createServer(
      createProxyHandler({
        harnessPort: mutePort,
        authenticate: () => ({ cloudDesktopAccess: true }),
        redeem: () => ({ error: "no" }),
        serverName: () => "Test computer",
        // the shipped value is 30s; the behaviour under test is the same one
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

  // A phone that walks out of range mid-download leaves the harness talking
  // to nobody. The SSE path already hung up on the upstream; these two did
  // not, so a large response kept being produced — and, on the JSON path,
  // kept being buffered.
  it("hangs up on the harness when the device disappears", async () => {
    let upstreamClosed: () => void;
    let upstreamReached: () => void;
    const closed = new Promise<void>((r) => (upstreamClosed = r));
    // The disconnect only means anything once the request has actually
    // arrived upstream. Waiting a fixed 250ms for that is a bet on how fast
    // the machine is, and this file has already lost one of those.
    const reached = new Promise<void>((r) => (upstreamReached = r));
    const slow = createServer((_req, res) => {
      res.on("error", () => {
        /* the sidecar hanging up is the pass condition */
      });
      res.on("close", () => upstreamClosed());
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"bots":[');
      // and then keeps the response open, as a slow endpoint does
      upstreamReached();
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
    const slowPort = (slow.address() as { port: number }).port;
    const relay = createServer(
      createProxyHandler({
        harnessPort: slowPort,
        authenticate: () => ({ cloudDesktopAccess: true }),
        redeem: () => ({ error: "no" }),
        serverName: () => "Test computer",
      }),
    );
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
    const port = (relay.address() as { port: number }).port;
    const abort = new AbortController();
    try {
      // Not awaited: a JSON response is buffered whole before any of it
      // reaches the device, so this request has no headers to resolve until
      // the stub ends — and the stub never ends. The disconnect under test
      // is one that happens while the request is still in flight.
      const pending = fetch(`http://127.0.0.1:${port}/api/bots`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: abort.signal,
      }).catch(() => {
        /* aborted on purpose */
      });
      await reached;
      abort.abort();
      // the upstream response closes because the sidecar dropped it, not
      // because the stub finished — it never finishes
      await closed;
      await pending;
    } finally {
      abort.abort();
      slow.closeAllConnections?.();
      await new Promise<void>((r) => slow.close(() => r()));
      await new Promise<void>((r) => relay.close(() => r()));
    }
  }, 20_000);

  // The scrubber holds a partial event until its terminator arrives, which is
  // correct and bounded by nothing. An upstream that opens a `data:` line and
  // never closes it would otherwise be a memory leak with a straight face.
  it("ends a stream whose event never terminates, rather than buffering it", async () => {
    const TWO_MIB = 2 * 1024 * 1024;
    const flood = createServer((_req, res) => {
      res.on("error", () => {
        /* the sidecar hangs up on us — that is the pass condition */
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: ");
      const blob = "x".repeat(64 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < TWO_MIB) {
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
        authenticate: () => ({ cloudDesktopAccess: true }),
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
      // Terminates, and forwards nothing: half an event cannot go out
      // scrubbed, and must not go out unscrubbed.
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
        // A successful response with no harness on this port also proves the
        // sidecar terminated the route locally.
        harnessPort: 1,
        authenticate: (token) => token === TOKEN ? { cloudDesktopAccess: false } : null,
        redeem: () => ({ error: "not used" }),
        serverName: () => "Test computer",
        endpoints: () => endpoints,
      }),
    );
    await new Promise<void>((resolve) => endpointServer.listen(0, "127.0.0.1", resolve));
    // SAFETY: an IP server that has completed listen() has an AddressInfo
    // object with a numeric port.
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
      // SAFETY: the endpoint route has just returned 200 JSON and this shape
      // is asserted immediately below; the cast grants no runtime behavior.
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

// The whole loop, with the real registry rather than a stub: open a pairing
// window on the control surface, redeem its QR credential the way the phone
// does, and
// use the token that comes back. This is the path that has no unit-test
// equivalent — every piece is real except the phone.
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
      companionPort: port,
      discovery: () => ({ advertising: false, name: "OpenMausBot" }),
      connectedDeviceIds: connections.ids,
      disconnectDevice: connections.disconnect,
    });
    await new Promise<void>((r) => control.listen(0, "127.0.0.1", r));
    // SAFETY: address() is AddressInfo — an object with a port — for any
    // IP server that is listening, which the awaited listen guarantees.
    const controlPort = (control.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const ctl = `http://127.0.0.1:${controlPort}`;

    try {
      // before pairing, the phone gets nowhere
      expect((await fetch(`${base}/api/bots`)).status).toBe(401);

      // the person clicks "Start pairing" on the computer
      // SAFETY: POST /pairing is this sidecar's own API and always answers
      // with both credentials; the matches below fail if the shape drifts.
      const opened = (await (await fetch(`${ctl}/pairing`, { method: "POST" })).json()) as {
        code: string;
        token: string;
      };
      expect(opened.code).toMatch(/^\d{6}$/);
      expect(opened.token).toMatch(/^omb_pair_[A-Za-z0-9_-]{43}$/);

      // a wrong code is refused, and does not burn the window
      const wrong = await fetch(`${base}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "000000", deviceName: "Impostor" }),
      });
      expect(wrong.status).toBe(401);

      // The QR token is redeemed exactly once and never forwarded upstream.
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
      // SAFETY: a 201 from /api/pair carries exactly this shape — the
      // sidecar's own contract, pinned by the expects that follow.
      const body = (await res.json()) as {
        token: string;
        serverName: string;
        hosts: string[];
        endpoints: Array<{ url: string; kind: string; priority: number }>;
      };
      expect(body.serverName).toBe("Ada's computer");
      expect(body.token).toMatch(/^omb_/);
      // The fallback list rides on the redeem response so a phone that paired
      // by typed address learns the other ways to reach this computer too.
      expect(body.hosts).toEqual(["macbook.tail1234.ts.net", "192.168.1.42", "openmausbot-abcd1234.local"]);
      expect(body.endpoints).toEqual([
        { url: "https://device-123.companion.example", kind: "hosted", priority: 0 },
        { url: "http://192.168.1.42:8810", kind: "lan", priority: 200 },
      ]);

      // Losing the first response after it reached the Mac must not strand an
      // orphan device. The same logical request can arrive through a fallback
      // address and receives the exact token already committed to disk.
      const replay = await fetch(`${base}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: pairBody,
      });
      expect(replay.status).toBe(201);
      expect((await replay.json() as { token: string }).token).toBe(body.token);

      // and the token works on the real API, through the real proxy
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

      // the computer can see the phone, and take it away again
      // SAFETY: /state's shape is this sidecar's own API, asserted by the
      // control-server tests above; a drifted shape fails the expects below.
      const state = (await (await fetch(`${ctl}/state`)).json()) as {
        devices: Array<{ id: string; name: string }>;
        connectedDeviceIds: string[];
      };
      expect(state.devices.map((d) => d.name)).toContain("Ada's iPhone");
      // By name, not by index: `devices[0]` is whichever record the registry
      // happens to have loaded first, and revoking the wrong one would leave
      // this test passing for the wrong reason.
      const ada = state.devices.find((d) => d.name === "Ada's iPhone")!;
      expect(state.connectedDeviceIds).toContain(ada.id);
      const revoked = await fetch(`${ctl}/devices/${ada.id}`, { method: "DELETE" });
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
      companionPort: 8800,
      discovery: () => ({ advertising: false, name: "OpenMausBot" }),
    });
    await new Promise<void>((r) => control.listen(0, "127.0.0.1", r));
    // SAFETY: address() is AddressInfo — an object with a port — for any
    // IP server that is listening, which the awaited listen guarantees.
    const port = (control.address() as { port: number }).port;
    try {
      // pairing and revocation are exactly what a phone must never reach
      expect(await withHost(port, "macbook.tail1234.ts.net:8801", "/state")).toBe(403);
      expect(await withHost(port, `127.0.0.1:${port}`, "/state")).toBe(200);
    } finally {
      await new Promise<void>((r) => control.close(() => r()));
    }
  });

  // A browser handed `http://[::1]:8811` sends `Host: [::1]:8811`, and the
  // colons in the literal are not the port separator. Splitting on the first
  // one refuses the address the person was told to use.
  it("understands an IPv6 loopback Host", async () => {
    const { DeviceRegistry } = await import("../src/devices.ts");
    const { createControlServer, hostOf } = await import("../src/control.ts");

    expect(hostOf("[::1]:8811")).toBe("::1");
    expect(hostOf("127.0.0.1:8811")).toBe("127.0.0.1");
    expect(hostOf("localhost")).toBe("localhost");
    // a malformed authority fails the allowlist rather than skipping it
    expect(hostOf("[::1")).toBe("[::1");

    const control = createControlServer({
      devices: new DeviceRegistry(),
      companionPort: 8800,
      discovery: () => ({ advertising: false, name: "OpenMausBot" }),
    });
    await new Promise<void>((r) => control.listen(0, "127.0.0.1", r));
    // SAFETY: address() is AddressInfo — an object with a port — for any
    // IP server that is listening, which the awaited listen guarantees.
    const port = (control.address() as { port: number }).port;
    try {
      expect(await withHost(port, `[::1]:${port}`, "/state")).toBe(200);
      // and the bracket parsing did not open a door: a real name is still out
      expect(await withHost(port, "[::1].evil.example", "/state")).toBe(403);

      // An authority the parser cannot make sense of is refused, not waved
      // through. Both of these are malformed — an IPv6 literal has to be
      // bracketed, and a port needs a host in front of it — and both used to
      // parse to the empty string, which the check then skipped.
      expect(await withHost(port, "::1", "/state")).toBe(403);
      expect(await withHost(port, ":8811", "/state")).toBe(403);
      expect(await withHost(port, "[]:8811", "/state")).toBe(403);
    } finally {
      await new Promise<void>((r) => control.close(() => r()));
    }
  });

  // Loopback is not a boundary a browser respects: any page the person is
  // reading can POST to 127.0.0.1 with a correct Host, unpreflighted, and
  // CORS only stops it reading the answer. It does not need the answer —
  // opening a pairing window and revoking a phone both land on the way in.
  it("refuses a write from a page the person happened to be reading", async () => {
    const { DeviceRegistry } = await import("../src/devices.ts");
    const { createControlServer } = await import("../src/control.ts");
    const registry = new DeviceRegistry();
    const control = createControlServer({
      devices: registry,
      companionPort: 8800,
      discovery: () => ({ advertising: false, name: "OpenMausBot" }),
    });
    await new Promise<void>((r) => control.listen(0, "127.0.0.1", r));
    // SAFETY: address() is AddressInfo — an object with a port — for any
    // IP server that is listening, which the awaited listen guarantees.
    const port = (control.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const evil = await fetch(`${base}/pairing`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
      });
      expect(evil.status).toBe(403);
      // and no window opened on the way to being refused
      expect(registry.pairing()).toBe(null);

      // A same-origin write is the control page itself, and must still work:
      // the browser sends Origin on any method that is not GET or HEAD, so a
      // blanket refusal would break the one legitimate browser there is.
      const ours = await fetch(`${base}/pairing`, {
        method: "POST",
        headers: { origin: base },
      });
      expect(ours.status).toBe(201);
      expect(registry.pairing()).not.toBe(null);

      // Revocation is the other write worth stealing.
      const stolen = await fetch(`${base}/devices/whatever`, {
        method: "DELETE",
        headers: { origin: "https://evil.example" },
      });
      expect(stolen.status).toBe(403);
    } finally {
      await new Promise<void>((r) => control.close(() => r()));
    }
  });

  // The Host check above is not enough on its own. A page anywhere can POST
  // to 127.0.0.1 without a preflight — it is a simple request — and it
  // arrives with a loopback Host like everything else. It cannot read the
  // reply, but opening a pairing window is already the damage: the code is
  // then on screen for whoever asked for it.
  it("refuses a cross-origin request even though its Host is loopback", async () => {
    const { DeviceRegistry } = await import("../src/devices.ts");
    const { createControlServer } = await import("../src/control.ts");
    const registry = new DeviceRegistry();
    const control = createControlServer({
      devices: registry,
      companionPort: 8800,
      discovery: () => ({ advertising: false, name: "OpenMausBot" }),
    });
    await new Promise<void>((r) => control.listen(0, "127.0.0.1", r));
    // SAFETY: address() is AddressInfo — an object with a port — for any
    // IP server that is listening, which the awaited listen guarantees.
    const port = (control.address() as { port: number }).port;
    const host = `127.0.0.1:${port}`;
    try {
      for (const origin of ["https://evil.example", "http://127.0.0.1.evil.example", "null"]) {
        expect(await withHost(port, host, "/state", { origin })).toBe(403);
      }
      // no pairing window was opened by any of that
      expect(registry.pairing()).toBeNull();

      // A loopback origin is not enough either, which is the rule that got
      // stricter: `http://localhost:<port>` reaches the same socket by the
      // same route, and is still some other program's page rather than the
      // one this server serves. Only the exact authority the request was
      // addressed to passes, because the alternative is putting a name
      // resolver inside a CSRF check.
      expect(await withHost(port, host, "/state", { origin: `http://localhost:${port}` })).toBe(403);

      // the control page itself is same-origin, and a native client sends
      // no Origin at all — both keep working
      expect(await withHost(port, host, "/state", { origin: `http://${host}` })).toBe(200);
      expect(await withHost(port, host, "/state")).toBe(200);
    } finally {
      await new Promise<void>((r) => control.close(() => r()));
    }
  });
});
