// End to end over a real harness: a client that is not on this machine pairs
// once, then uses the API, the served UI and the event stream with a bearer
// token or the session cookie, and is refused again after revocation.
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCKOUT } from "./sessions.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const WEBHOOK_PORT = 39000 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const REMOTE_HOST = "mini.tail1234.ts.net:8799";
const PUBLIC_URL = "https://mini.tail1234.ts.net";

let home: string;
let child: ChildProcess;
let stderr = "";

/** Every request from "elsewhere": a non-loopback Host, and a distinct
 * forwarded source so the pairing lockout is exercised on purpose only. */
const remote = (source: string, extra: Record<string, string> = {}) => ({ host: REMOTE_HOST, "x-forwarded-for": source, ...extra });

/** Plain node:http, because fetch silently drops a custom Host header and the
 * whole point is to arrive with one that is not loopback. */
function call(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: any; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: PORT, path, method: init.method ?? "GET", headers: { "content-type": "application/json", ...init.headers } },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let body: any = {};
          try {
            body = raw ? JSON.parse(raw) : {};
          } catch {
            body = { raw };
          }
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

const header = (headers: Record<string, string | string[] | undefined>, name: string): string => {
  const v = headers[name];
  return Array.isArray(v) ? v.join("\n") : (v ?? "");
};

async function pairingCode(scopes?: string[]): Promise<{ code: string; url: string | null; hint: string | null }> {
  const opened = await call("/api/auth/pairing", { method: "POST", body: JSON.stringify(scopes ? { scopes } : {}) });
  expect(opened.status).toBe(200);
  return opened.body;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-remote-test-"));
  const staticDir = join(home, "static");
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Served UI</title>");
  // Avoid probing whatever agent CLIs happen to be installed on the test
  // machine; remote-session behavior does not depend on an engine.
  writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
    instances: { fixture: { driver: "remote-session-test-shadow" } },
  }));
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_WEBHOOK_PORT: String(WEBHOOK_PORT),
      OMB_STATIC_DIR: staticDir,
      OMB_PUBLIC_URL: `${PUBLIC_URL}/`,
      OMB_APP_VERSION: "9.9.9-test",
      OMB_ENVIRONMENT_LABEL: "cab mini",
      OMB_BROWSER_CONNECTION: join(home, "browser-test-connection.json"),
      // Slow heartbeat on purpose: the revocation test must prove the stream is
      // ended by the revoke itself, not by the next heartbeat noticing.
      OMB_SSE_HEARTBEAT_MS: "4000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${stderr}`);
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("before pairing", () => {
  it("describes itself to anyone, but serves nothing else off-machine", async () => {
    const descriptor = await call("/.well-known/openmausbot/environment", { headers: remote("10.0.0.1") });
    expect(descriptor.status).toBe(200);
    expect(descriptor.body.environmentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(descriptor.body.label).toBe("cab mini");
    expect(descriptor.body.version).toBe("9.9.9-test");
    expect(descriptor.body.capabilities).toEqual({ remoteSessions: true, selfUpdate: "operator" });
    const refused = await call("/api/bots", { headers: remote("10.0.0.1") });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/pair this device/);
  });

  it("serves the UI shell to a remote browser so it can reach the pair page", async () => {
    const res = await call("/pair", { headers: remote("10.0.0.1") });
    expect(res.status).toBe(200);
    expect(res.body.raw).toContain("Served UI");
  });

  it("keeps the owner's loopback path untouched", async () => {
    expect((await call("/api/bots")).status).toBe(200);
    const me = await call("/api/auth/session");
    expect(me.body).toMatchObject({ kind: "loopback", scopes: ["admin", "client"] });
    const ticket = await call("/api/auth/stream-ticket", { method: "POST" });
    expect(ticket.body.ticket).toBeNull();
  });
});

