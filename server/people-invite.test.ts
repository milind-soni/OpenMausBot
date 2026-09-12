// End to end: adding people to a hosted workspace. The owner bootstraps the
// first admin from the box, that admin signs in with an emailed code (the
// control plane is stubbed) and, through the same requests Settings → People
// sends, invites a member, promotes them, removes them and revokes their
// device. Everything the People card reads answers in the shape it renders.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { startControlPlaneStub, type ControlPlaneStub } from "./testing/control-plane-stub.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
let port: number;
const HOST = "acme.agentada.test";
const ADA = "ada@example.test";
const BOB = "bob@acme.test";

let home: string;
let child: ChildProcess;
let stub: ControlPlaneStub;
let stderr = "";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

interface CallInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  from?: string;
}

function send(path: string, init: CallInit, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        signal: AbortSignal.timeout(5_000),
        method: init.method ?? (payload ? "POST" : "GET"),
        headers: { ...headers, ...(payload ? { "content-type": "application/json" } : {}), ...init.headers },
      },
      (res) => {
        let raw = "";
        res.on("error", reject);
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

/** The box itself: a loopback Host and Origin, nothing forwarded. This is the
 * owner, the way `openmausbot` on the server or a bootstrap script talks. */
const owner = (path: string, init: CallInit = {}) => send(path, init, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` });

/** A browser somewhere else, reaching the server through its proxy. */
const remote = (path: string, init: CallInit = {}) =>
  send(path, init, { host: HOST, "x-forwarded-for": init.from ?? "203.0.113.7", "x-forwarded-proto": "https", origin: `https://${HOST}` });

const cookieOf = (reply: Reply): string => {
  const raw = reply.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return (first ?? "").split(";")[0];
};

/** What the sign-in page does with an emailed code: a cookie session. */
async function signIn(email: string, label: string): Promise<{ reply: Reply; cookie: string }> {
  const started = await remote("/api/auth/email/start", { body: { email } });
  if (started.status !== 200) return { reply: started, cookie: "" };
  const reply = await remote("/api/auth/email/verify", { body: { email, code: stub.otp, label } });
  return { reply, cookie: cookieOf(reply) };
}

const as = (cookie: string) => (path: string, init: CallInit = {}) => remote(path, { ...init, headers: { cookie, ...init.headers } });

beforeAll(async () => {
  port = await freePortBlock([0, 1]);
  stub = await startControlPlaneStub();
  home = mkdtempSync(join(tmpdir(), "omb-people-invite-"));
  const staticDir = join(home, "static");
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Served UI</title>");
  // No sign-in list on disk and none in the environment: nobody is welcome yet.
  writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({ instances: { fixture: { driver: "people-invite-test-shadow" } } }));
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_STATIC_DIR: staticDir,
      OMB_PUBLIC_URL: `https://${HOST}`,
      OMB_ENVIRONMENT_LABEL: "acme",
      OMB_BROWSER_CONNECTION: join(home, "browser-test-connection.json"),
      OMB_CONTROL_PLANE_URL: stub.url,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();
  let spawnError: Error | undefined;
  child.on("error", (error) => { spawnError = error; });
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`fixture exited:\n${stderr}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${stderr}`);
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (stub) await stub.close();
  if (home) await removeTempDir(home);
});

