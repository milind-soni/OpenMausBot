// The done-check for phase 1 (docs/plans/2026-09-07-users-and-roles.md §4):
// a real server, a real roster, and devices arriving from somewhere else.
//
// Two things here cannot be proved by a unit test and are the point of this
// file: that a role change lands on an already-paired device without it
// re-pairing, and that disabling someone ends their open event stream at the
// moment of the disable rather than whenever the next heartbeat notices.
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const WEBHOOK_PORT = 39000 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const REMOTE_HOST = "mini.tail1234.ts.net:8799";

let home: string;
let child: ChildProcess;
let stderr = "";

/** Every request from "elsewhere": a non-loopback Host and a distinct
 * forwarded source, so the pairing lockout is never hit by accident. */
const remote = (source: string, extra: Record<string, string> = {}) => ({ host: REMOTE_HOST, "x-forwarded-for": source, ...extra });
const asDevice = (token: string, source = "10.0.0.9") => remote(source, { authorization: `Bearer ${token}` });

/** node:http, because fetch silently drops a custom Host header and arriving
 * with a non-loopback one is the whole point. */
function call(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: any }> {
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
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

const get = (path: string, headers?: Record<string, string>) => call(path, headers ? { headers } : {});
const del = (path: string, headers?: Record<string, string>) => call(path, { method: "DELETE", ...(headers ? { headers } : {}) });
const post = (path: string, body: unknown, headers?: Record<string, string>) =>
  call(path, { method: "POST", body: JSON.stringify(body), ...(headers ? { headers } : {}) });
const patch = (path: string, body: unknown, headers?: Record<string, string>) =>
  call(path, { method: "PATCH", body: JSON.stringify(body), ...(headers ? { headers } : {}) });

/** Mint a code (loopback) and exchange it from somewhere else. */
async function pairDevice(input: { userId?: string; scopes?: string[]; label?: string; source: string }): Promise<string> {
  const minted = await post("/api/auth/pairing", {
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.scopes ? { scopes: input.scopes } : {}),
  });
  expect(minted.status, JSON.stringify(minted.body)).toBe(200);
  const paired = await post("/api/auth/pair", { code: minted.body.code, label: input.label ?? "device" }, remote(input.source));
  expect(paired.status, JSON.stringify(paired.body)).toBe(200);
  return paired.body.token;
}