describe("pairing", () => {
  it("mints a code on the server with a link built from the public address", async () => {
    const opened = await pairingCode();
    expect(opened.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(opened.url).toBe(`${PUBLIC_URL}/pair#code=${opened.code}`);
    expect(opened.hint).toBeNull();
    const listed = await call("/api/auth/pairing");
    expect(listed.body.pairings.length).toBeGreaterThanOrEqual(1);
  });

  it("refuses to mint or list codes from a client-only session", async () => {
    const opened = await pairingCode(["client"]);
    const paired = await call("/api/auth/pair", { method: "POST", headers: remote("10.0.0.2"), body: JSON.stringify({ code: opened.code, label: "viewer" }) });
    expect(paired.status).toBe(200);
    const denied = await call("/api/auth/pairing", { method: "POST", headers: remote("10.0.0.2", { authorization: `Bearer ${paired.body.token}` }), body: "{}" });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toContain("lacks the admin scope");
    expect((await call("/api/bots", { headers: remote("10.0.0.2", { authorization: `Bearer ${paired.body.token}` }) })).status).toBe(200);
  });

  it("exchanges a code exactly once, with a bearer token for native clients", async () => {
    const opened = await pairingCode();
    const wrong = await call("/api/auth/pair", { method: "POST", headers: remote("10.0.0.3"), body: JSON.stringify({ code: "AAAA-AAAA-AAAA" }) });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toMatch(/wrong or has expired/);
    const paired = await call("/api/auth/pair", {
      method: "POST",
      headers: remote("10.0.0.3", { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1" }),
      body: JSON.stringify({ code: opened.code.toLowerCase() }),
    });
    expect(paired.status).toBe(200);
    expect(paired.body.token).toMatch(/^omb_sess_/);
    expect(paired.body.session.label).toBe("Safari on Mac");
    expect(paired.body.environment.label).toBe("cab mini");
    // a plain retry (no attempt id) is a second use of a consumed code: refused
    const again = await call("/api/auth/pair", { method: "POST", headers: remote("10.0.0.3"), body: JSON.stringify({ code: opened.code }) });
    expect(again.status).toBe(401);

    const bearer = remote("10.0.0.3", { authorization: `Bearer ${paired.body.token}` });
    expect((await call("/api/bots", { headers: bearer })).status).toBe(200);
    const me = await call("/api/auth/session", { headers: bearer });
    expect(me.body).toMatchObject({ kind: "session", via: "bearer", label: "Safari on Mac", scopes: ["admin", "client"] });

    const ticket = await call("/api/auth/stream-ticket", { method: "POST", headers: bearer });
    expect(ticket.body.ticket).toMatch(/^omb_tick_/);
    const stream = await openSse(`${BASE}/api/events?ticket=${ticket.body.ticket}`, { host: REMOTE_HOST });
    try {
      const hello = await stream.until((f) => f.kind === "hello", 5_000);
      expect(hello.kind).toBe("hello");
    } finally {
      stream.close();
    }
    const reused = await call(`/api/events?ticket=${ticket.body.ticket}`, { headers: remote("10.0.0.3") });
    expect(reused.status).toBe(401);

    const sessionsList = await call("/api/auth/sessions");
    const mine = sessionsList.body.sessions.find((s: { id: string }) => s.id === me.body.id);
    expect(mine.label).toBe("Safari on Mac");
    expect(JSON.stringify(sessionsList.body)).not.toContain(paired.body.token);
    const revoked = await call(`/api/auth/sessions/${me.body.id}`, { method: "DELETE" });
    expect(revoked.status).toBe(200);
    const after = await call("/api/bots", { headers: bearer });
    expect(after.status).toBe(401);
    expect(after.body.error).toMatch(/pair this device again/);
  });

  it("gives a browser a cookie that only works same-origin", async () => {
    const opened = await pairingCode();
    const res = await call("/api/auth/pair", {
      method: "POST",
      headers: remote("10.0.0.4", { "x-forwarded-proto": "https" }),
      body: JSON.stringify({ code: opened.code, label: "iPad in the kitchen", cookie: true }),
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeUndefined();
    const setCookie = header(res.headers, "set-cookie");
    expect(setCookie).toMatch(new RegExp(`^omb_session_${PORT}_[a-f0-9]{12}=omb_sess_`));
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");
    const cookie = setCookie.split(";")[0];

    const sameOrigin = await call("/api/bots", { headers: remote("10.0.0.4", { cookie, origin: `http://${REMOTE_HOST}` }) });
    expect(sameOrigin.status).toBe(200);
    const noOrigin = await call("/api/auth/session", { headers: remote("10.0.0.4", { cookie }) });
    expect(noOrigin.body).toMatchObject({ kind: "session", via: "cookie", label: "iPad in the kitchen" });
    const csrf = await call("/api/bots", { method: "POST", headers: remote("10.0.0.4", { cookie, origin: "https://evil.example" }), body: "{}" });
    expect(csrf.status).toBe(403);
    expect(csrf.body.error).toBe("forbidden: cross-origin request");

    const logout = await call("/api/auth/logout", { method: "POST", headers: remote("10.0.0.4", { cookie }) });
    expect(header(logout.headers, "set-cookie")).toContain("Max-Age=0");
    expect((await call("/api/bots", { headers: remote("10.0.0.4", { cookie }) })).status).toBe(401);
  });

  it("only accepts JSON for the exchange, and replays a lost response by attempt id", async () => {
    const opened = await pairingCode();
    const form = await call("/api/auth/pair", { method: "POST", headers: { ...remote("10.0.0.20"), "content-type": "application/x-www-form-urlencoded" }, body: `code=${opened.code}` });
    expect(form.status).toBe(415);
    const first = await call("/api/auth/pair", { method: "POST", headers: remote("10.0.0.20"), body: JSON.stringify({ code: opened.code, attemptId: "attempt-first-0001" }) });
    expect(first.status).toBe(200);
    const replay = await call("/api/auth/pair", { method: "POST", headers: remote("10.0.0.21"), body: JSON.stringify({ code: opened.code, attemptId: "attempt-first-0001" }) });
    expect(replay.status).toBe(200);
    expect(replay.body.token).toBe(first.body.token);
    const other = await call("/api/auth/pair", { method: "POST", headers: remote("10.0.0.20"), body: JSON.stringify({ code: opened.code, attemptId: "attempt-other-0002" }) });
    expect(other.status).toBe(401);
  });

  it("ends a live event stream the moment its session is revoked", async () => {
    const opened = await pairingCode();
    const paired = await call("/api/auth/pair", { method: "POST", headers: remote("10.0.0.30"), body: JSON.stringify({ code: opened.code, label: "stream" }) });
    const bearer = remote("10.0.0.30", { authorization: `Bearer ${paired.body.token}` });
    const ticket = await call("/api/auth/stream-ticket", { method: "POST", headers: bearer });
    const ended = new Promise<{ hello: boolean; endedMs: number }>((resolve, reject) => {
      const startedAt = Date.now();
      let hello = false;
      const req = request({ host: "127.0.0.1", port: PORT, path: `/api/events?ticket=${ticket.body.ticket}`, method: "GET", headers: { accept: "text/event-stream", ...remote("10.0.0.30") } }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (chunk.includes('"kind":"hello"')) {
            hello = true;
            void call(`/api/auth/sessions/${paired.body.session.id}`, { method: "DELETE" }).then((r) => {
              if (r.status !== 200) reject(new Error(`revoke returned ${r.status}`));
            });
          }
        });
        res.on("end", () => resolve({ hello, endedMs: Date.now() - startedAt }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
      setTimeout(() => reject(new Error("stream did not end after revocation")), 8_000).unref();
    });
    const outcome = await ended;
    expect(outcome.hello).toBe(true);
    // well under the 4 s heartbeat: the revoke closed it, not the heartbeat
    expect(outcome.endedMs).toBeLessThan(2_500);
  });

  it("gives a client-scope session chat but not the machine: allow-list, display-only edits, stripped config", async () => {
    const opened = await pairingCode(["client"]);
    const paired = await call("/api/auth/pair", { method: "POST", headers: remote("10.0.0.40"), body: JSON.stringify({ code: opened.code, label: "viewer" }) });
    expect(paired.status).toBe(200);
    const h = (extra: Record<string, string> = {}) => remote("10.0.0.40", { authorization: `Bearer ${paired.body.token}`, ...extra });
    expect((await call("/api/bots", { headers: h() })).status).toBe(200);
    for (const [method, path] of [["POST", "/api/cli-test"], ["GET", "/api/instances"], ["POST", "/api/webhooks"], ["GET", "/api/mcp/servers"], ["POST", "/api/local-computer/run"]] as const) {
      const r = await call(path, { method, headers: h(), body: method === "POST" ? "{}" : undefined });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.error, `${method} ${path}`).toContain("admin scope");
    }
    const created = await call("/api/bots", { method: "POST", body: JSON.stringify({ name: "Scoped" }) });
    const botId = created.body?.id ?? created.body?.bot?.id;
    if (botId) {
      const cosmetic = await call(`/api/bots/${botId}`, { method: "PATCH", headers: h(), body: JSON.stringify({ unread: true }) });
      expect(cosmetic.status).toBe(200);
      const smuggled = await call(`/api/bots/${botId}`, { method: "PATCH", headers: h(), body: JSON.stringify({ unread: true, autoApprove: true }) });
      expect(smuggled.status).toBe(403);
      expect(smuggled.body.error).toContain('"autoApprove"');
    }
    const config = await call("/api/config", { headers: h() });
    expect(config.status).toBe(200);
    expect(config.body.vps.sshAlias).toBe("");
    expect(config.body.profile.email).toBe("");
    expect(JSON.stringify(config.body)).not.toContain("partitionId");
  });

  it("locks a source out after repeated bad codes and says how long", async () => {
    for (let i = 0; i < LOCKOUT.failures; i++) {
      const r = await call("/api/auth/pair", { method: "POST", headers: remote("10.0.0.99"), body: JSON.stringify({ code: `BAD${i}-BADB-ADBA` }) });
      expect(r.status).toBe(401);
    }
    const opened = await pairingCode();
    const locked = await call("/api/auth/pair", { method: "POST", headers: remote("10.0.0.99"), body: JSON.stringify({ code: opened.code }) });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toMatch(/from your address; try again in \d+s/);
    // the code itself is untouched: another source can still use it
    expect((await call("/api/auth/pair", { method: "POST", headers: remote("10.0.0.100"), body: JSON.stringify({ code: opened.code }) })).status).toBe(200);
    expect(stderr).toMatch(/pairing refused from 10\.0\.0\.99/);
  });
});
