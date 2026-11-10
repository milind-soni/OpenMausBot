// Each guard the hardened profile gives a self-hosted server, attacked as a bot's process would attack it, and then the
// same attack with that one guard taken away, which must succeed: so a test here fails when its guard is removed.
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openHarnessGate, type HarnessGate } from "./bot-box/harness-gate.ts";
import { planBox, visibleInBox, type BoxSetup } from "./bot-box/plan.ts";
import { clientBotPatchViolation, resolveLoopbackTrust, resolveRequestAuth } from "./request-auth.ts";
import { OPERATOR_TOKEN_FILE } from "./server-profile.ts";
import { SessionRegistry } from "./sessions.ts";

function request(headers: Record<string, string>, method: string): IncomingMessage {
  // SAFETY: the resolver reads only headers and method; a bare object is the whole contract here
  return { headers, method } as unknown as IncomingMessage;
}

/** What a server one person uses decides, and what one in the hardened profile decides. */
const STANDARD = resolveLoopbackTrust({ env: {}, desktopManaged: false, hostedWorkspace: false });
const HARDENED = resolveLoopbackTrust({ env: {}, desktopManaged: false, hostedWorkspace: false, hardened: true });

describe("a bot's process cannot act as the server's owner over loopback", () => {
  let dir: string, sessions: SessionRegistry;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-profile-guards-"));
    sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A request from the server's own machine with no session: curl in a bot's shell. */
  const local = (method: string, path: string, trust: typeof HARDENED, extra: { headers?: Record<string, string>; operatorToken?: string } = {}) =>
    resolveRequestAuth(request({ host: "127.0.0.1:8799", ...extra.headers }, method), {
      sessions, cookieName: "omb_session_8799_env", streamPath: "/api/events", url: new URL(path, "http://x"),
      loopbackTrust: trust.trust, serviceRelay: trust.relay, ...(extra.operatorToken ? { operatorToken: extra.operatorToken } : {}),
    });

  const OWNER_ONLY: Array<[string, string]> = [
    ["GET", "/api/config"], ["PUT", "/api/config"], ["PATCH", "/api/config"], ["POST", "/api/config/server-profile-notice"],
    ["POST", "/api/auth/pairing"], ["GET", "/api/auth/sessions"], ["DELETE", "/api/auth/sessions/sess-admin"],
    ["PATCH", "/api/bots/bot-1"], ["POST", "/api/bots"], ["POST", "/api/bots/bot-1/respond"], ["POST", "/api/bots/bot-1/always-allow"],
    ["POST", "/api/mcp-servers"], ["POST", "/api/webhooks"], ["POST", "/api/instances"], ["POST", "/api/workspace-backup/export"],
  ];

  it("is refused every owner route in the hardened profile, and was the owner without it", () => {
    for (const [method, path] of OWNER_ONLY) {
      const refused = local(method, path, HARDENED);
      expect(refused.auth, `${method} ${path}`).toBeNull();
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(local(method, path, STANDARD).auth, `${method} ${path} without the guard`).toEqual({ kind: "loopback", scopes: ["admin", "client"] });
    }
  });

  it("keeps what a bot's own helpers need: health, and the routes that check the turn's own token", () => {
    for (const [method, path] of [["GET", "/api/health"], ["GET", "/api/auth/session"], ["POST", "/api/internal/hook"], ["GET", "/api/internal/agents"]] as const) {
      expect(local(method, path, HARDENED).auth, `${method} ${path}`).toEqual({ kind: "loopback", scopes: ["client"], trust: "service" });
    }
  });

  /** How a session-less local process got Full access on a shared server: it posts into a Full-access conversation, or
   * opens one, through the routes kept for a Slack worker. */
  const RAISE: Array<[string, string]> = [
    ["POST", "/api/bots/bot-1/messages/guarded"], ["POST", "/api/bots/bot-1/tasks"], ["GET", "/api/bots"],
    ["GET", "/api/threads/thread-1/messages"], ["POST", "/api/threads/thread-1/respond"], ["POST", "/api/bots/bot-1/requests/job-1/interrupt"],
  ];

  it("cannot raise itself to Full access: the worker's routes are closed to it, and were open while a relay was assumed", () => {
    for (const [method, path] of RAISE) {
      expect(local(method, path, HARDENED).auth, `${method} ${path}`).toBeNull();
      expect(local(method, path, { ...HARDENED, relay: true }).auth, `${method} ${path} without the guard`).toEqual({ kind: "loopback", scopes: ["client"], trust: "service" });
    }
  });

  it("cannot raise itself with a member's session either: a chat-only session changes neither settings nor what a bot may do", () => {
    const member = sessions.issue({ label: "Member", scopes: ["client"] });
    const admin = sessions.issue({ label: "Admin", scopes: ["admin", "client"] });
    const as = (token: string, method: string, path: string) => local(method, path, HARDENED, { headers: { authorization: `Bearer ${token}` } });
    for (const [method, path] of [["PUT", "/api/config"], ["PATCH", "/api/config"], ["POST", "/api/auth/pairing"], ["POST", "/api/bots"], ["POST", "/api/mcp-servers"]] as const) {
      expect(as(member.token, method, path).status, `${method} ${path}`).toBe(403);
      expect(as(member.token, method, path).auth, `${method} ${path}`).toBeNull();
      expect(as(admin.token, method, path).auth?.kind, `${method} ${path} as an admin`).toBe("session");
    }
    for (const field of ["approvalMode", "cwd", "instanceId", "allowedTools"]) {
      expect(clientBotPatchViolation({ [field]: "full" }), field).toBe(field);
    }
    expect(clientBotPatchViolation({ pinned: true })).toBeNull();
  });

  it("opens only pairing codes to a command that read the operator token, which no boxed process can", () => {
    const token = "o".repeat(43);
    const present = (method: string, path: string, header: string | undefined, given: string | undefined = token) =>
      local(method, path, HARDENED, { headers: header ? { "x-openmausbot-cli-owner": header } : {}, operatorToken: given });
    expect(present("POST", "/api/auth/pairing", token).auth).toEqual({ kind: "loopback", scopes: ["admin", "client"] });
    expect(present("POST", "/api/auth/pairing", undefined).auth).toBeNull();
    expect(present("POST", "/api/auth/pairing", "x".repeat(43)).auth).toBeNull();
    expect(present("POST", "/api/auth/pairing", token, "").auth).toBeNull();
    for (const [method, path] of [["PUT", "/api/config"], ["GET", "/api/auth/sessions"], ["PATCH", "/api/bots/bot-1"], ["POST", "/api/bots/bot-1/messages/guarded"]] as const) {
      expect(present(method, path, token).auth, `${method} ${path}`).toBeNull();
    }
  });
});