describe("adding people to a hosted workspace", () => {
  let ada: (path: string, init?: CallInit) => Promise<Reply>;
  let bobCookie = "";

  it("offers no email sign-in until the owner names the first admin", async () => {
    expect((await remote("/.well-known/openmausbot/environment")).body.capabilities.emailSignIn).toBe(false);
    const early = await remote("/api/auth/email/start", { body: { email: ADA } });
    expect(early.status).toBe(404);
    expect(early.body.error).toMatch(/not set up/);

    const saved = await owner("/api/config", { method: "PUT", body: { signIn: { admins: [ADA], members: [] } } });
    expect(saved.status).toBe(200);
    expect((await owner("/api/config")).body.signIn).toEqual({ admins: [ADA], members: [] });
    expect((await remote("/.well-known/openmausbot/environment")).body.capabilities.emailSignIn).toBe(true);
    expect(stub.calls).not.toContain("POST /api/auth/email-otp/send-verification-otp");
  });

  it("lets that admin sign in and invite a member the way the People card does", async () => {
    const adaSignIn = await signIn(ADA, "Ada's laptop");
    expect(adaSignIn.reply.status).toBe(200);
    expect(adaSignIn.reply.body.session).toMatchObject({ email: ADA, scopes: ["admin", "client"] });
    ada = as(adaSignIn.cookie);

    // What the card loads: the list, the devices, this month's spend, the public address for links.
    const config = await ada("/api/config");
    expect(config.status).toBe(200);
    expect(config.body.signIn).toEqual({ admins: [ADA], members: [] });
    const sessions = await ada("/api/auth/sessions");
    expect(sessions.body.sessions.map((s: { email?: string }) => s.email)).toEqual([ADA]);
    const usage = await ada("/api/usage?groupBy=user");
    expect(usage.status).toBe(200);
    expect(Array.isArray(usage.body.groups)).toBe(true);
    const domain = await ada("/api/settings/custom-domain");
    expect(domain.body.publicUrl).toBe(`https://${HOST}`);

    // Invite: the card writes the whole list back, then shows the link.
    const invited = await ada("/api/config", { method: "PUT", body: { signIn: { admins: [ADA], members: [BOB] } } });
    expect(invited.status).toBe(200);
    expect((await ada("/api/config")).body.signIn).toEqual({ admins: [ADA], members: [BOB] });

    // The link opens the served sign-in page for anyone, with the address in the query.
    const page = await remote(`/pair?email=${encodeURIComponent(BOB)}`);
    expect(page.status).toBe(200);
    expect(String(page.headers["content-type"])).toMatch(/text\/html/);
    expect(page.body).toContain("Served UI");

    const bob = await signIn(BOB, "Bob's phone");
    expect(bob.reply.status).toBe(200);
    expect(bob.reply.body.session).toMatchObject({ email: BOB, scopes: ["client"] });
    bobCookie = bob.cookie;
    expect((await as(bobCookie)("/api/bots")).status).toBe(200);
    // a member chats; the sign-in list is not theirs to change
    expect((await as(bobCookie)("/api/config", { method: "PUT", body: { signIn: { admins: [BOB], members: [] } } })).status).toBe(403);
    expect((await ada("/api/config")).body.signIn).toEqual({ admins: [ADA], members: [BOB] });
    // and Bob's device now shows on Ada's list, by address
    const listed = await ada("/api/auth/sessions");
    expect(listed.body.sessions.find((s: { email?: string; label: string }) => s.email === BOB)?.label).toBe("Bob's phone");
  });

  it("applies a promotion to the next sign-in, and a removal to every new one", async () => {
    expect((await ada("/api/config", { method: "PUT", body: { signIn: { admins: [ADA, BOB], members: [] } } })).status).toBe(200);
    // the device Bob already has keeps the scopes it was issued with
    expect((await as(bobCookie)("/api/config", { method: "PUT", body: { language: "en" } })).status).toBe(403);
    const again = await signIn(BOB, "Bob's laptop");
    expect(again.reply.body.session.scopes).toEqual(["admin", "client"]);

    expect((await ada("/api/config", { method: "PUT", body: { signIn: { admins: [ADA], members: [] } } })).status).toBe(200);
    const refused = await remote("/api/auth/email/start", { body: { email: BOB } });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/not on this server's sign-in list/);
    expect(stub.calls.filter((c) => c === "POST /api/auth/email-otp/send-verification-otp")).toHaveLength(3);
  });

  it("keeps a removed person's devices until an admin revokes them, as the card says", async () => {
    expect((await as(bobCookie)("/api/bots")).status).toBe(200);
    const listed = await ada("/api/auth/sessions");
    const bobs = listed.body.sessions.filter((s: { email?: string }) => s.email === BOB);
    expect(bobs).toHaveLength(2);
    for (const session of bobs) expect((await ada(`/api/auth/sessions/${session.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await as(bobCookie)("/api/bots")).status).toBe(401);
    expect((await ada("/api/auth/sessions")).body.sessions.map((s: { email?: string }) => s.email)).toEqual([ADA]);
  });

  it("welcomes a whole domain from one entry", async () => {
    expect((await ada("/api/config", { method: "PUT", body: { signIn: { admins: [ADA], members: ["@acme.test"] } } })).status).toBe(200);
    const carol = await signIn("carol@acme.test", "Carol's tablet");
    expect(carol.reply.body.session).toMatchObject({ email: "carol@acme.test", scopes: ["client"] });
    expect((await signIn("carol@acme.test.evil", "Impostor")).reply.status).toBe(403);
  });
});
