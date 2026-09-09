// End to end: a hosted server with a sign-in allow-list lets a remote browser
// sign in with an emailed code from the control plane (stubbed here) and
// ends up with the same cookie session a pairing code would give.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { startControlPlaneStub, type ControlPlaneStub } from "./testing/control-plane-stub.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = 24000 + Math.floor(Math.random() * 5000);
const HOST = "agentada.test";

let home: string;
let child: ChildProcess;
let stub: ControlPlaneStub;
let stderr = "";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

/** A remote browser: a foreign Host and a forwarded address, like a proxy or tunnel hands us. */
function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; from?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path,
        method: init.method ?? (payload ? "POST" : "GET"),
        headers: {
          host: HOST,
          "x-forwarded-for": init.from ?? "203.0.113.7",
          "x-forwarded-proto": "https",
          ...(payload ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let body: unknown = raw;
          try {
            body = JSON.parse(raw);
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const cookieOf = (reply: Reply): string => {
  const raw = reply.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return (first ?? "").split(";")[0];
};

beforeAll(async () => {
  stub = await startControlPlaneStub();
  home = mkdtempSync(join(tmpdir(), "omb-email-signin-"));
  const staticDir = join(home, "static");
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Served UI</title>");
  writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({ instances: { fixture: { driver: "email-signin-test-shadow" } } }));
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_WEBHOOK_PORT: String(PORT + 1),
      OMB_STATIC_DIR: staticDir,
      OMB_PUBLIC_URL: `https://${HOST}`,
      OMB_ENVIRONMENT_LABEL: "agentada",
      OMB_BROWSER_CONNECTION: join(home, "browser-test-connection.json"),
      OMB_CONTROL_PLANE_URL: stub.url,
      OMB_SIGNIN_EMAILS: "Her@Example.test, @agentada.test",
      OMB_SIGNIN_MEMBER_EMAILS: "staff@example.test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
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
  await stub.close();
  await removeTempDir(home);
});

describe("sign in with your email on a hosted server", () => {
  it("advertises the option in the public descriptor", async () => {
    const descriptor = await call("/.well-known/openmausbot/environment");
    expect(descriptor.status).toBe(200);
    expect(descriptor.body.capabilities.emailSignIn).toBe(true);
  });

  it("is JSON-only and refuses addresses that are not on the list", async () => {
    const form = await new Promise<Reply>((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port: PORT, path: "/api/auth/email/start", method: "POST", headers: { host: HOST, "x-forwarded-for": "203.0.113.9", "content-type": "application/x-www-form-urlencoded" } }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw }));
      });
      req.on("error", reject);
      req.end("email=her%40example.test");
    });
    expect(form.status).toBe(415);
    const stranger = await call("/api/auth/email/start", { body: { email: "stranger@example.test" } });
    expect(stranger.status).toBe(403);
    expect(stranger.body.error).toMatch(/not on this server's sign-in list/);
    expect(stub.calls).not.toContain("POST /api/auth/email-otp/send-verification-otp");
  });

  it("emails a code to a welcome address, then turns the code into an admin cookie session that shows its email", async () => {
    const started = await call("/api/auth/email/start", { body: { email: "her@example.test" } });
    expect(started.status).toBe(200);
    expect(stub.calls).toContain("POST /api/auth/email-otp/send-verification-otp");

    const wrong = await call("/api/auth/email/verify", { body: { email: "her@example.test", code: "00000000", label: "Her iPad" } });
    expect(wrong.status).toBe(401);
    expect(cookieOf(wrong)).toBe("");

    const right = await call("/api/auth/email/verify", { body: { email: "her@example.test", code: stub.otp, label: "Her iPad" } });
    expect(right.status).toBe(200);
    expect(right.body.session).toMatchObject({ label: "Her iPad", scopes: ["admin", "client"], email: "her@example.test" });
    expect(right.body.environment.environmentId).toBeTruthy();
    const cookie = cookieOf(right);
    expect(cookie).toMatch(/^omb_session_/);
    expect(String(right.headers["set-cookie"])).toMatch(/HttpOnly/);

    const me = await call("/api/auth/session", { headers: { cookie, origin: `https://${HOST}` } });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ kind: "session", email: "her@example.test", scopes: ["admin", "client"], via: "cookie" });
    // admin scope: settings are hers to change
    const config = await call("/api/config", { method: "PUT", body: { language: "en" }, headers: { cookie, origin: `https://${HOST}` } });
    expect(config.status).toBe(200);
    const listed = await call("/api/auth/sessions", { headers: { cookie, origin: `https://${HOST}` } });
    expect(listed.status).toBe(200);
    expect(listed.body.sessions.some((s: { email?: string }) => s.email === "her@example.test")).toBe(true);
  });

  it("a member address gets a chat-only session; a domain entry welcomes the whole company", async () => {
    await call("/api/auth/email/start", { body: { email: "staff@example.test" } });
    const member = await call("/api/auth/email/verify", { body: { email: "staff@example.test", code: stub.otp, label: "Staff phone" } });
    expect(member.status).toBe(200);
    expect(member.body.session.scopes).toEqual(["client"]);
    const cookie = cookieOf(member);
    const bots = await call("/api/bots", { headers: { cookie, origin: `https://${HOST}` } });
    expect(bots.status).toBe(200);
    const config = await call("/api/config", { method: "PUT", body: { language: "en" }, headers: { cookie, origin: `https://${HOST}` } });
    expect(config.status).toBe(403);

    await call("/api/auth/email/start", { body: { email: "anyone@agentada.test" } });
    const colleague = await call("/api/auth/email/verify", { body: { email: "anyone@agentada.test", code: stub.otp } });
    expect(colleague.status).toBe(200);
    expect(colleague.body.session.scopes).toEqual(["admin", "client"]);
    // no label and no browser user agent in this test client: the generic fallback
    expect(colleague.body.session.label).toBe("Unnamed device");
  });

  it("locks a source out after repeated wrong codes, like pairing does", async () => {
    let last = 0;
    for (let i = 0; i < 12; i += 1) {
      const reply = await call("/api/auth/email/verify", { body: { email: "her@example.test", code: "99999999" }, from: "198.51.100.42" });
      last = reply.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
    // the lockout is per source: someone else still gets in
    const other = await call("/api/auth/email/verify", { body: { email: "her@example.test", code: stub.otp }, from: "198.51.100.43" });
    expect(other.status).toBe(200);
  });
});