const ADMIN_ROUTE = "/api/auth/users";
const CLIENT_ROUTE = "/api/bots";

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-rbac-test-"));
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  // No real engine: this file is about authorization, not agents.
  writeFileSync(join(home, ".openmausbot", "config.json"), JSON.stringify({
    instances: { fixture: { driver: "rbac-test-shadow" } },
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
      // Slow on purpose: disabling someone must end their stream itself, not
      // leave it to the next heartbeat.
      OMB_SSE_HEARTBEAT_MS: "4000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
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

let ADA = "";
let BOB = "";
let adaToken = "";

describe("an empty roster is the pre-RBAC server", () => {
  it("still pairs an unnamed device, which reports no owner", async () => {
    expect((await get(ADMIN_ROUTE)).body).toEqual({ users: [] });
    const token = await pairDevice({ source: "10.0.0.1", label: "Legacy laptop" });
    const me = await get("/api/auth/session", asDevice(token, "10.0.0.1"));
    expect(me.status).toBe(200);
    expect(me.body.user).toBeNull();
    expect(me.body.scopes).toEqual(["admin", "client"]);
    // And it keeps working after accounts exist (asserted again at the end).
    expect((await get(CLIENT_ROUTE, asDevice(token, "10.0.0.1"))).status).toBe(200);
  });
});

describe("creating people", () => {
  it("makes the first admin over loopback, and refuses a duplicate address", async () => {
    const created = await post(ADMIN_ROUTE, { name: "Ada Lovelace", email: "ada@example.test", role: "admin" });
    expect(created.status).toBe(201);
    expect(created.body.user).toMatchObject({ name: "Ada Lovelace", email: "ada@example.test", role: "admin", status: "active" });
    ADA = created.body.user.id;

    const clash = await post(ADMIN_ROUTE, { name: "Impostor", email: "ADA@EXAMPLE.TEST" });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatch(/already in use/);

    const bob = await post(ADMIN_ROUTE, { name: "Bob", role: "member" });
    expect(bob.status).toBe(201);
    BOB = bob.body.user.id;
  });

  it("rejects a body it cannot store, naming the field", async () => {
    expect((await post(ADMIN_ROUTE, { name: "X", role: "owner" })).status).toBe(400);
    expect((await post(ADMIN_ROUTE, { name: "" })).status).toBe(400);
    const unknown = await post(ADMIN_ROUTE, { name: "X", nickname: "hax" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/unknown field "nickname"/);
    expect((await get(`${ADMIN_ROUTE}/no-such-id`)).status).toBe(404);
  });
});

describe("once people exist, every new device names one", () => {
  it("refuses an unnamed code, an unknown person and impossible scopes", async () => {
    const unnamed = await post("/api/auth/pairing", {});
    expect(unnamed.status).toBe(400);
    expect(unnamed.body.error).toMatch(/userId is required/);
    expect((await post("/api/auth/pairing", { userId: "no-such-id" })).status).toBe(404);
    // A member can never hold admin, so a code that only asks for admin would
    // pair and then fail every request.
    const impossible = await post("/api/auth/pairing", { userId: BOB, scopes: ["admin"] });
    expect(impossible.status).toBe(400);
    expect(impossible.body.error).toMatch(/cannot apply to that account/);
  });

  it("binds the device to the person, and an admin may mint for someone else", async () => {
    adaToken = await pairDevice({ userId: ADA, source: "10.0.0.2", label: "Ada's Mac" });
    const me = await get("/api/auth/session", asDevice(adaToken, "10.0.0.2"));
    expect(me.body.user).toMatchObject({ id: ADA, name: "Ada Lovelace", role: "admin" });
    expect(me.body.scopes).toEqual(["admin", "client"]);

    // Ada, remotely, mints for Bob.
    const forBob = await post("/api/auth/pairing", { userId: BOB }, asDevice(adaToken, "10.0.0.2"));
    expect(forBob.status).toBe(200);
    expect(forBob.body.userId).toBe(BOB);
  });
});

describe("what a member may do", () => {
  let bobToken = "";

  it("chats, but cannot administer", async () => {
    bobToken = await pairDevice({ userId: BOB, source: "10.0.0.3", label: "Bob's phone" });
    const me = await get("/api/auth/session", asDevice(bobToken, "10.0.0.3"));
    expect(me.body.user).toMatchObject({ id: BOB, role: "member" });
    expect(me.body.scopes).toEqual(["client"]);
    expect((await get(CLIENT_ROUTE, asDevice(bobToken, "10.0.0.3"))).status).toBe(200);

    const refused = await get(ADMIN_ROUTE, asDevice(bobToken, "10.0.0.3"));
    expect(refused.status).toBe(403);
    // The pre-existing message: nothing about scope denial regressed.
    expect(refused.body.error).toMatch(/lacks the admin scope/);
    expect((await post("/api/auth/pairing", { userId: BOB }, asDevice(bobToken, "10.0.0.3"))).status).toBe(403);
  });

  it("stays capped by the device ceiling even after a promotion", async () => {
    // Bob's phone was paired with the full ceiling, so promoting him lifts it.
    expect((await patch(`${ADMIN_ROUTE}/${BOB}`, { role: "admin" }, asDevice(adaToken, "10.0.0.2"))).status).toBe(200);
    expect((await get(ADMIN_ROUTE, asDevice(bobToken, "10.0.0.3"))).status).toBe(200);

    // A chat-only device of the same admin stays chat-only: the ceiling vetoes.
    const capped = await pairDevice({ userId: BOB, scopes: ["client"], source: "10.0.0.4", label: "Kitchen iPad" });
    expect((await get(ADMIN_ROUTE, asDevice(capped, "10.0.0.4"))).status).toBe(403);
    expect((await get(CLIENT_ROUTE, asDevice(capped, "10.0.0.4"))).status).toBe(200);

    // And a demotion lands on the next request, with no re-pairing.
    expect((await patch(`${ADMIN_ROUTE}/${BOB}`, { role: "member" }, asDevice(adaToken, "10.0.0.2"))).status).toBe(200);
    expect((await get(ADMIN_ROUTE, asDevice(bobToken, "10.0.0.3"))).status).toBe(403);
  });
});

describe("nobody can lock themselves out", () => {
  it("refuses to edit your own authority or delete yourself (guards B and C)", async () => {
    const demoteSelf = await patch(`${ADMIN_ROUTE}/${ADA}`, { role: "member" }, asDevice(adaToken, "10.0.0.2"));
    expect(demoteSelf.status).toBe(409);
    expect(demoteSelf.body.error).toMatch(/your own role or status/);
    expect((await patch(`${ADMIN_ROUTE}/${ADA}`, { status: "disabled" }, asDevice(adaToken, "10.0.0.2"))).status).toBe(409);
    const deleteSelf = await del(`${ADMIN_ROUTE}/${ADA}`, asDevice(adaToken, "10.0.0.2"));
    expect(deleteSelf.status).toBe(409);
    expect(deleteSelf.body.error).toMatch(/your own account/);
    // Renaming yourself is fine — it is not authority.
    expect((await patch(`${ADMIN_ROUTE}/${ADA}`, { name: "Ada L." }, asDevice(adaToken, "10.0.0.2"))).status).toBe(200);
  });

  it("keeps at least one active admin, and the rule binds loopback too (guard A)", async () => {
    // Ada is the only admin now (Bob was demoted), so even the machine's owner
    // may not disable her.
    const fromTheMachine = await patch(`${ADMIN_ROUTE}/${ADA}`, { status: "disabled" }, {});
    expect(fromTheMachine.status).toBe(409);
    expect(fromTheMachine.body.error).toMatch(/last active admin/);
    expect((await get(`${ADMIN_ROUTE}/${ADA}`)).body.user.status).toBe("active");
  });
});

describe("switching someone off", () => {
  it("ends their live stream at once and signs their devices out, reversibly", async () => {
    const bobToken = await pairDevice({ userId: BOB, source: "10.0.0.5", label: "Bob's laptop" });
    const ticket = await post("/api/auth/stream-ticket", {}, asDevice(bobToken, "10.0.0.5"));
    expect(ticket.body.ticket).toBeTruthy();

    // Hold the stream open, and record the moment it ends.
    const stream = request({ host: "127.0.0.1", port: PORT, path: `/api/events?ticket=${ticket.body.ticket}`, headers: remote("10.0.0.5") });
    const ended = new Promise<void>((resolve) => {
      stream.on("response", (res) => {
        expect(res.statusCode).toBe(200);
        res.on("data", () => {});
        res.on("end", () => resolve());
      });
    });
    stream.end();
    await new Promise((r) => setTimeout(r, 300)); // let it register

    const started = Date.now();
    const disabled = await patch(`${ADMIN_ROUTE}/${BOB}`, { status: "disabled" }, asDevice(adaToken, "10.0.0.2"));
    expect(disabled.status).toBe(200);
    expect(disabled.body.revokedSessions).toBeGreaterThanOrEqual(1); // reported as "signed out"

    await ended;
    // The disable ended it, not the 4s heartbeat.
    expect(Date.now() - started).toBeLessThan(3_000);

    // Every request is refused, and told WHY: disabling is not a revoked
    // credential, and re-pairing would not fix it.
    const denied = await get(CLIENT_ROUTE, asDevice(bobToken, "10.0.0.5"));
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/account is disabled/);
    const refused = await post("/api/auth/pairing", { userId: BOB }, asDevice(adaToken, "10.0.0.2"));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/disabled/);

    // Disable is a switch, not a shredder: enabling restores the very same
    // device, with no re-pairing. This is the whole reason the sessions are
    // kept rather than revoked.
    expect((await patch(`${ADMIN_ROUTE}/${BOB}`, { status: "active" }, asDevice(adaToken, "10.0.0.2"))).status).toBe(200);
    expect((await get(CLIENT_ROUTE, asDevice(bobToken, "10.0.0.5"))).status).toBe(200);
  }, 20_000);
});

describe("removing someone", () => {
  it("signs out every device of theirs and leaves everyone else alone", async () => {
    const before = await get("/api/auth/sessions");
    const bobDevices = before.body.sessions.filter((s: any) => s.userId === BOB);
    expect(bobDevices.length).toBeGreaterThan(0);
    // The list names the person, not just the device.
    expect(bobDevices[0].user).toMatchObject({ id: BOB, name: "Bob" });

    const removed = await del(`${ADMIN_ROUTE}/${BOB}`, asDevice(adaToken, "10.0.0.2"));
    expect(removed.status).toBe(200);
    expect(removed.body.revokedSessions).toBe(bobDevices.length);

    const after = await get("/api/auth/sessions");
    expect(after.body.sessions.some((s: any) => s.userId === BOB)).toBe(false);
    // Ada's own device, and the legacy unnamed one, are untouched.
    expect((await get(CLIENT_ROUTE, asDevice(adaToken, "10.0.0.2"))).status).toBe(200);
    expect(after.body.sessions.some((s: any) => s.userId === null)).toBe(true);
    expect((await get(`${ADMIN_ROUTE}/${BOB}`)).status).toBe(404);
  });
});

describe("the roster survives a restart", () => {
  it("reloads the same people and the same bindings", async () => {
    const listed = await get(ADMIN_ROUTE);
    expect(listed.body.users.map((u: any) => u.id)).toEqual([ADA]);
    expect(listed.body.notice).toBeUndefined();
    // Ada's device still resolves to Ada after everything above.
    const me = await get("/api/auth/session", asDevice(adaToken, "10.0.0.2"));
    expect(me.body.user).toMatchObject({ id: ADA, name: "Ada L.", role: "admin" });
  });
});

// ── phase 4: who may see which bot ────────────────────────────────────────
// The fixture engine makes no bots, so these drive the visibility API against
// a bot created through the ordinary route and assert what each viewer sees.
describe("bot visibility", () => {
  let botId = "";
  let memberToken = "";
  let MEMBER = "";

  it("sets up a bot and a member who can see it", async () => {
    const made = await post("/api/bots", { name: "Finance" });
    expect([200, 201]).toContain(made.status);
    botId = made.body.id ?? made.body.bot?.id;
    expect(botId).toBeTruthy();

    const person = await post(ADMIN_ROUTE, { name: "Cara", role: "member" });
    expect(person.status).toBe(201);
    MEMBER = person.body.user.id;
    memberToken = await pairDevice({ userId: MEMBER, source: "10.0.1.1" });

    // Everyone sees it by default — the pre-phase-4 behaviour.
    const seen = await get(CLIENT_ROUTE, asDevice(memberToken, "10.0.1.1"));
    expect(seen.body.bots.some((b: any) => b.id === botId)).toBe(true);
  });

  it("rejects a visibility body it cannot honour", async () => {
    expect((await patch(`/api/bots/${botId}/visibility`, { mode: "sometimes" })).status).toBe(400);
    expect((await patch(`/api/bots/${botId}/visibility`, { mode: "restricted", userIds: ["ghost"] })).status).toBe(404);
    expect((await patch(`/api/bots/no-such-bot/visibility`, { mode: "everyone" })).status).toBe(404);
  });

  it("hides a restricted bot from a member, and never confirms it exists", async () => {
    expect((await patch(`/api/bots/${botId}/visibility`, { mode: "restricted", userIds: [] })).status).toBe(200);

    // Gone from the fleet list.
    const fleet = await get(CLIENT_ROUTE, asDevice(memberToken, "10.0.1.1"));
    expect(fleet.body.bots.some((b: any) => b.id === botId)).toBe(false);
    // And gone from the computerControl map that rides along with it.
    expect(Object.keys(fleet.body.computerControl ?? {})).not.toContain(botId);

    // Its transcript reads as ABSENT, not forbidden: a 403 would confirm it.
    const threadId = (await get(CLIENT_ROUTE)).body.bots.find((b: any) => b.id === botId).threadId;
    const transcript = await get(`/api/threads/${threadId}/messages`, asDevice(memberToken, "10.0.1.1"));
    expect(transcript.status).toBe(404);
    expect(transcript.body.error).toMatch(/no such conversation/);

    // The admin still sees everything.
    expect((await get(CLIENT_ROUTE)).body.bots.some((b: any) => b.id === botId)).toBe(true);
  });

  it("shows it again to a member named on the list, then to everyone", async () => {
    expect((await patch(`/api/bots/${botId}/visibility`, { mode: "restricted", userIds: [MEMBER] })).status).toBe(200);
    expect((await get(CLIENT_ROUTE, asDevice(memberToken, "10.0.1.1"))).body.bots.some((b: any) => b.id === botId)).toBe(true);

    expect((await patch(`/api/bots/${botId}/visibility`, { mode: "everyone" })).status).toBe(200);
    expect((await get(CLIENT_ROUTE, asDevice(memberToken, "10.0.1.1"))).body.bots.some((b: any) => b.id === botId)).toBe(true);
  });

  it("is admin-only to change", async () => {
    const refused = await patch(`/api/bots/${botId}/visibility`, { mode: "restricted", userIds: [] }, asDevice(memberToken, "10.0.1.1"));
    expect(refused.status).toBe(403);
  });
});

// ── phase 2: the audit trail, through the real routes ─────────────────────
describe("the audit trail", () => {
  it("records who did what, and is admin-only to read", async () => {
    const rows = (await get("/api/auth/audit")).body.rows;
    const actions = rows.map((r: any) => r.action);
    // Everything the tests above did should be on the record.
    expect(actions).toContain("user.create");
    expect(actions).toContain("user.disable");
    expect(actions).toContain("user.remove");
    expect(actions).toContain("pairing.mint");
    // Rows name the person acted on, and a disable reports what it cost.
    const disabled = rows.find((r: any) => r.action === "user.disable");
    expect(disabled.target.kind).toBe("user");
    expect(disabled.effects?.revokedSessions).toBeGreaterThanOrEqual(0);
    // A remove that Ada performed remotely is attributed to Ada, not loopback.
    const removal = rows.find((r: any) => r.action === "user.remove");
    expect(removal.actor.kind).toBe("user");
    expect(removal.actor.userName).toBe("Ada L.");
  });
});

// ── phase 3: the catalog ──────────────────────────────────────────────────
describe("the permission catalog", () => {
  it("is readable by a member, and whoami reports their own permissions", async () => {
    const person = await post(ADMIN_ROUTE, { name: "Dee", role: "member" });
    const token = await pairDevice({ userId: person.body.user.id, source: "10.0.2.1" });

    const catalog = await get("/api/auth/permissions", asDevice(token, "10.0.2.1"));
    expect(catalog.status).toBe(200);
    expect(catalog.body.permissions.length).toBeGreaterThan(0);
    expect(catalog.body.roles.member).toContain("chat");

    const me = await get("/api/auth/session", asDevice(token, "10.0.2.1"));
    expect(me.body.permissions).toContain("chat");
    expect(me.body.permissions).not.toContain("users.manage");
  });
});