// The harness gate listens on a unix socket, which Windows refuses at a file path; the box itself runs only on Linux.
describe.skipIf(process.platform === "win32")("a boxed process reaches the server only through the harness gate", () => {
  let upstream: Server, gate: HarnessGate, dir: string, port: number;
  const reached: string[] = [];
  beforeEach(async () => {
    upstream = createServer((req, res) => { reached.push(`${req.method} ${req.url}`); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    port = (upstream.address() as { port: number }).port;
    dir = mkdtempSync(join(tmpdir(), "omb-profile-gate-"));
    gate = await openHarnessGate({ socketPath: join(dir, "h.sock"), port });
  });
  afterEach(async () => {
    await gate.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    reached.length = 0;
  });
  const call = (target: { socketPath: string } | { port: number }, method: string, path: string) => new Promise<number>((resolve, reject) => {
    const req = httpRequest({ ...("port" in target ? { host: "127.0.0.1" } : {}), ...target, path, method, headers: { "content-type": "application/json" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
    req.on("error", reject);
    req.end(method === "GET" ? undefined : "{}");
  });

  it("answers 403 itself for settings, pairing, the guarded send and a Full-access change: the server is never asked", async () => {
    const attacks: Array<[string, string]> = [
      ["GET", "/api/config"], ["PUT", "/api/config"], ["POST", "/api/auth/pairing"], ["PATCH", "/api/bots/bot-1"],
      ["POST", "/api/bots/bot-1/messages/guarded"], ["POST", "/api/bots/bot-1/tasks"], ["POST", "/api/threads/thread-1/respond"], ["GET", "/api/internal/../config"],
    ];
    for (const [method, path] of attacks) expect(await call({ socketPath: gate.socketPath }, method, path), `${method} ${path}`).toBe(403);
    expect(reached).toEqual([]);
    expect(gate.refused).toBe(attacks.length);
    expect(await call({ socketPath: gate.socketPath }, "POST", "/api/internal/hook")).toBe(200);
    expect(reached).toEqual(["POST /api/internal/hook"]);
  });

  it("is what refuses them: the same requests straight to the server's port, as an unboxed process sends them, arrive", async () => {
    expect(await call({ port }, "PUT", "/api/config")).toBe(200);
    expect(await call({ port }, "POST", "/api/bots/bot-1/messages/guarded")).toBe(200);
    expect(reached).toEqual(["PUT /api/config", "POST /api/bots/bot-1/messages/guarded"]);
  });
});

describe("a boxed process has none of the server's files", () => {
  const home = "/data", dataDir = "/data/.openmausbot";
  const setup: BoxSetup = { dataDir, home, codeRoots: ["/app"], engineRoots: [], bridges: [] };
  const turn = { command: "claude", args: [], cwd: join(dataDir, "task-workspaces", "bot-1", "thread-1"), env: { HOME: home } };
  const SERVER_FILES = [
    "config.json", "logins.json", "logins.key", "sessions.json", "messages.db", OPERATOR_TOKEN_FILE, "server-profile.json", "box/harness.sock",
    "workspaces/bot-2/MEMORY.md", "task-workspaces/bot-2/thread-9/notes.md", "attachments/someone-elses.pdf",
  ];

  it("sees its own folders and nothing else under the data folder", () => {
    const plan = planBox(setup, turn);
    for (const file of SERVER_FILES) expect(visibleInBox(plan, join(dataDir, file)), file).toBe("none");
    expect(visibleInBox(plan, join(dataDir, "task-workspaces", "bot-1", "thread-1", "notes.md"))).toBe("rw");
    expect(visibleInBox(plan, join(dataDir, "workspaces", "bot-1", "MEMORY.md"))).toBe("rw");
    expect(plan.options).toContain("--unshare-net");
    expect(plan.options).toContain("--unshare-pid");
  });

  it("would see all of it without the empty folder the box puts over the data folder", () => {
    const plan = planBox({ ...setup, mutate: new Set(["bind-data"]) }, turn);
    for (const file of SERVER_FILES) expect(visibleInBox(plan, join(dataDir, file)), file).toBe("rw");
  });

  it("has them hidden when the data folder is outside HOME too", () => {
    const apart: BoxSetup = { ...setup, home: "/home/maus", dataDir: "/srv/openmausbot" };
    const plan = planBox(apart, { ...turn, cwd: "/srv/openmausbot/task-workspaces/bot-1/thread-1", env: { HOME: "/home/maus" } });
    for (const file of SERVER_FILES) expect(visibleInBox(plan, join("/srv/openmausbot", file)), file).toBe("none");
    expect(visibleInBox(plan, "/srv/openmausbot/task-workspaces/bot-1/thread-1/notes.md")).toBe("rw");
  });
});
