// API smoke test: boots the real harness server (node server/index.ts)
// against a throwaway home directory and exercises the HTTP surface the
// app depends on. The config pins one deliberately-unknown driver so the
// suite is deterministic with or without agent CLIs installed — and pins
// the shadow-instance behavior end to end while it's at it.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";
import { FILE_MAX_BYTES, IMAGE_MAX_BYTES } from "./attachments.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const WEBHOOK_PORT = 39000 + Math.floor(Math.random() * 10_000);
const WEBHOOK_BASE = `http://127.0.0.1:${WEBHOOK_PORT}`;

let child: ChildProcess;
/** stands in for the box provider so config saving never touches the network */
let boxStub: Server;
let boxStubPort = 0;
let home: string;
let staticDir: string;
let fakeClaudeDump: string;
let stderr = "";
const browserCapabilityCalls: Array<{ operation: string; authorization?: string; body: any }> = [];
let browserRevokeFailuresRemaining = 0;
let browserRegisterDelayMs = 0;

const expectStoppedTestServerCleanly = (serverChild: ChildProcess, capturedStderr: string): void => {
  // POSIX delivers SIGTERM to the server's graceful-shutdown handler, which
  // exits with code 0. Windows cannot deliver that handler signal: Node maps
  // child.kill("SIGTERM") to TerminateProcess and reports the requested stop
  // through signalCode instead. Accept only that exact Windows teardown shape
  // so a non-zero crash or SIGKILL escalation still fails the feature test.
  const requestedWindowsStop = process.platform === "win32"
    && serverChild.exitCode === null
    && serverChild.signalCode === "SIGTERM";
  expect(serverChild.exitCode === 0 || requestedWindowsStop, capturedStderr).toBe(true);
};

const waitForIsolatedServer = async (
  serverChild: ChildProcess,
  port: number,
  capturedStderr: () => string,
): Promise<void> => {
  const deadline = Date.now() + 20_000;
  let lastObservedHealth = "none";
  for (;;) {
    if (serverChild.exitCode !== null || serverChild.signalCode !== null) {
      throw new Error(
        `isolated server exited before becoming healthy `
        + `(code=${String(serverChild.exitCode)}, signal=${String(serverChild.signalCode)}).\n${capturedStderr()}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.status === 200) {
        const health = await response.json() as { app?: unknown; pid?: unknown; static?: unknown };
        lastObservedHealth = JSON.stringify(health);
        if (health.app === "openmausbot" && health.pid === serverChild.pid && health.static === true) return;
      }
    } catch {
      /* still starting */
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `isolated server never became healthy (last health: ${lastObservedHealth}).\n${capturedStderr()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const readJsonFileWhenReady = async <T = unknown>(file: string, timeout = 5_000): Promise<T> => {
  let parsed: unknown;
  await expect.poll(() => {
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
      return true;
    } catch {
      return false;
    }
  }, { timeout }).toBe(true);
  return parsed as T;
};

const storedMessageCount = (threadId: string): number => {
  const db = new DatabaseSync(join(home, ".openmausbot", "messages.db"), { readOnly: true });
  try {
    const row = z.object({ count: z.number() }).parse(
      db.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?").get(threadId),
    );
    return row.count;
  } finally {
    db.close();
  }
};

const uploadAvatar = async (mime = "image/png"): Promise<string> => {
  const response = await fetch(`${BASE}/api/attachments`, {
    method: "POST",
    headers: { "content-type": mime },
    body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  });
  expect(response.status).toBe(201);
  const saved = (await response.json()) as { path: string };
  const name = saved.path.replaceAll("\\", "/").split("/").pop();
  if (!name) throw new Error("attachment response did not include a filename");
  return `/api/attachments/${name}`;
};

const statusWithHeaders = (headers: Record<string, string>): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: PORT, path: "/api/health", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-api-test-"));
  staticDir = join(home, "static");
  fakeClaudeDump = join(home, "fake-claude-dump.json");
  // a fleet of exactly one unknown driver: no CLI probes, no network
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Packaged OpenMausBot</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body { color: white; }");
  writeFileSync(
    join(home, ".openmausbot", "config.json"),
    JSON.stringify({
      instances: {
        ghost: { driver: "not-a-real-driver", displayName: "Ghost" },
        claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLAUDE_CLI } },
      },
    }),
  );
  writeFileSync(
    join(home, ".openmausbot", "groups.json"),
    JSON.stringify([
      {
        id: "test-dm",
        threadId: "test-dm-thread",
        name: "Private channel",
        memberIds: ["test-bot-a", "test-bot-b"],
        defaultResponder: { kind: "mentions" },
        bulletin: "",
        unread: false,
        createdAt: 1,
        dm: true,
      },
      {
        id: "test-stranded-room",
        threadId: "test-stranded-room-thread",
        name: "Stranded room",
        memberIds: ["test-bot-a"],
        defaultResponder: { kind: "member", botId: "test-bot-a" },
        bulletin: "",
        unread: false,
        createdAt: 3,
      },
      {
        id: "test-cancel-room",
        threadId: "test-cancel-room-thread",
        name: "Cancel room",
        memberIds: ["test-bot-a"],
        defaultResponder: { kind: "member", botId: "test-bot-a" },
        bulletin: "",
        unread: false,
        createdAt: 4,
      },
      {
        id: "test-pinned-room",
        threadId: "test-pinned-room-thread",
        name: "Pinned room",
        memberIds: ["test-bot-a"],
        defaultResponder: { kind: "member", botId: "test-bot-a" },
        bulletin: "",
        unread: false,
        createdAt: 2,
        pinnedCwd: null,
      },
    ]),
  );

  // A room transcript carrying an approval that outlived its turn: the card
  // is durable, but busyBotId is in-memory only and never survives a restart.
  writeFileSync(
    join(home, ".openmausbot", "messages-test-stranded-room-thread.json"),
    JSON.stringify({
      activeLeafId: "stranded-card",
      messages: [
        {
          id: "stranded-card",
          at: 3,
          parentId: null,
          role: "bot",
          kind: "options",
          card: {
            title: "Approval needed",
            subtitle: "rm -rf /tmp/scratch",
            options: ["Allow", "Deny"],
            requestId: "stranded-request",
            tool: "Bash",
            allowKey: "Bash:rm",
          },
          from: { botId: "test-bot-a", name: "Test bot A", color: "purple" },
        },
      ],
    }),
  );

  // A room holding an approval nobody has answered yet, so "Cancel turn"
  // has something open to close.
  writeFileSync(
    join(home, ".openmausbot", "messages-test-cancel-room-thread.json"),
    JSON.stringify({
      activeLeafId: "cancel-card",
      messages: [
        {
          id: "cancel-card",
          at: 4,
          parentId: null,
          role: "bot",
          kind: "options",
          card: {
            title: "Approval needed",
            subtitle: "rm -rf /tmp/scratch",
            options: ["Allow", "Deny"],
            requestId: "cancel-request",
            tool: "Bash",
            allowKey: "Bash:rm",
          },
          from: { botId: "test-bot-a", name: "Test bot A", color: "purple" },
        },
      ],
    }),
  );

  boxStub = createServer(async (req, res) => {
    if (req.url?.startsWith("/v1/capabilities/")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      const operation = req.url.split("/").pop() ?? "";
      browserCapabilityCalls.push({
        operation,
        authorization: Array.isArray(req.headers.authorization) ? undefined : req.headers.authorization,
        body,
      });
      if (req.headers.authorization !== `Bearer ${"c".repeat(64)}`) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unauthorized" }));
      }
      if (operation === "revoke" && browserRevokeFailuresRemaining > 0) {
        browserRevokeFailuresRemaining -= 1;
        res.writeHead(503, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "temporary failure" }));
      }
      if (operation === "register" && browserRegisterDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, browserRegisterDelayMs));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(operation === "register" ? { ok: true, expiresAt: body.expiresAt } : { ok: true }));
    }
    if (req.url?.startsWith("/api/v3.1/tool_router/session")) {
      if (req.headers["x-api-key"] !== "ak_good") {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "invalid project key" } }));
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      res.writeHead(201, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        session_id: "trs_config_test",
        mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_config_test/mcp" },
        config: { user_id: body.user_id },
      }));
    }
    if (req.headers.authorization === "Bearer box_slow") {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const ok = req.headers.authorization === "Bearer box_good" || req.headers.authorization === "Bearer box_slow";
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { ok: true, boxes: [] } : { ok: false, code: "unauthorized" }));
  });
  await new Promise<void>((r) => boxStub.listen(0, "127.0.0.1", r));
  boxStubPort = (boxStub.address() as { port: number }).port;

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_WEBHOOK_PORT: String(WEBHOOK_PORT),
      OMB_BOX_API: `http://127.0.0.1:${boxStubPort}`,
      OMB_COMPOSIO_API: `http://127.0.0.1:${boxStubPort}/api/v3.1`,
      OMB_STATIC_DIR: staticDir,
      // Created only by the browser integration test. Keeping an explicit
      // path prevents that test from ever discovering a developer app's live
      // descriptor on the host running the suite.
      OMB_BROWSER_CONNECTION: join(home, "browser-test-connection.json"),
      // Production uses 15s. Keep the real timer path while making the
      // browser-visible heartbeat assertion fast and deterministic.
      OMB_SSE_HEARTBEAT_MS: "50",
      FAKE_CLAUDE_MODE: "hang",
      FAKE_CLAUDE_DUMP: fakeClaudeDump,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}, 30_000);

afterAll(async () => {
  boxStub?.close();
  // Upstream fixed this same Linux scratch-cleanup flake with an inline
  // retry loop; these helpers are that fix plus the cause — the retry AND
  // an exit that is actually waited for before the delete begins.
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("harness HTTP API", () => {
  it("rejects non-loopback authorities while accepting IPv4 and IPv6 loopback forms", async () => {
    expect(await statusWithHeaders({ host: "example.com" })).toBe(403);
    expect(await statusWithHeaders({ origin: "https://example.com" })).toBe(403);
    expect(await statusWithHeaders({ host: `127.0.0.2:${PORT}` })).toBe(200);
    expect(await statusWithHeaders({ host: `[::1]:${PORT}` })).toBe(200);
    expect(await statusWithHeaders({ origin: `http://[::1]:${PORT}` })).toBe(200);
  });

  it("identifies itself on /api/health", async () => {
    const { status, body } = await api("GET", "/api/health");
    expect(status).toBe(200);
    expect(body.app).toBe("openmausbot");
    expect(typeof body.pid).toBe("number");
    expect(body.static).toBe(true);
  });

  it("serves packaged UI assets and preserves API 404s", async () => {
    const root = await fetch(`${BASE}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toBe("text/html");
    expect(await root.text()).toContain("Packaged OpenMausBot");

    const asset = await fetch(`${BASE}/assets/smoke.css`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("text/css");
    expect(await asset.text()).toContain("color: white");

    const spa = await fetch(`${BASE}/settings/desktop`);
    expect(spa.status).toBe(200);
    expect(spa.headers.get("content-type")).toBe("text/html");
    expect(await spa.text()).toContain("Packaged OpenMausBot");

    const unknownApi = await api("GET", "/api/not-a-real-route");
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.body.error).toContain("/api/not-a-real-route");
  });

  it("rejects malformed and oversized JSON bodies without hanging", async () => {
    const malformed = await fetch(`${BASE}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid JSON body" });

    const oversized = await fetch(`${BASE}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: "x".repeat(1_000_001) } }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "body too large" });

    expect((await fetch(`${BASE}/api/health`)).status).toBe(200);
  });

  it("seeds one starter bot with its greeting", async () => {
    const { status, body } = await api("GET", "/api/bots");
    expect(status).toBe(200);
    expect(body.bots.length).toBeGreaterThanOrEqual(1);
    expect(body.bots[0].messages.length).toBeGreaterThanOrEqual(2);
  });

  it("projects privacy-safe live team-map metadata", async () => {
    const response = await api("GET", "/api/team-map");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ collaborations: expect.any(Array), queued: [], running: [] });
    for (const collaboration of response.body.collaborations) {
      expect(collaboration).toEqual({
        groupId: expect.any(String),
        botIds: [expect.any(String), expect.any(String)],
        lastAt: expect.any(Number),
      });
    }
    expect(JSON.stringify(response.body)).not.toContain("messages");
    expect(JSON.stringify(response.body)).not.toContain("prompt");
  });

  it("rejects non-object bot and channel create bodies without writing records", async () => {
    const before = await api("GET", "/api/bots?messages=0");
    for (const path of ["/api/bots", "/api/groups"]) {
      for (const body of ["null", "[]"]) {
        const response = await fetch(`${BASE}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: expect.stringMatching(/JSON object/) });
      }
    }
    const after = await api("GET", "/api/bots?messages=0");
    expect(after.body.bots).toHaveLength(before.body.bots.length);
    expect(after.body.groups).toHaveLength(before.body.groups.length);
  });

  it("adds and removes room members through PATCH", async () => {
    const [first, second, third] = await Promise.all([
      api("POST", "/api/bots"),
      api("POST", "/api/bots"),
      api("POST", "/api/bots"),
    ]).then((created) => created.map((response) => response.body.bot));
    const room = (await api("POST", "/api/groups", { name: "Roster", memberIds: [first.id, second.id] })).body.group;
    try {
      const added = await api("PATCH", `/api/groups/${room.id}`, { memberIds: [first.id, second.id, third.id] });
      expect(added.status).toBe(200);
      expect(added.body.group.memberIds).toEqual([first.id, second.id, third.id]);

      const removed = await api("PATCH", `/api/groups/${room.id}`, { memberIds: [third.id] });
      expect(removed.status).toBe(200);
      expect(removed.body.group.memberIds).toEqual([third.id]);

      const state = (await api("GET", "/api/bots")).body;
      expect(state.groups.find((group: { id: string }) => group.id === room.id).memberIds).toEqual([third.id]);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      for (const bot of [first, second, third]) await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses to empty a room's roster", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Never empty", memberIds: [bot.id] })).body.group;
    try {
      for (const memberIds of [[], ["no-such-bot"]]) {
        const attempted = await api("PATCH", `/api/groups/${room.id}`, { memberIds });
        expect(attempted.status).toBe(400);
        expect(attempted.body.error).toMatch(/at least one bot|unknown room member/i);
      }
      const state = (await api("GET", "/api/bots")).body;
      expect(state.groups.find((group: { id: string }) => group.id === room.id).memberIds).toEqual([bot.id]);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses a room whose every member is archived", async () => {
    const [archived, active] = await Promise.all([api("POST", "/api/bots"), api("POST", "/api/bots")]).then(
      (created) => created.map((response) => response.body.bot),
    );
    await api("PATCH", `/api/bots/${archived.id}`, { hidden: true });
    try {
      const refused = await api("POST", "/api/groups", { name: "All archived", memberIds: [archived.id] });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/at least one active bot/i);

      // one active member is enough — the archived one may still ride along
      const created = await api("POST", "/api/groups", {
        name: "Mixed roster",
        memberIds: [archived.id, active.id],
      });
      expect(created.status).toBe(201);
      await api("DELETE", `/api/groups/${created.body.group.id}`);
    } finally {
      for (const bot of [archived, active]) await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("deduplicates repeated room members while preserving their first-seen order", async () => {
    const [first, second] = await Promise.all([api("POST", "/api/bots"), api("POST", "/api/bots")]).then(
      (created) => created.map((response) => response.body.bot),
    );
    const room = (await api("POST", "/api/groups", { name: "Unique roster", memberIds: [first.id] })).body.group;
    try {
      const patched = await api("PATCH", `/api/groups/${room.id}`, {
        memberIds: [second.id, first.id, second.id, first.id],
      });
      expect(patched.status).toBe(200);
      expect(patched.body.group.memberIds).toEqual([second.id, first.id]);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      for (const bot of [first, second]) await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("keeps direct-message channels a fixed pair at the API boundary", async () => {
    const attempted = await api("PATCH", "/api/groups/test-dm", { memberIds: ["test-bot-a"] });
    expect(attempted.status).toBe(400);
    expect(attempted.body.error).toMatch(/direct-message.*members/i);
    const state = await api("GET", "/api/bots");
    const dm = state.body.groups.find((group: { id: string }) => group.id === "test-dm");
    expect(dm.memberIds).toEqual(["test-bot-a", "test-bot-b"]);
  });

  it("hands the lead to a remaining member when the lead leaves the room", async () => {
    const [lead, other] = await Promise.all([api("POST", "/api/bots"), api("POST", "/api/bots")]).then((created) =>
      created.map((response) => response.body.bot),
    );
    const room = (await api("POST", "/api/groups", { name: "Handover", memberIds: [lead.id, other.id] })).body.group;
    try {
      expect(room.defaultResponder).toEqual({ kind: "member", botId: lead.id });
      const patched = await api("PATCH", `/api/groups/${room.id}`, { memberIds: [other.id] });
      expect(patched.status).toBe(200);
      expect(patched.body.group.defaultResponder).toEqual({ kind: "member", botId: other.id });
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      for (const bot of [lead, other]) await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("persists room setup and blocks the first message until it is finished", async () => {
    const bot = (await api("GET", "/api/bots")).body.bots[0];
    const created = await api("POST", "/api/groups", { name: "Setup probe", memberIds: [bot.id] });
    expect(created.status).toBe(201);
    const group = created.body.group;
    try {
      expect(group).toMatchObject({ setupCompletedAt: null, setupSkippedAt: null, messages: [] });
      const blocked = await api("POST", `/api/groups/${group.id}/messages`, { text: "before setup" });
      expect(blocked.status).toBe(409);
      expect((await api("GET", "/api/bots")).body.groups.find((candidate: { id: string }) => candidate.id === group.id).messages).toHaveLength(0);

      const invalid = await api("PATCH", `/api/groups/${group.id}/setup`, {
        action: "complete",
        cwd: null,
        bulletin: "",
        defaultResponder: { kind: "member", botId: "missing" },
      });
      expect(invalid.status).toBe(400);

      const completed = await api("PATCH", `/api/groups/${group.id}/setup`, {
        action: "complete",
        cwd: null,
        bulletin: "shared brief",
        defaultResponder: { kind: "member", botId: bot.id },
      });
      expect(completed.status).toBe(200);
      expect(completed.body.group).toMatchObject({ bulletin: "shared brief", setupCompletedAt: expect.any(Number) });
      expect((await api("GET", "/api/bots")).body.groups.find((candidate: { id: string }) => candidate.id === group.id)).toMatchObject({
        bulletin: "shared brief",
        setupSkippedAt: null,
      });
    } finally {
      await api("DELETE", `/api/groups/${group.id}`);
    }
  });

  it("creates an MCP-ready channel in one request without exposing partial setup", async () => {
    const bot = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    const created = await api("POST", "/api/groups", {
      name: "Atomic setup",
      memberIds: [bot.id],
      section: "Work",
      setup: {
        bulletin: "Keep updates concise.",
        defaultResponder: { kind: "mentions" },
      },
    });
    expect(created.status).toBe(201);
    const group = created.body.group;
    try {
      expect(group).toMatchObject({
        name: "Atomic setup",
        memberIds: [bot.id],
        section: "Work",
        bulletin: "Keep updates concise.",
        defaultResponder: { kind: "mentions" },
        setupSkippedAt: null,
      });
      expect(group.setupCompletedAt).toEqual(expect.any(Number));
      expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "A quiet update" })).status).toBe(202);
    } finally {
      await api("POST", `/api/groups/${group.id}/interrupt`, {});
      await api("DELETE", `/api/groups/${group.id}`);
    }
  });

  it("returns the canonical stored user message for direct and channel sends", async () => {
    const created = await api("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    let room: any;
    try {
      const direct = await api("POST", `/api/bots/${bot.id}/messages`, { text: "canonical direct" });
      expect(direct.status).toBe(202);
      expect(direct.body).toMatchObject({
        ok: true,
        threadId: bot.threadId,
        message: {
          id: expect.any(String),
          at: expect.any(Number),
          role: "user",
          kind: "text",
          text: "canonical direct",
        },
      });
      const afterDirect = (await api("GET", "/api/bots?messages=20")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(afterDirect.messages.find((message: { id: string }) => message.id === direct.body.message.id))
        .toEqual(direct.body.message);

      expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBe(false);

      room = (await api("POST", "/api/groups", {
        name: "Canonical response room",
        memberIds: [bot.id],
        setup: { bulletin: "", defaultResponder: { kind: "mentions" } },
      })).body.group;
      const channel = await api("POST", `/api/groups/${room.id}/messages`, { text: "canonical channel" });
      expect(channel.status).toBe(202);
      expect(channel.body).toMatchObject({
        ok: true,
        threadId: room.threadId,
        message: {
          id: expect.any(String),
          at: expect.any(Number),
          role: "user",
          kind: "text",
          text: "canonical channel",
        },
      });
      const afterChannel = (await api("GET", "/api/bots?messages=20")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      expect(afterChannel.messages.find((message: { id: string }) => message.id === channel.body.message.id))
        .toEqual(channel.body.message);
    } finally {
      if (room) await api("DELETE", `/api/groups/${room.id}`);
      await api("POST", `/api/bots/${bot.id}/interrupt`).catch(() => undefined);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("deduplicates direct send retries by sendId, including after the accepted task becomes inactive", async () => {
    const created = await api("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const originalThreadId = bot.threadId;
    const sendId = "direct_retry_1234567890";
    const request = { text: "retry this direct message once", threadId: originalThreadId, sendId };
    try {
      const first = await api("POST", `/api/bots/${bot.id}/messages`, request);
      expect(first.status).toBe(202);
      expect(first.body).toMatchObject({
        ok: true,
        threadId: originalThreadId,
        message: { role: "user", kind: "text", text: request.text, sendId },
      });

      const duplicate = await api("POST", `/api/bots/${bot.id}/messages`, request);
      expect(duplicate.status).toBe(202);
      expect(duplicate.body).toEqual(first.body);

      const conflict = await api("POST", `/api/bots/${bot.id}/messages`, {
        ...request,
        text: "a different message cannot reuse that identity",
      });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error).toMatch(/sendId already belongs/i);

      const invalid = await api("POST", `/api/bots/${bot.id}/messages`, {
        text: "invalid identity must not land",
        threadId: originalThreadId,
        sendId: "short",
      });
      expect(invalid.status).toBe(400);

      const accepted = (await api("GET", "/api/bots?messages=50")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(accepted.messages.filter((message: { role: string; sendId?: string }) =>
        message.role === "user" && message.sendId === sendId
      )).toHaveLength(1);
      expect(accepted.messages.some((message: { text?: string }) => message.text === "invalid identity must not land"))
        .toBe(false);

      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: originalThreadId });
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return state?.busy;
      }, { timeout: 5_000 }).toBe(false);

      const nextTask = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Now active" });
      expect(nextTask.status).toBe(201);
      expect(nextTask.body.task.threadId).not.toBe(originalThreadId);

      const inactiveRetry = await api("POST", `/api/bots/${bot.id}/messages`, request);
      expect(inactiveRetry.status).toBe(202);
      expect(inactiveRetry.body).toEqual(first.body);
      const current = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(current.threadId).toBe(nextTask.body.task.threadId);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("deduplicates channel send retries by sendId", async () => {
    const member = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    const room = (await api("POST", "/api/groups", {
      name: "Idempotent channel",
      memberIds: [member.id],
      setup: { bulletin: "", defaultResponder: { kind: "mentions" } },
    })).body.group;
    const sendId = "channel_retry_123456789";
    const request = { text: "one canonical channel message", threadId: room.threadId, sendId };
    try {
      const first = await api("POST", `/api/groups/${room.id}/messages`, request);
      expect(first.status).toBe(202);
      expect(first.body).toMatchObject({
        ok: true,
        threadId: room.threadId,
        message: { role: "user", kind: "text", text: request.text, sendId },
      });

      const duplicate = await api("POST", `/api/groups/${room.id}/messages`, request);
      expect(duplicate.status).toBe(202);
      expect(duplicate.body).toEqual(first.body);

      const snapshot = (await api("GET", "/api/bots?messages=50")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      expect(snapshot.messages.filter((message: { role: string; sendId?: string }) =>
        message.role === "user" && message.sendId === sendId
      )).toHaveLength(1);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
      await api("DELETE", `/api/groups/${room.id}`);
    }
  });

  it("rejects an entire channel roster when any requested member is unknown", async () => {
    const bot = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    const before = (await api("GET", "/api/bots?messages=0")).body.groups.length;
    const rejectedCreate = await api("POST", "/api/groups", {
      name: "No partial roster",
      memberIds: [bot.id, "missing-bot"],
    });
    expect(rejectedCreate.status).toBe(400);
    expect(rejectedCreate.body.error).toContain("missing-bot");
    expect((await api("GET", "/api/bots?messages=0")).body.groups).toHaveLength(before);

    const room = (await api("POST", "/api/groups", { name: "Stable roster", memberIds: [bot.id] })).body.group;
    try {
      const rejectedPatch = await api("PATCH", `/api/groups/${room.id}`, {
        memberIds: [bot.id, "missing-bot"],
      });
      expect(rejectedPatch.status).toBe(400);
      const reread = (await api("GET", "/api/bots?messages=0")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      expect(reread.memberIds).toEqual([bot.id]);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
    }
  });

  it("creates, switches, renames and deletes independent channel tasks", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Parallel work", memberIds: [bot.id] })).body.group;
    try {
      expect(room.tasks).toHaveLength(1);
      expect(room.tasks[0].threadId).toBe(room.threadId);
      const originalThread = room.threadId;

      const created = await api("POST", `/api/groups/${room.id}/tasks`, { title: "Launch plan" });
      expect(created.status).toBe(201);
      expect(created.body.group.threadId).toBe(created.body.task.threadId);
      expect(created.body.group.messages).toEqual([]);
      expect(created.body.group.tasks).toHaveLength(2);

      const newThread = created.body.task.threadId;
      const renamed = await api("PATCH", `/api/groups/${room.id}/tasks/${newThread}`, {
        title: "Release plan",
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body.task.title).toBe("Release plan");

      const switched = await api("POST", `/api/groups/${room.id}/tasks/${originalThread}`);
      expect(switched.status).toBe(200);
      expect(switched.body.group.threadId).toBe(originalThread);
      expect(switched.body.group.tasks.find((task: { threadId: string }) => task.threadId === newThread).title).toBe("Release plan");

      const removed = await api("DELETE", `/api/groups/${room.id}/tasks/${newThread}`);
      expect(removed.status).toBe(200);
      expect(removed.body.group.tasks).toHaveLength(1);
      expect((await api("DELETE", `/api/groups/${room.id}/tasks/${originalThread}`)).status).toBe(400);
      expect((await api("POST", `/api/groups/${room.id}/tasks/missing-thread`)).status).toBe(404);
      expect((await api("POST", `/api/groups/${room.id}/tasks`, { title: 42 })).status).toBe(400);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("lets a Chief create operators from its direct and channel tasks but not from channels it cannot access", async () => {
    const chief = (await api("POST", "/api/bots")).body.bot;
    const outsider = (await api("POST", "/api/bots")).body.bot;
    let channel: any;
    let outsiderChannel: any;
    const createdBotIds: string[] = [];
    try {
      const selected = await api("PATCH", `/api/bots/${chief.id}`, {
        name: "Channel Chief",
        section: "Channel creation test",
        chiefOfStaff: true,
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      });
      expect(selected.status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/bots/${chief.id}/messages`, { text: "prepare the team" })).status).toBe(202);
      const dump = z.object({
        mcpConfig: z.object({
          mcpServers: z.object({
            agents: z.object({ env: z.object({ OMB_COMMS_TOKEN: z.string() }) }),
          }),
        }),
      }).parse(await readJsonFileWhenReady(fakeClaudeDump));
      const internalHeaders = {
        authorization: `Bearer ${dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN}`,
        "content-type": "application/json",
      };
      expect((await api("POST", `/api/bots/${chief.id}/interrupt`)).status).toBe(200);

      const createOperator = async (fromThreadId: string, name: string, fromBotId = chief.id) => {
        const response = await fetch(`${BASE}/api/internal/create-bot`, {
          method: "POST",
          headers: internalHeaders,
          body: JSON.stringify({
            fromBotId,
            fromThreadId,
            name,
            role: "Research operator",
            instructions: "Research the assigned question and report concise findings.",
          }),
        });
        const body = z.object({
          id: z.string().optional(),
          section: z.string().optional(),
          error: z.string().optional(),
        }).passthrough().parse(await response.json());
        if (response.status === 201 && body.id) createdBotIds.push(body.id);
        return { status: response.status, body };
      };

      const direct = await createOperator(chief.threadId, "Direct Task Operator");
      expect(direct).toMatchObject({ status: 201, body: { section: "Channel creation test" } });

      channel = (await api("POST", "/api/groups", {
        name: "Chief member channel",
        memberIds: [chief.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: chief.id } },
      })).body.group;
      const rootThreadId = channel.threadId;
      const channelTask = await api("POST", `/api/groups/${channel.id}/tasks`, { title: "Research task" });
      expect(channelTask.status).toBe(201);
      const rootTask = await createOperator(rootThreadId, "Channel Root Operator");
      expect(rootTask.status).toBe(201);
      const nestedTask = await createOperator(channelTask.body.task.threadId, "Channel Task Operator");
      expect(nestedTask.status).toBe(201);

      outsiderChannel = (await api("POST", "/api/groups", {
        name: "Outsider-only channel",
        memberIds: [outsider.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: outsider.id } },
      })).body.group;
      const nonChief = await createOperator(outsiderChannel.threadId, "Non-Chief Operator", outsider.id);
      expect(nonChief).toEqual({
        status: 403,
        body: { error: "only a section's Chief of Staff can create operator bots" },
      });
      const denied = await createOperator(outsiderChannel.threadId, "Forbidden Operator");
      expect(denied).toEqual({
        status: 403,
        body: { error: "source conversation does not belong to sender" },
      });
      const state = (await api("GET", "/api/bots?messages=0")).body;
      expect(state.bots.some((bot: { name: string }) => bot.name === "Forbidden Operator")).toBe(false);
    } finally {
      await api("POST", `/api/bots/${chief.id}/interrupt`);
      if (outsiderChannel?.id) await api("DELETE", `/api/groups/${outsiderChannel.id}`);
      if (channel?.id) await api("DELETE", `/api/groups/${channel.id}`);
      for (const botId of createdBotIds) await api("DELETE", `/api/bots/${botId}`);
      await api("DELETE", `/api/bots/${outsider.id}`);
      await api("DELETE", `/api/bots/${chief.id}`);
    }
  });

  it("rejects null and array task, channel, and bot mutation bodies", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Object bodies", memberIds: [bot.id] })).body.group;
    try {
      const routes = [
        ["POST", `/api/groups/${room.id}/tasks`],
        ["PATCH", `/api/groups/${room.id}/tasks/${room.threadId}`],
        ["PATCH", `/api/groups/${room.id}`],
        ["PATCH", `/api/bots/${bot.id}`],
      ] as const;
      for (const [method, path] of routes) {
        for (const body of ["null", "[]"]) {
          const response = await fetch(`${BASE}${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body,
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({ error: "body must be a JSON object" });
        }
      }
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("keeps bot-to-bot channels single-threaded and blocks task changes on an open approval", async () => {
    const dm = await api("POST", "/api/groups/test-dm/tasks", {});
    expect(dm.status).toBe(400);
    expect(dm.body.error).toMatch(/one canonical conversation/i);

    const blocked = await api("POST", "/api/groups/test-stranded-room/tasks", {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/waiting on you/i);
  });

  it("keeps direct-message channels folderless at the API boundary", async () => {
    const attempted = await api("PATCH", "/api/groups/test-dm", { cwd: home });
    expect(attempted.status).toBe(400);
    expect(attempted.body.error).toMatch(/direct-message.*working folder/i);
    const state = await api("GET", "/api/bots");
    expect(state.body.groups.find((group: { id: string }) => group.id === "test-dm")).not.toHaveProperty("cwd");
    expect((await api("DELETE", "/api/groups/test-dm")).status).toBe(200);
  });

  it("rejects working-folder changes after a room has pinned its first turn", async () => {
    const attempted = await api("PATCH", "/api/groups/test-pinned-room", { cwd: home });
    expect(attempted.status).toBe(409);
    expect(attempted.body.error).toMatch(/fixed after its first turn/i);
    const state = await api("GET", "/api/bots");
    expect(state.body.groups.find((group: { id: string }) => group.id === "test-pinned-room")).not.toHaveProperty("cwd");
    expect((await api("DELETE", "/api/groups/test-pinned-room")).status).toBe(200);
  });

  it("renames rooms through a bounded non-empty name", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Old room", memberIds: [bot.id] })).body.group;
    try {
      const renamed = await api("PATCH", `/api/groups/${room.id}`, { name: "  Project Atlas  " });
      expect(renamed.status).toBe(200);
      expect(renamed.body.group.name).toBe("Project Atlas");

      for (const name of ["", "   ", 42, "x".repeat(101)]) {
        expect((await api("PATCH", `/api/groups/${room.id}`, { name })).status).toBe(400);
      }

      const state = (await api("GET", "/api/bots")).body;
      expect(state.groups.find((group: { id: string }) => group.id === room.id).name).toBe("Project Atlas");
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("describes the configured fleet, shadows included", async () => {
    const { status, body } = await api("GET", "/api/instances");
    expect(status).toBe(200);
    const ghost = body.instances.find((instance: { instanceId: string }) => instance.instanceId === "ghost");
    expect(ghost).toMatchObject({
      instanceId: "ghost",
      driverKind: "not-a-real-driver",
      displayName: "Ghost",
      snapshot: { state: "unavailable" },
    });
    expect(ghost.snapshot.reason).toContain("not-a-real-driver");
    expect(body.instances).toContainEqual(expect.objectContaining({
      instanceId: "claude",
      driverKind: "claudeAgent",
      displayName: "Fixture Claude",
    }));
  });

  it("searches transcripts and exports a conversation", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    // every new bot opens with a seeded greeting — a known searchable string
    const hits = await api("GET", "/api/search?q=nice%20to%20meet");
    expect(hits.status).toBe(200);
    const hit = hits.body.hits.find((h: { botId?: string }) => h.botId === bot.id);
    expect(hit).toMatchObject({
      botId: bot.id,
      threadId: bot.threadId,
      name: bot.name,
      kind: "text",
      onActivePath: true,
    });
    expect(hit.snippet.toLowerCase()).toContain("nice to meet");
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength).toLowerCase()).toBe("nice to meet");
    expect((await api("GET", "/api/search?q=")).body.hits).toEqual([]);
    const scoped = await api("GET", `/api/search?q=nice%20to%20meet&threadId=${bot.threadId}`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.hits.every((candidate: { threadId: string }) => candidate.threadId === bot.threadId)).toBe(true);
    expect((await api("GET", "/api/search?q=hello&threadId=missing-thread")).status).toBe(404);

    const markdown = await fetch(`${BASE}/api/threads/${bot.threadId}/export`);
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(markdown.headers.get("content-disposition")).toContain("attachment");
    const text = await markdown.text();
    expect(text).toContain("Nice to meet you");

    const asJson = await api("GET", `/api/threads/${bot.threadId}/export?format=json`);
    expect(asJson.status).toBe(200);
    expect(asJson.body.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(asJson.body)).not.toContain('"png"');
    expect((await api("GET", `/api/threads/${bot.threadId}/export?format=pdf`)).status).toBe(400);
    expect((await api("GET", "/api/threads/nope/export")).status).toBe(404);

    // one pinned message per thread: pin, round-trip, replace, clear; the
    // id is stored verbatim — resolution is the UI's job
    const pin = await api("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: "msg-abc_123" });
    expect(pin.status).toBe(200);
    expect(pin.body.bot).toMatchObject({ pinnedMessageId: "msg-abc_123" });
    const repin = await api("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: "msg-second" });
    expect(repin.body.bot).toMatchObject({ pinnedMessageId: "msg-second" });
    expect((await api("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: "not an id!" })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: 42 })).status).toBe(400);
    const unpinned = await api("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: null });
    expect(unpinned.status).toBe(200);
    expect(unpinned.body.bot).not.toHaveProperty("pinnedMessageId");

    const room = (await api("POST", "/api/groups", { name: "Pins", memberIds: [bot.id] })).body.group;
    const roomPin = await api("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: "msg-room_1" });
    expect(roomPin.status).toBe(200);
    expect(roomPin.body.group).toMatchObject({ pinnedMessageId: "msg-room_1" });
    const roomRepin = await api("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: "msg-room_2" });
    expect(roomRepin.body.group).toMatchObject({ pinnedMessageId: "msg-room_2" });
    expect((await api("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: "not an id!" })).status).toBe(400);
    expect((await api("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: 42 })).status).toBe(400);
    const roomCleared = await api("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: "" });
    expect(roomCleared.status).toBe(200);
    expect(roomCleared.body.group).not.toHaveProperty("pinnedMessageId");

    // deleted conversations drop out of search rather than 404ing it
    await api("DELETE", `/api/bots/${bot.id}`);
    const after = await api("GET", "/api/search?q=nice%20to%20meet");
    expect(after.body.hits.find((h: { botId?: string }) => h.botId === bot.id)).toBeUndefined();
  });

  it("stores a room reply as a flat reference and rejects foreign targets", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const foreign = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Reply room", memberIds: [bot.id] })).body.group;
    try {
      await api("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" });
      await api("PATCH", `/api/groups/${room.id}`, { defaultResponder: { kind: "mentions" } });
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "First thought" })).status).toBe(202);
      let current = (await api("GET", "/api/bots?messages=20")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      const original = current.messages.at(-1);
      expect((await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Following up",
        replyToId: original.id,
      })).status).toBe(202);
      current = (await api("GET", "/api/bots?messages=20")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      expect(current.messages.at(-1)).toMatchObject({ text: "Following up", replyToId: original.id });
      expect((await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Wrong conversation",
        replyToId: foreign.messages[0].id,
      })).status).toBe(404);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
      await api("DELETE", `/api/bots/${foreign.id}`);
    }
  });

  it("creates, patches, and deletes a bot", async () => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const bot = created.body.bot;

    const patched = await api("PATCH", `/api/bots/${bot.id}`, { name: "Renamed", pinned: true });
    expect(patched.status).toBe(200);
    expect(patched.body.bot).toMatchObject({ name: "Renamed", pinned: true });

    const missing = await api("PATCH", "/api/bots/does-not-exist", { name: "x" });
    expect(missing.status).toBe(404);

    // persona fields are bounded at the write boundary — they reach system
    // prompts (Chief roster, room rosters), so an unbounded PATCH is a
    // token-burn and prompt-injection surface
    expect((await api("PATCH", `/api/bots/${bot.id}`, { name: "N".repeat(101) })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { name: "   " })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { title: "T".repeat(201) })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { description: "D".repeat(4001) })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { description: 7 })).status).toBe(400);

    // the per-bot composio gate is a boolean, and it round-trips
    expect((await api("PATCH", `/api/bots/${bot.id}`, { composio: "yes" })).status).toBe(400);
    const gated = await api("PATCH", `/api/bots/${bot.id}`, { composio: false });
    expect(gated.status).toBe(200);

    // sidebar sections: assign, round-trip, trim, clear — and the field
    // drops off the record entirely once cleared rather than lingering
    // as an empty string through exports and wire frames
    const sectioned = await api("PATCH", `/api/bots/${bot.id}`, { section: "  Research  " });
    expect(sectioned.status).toBe(200);
    expect(sectioned.body.bot).toMatchObject({ section: "Research" });
    expect((await api("PATCH", `/api/bots/${bot.id}`, { section: 7 })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { section: "S".repeat(61) })).status).toBe(400);
    const cleared = await api("PATCH", `/api/bots/${bot.id}`, { section: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.bot).not.toHaveProperty("section");
    const clearedEmpty = await api("PATCH", `/api/bots/${bot.id}`, { section: "   " });
    expect(clearedEmpty.status).toBe(200);
    expect(clearedEmpty.body.bot).not.toHaveProperty("section");

    // Channels can be born inside a Work/Personal/project context, and can
    // later move through the same context contract as bots.
    const createdInContext = await api("POST", "/api/groups", {
      name: "Filed",
      memberIds: [bot.id, bot.id],
      section: "  Work  ",
    });
    expect(createdInContext.status).toBe(201);
    expect(createdInContext.body.group).toMatchObject({ section: "Work", memberIds: [bot.id] });
    expect((await api("POST", "/api/groups", { name: 7, memberIds: [bot.id] })).status).toBe(400);
    expect((await api("POST", "/api/groups", { name: "N".repeat(101), memberIds: [bot.id] })).status).toBe(400);
    expect((await api("POST", "/api/groups", { name: "Bad context", memberIds: [bot.id], section: 7 })).status).toBe(400);
    expect((await api("POST", "/api/groups", { name: "Long context", memberIds: [bot.id], section: "S".repeat(61) })).status).toBe(400);
    const sectionRoom = createdInContext.body.group;
    const roomSectioned = await api("PATCH", `/api/groups/${sectionRoom.id}`, { section: "  Clients  " });
    expect(roomSectioned.status).toBe(200);
    expect(roomSectioned.body.group).toMatchObject({ section: "Clients" });
    expect((await api("PATCH", `/api/groups/${sectionRoom.id}`, { section: 7 })).status).toBe(400);
    expect((await api("PATCH", `/api/groups/${sectionRoom.id}`, { section: "S".repeat(61) })).status).toBe(400);
    const roomSectionCleared = await api("PATCH", `/api/groups/${sectionRoom.id}`, { section: null });
    expect(roomSectionCleared.status).toBe(200);
    expect(roomSectionCleared.body.group).not.toHaveProperty("section");
    const roomSectionEmpty = await api("PATCH", `/api/groups/${sectionRoom.id}`, { section: "   " });
    expect(roomSectionEmpty.status).toBe(200);
    expect(roomSectionEmpty.body.group).not.toHaveProperty("section");
    expect((await api("DELETE", `/api/groups/${sectionRoom.id}`)).status).toBe(200);
    expect(gated.body.bot.composio).toBe(false);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { composio: true })).body.bot.composio).toBe(true);

    const deleted = await api("DELETE", `/api/bots/${bot.id}`);
    expect(deleted.status).toBe(200);
    const after = await api("GET", "/api/bots");
    expect(after.body.bots.find((b: { id: string }) => b.id === bot.id)).toBeUndefined();
  });

  it("elects one Chief of Staff per section and preserves other section Chiefs", async () => {
    const workA = (await api("POST", "/api/bots")).body.bot;
    const workB = (await api("POST", "/api/bots")).body.bot;
    const personal = (await api("POST", "/api/bots")).body.bot;
    try {
      await api("PATCH", `/api/bots/${workA.id}`, { section: "Work", chiefOfStaff: true });
      await api("PATCH", `/api/bots/${workB.id}`, { section: "Work" });
      await api("PATCH", `/api/bots/${personal.id}`, { section: "Personal", chiefOfStaff: true });

      let bots = (await api("GET", "/api/bots")).body.bots;
      expect(bots.find((bot: { id: string }) => bot.id === workA.id).chiefOfStaff).toBe(true);
      expect(bots.find((bot: { id: string }) => bot.id === personal.id).chiefOfStaff).toBe(true);

      await api("PATCH", `/api/bots/${workB.id}`, { chiefOfStaff: true });
      bots = (await api("GET", "/api/bots")).body.bots;
      expect(bots.find((bot: { id: string }) => bot.id === workA.id).chiefOfStaff).toBe(false);
      expect(bots.find((bot: { id: string }) => bot.id === workB.id).chiefOfStaff).toBe(true);
      expect(bots.find((bot: { id: string }) => bot.id === personal.id).chiefOfStaff).toBe(true);

      // Moving a Chief keeps its role and hands off only in the destination.
      await api("PATCH", `/api/bots/${workB.id}`, { section: "Personal" });
      bots = (await api("GET", "/api/bots")).body.bots;
      expect(bots.find((bot: { id: string }) => bot.id === workB.id).chiefOfStaff).toBe(true);
      expect(bots.find((bot: { id: string }) => bot.id === personal.id).chiefOfStaff).toBe(false);
    } finally {
      for (const bot of [workA, workB, personal]) await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("files a sidebar section atomically, trims and dedupes, and preserves its Chief", async () => {
    const incumbent = (await api("POST", "/api/bots")).body.bot;
    const incoming = (await api("POST", "/api/bots")).body.bot;
    const teammate = (await api("POST", "/api/bots")).body.bot;
    try {
      await api("PATCH", `/api/bots/${incumbent.id}`, { section: "Launch", chiefOfStaff: true });
      await api("PATCH", `/api/bots/${incoming.id}`, { section: "Research" });
      await api("PATCH", `/api/bots/${teammate.id}`, { section: "Personal" });

      const stream = await openSse(`${BASE}/api/events`);
      try {
        await stream.until((frame) => frame.kind === "hello");
        const created = await api("POST", "/api/sidebar-sections", {
          name: "  Launch  ",
          botIds: [incoming.id, teammate.id, incoming.id],
        });
        expect(created.status).toBe(200);
        expect(created.body.section).toBe("Launch");
        expect(created.body.bots.map((bot: { id: string }) => bot.id)).toEqual([
          incoming.id,
          teammate.id,
        ]);
        expect(created.body.bots.find((bot: { id: string }) => bot.id === incoming.id))
          .toMatchObject({ section: "Launch" });
        expect(Boolean(created.body.bots.find((bot: { id: string }) => bot.id === incoming.id)?.chiefOfStaff))
          .toBe(false);

        for (const id of [incoming.id, teammate.id]) {
          const frame = await stream.until(
            (candidate) => candidate.kind === "bot" && candidate.bot?.id === id,
          );
          expect(frame.bot.section).toBe("Launch");
        }

        const bots = (await api("GET", "/api/bots")).body.bots;
        expect(bots.find((bot: { id: string }) => bot.id === incumbent.id))
          .toMatchObject({ section: "Launch", chiefOfStaff: true });
      } finally {
        stream.close();
      }
    } finally {
      for (const bot of [incumbent, incoming, teammate]) await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("rejects a sidebar section Chief collision without changing any bot", async () => {
    const incumbent = (await api("POST", "/api/bots")).body.bot;
    const incoming = (await api("POST", "/api/bots")).body.bot;
    const teammate = (await api("POST", "/api/bots")).body.bot;
    try {
      await api("PATCH", `/api/bots/${incumbent.id}`, { section: "Launch", chiefOfStaff: true });
      await api("PATCH", `/api/bots/${incoming.id}`, { section: "Research", chiefOfStaff: true });
      await api("PATCH", `/api/bots/${teammate.id}`, { section: "Personal" });

      const response = await api("POST", "/api/sidebar-sections", {
        name: "Launch",
        botIds: [incoming.id, teammate.id],
      });
      expect(response).toEqual({
        status: 409,
        body: {
          error: "A section can have only one Chief of Staff. Choose one Chief or use a section without one.",
        },
      });

      const bots = (await api("GET", "/api/bots")).body.bots;
      expect(bots.find((bot: { id: string }) => bot.id === incumbent.id))
        .toMatchObject({ section: "Launch", chiefOfStaff: true });
      expect(bots.find((bot: { id: string }) => bot.id === incoming.id))
        .toMatchObject({ section: "Research", chiefOfStaff: true });
      expect(bots.find((bot: { id: string }) => bot.id === teammate.id))
        .toMatchObject({ section: "Personal" });
      expect(Boolean(bots.find((bot: { id: string }) => bot.id === teammate.id)?.chiefOfStaff))
        .toBe(false);
    } finally {
      for (const bot of [incumbent, incoming, teammate]) await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("rejects malformed or unavailable sidebar section targets without partially filing bots", async () => {
    const visible = (await api("POST", "/api/bots")).body.bot;
    const hidden = (await api("POST", "/api/bots")).body.bot;
    try {
      await api("PATCH", `/api/bots/${visible.id}`, { section: "Original" });
      await api("PATCH", `/api/bots/${hidden.id}`, { hidden: true, chiefOfStaff: false });

      for (const body of [
        { name: "   ", botIds: [visible.id] },
        { name: "S".repeat(61), botIds: [visible.id] },
        { name: "Work", botIds: [] },
        { name: "Work", botIds: ["not/an/id"] },
        { name: "Work", botIds: [visible.id], extra: true },
      ]) {
        expect((await api("POST", "/api/sidebar-sections", body)).status).toBe(400);
      }
      expect((await api("POST", "/api/sidebar-sections", {
        name: "Work",
        botIds: [visible.id, "missing"],
      })).status).toBe(404);
      expect((await api("POST", "/api/sidebar-sections", {
        name: "Work",
        botIds: [visible.id, hidden.id],
      })).status).toBe(404);

      const bots = (await api("GET", "/api/bots")).body.bots;
      expect(bots.find((bot: { id: string }) => bot.id === visible.id)?.section).toBe("Original");
    } finally {
      await api("DELETE", `/api/bots/${visible.id}`);
      await api("DELETE", `/api/bots/${hidden.id}`);
    }
  });

  it("explains when archived room members cannot respond", async () => {
    const archived = (await api("POST", "/api/bots")).body.bot;
    const active = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Archived member feedback",
      memberIds: [archived.id, active.id],
    })).body.group;

    try {
      expect((await api("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" })).status).toBe(200);
      const archivedBot = await api("PATCH", `/api/bots/${archived.id}`, {
        name: "Quill",
        hidden: true,
        chiefOfStaff: false,
      });
      expect(archivedBot.status).toBe(200);
      await api("PATCH", `/api/bots/${active.id}`, {
        name: "Atlas",
        modelSelection: { instanceId: "ghost", model: "ghost-1" },
      });
      await api("PATCH", `/api/groups/${room.id}`, { defaultResponder: { kind: "mentions" } });

      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "@Quill take this" })).status).toBe(202);
      let state = (await api("GET", "/api/bots?messages=20")).body;
      let messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
      expect(messages.at(-1)).toMatchObject({
        kind: "activity",
        tool: {
          name: "Quill is archived and can't respond — restore it or mention an active room member.",
          ok: false,
        },
      });

      const archivedError = "Quill is archived and can't respond — restore it or mention an active room member.";
      const beforeMixedMention = messages.filter((message: { tool?: { name?: string } }) =>
        message.tool?.name === archivedError
      ).length;
      await api("POST", `/api/groups/${room.id}/messages`, { text: "@Quill and @Atlas take this" });
      await expect.poll(async () => {
        state = (await api("GET", "/api/bots?messages=20")).body;
        messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
        return {
          archivedErrors: messages.filter((message: { tool?: { name?: string } }) =>
            message.tool?.name === archivedError
          ).length,
          activeDispatched: messages.some((message: { tool?: { name?: string } }) =>
            message.tool?.name === "error: Atlas's model is unavailable"
          ),
        };
      }).toEqual({ archivedErrors: beforeMixedMention + 1, activeDispatched: true });

      await api("PATCH", `/api/groups/${room.id}`, {
        defaultResponder: { kind: "member", botId: archived.id },
      });
      await api("POST", `/api/groups/${room.id}/messages`, { text: "use the default responder" });
      state = (await api("GET", "/api/bots?messages=20")).body;
      messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
      expect(messages.at(-1)?.tool).toEqual({ name: archivedError, ok: false });

      await api("PATCH", `/api/groups/${room.id}`, { defaultResponder: { kind: "mentions" } });

      const beforeUnmentioned = messages.length;
      await api("POST", `/api/groups/${room.id}/messages`, { text: "no mention" });
      state = (await api("GET", "/api/bots?messages=20")).body;
      messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
      expect(messages).toHaveLength(beforeUnmentioned + 1);
      expect(messages.at(-1)).toMatchObject({ kind: "text", role: "user", text: "no mention" });

      await api("PATCH", `/api/bots/${active.id}`, { hidden: true });
      await api("POST", `/api/groups/${room.id}/messages`, { text: "hello everyone" });
      state = (await api("GET", "/api/bots?messages=20")).body;
      messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
      expect(messages.at(-1)).toMatchObject({
        kind: "activity",
        tool: {
          name: "No active room members can respond — restore an archived bot or add an active member.",
          ok: false,
        },
      });
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${archived.id}`);
      await api("DELETE", `/api/bots/${active.id}`);
    }
  });

  it("saves, serves, and guards image attachments", async () => {
    // a real 1x1 PNG so the bytes round-trip intact
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    const wrongType = await fetch(`${BASE}/api/attachments`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not an image",
    });
    expect(wrongType.status).toBe(400);

    const saved = await fetch(`${BASE}/api/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(png),
    });
    expect(saved.status).toBe(201);
    const { path: savedPath, mime, bytes } = (await saved.json()) as { path: string; mime: string; bytes: number };
    expect(mime).toBe("image/png");
    expect(bytes).toBe(png.byteLength);
    expect(savedPath).toContain("attachments");

    const name = savedPath.split(/[\\/]/).pop();
    const served = await fetch(`${BASE}/api/attachments/${name}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);

    // the serving route is name-locked to the attachments dir
    const traversal = await fetch(`${BASE}/api/attachments/..%2F..%2Fconfig.json`);
    expect(traversal.status).toBe(404);
    const unknown = await fetch(`${BASE}/api/attachments/00000000-0000-0000-0000-000000000000.png`);
    expect(unknown.status).toBe(404);

    const tooBig = await fetch(`${BASE}/api/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: Buffer.alloc(IMAGE_MAX_BYTES + 1),
    });
    expect(tooBig.status).toBe(413);

    const uploadId = "11111111-1111-4111-8111-111111111111";
    const idempotent = await fetch(`${BASE}/api/attachments?uploadId=${uploadId}`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(png),
    });
    expect(idempotent.status).toBe(201);
    const idempotentResult = (await idempotent.json()) as { path: string };
    const retry = await fetch(`${BASE}/api/attachments?uploadId=${uploadId}`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(png),
    });
    expect(retry.status).toBe(201);
    expect((await retry.json() as { path: string }).path).toBe(idempotentResult.path);

    const conflictingRetry = await fetch(`${BASE}/api/attachments?uploadId=${uploadId}`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(conflictingRetry.status).toBe(409);

    const malformedId = await fetch(`${BASE}/api/attachments?uploadId=..%2Fescape`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(png),
    });
    expect(malformedId.status).toBe(400);
  });

  it("streams shared documents safely into the local attachments directory", async () => {
    const contents = Buffer.from("name,score\nAda,10\n");
    const saved = await fetch(`${BASE}/api/files?name=${encodeURIComponent("scores.exe")}`, {
      method: "POST",
      headers: { "content-type": "text/csv; charset=utf-8" },
      body: contents,
    });
    expect(saved.status).toBe(201);
    const result = (await saved.json()) as { path: string; name: string; mime: string; bytes: number };
    expect(result).toMatchObject({ name: "scores.csv", mime: "text/csv", bytes: contents.byteLength });
    expect(result.path).toMatch(/[\\/]attachments[\\/][0-9a-f-]+\.csv$/);
    expect(readFileSync(result.path).equals(contents)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(dirname(result.path)).mode & 0o777).toBe(0o700);
      expect(statSync(result.path).mode & 0o777).toBe(0o600);
    }

    const unsupported = await fetch(`${BASE}/api/files?name=payload.zip`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: Buffer.from("archive"),
    });
    expect(unsupported.status).toBe(400);

    const missingName = await fetch(`${BASE}/api/files`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: Buffer.from("hello"),
    });
    expect(missingName.status).toBe(400);

    for (const name of ["..%2F..%2Fsecret.txt", "..%5C..%5Csecret.txt", "..%252F..%252Fsecret.txt"]) {
      const traversal = await fetch(`${BASE}/api/files?name=${name}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: Buffer.from("hello"),
      });
      expect(traversal.status, name).toBe(400);
    }

    const empty = await fetch(`${BASE}/api/files?name=empty.pdf`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: Buffer.alloc(0),
    });
    expect(empty.status).toBe(400);

    const tooBig = await fetch(`${BASE}/api/files?name=large.pdf`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: Buffer.alloc(FILE_MAX_BYTES + 1),
    });
    expect(tooBig.status).toBe(413);

    const uploadId = "22222222-2222-4222-8222-222222222222";
    const first = await fetch(`${BASE}/api/files?name=notes.txt&uploadId=${uploadId}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: Buffer.from("retry-safe"),
    });
    expect(first.status).toBe(201);
    const firstResult = (await first.json()) as { path: string };
    const retry = await fetch(`${BASE}/api/files?name=notes.txt&uploadId=${uploadId}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: Buffer.from("retry-safe"),
    });
    expect(retry.status).toBe(201);
    expect((await retry.json() as { path: string }).path).toBe(firstResult.path);

    const conflictingRetry = await fetch(`${BASE}/api/files?name=notes.txt&uploadId=${uploadId}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: Buffer.from("different"),
    });
    expect(conflictingRetry.status).toBe(409);

    const malformedId = await fetch(`${BASE}/api/files?name=notes.txt&uploadId=not-a-uuid`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: Buffer.from("hello"),
    });
    expect(malformedId.status).toBe(400);
  });

  it("persists only app-owned bot avatars and supported crop shapes", async () => {
    const created = await api("POST", "/api/bots");
    const bot = created.body.bot;
    const avatarUrl = await uploadAvatar("image/webp");

    const saved = await api("PATCH", `/api/bots/${bot.id}`, { avatarUrl, avatarCrop: "rounded" });
    expect(saved.status).toBe(200);
    expect(saved.body.bot).toMatchObject({ avatarUrl, avatarCrop: "rounded" });

    expect((await api("PATCH", `/api/bots/${bot.id}`, {
      avatarUrl: "https://tracker.example/avatar.png",
    })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, {
      avatarUrl: "/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp",
    })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { avatarCrop: "hexagon" })).status).toBe(400);

    const cleared = await api("PATCH", `/api/bots/${bot.id}`, { avatarUrl: null, avatarCrop: "mascot" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.bot.avatarUrl).toBeNull();
    expect(cleared.body.bot.avatarCrop).toBe("mascot");
  });

  it("limits paired profile writes to validated profile fields and broadcasts the result", async () => {
    const created = await api("POST", "/api/bots");
    const bot = created.body.bot;
    const avatarUrl = await uploadAvatar();
    const stream = await openSse(`${BASE}/api/events`);
    try {
      await stream.until((frame) => frame.kind === "hello");
      const saved = await api("PATCH", `/api/bots/${bot.id}/profile`, {
        name: "Paired Profile",
        title: "Mobile-safe agent",
        description: "Only profile data crosses this boundary.",
        notifications: false,
        avatarUrl,
        avatarCrop: "circle",
        voice: "voice_fixture",
        speakReplies: true,
      });
      expect(saved.status).toBe(200);
      expect(saved.body.bot).toMatchObject({
        name: "Paired Profile",
        title: "Mobile-safe agent",
        description: "Only profile data crosses this boundary.",
        notifications: false,
        avatarUrl,
        avatarCrop: "circle",
        voice: "voice_fixture",
        speakReplies: true,
      });
      const frame = await stream.until(
        (candidate) => candidate.kind === "bot" && candidate.bot?.id === bot.id,
      );
      expect(frame.bot).toMatchObject({ id: bot.id, avatarUrl, avatarCrop: "circle" });

      for (const invalid of [
        { color: "red" },
        { avatarUrl: "https://tracker.example/avatar.png" },
        { avatarUrl: "/api/attachments/123e4567-e89b-12d3-a456-426614174000.png" },
        { avatarCrop: "hexagon" },
        { name: 42 },
        { notifications: "yes" },
        { voice: null },
        { speakReplies: 1 },
      ]) {
        expect((await api("PATCH", `/api/bots/${bot.id}/profile`, invalid)).status).toBe(400);
      }

      const cleared = await api("PATCH", `/api/bots/${bot.id}/profile`, {
        avatarUrl: null,
        avatarCrop: "mascot",
        voice: "",
        speakReplies: false,
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body.bot).toMatchObject({
        avatarUrl: null,
        avatarCrop: "mascot",
        voice: "",
        speakReplies: false,
      });
    } finally {
      stream.close();
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("exports every visible bot and imports the team without creating a room", async () => {
    const first = (await api("POST", "/api/bots")).body.bot;
    const second = (await api("POST", "/api/bots")).body.bot;
    const hidden = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${first.id}`, {
      name: "Mira",
      title: "Project Lead",
      description: "Coordinates the crew",
      color: "purple",
      mascotExpression: "focused",
      autoApprove: true,
      alwaysAllow: ["Bash:git"],
    });
    await api("PATCH", `/api/bots/${second.id}`, {
      name: "Scout",
      title: "Researcher",
      description: "Finds evidence",
      color: "cyan",
    });
    await api("PATCH", `/api/bots/${hidden.id}`, { name: "Archived", hidden: true });

    const stateBefore = (await api("GET", "/api/bots")).body;
    const roomsBefore = stateBefore.groups.length;
    const visibleNames = stateBefore.bots
      .filter((bot: { hidden?: boolean }) => !bot.hidden)
      .map((bot: { name: string }) => bot.name);
    const exported = await api("POST", "/api/teams/export", { name: "Field Team" });
    expect(exported.status).toBe(200);
    expect(exported.body).toMatchObject({ format: "openmaus.team", version: 2, team: { name: "Field Team" } });
    expect(exported.body.team.members.map((member: { name: string }) => member.name)).toEqual(visibleNames);
    expect(exported.body.team.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "mira", name: "Mira", title: "Project Lead", appearance: { color: "purple", mascotExpression: "focused" } }),
      expect.objectContaining({ key: "scout", name: "Scout", title: "Researcher", appearance: { color: "cyan" } }),
    ]));
    expect(exported.body.team).not.toHaveProperty("room");
    expect(JSON.stringify(exported.body)).not.toMatch(/Archived|autoApprove|alwaysAllow|modelSelection|threadId/);
    const markdownExport = await api("POST", "/api/teams/export", { name: "Field Team", format: "package" });
    expect(markdownExport.status).toBe(200);
    expect(markdownExport.body).toMatchObject({ name: "Field Team", members: visibleNames.length });
    expect(markdownExport.body.markdown).toContain("## Activation");
    expect(markdownExport.body.markdown).toContain("Give this file to your Chief of Staff");
    expect(markdownExport.body.markdown).not.toMatch(/Archived|autoApprove|alwaysAllow|modelSelection|threadId/);
    expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore);
    expect((await api("POST", "/api/teams/export", {})).body.team.name).toBe("My OpenMaus Team");

    const stream = await openSse(`${BASE}/api/events`);
    try {
      await stream.until((frame) => frame.kind === "hello");
      const imported = await api("POST", "/api/teams/import", exported.body);
      expect(imported.status).toBe(201);
      // the originals still exist, so every member arrives visibly numbered
      // rather than wearing a name that already resolves to another bot. The
      // starter name is intentionally random, so it can duplicate a member
      // name and advance that member to the next available suffix.
      const importedNames = imported.body.bots.map((bot: { name: string }) => bot.name);
      const namesBefore = new Set(stateBefore.bots.map((bot: { name: string }) => bot.name.toLowerCase()));
      expect(importedNames).toHaveLength(visibleNames.length);
      expect(new Set(importedNames.map((name: string) => name.toLowerCase())).size).toBe(importedNames.length);
      for (const [index, name] of importedNames.entries()) {
        const base = visibleNames[index]!;
        expect(name.startsWith(`${base} `)).toBe(true);
        expect(Number(name.slice(base.length + 1))).toBeGreaterThanOrEqual(2);
        expect(namesBefore.has(name.toLowerCase())).toBe(false);
      }
      expect(imported.body.bots.every((bot: { id: string }) => ![first.id, second.id].includes(bot.id))).toBe(true);
      expect(imported.body.bots[0]).not.toHaveProperty("alwaysAllow");
      // imported bots arrive quiet and without reach: no seeded greeting
      // in their name, and no access to the workspace's connected apps
      // until the user grants it per bot
      expect(imported.body.bots.every((bot: { messages: unknown[] }) => bot.messages.length === 0)).toBe(true);
      expect(imported.body.bots.every((bot: { composio?: boolean }) => bot.composio === false)).toBe(true);
      expect(imported.body).not.toHaveProperty("group");

      const lastImported = imported.body.bots.at(-1)!;
      await stream.until((frame) => frame.kind === "bot" && frame.bot?.id === lastImported.id);
      const importedBotIds = new Set(imported.body.bots.map((bot: { id: string }) => bot.id));
      const importFrames = stream.frames.filter(
        (frame) => frame.kind === "bot" && importedBotIds.has(frame.bot?.id),
      );
      // every imported bot is announced to other windows. The store emits
      // on every write now, so a bot may produce more than one frame —
      // the invariant is coverage, not an exact count.
      for (const id of importedBotIds) expect(importFrames.some((frame) => frame.bot?.id === id)).toBe(true);
      expect(importFrames.every((frame) => frame.kind === "bot")).toBe(true);
      expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore);

      const invalid = await api("POST", "/api/teams/import", { ...exported.body, version: 3 });
      expect(invalid.status).toBe(400);
      expect((await api("POST", "/api/teams/import?mode=erase", exported.body)).status).toBe(400);

      const beforeReplace = (await api("GET", "/api/bots")).body.bots.filter(
        (bot: { hidden?: boolean }) => !bot.hidden,
      );
      const replaced = await api("POST", "/api/teams/import?mode=replace", exported.body);
      expect(replaced.status).toBe(201);
      expect(replaced.body.archived.map((bot: { id: string }) => bot.id).sort()).toEqual(
        beforeReplace.map((bot: { id: string }) => bot.id).sort(),
      );
      expect(replaced.body.archivedBots.every((bot: { hidden?: boolean }) => bot.hidden)).toBe(true);
      const afterReplace = (await api("GET", "/api/bots")).body.bots;
      expect(afterReplace.filter((bot: { hidden?: boolean }) => !bot.hidden).map((bot: { id: string }) => bot.id).sort()).toEqual(
        replaced.body.bots.map((bot: { id: string }) => bot.id).sort(),
      );
      expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore);

      // Put the shared test harness back exactly as it was before exercising
      // replace. This mirrors the UI's Undo action and preserves the seeded bot.
      for (const bot of replaced.body.bots) await api("DELETE", `/api/bots/${bot.id}`);
      for (const bot of replaced.body.archived.filter((item: { chiefOfStaff: boolean }) => !item.chiefOfStaff)) {
        await api("PATCH", `/api/bots/${bot.id}`, { hidden: false });
      }
      const previousChief = replaced.body.archived.find((bot: { chiefOfStaff: boolean }) => bot.chiefOfStaff);
      if (previousChief) await api("PATCH", `/api/bots/${previousChief.id}`, { hidden: false, chiefOfStaff: true });

      for (const bot of [first, second, hidden, ...imported.body.bots]) {
        expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
      }
    } finally {
      stream.close();
    }
  });

  it("imports a team as a project: one room, on a folder", async () => {
    // The manifest still describes only people. Room name and folder come
    // from the CALLER, so a manifest fetched from the library cannot create
    // structure in someone's workspace — the property v2 established by
    // dropping its `room` block.
    const seed = await api("POST", "/api/bots", { name: "Planner", title: "Lead", description: "Plans", color: "purple" });
    const exported = await api("POST", "/api/teams/export", { name: "Client XY" });
    expect(exported.body.team).not.toHaveProperty("room");

    const roomsBefore = (await api("GET", "/api/bots")).body.groups.length;
    const folder = mkdtempSync(join(tmpdir(), "omb-project-"));

    const stream = await openSse(`${BASE}/api/events`);
    try {
      await stream.until((frame) => frame.kind === "hello");

      // A folder that does not exist must not leave half a project behind.
      const bogus = await api("POST", `/api/teams/import?mode=project&cwd=${encodeURIComponent(join(folder, "nope"))}`, exported.body);
      expect(bogus.status).toBe(400);
      expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore);

      const created = await api("POST", `/api/teams/import?mode=project&cwd=${encodeURIComponent(folder)}`, exported.body);
      expect(created.status).toBe(201);
      expect(created.body.group).toMatchObject({ name: "Client XY", cwd: folder });
      // the room is made of exactly the bots this import created
      expect(created.body.group.memberIds.sort()).toEqual(created.body.bots.map((bot: { id: string }) => bot.id).sort());
      // the folder is the room's WISH; the store pins it on the first turn
      expect(created.body.group).not.toHaveProperty("pinnedCwd");
      expect((await api("GET", "/api/bots")).body.groups).toHaveLength(roomsBefore + 1);
      await stream.until((frame) => frame.kind === "group" && frame.group?.id === created.body.group.id);

      // an explicit name wins over the team name, and the folder is optional
      const named = await api("POST", "/api/teams/import?mode=project&room=Client%20XY%20-%20Ads", exported.body);
      expect(named.body.group).toMatchObject({ name: "Client XY - Ads" });
      expect(named.body.group.cwd).toBeUndefined();

      for (const room of [created.body.group, named.body.group]) {
        expect((await api("DELETE", `/api/groups/${room.id}`)).status).toBe(200);
      }
      for (const bot of [seed.body, ...created.body.bots, ...named.body.bots]) {
        await api("DELETE", `/api/bots/${bot.id}`);
      }
    } finally {
      stream.close();
    }
  });

  it("installs a complete bot package with a Chief, room, playbook, connector intent, and paused routine", async () => {
    const packageFile = {
      format: "openmaus.package",
      version: 1,
      package: {
        id: "signal-desk",
        release: "1.0.0",
        name: "Signal Desk",
        tagline: "Find and explain the signal.",
        summary: "A complete two-bot signal workflow.",
        category: "Research",
        author: { name: "OpenMausBot" },
        license: "MIT",
        outcomes: ["Produce a concise signal brief."],
        setupMinutes: 4,
        requirements: {
          apps: [{ slug: "reddit", label: "Reddit", reason: "Read approved communities." }],
          capabilities: ["computer"],
        },
        agents: [
          {
            key: "scout",
            name: "Package Scout",
            title: "Researcher",
            description: "Find evidence.",
            appearance: { color: "cyan" },
            playbooks: ["signal-check"],
            autoApprove: true,
          },
          {
            key: "editor",
            name: "Package Editor",
            title: "Editor",
            description: "Explain the result.",
            appearance: { color: "green" },
          },
        ],
        chiefOfStaff: "scout",
        rooms: [{
          key: "signals",
          name: "Signal Room",
          members: ["scout", "editor"],
          bulletin: "Separate direct evidence from inference.",
          defaultResponder: { kind: "agent", agent: "scout" },
        }],
        routines: [{
          key: "morning-signals",
          name: "Morning signals",
          agent: "scout",
          prompt: "Prepare the approved morning signal brief.",
          runOn: "maus",
          schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
          durationMinutes: 30,
          enabledAfterInstall: false,
        }],
        playbooks: [{
          key: "signal-check",
          name: "Signal Check",
          summary: "Verify a public signal.",
          triggers: ["signal brief"],
          instructions: "Keep the source URL and confidence.",
        }],
      },
    };

    const installed = await api("POST", "/api/teams/import", packageFile);
    expect(installed.status).toBe(201);
    expect(installed.body.bots).toHaveLength(2);
    expect(installed.body.groups).toHaveLength(1);
    expect(installed.body.routines).toHaveLength(1);

    const scout = installed.body.bots.find((bot: { name: string }) => bot.name.startsWith("Package Scout"));
    const editor = installed.body.bots.find((bot: { name: string }) => bot.name.startsWith("Package Editor"));
    expect(scout).toMatchObject({
      chiefOfStaff: true,
      composio: false,
      playbooks: [{ key: "signal-check", instructions: "Keep the source URL and confidence." }],
      installedPackage: {
        id: "signal-desk",
        release: "1.0.0",
        requiredApps: [{ slug: "reddit", label: "Reddit" }],
      },
    });
    expect(scout).not.toHaveProperty("autoApprove");
    expect(editor.playbooks).toBeUndefined();
    expect(scout.section).toBe(editor.section);
    expect(installed.body.groups[0]).toMatchObject({
      name: "Signal Room",
      memberIds: expect.arrayContaining([scout.id, editor.id]),
      defaultResponder: { kind: "member", botId: scout.id },
      bulletin: "Separate direct evidence from inference.",
      setupCompletedAt: expect.any(Number),
    });
    expect(installed.body.routines[0]).toMatchObject({
      name: "Morning signals",
      botId: scout.id,
      enabled: false,
      nextRunAt: null,
    });

    await api("DELETE", `/api/routines/${installed.body.routines[0].id}`);
    await api("DELETE", `/api/groups/${installed.body.groups[0].id}`);
    for (const bot of installed.body.bots) await api("DELETE", `/api/bots/${bot.id}`);
  });

  it("the scout reads a folder, proposes an importable team, and creates nothing until the human imports", async () => {
    const folder = mkdtempSync(join(tmpdir(), "omb-scout-"));
    writeFileSync(join(folder, "README.md"), "# Demo Shop\n\nA storefront demo.\n");
    writeFileSync(
      join(folder, "package.json"),
      JSON.stringify({ dependencies: { react: "^19" }, devDependencies: { vitest: "^3" } }),
    );

    const before = (await api("GET", "/api/bots")).body;

    expect((await api("GET", "/api/teams/scout")).status).toBe(400);
    expect((await api("GET", `/api/teams/scout?cwd=${encodeURIComponent(join(folder, "nope"))}`)).status).toBe(400);

    const scouted = await api("GET", `/api/teams/scout?cwd=${encodeURIComponent(folder)}`);
    expect(scouted.status).toBe(200);
    expect(scouted.body.profile).toMatchObject({ name: "Demo Shop", summary: "A storefront demo." });
    expect(scouted.body.profile.stacks).toContain("React");
    expect(scouted.body.suggestion.roomName).toBe("Demo Shop");
    const keys = scouted.body.suggestion.manifest.team.members.map((member: { key: string }) => member.key);
    expect(keys).toEqual(["lead", "frontend", "testing"]);
    expect(Object.keys(scouted.body.suggestion.reasons).sort()).toEqual(keys.slice().sort());

    // scouting is read-only: no bot and no room exists until the import
    const after = (await api("GET", "/api/bots")).body;
    expect(after.bots).toHaveLength(before.bots.length);
    expect(after.groups).toHaveLength(before.groups.length);

    // and the suggestion goes through the real importer verbatim
    const imported = await api(
      "POST",
      `/api/teams/import?mode=project&cwd=${encodeURIComponent(folder)}&room=${encodeURIComponent(scouted.body.suggestion.roomName)}`,
      scouted.body.suggestion.manifest,
    );
    expect(imported.status).toBe(201);
    expect(imported.body.group).toMatchObject({ name: "Demo Shop", cwd: folder });
    expect(imported.body.bots).toHaveLength(3);

    expect((await api("DELETE", `/api/groups/${imported.body.group.id}`)).status).toBe(200);
    for (const bot of imported.body.bots) await api("DELETE", `/api/bots/${bot.id}`);
    rmSync(folder, { recursive: true, force: true });
  });

  it("team import is additive-only: smuggled grants, claimed ids, and re-imports never touch existing records", async () => {
    // an armed bot: every privilege a malicious manifest could try to
    // capture is switched ON here, so any write-through shows up as a diff
    const trusted = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${trusted.id}`, {
      name: "Mira",
      title: "Project Lead",
      autoApprove: true,
      autoReview: "enforce",
      alwaysAllow: ["Bash:git"],
      approvePeerComms: true,
      chiefOfStaff: true,
      composio: true,
      computer: "off",
    });
    const groupsBefore = (await api("GET", "/api/bots")).body.groups.length;
    const room = (await api("POST", "/api/groups", { memberIds: [trusted.id], name: "War Room" })).body.group;

    const smuggled = {
      format: "openmaus.team",
      version: 2,
      team: {
        name: "Trap Team",
        members: [
          {
            key: "mira",
            name: "Mira",
            title: "Impostor",
            description: "claims to be the lead",
            appearance: { color: "red" },
            // none of these exist in the manifest format, but a hand-edited
            // file can still claim them — and they must go nowhere
            id: trusted.id,
            threadId: trusted.threadId,
            autoApprove: true,
            autoReview: "enforce",
            alwaysAllow: ["Bash"],
            chiefOfStaff: true,
            approvePeerComms: false,
            composio: true,
            computer: "local",
            cloudBackend: "vps",
            cwd: "/",
            hidden: false,
          },
        ],
      },
    };
    const first = await api("POST", "/api/teams/import", smuggled);
    expect(first.status).toBe(201);
    expect(first.body.bots).toHaveLength(1);
    const impostor = first.body.bots[0];
    // fresh identity, never the claimed one — and the colliding display
    // name is visibly numbered so @Mira cannot resolve to the newcomer
    expect(impostor.id).not.toBe(trusted.id);
    expect(impostor.threadId).not.toBe(trusted.threadId);
    expect(impostor.name).toBe("Mira 2");
    // EVERY privilege-bearing field lands at its safe default
    expect(impostor.autoApprove).toBeUndefined();
    expect(impostor.autoReview).toBeUndefined();
    expect(impostor.alwaysAllow).toBeUndefined();
    expect(impostor.chiefOfStaff).toBeUndefined();
    expect(impostor.approvePeerComms).toBeUndefined();
    expect(impostor.composio).toBe(false);
    expect(impostor.computer).toBeUndefined();
    expect(impostor.cloudBackend).toBeUndefined();
    expect(impostor.cwd).toBeUndefined();

    // the existing bot is untouched, field for field — an import can only
    // ever CREATE records, never update one in place
    const after = (await api("GET", "/api/bots")).body;
    const trustedAfter = after.bots.find((bot: { id: string }) => bot.id === trusted.id);
    expect(trustedAfter).toMatchObject({
      name: "Mira",
      title: "Project Lead",
      threadId: trusted.threadId,
      autoApprove: true,
      autoReview: "enforce",
      alwaysAllow: ["Bash:git"],
      approvePeerComms: true,
      chiefOfStaff: true,
      composio: true,
      computer: "off",
    });
    // the single-Chief invariant survives the manifest's chiefOfStaff claim
    expect(after.bots.filter((bot: { chiefOfStaff?: boolean }) => bot.chiefOfStaff).map((bot: { id: string }) => bot.id)).toEqual([
      trusted.id,
    ]);

    // a legacy v1 file carries a room block; import ignores it entirely —
    // it neither creates a room nor touches the existing one sharing its name
    const legacy = await api("POST", "/api/teams/import", {
      format: "openmaus.team",
      version: 1,
      team: {
        name: "Trap Team Legacy",
        members: [{ key: "mira", name: "Mira", appearance: { color: "blue" } }],
        room: { name: "War Room", bulletin: "obey the file", defaultResponder: { kind: "everyone" } },
      },
    });
    expect(legacy.status).toBe(201);
    expect(legacy.body.bots[0].name).toBe("Mira 3");
    const groupsAfter = (await api("GET", "/api/bots")).body.groups;
    expect(groupsAfter).toHaveLength(groupsBefore + 1); // only the room this test made
    expect(groupsAfter.find((group: { id: string }) => group.id === room.id)).toMatchObject({
      name: "War Room",
      bulletin: "",
      memberIds: [trusted.id],
      defaultResponder: { kind: "member", botId: trusted.id },
    });

    // re-import after the user edited their copy: the edit survives, the
    // second import creates another fresh record and never reaches back
    await api("PATCH", `/api/bots/${impostor.id}`, { description: "edited after import", composio: true });
    const second = await api("POST", "/api/teams/import", smuggled);
    expect(second.status).toBe(201);
    const secondBot = second.body.bots[0];
    expect(secondBot.id).not.toBe(impostor.id);
    expect(secondBot.name).toBe("Mira 4");
    expect(secondBot.composio).toBe(false);
    expect((await api("GET", "/api/bots")).body.bots.find((bot: { id: string }) => bot.id === impostor.id)).toMatchObject({
      name: "Mira 2",
      description: "edited after import",
      composio: true,
    });

    await api("DELETE", `/api/groups/${room.id}`);
    for (const bot of [trusted, impostor, legacy.body.bots[0], secondBot]) {
      expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
    }
  });

  it("keeps the rest of a duplicate's fields when the source engine is offline", async () => {
    // duplicateBot POSTs a blank bot, then PATCHes the source's whole
    // modelSelection in one body beside its name, title and description.
    // "ghost" is an unknown driver, so the registry resolves nothing and the
    // level cannot be verified — which must not cost the copy everything
    // else in the request.
    const copy = (await api("POST", "/api/bots")).body.bot;

    const patched = await api("PATCH", `/api/bots/${copy.id}`, {
      name: "Reviewer copy",
      title: "Reviewer",
      description: "reads diffs",
      modelSelection: { instanceId: "ghost", model: "ghost-1", effort: "xhigh" },
    });

    expect(patched.status).toBe(200);
    expect(patched.body.bot).toMatchObject({
      name: "Reviewer copy",
      title: "Reviewer",
      description: "reads diffs",
      modelSelection: { instanceId: "ghost", model: "ghost-1", effort: "xhigh" },
    });
  });

  it("rejects an unknown effort value even while the engine is offline", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const patched = await api("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { instanceId: "ghost", model: "ghost-1", effort: "turbo" },
    });

    expect(patched.status).toBe(400);
    expect(patched.body.error).toContain("not recognized");
  });

  it("creates a fully configured bot in one request and greets with its final name", async () => {
    const created = await api("POST", "/api/bots", {
      name: "  Pathfinder  ",
      title: "Researcher",
      description: "Maps the problem before acting.",
      section: "  Work  ",
      modelSelection: { instanceId: "  ghost  ", model: "  ghost-1  ", effort: "high" },
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    try {
      expect(bot).toMatchObject({
        name: "Pathfinder",
        title: "Researcher",
        description: "Maps the problem before acting.",
        section: "Work",
        modelSelection: { instanceId: "ghost", model: "ghost-1", effort: "high" },
      });
      expect(bot.messages[0].text).toContain("Pathfinder");
      expect(bot.messages[0].text).not.toContain("Maus");
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("opts MCP-style model writes into the current live catalog without narrowing general writes", async () => {
    const instances = (await api("GET", "/api/instances")).body.instances;
    const claude = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
    expect(claude.snapshot.state).toBe("available");
    const customModel = `${claude.models.default}-custom`;
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const general = await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: customModel },
      });
      expect(general.status).toBe(200);
      expect(general.body.bot.modelSelection.model).toBe(customModel);

      const strictPatch = await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: customModel },
        requireAvailableModel: true,
      });
      expect(strictPatch.status).toBe(400);
      expect(strictPatch.body.error).toMatch(/not offered/i);

      const beforeIds = (await api("GET", "/api/bots?messages=0")).body.bots.map(
        (candidate: { id: string }) => candidate.id,
      );
      const strictCreate = await api("POST", "/api/bots", {
        name: "Should not exist",
        modelSelection: { instanceId: "claude", model: customModel },
        requireAvailableModel: true,
      });
      expect(strictCreate.status).toBe(400);
      const afterIds = (await api("GET", "/api/bots?messages=0")).body.bots.map(
        (candidate: { id: string }) => candidate.id,
      );
      expect(afterIds).toEqual(beforeIds);

      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        requireAvailableModel: "yes",
      })).status).toBe(400);
      expect((await api("POST", "/api/bots", {
        name: "Missing selection",
        requireAvailableModel: true,
      })).status).toBe(400);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("rejects incomplete model selections instead of persisting a broken bot", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const missingModel = await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "ghost" },
      });
      expect(missingModel.status).toBe(400);
      expect(missingModel.body.error).toContain("modelSelection.model");

      const missingInstance = await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { model: "ghost-1" },
      });
      expect(missingInstance.status).toBe(400);
      expect(missingInstance.body.error).toContain("modelSelection.instanceId");

      const reread = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(reread.modelSelection).toEqual(bot.modelSelection);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses to switch a bot's active task while its turn is running", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const instances = (await api("GET", "/api/instances")).body.instances;
      const claude = instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
      expect(claude.snapshot.state).toBe("available");
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: claude.models.default },
      })).status).toBe(200);

      const originalTask = bot.threadId;
      const created = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Running task" });
      expect(created.status).toBe(201);
      const runningTask = created.body.task.threadId;
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "keep running" })).status).toBe(202);

      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return state?.busy;
      }).toBe(true);

      const blocked = await api("POST", `/api/bots/${bot.id}/tasks/${originalTask}`);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatch(/stop it before switching tasks/i);
      const current = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(current.threadId).toBe(runningTask);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses to interrupt a conversation after its active task changed", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Exact stop", memberIds: [bot.id] })).body.group;
    try {
      const wrongBot = await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: "old-task" });
      expect(wrongBot.status).toBe(409);
      const wrongRoom = await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: "old-task" });
      expect(wrongRoom.status).toBe(409);
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
      expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
      for (const route of [`/api/bots/${bot.id}/interrupt`, `/api/groups/${room.id}/interrupt`]) {
        const compatibleNull = await fetch(`${BASE}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "null",
        });
        expect(compatibleNull.status).toBe(200);
        const rejectedArray = await fetch(`${BASE}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "[]",
        });
        expect(rejectedArray.status).toBe(400);
      }
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("pins sends to the expected task and offers compact switch responses", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Pinned sends", memberIds: [bot.id] })).body.group;
    try {
      const wrongBot = await api("POST", `/api/bots/${bot.id}/messages`, {
        text: "Do not reroute me",
        threadId: "old-task",
      });
      expect(wrongBot.status).toBe(409);
      expect(wrongBot.body.error).toMatch(/switched tasks/i);

      const wrongRoom = await api("POST", `/api/groups/${room.id}/messages`, {
        text: "Do not reroute me",
        threadId: "old-task",
      });
      expect(wrongRoom.status).toBe(409);
      expect(wrongRoom.body.error).toMatch(/switched tasks/i);

      const botOriginal = bot.threadId;
      const botTask = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Second" });
      expect(botTask.status).toBe(201);
      const compactBot = await api("POST", `/api/bots/${bot.id}/tasks/${botOriginal}?messages=0`, {});
      expect(compactBot.status).toBe(200);
      expect(compactBot.body.bot.threadId).toBe(botOriginal);
      expect(compactBot.body.bot.tasks).toHaveLength(2);
      expect(compactBot.body.bot).not.toHaveProperty("messages");
      expect(compactBot.body.bot).not.toHaveProperty("activeLeafId");

      const roomOriginal = room.threadId;
      const roomTask = await api("POST", `/api/groups/${room.id}/tasks`, { title: "Second" });
      expect(roomTask.status).toBe(201);
      const compactRoom = await api("POST", `/api/groups/${room.id}/tasks/${roomOriginal}?messages=0`, {});
      expect(compactRoom.status).toBe(200);
      expect(compactRoom.body.group.threadId).toBe(roomOriginal);
      expect(compactRoom.body.group.tasks).toHaveLength(2);
      expect(compactRoom.body.group).not.toHaveProperty("messages");
      expect(compactRoom.body.group).not.toHaveProperty("activeLeafId");
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, {});
      await api("DELETE", `/api/groups/${room.id}`);
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("leaves a bot with no effort level untouched", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    expect(bot.modelSelection.effort).toBeUndefined();

    const renamed = await api("PATCH", `/api/bots/${bot.id}`, { name: "Plain" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.bot.modelSelection.effort).toBeUndefined();
  });

  // This fixture pins a single unknown driver, so no instance here ever
  // resolves: these cover the gate's pass-through and the store's replace
  // semantics, NOT the comparison against a live engine's declared list.
  // That branch has no coverage at this layer, and manufacturing a live
  // instance in this fixture would cost it its no-probe determinism.
  it("round-trips an effort level and clears it when the key is dropped", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const selection = { instanceId: "ghost", model: "ghost-1" };

    const set = await api("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { ...selection, effort: "high" },
    });
    expect(set.status).toBe(200);
    expect(set.body.bot.modelSelection.effort).toBe("high");

    const reread = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id);
    expect(reread.modelSelection.effort).toBe("high");

    // The panel's "Default" button spreads the selection with effort:
    // undefined, and JSON.stringify drops the key — so clearing reaches the
    // server as a modelSelection carrying no effort at all.
    const cleared = await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: selection });
    expect(cleared.status).toBe(200);

    const after = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id);
    expect(after.modelSelection).toEqual(selection);
    expect(after.modelSelection.effort).toBeUndefined();
  });

  it("grants Auto on this computer only through the warning acknowledgement", async () => {
    const created = await api("POST", "/api/bots");
    const bot = created.body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true })).body.bot.autoApprove).toBe(
      true,
    );

    // The important half: a blind PATCH — exactly what a bot curling the
    // loopback API from a tool call would send — must be refused. The
    // renderer's warning dialog is not a boundary; this 400 is.
    const blind = await api("PATCH", `/api/bots/${bot.id}`, { computer: "local" });
    expect(blind.status).toBe(400);
    const oneShot = await api("PATCH", `/api/bots/${bot.id}`, { computer: "local", autoApprove: true });
    expect(oneShot.status).toBe(400);
    const after = (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id);
    expect(after.computer).not.toBe("local");

    // The dialog's acknowledgement grants it, and the flag is not persisted.
    const local = await api("PATCH", `/api/bots/${bot.id}`, { computer: "local", acknowledgeLocalAuto: true });
    expect(local.status).toBe(200);
    expect(local.body.bot).toMatchObject({ computer: "local", autoApprove: true });
    expect(local.body.bot.acknowledgeLocalAuto).toBeUndefined();

    // Once granted, re-asserting auto and unrelated PATCHes need no re-ack.
    const enabled = await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.bot.autoApprove).toBe(true);

    // The other direction needs the warning too: local first, then auto.
    await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: false });
    const autoBlind = await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true });
    expect(autoBlind.status).toBe(400);
    const autoAcked = await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, acknowledgeLocalAuto: true });
    expect(autoAcked.status).toBe(200);

    // Leaving local ends the grant; coming back needs the warning again.
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off" });
    const back = await api("PATCH", `/api/bots/${bot.id}`, { computer: "local" });
    expect(back.status).toBe(400);
    await api("DELETE", `/api/bots/${bot.id}`);
  });

  it("stores only known approval-review modes", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    for (const autoReview of ["off", "shadow", "enforce"]) {
      const response = await api("PATCH", `/api/bots/${bot.id}`, { autoReview });
      expect(response.status).toBe(200);
      expect(response.body.bot.autoReview).toBe(autoReview);
    }
    expect((await api("PATCH", `/api/bots/${bot.id}`, { autoReview: "always" })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { autoReview: true })).status).toBe(400);
    await api("DELETE", `/api/bots/${bot.id}`);
  });

  it("offers an idempotent stop boundary for active local turns", async () => {
    const unsupported = await api("POST", "/api/local-computer/interrupt");
    expect(unsupported).toEqual({
      status: 415,
      body: { error: "content-type must be application/json" },
    });
    const stopped = await api("POST", "/api/local-computer/interrupt", {});
    expect(stopped).toEqual({ status: 200, body: { ok: true } });
  });

  it("persists an answered onboarding card", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const card = bot.messages.find((m: { kind: string }) => m.kind === "options");
    const res = await api("PATCH", `/api/bots/${bot.id}/cards/${card.id}`, { answered: card.card.options[0] });
    expect(res.status).toBe(200);
    expect(res.body.message.card.answered).toBe(card.card.options[0]);
  });

  it("validates approval decisions and reports a request that is no longer open", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];

    const invalid = await api("POST", `/api/bots/${bot.id}/respond`, {
      requestId: "gone",
      behavior: "approve-everything",
    });
    expect(invalid.status).toBe(400);

    const unavailable = await api("POST", `/api/bots/${bot.id}/respond`, {
      requestId: "gone",
      behavior: "allow",
    });
    expect(unavailable.status).toBe(200);
    expect(unavailable.body).toEqual({ ok: true, outcome: "unavailable" });

    const reread = (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    expect(reread.messages.at(-1).tool).toMatchObject({ ok: false });
    expect(reread.messages.at(-1).tool.name).toContain("request is no longer open");
  });

  it("answers a room approval whose turn is already over instead of stranding the room", async () => {
    // busyBotId lives in memory only, so a card that outlives its turn (or the
    // process) has no speaker. The room must still be answerable: a pending
    // approval takes over the composer, so a dead end locks the room for good.
    const answered = await api("POST", "/api/threads/test-stranded-room-thread/respond", {
      requestId: "stranded-request",
      behavior: "allow",
    });
    expect(answered.status).toBe(200);
    expect(answered.body).toEqual({ ok: true, outcome: "unavailable" });

    const room = (await api("GET", "/api/bots")).body.groups.find(
      (group: { id: string }) => group.id === "test-stranded-room",
    );
    const card = room.messages.find((message: { id: string }) => message.id === "stranded-card").card;
    expect(card.dismissed).toBe(true);
    expect(card.answered).toBe("unavailable");

    // a room with nothing pending still reports that plainly
    const nothing = await api("POST", "/api/threads/test-pinned-room-thread/respond", {
      requestId: "never-existed",
      behavior: "allow",
    });
    expect(nothing.status).toBe(404);
  });

  it("closes the approvals a cancelled turn can no longer answer", async () => {
    // "Cancel turn" is a button ON the approval card, and a pending approval
    // owns the composer. Stopping the turn without closing its card leaves the
    // room blocked by a question whose asker is already gone.
    const stopped = await api("POST", "/api/groups/test-cancel-room/interrupt");
    expect(stopped.status).toBe(200);

    const room = (await api("GET", "/api/bots")).body.groups.find(
      (group: { id: string }) => group.id === "test-cancel-room",
    );
    const card = room.messages.find((message: { id: string }) => message.id === "cancel-card").card;
    expect(card.dismissed).toBe(true);
    expect(card.answered).toBe("unavailable");
  });

  it("rejects an empty message and explains an unavailable provider", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];

    const empty = await api("POST", `/api/bots/${bot.id}/messages`, { text: "   " });
    expect(empty.status).toBe(400);

    // the seeded bot's selection points at the ghost instance — sending a
    // real message must fail loudly, not 202-and-hang
    const send = await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello?" });
    expect(send.status).toBe(409);
    expect(send.body.error).toContain("unavailable");
    // a failed send never landed a user message, so the first-run quiz stays
    const afterFail = (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    expect(afterFail.messages.find((m: { kind: string }) => m.kind === "options")?.card.dismissed).toBeFalsy();
  });

  it("refuses to fork a message when the provider is unavailable, without mutating", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const before = bot.messages.length;

    // greeting is a bot message — not editable
    const greeting = bot.messages.find((m: { role: string }) => m.role === "bot");
    const notUser = await api("POST", `/api/bots/${bot.id}/messages/${greeting.id}/edit`, { text: "x" });
    expect(notUser.status).toBe(404);

    // no user message exists yet, so fabricate the check via the card id
    const card = bot.messages.find((m: { kind: string }) => m.kind === "options");
    const res = await api("POST", `/api/bots/${bot.id}/messages/${card.id}/edit`, { text: "x" });
    expect(res.status).toBe(404); // options card, not a user text message

    const empty = await api("POST", `/api/bots/${bot.id}/messages/${greeting.id}/edit`, { text: "  " });
    expect(empty.status).toBe(400);

    const after = await api("GET", "/api/bots");
    expect(after.body.bots[0].messages.length).toBe(before);
  });

  it("switches the active branch and reports the new leaf", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    expect(bot.activeLeafId).toBe(bot.messages.at(-1).id);

    // pointing at the first message descends back to the newest leaf on
    // that (only) branch — a no-op switch, but it exercises the descent
    const res = await api("POST", `/api/bots/${bot.id}/active-branch`, { messageId: bot.messages[0].id });
    expect(res.status).toBe(200);
    expect(res.body.activeLeafId).toBe(bot.messages.at(-1).id);

    const missing = await api("POST", `/api/bots/${bot.id}/active-branch`, { messageId: "nope" });
    expect(missing.status).toBe(404);
  });

  it("refuses a box token the provider rejects, at the point of pasting", async () => {
    // the stub answers 401 for anything but the good token
    const bad = await api("PUT", "/api/config", { box: { token: "box_wrong" } });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/rejected/i);
    const after = await api("GET", "/api/config");
    expect(after.body.box).toEqual({ configured: false });
  });

  it("saves config keys write-only and reports booleans", async () => {
    const before = await api("GET", "/api/config");
    expect(before.body.box).toEqual({ configured: false });

    const put = await api("PUT", "/api/config", { box: { token: "box_good" } });
    expect(put.status).toBe(200);
    expect(put.body.box).toEqual({ configured: true });
    expect(JSON.stringify(put.body)).not.toContain("box_good");

    const after = await api("GET", "/api/config");
    expect(after.body.box).toEqual({ configured: true });
    expect(JSON.stringify(after.body)).not.toContain("box_good");

    const nothing = await api("PUT", "/api/config", {});
    expect(nothing.status).toBe(400);
  });

  it("round-trips the UI language and clears it back to system", async () => {
    const set = await api("PUT", "/api/config", { language: "de" });
    expect(set.status).toBe(200);
    expect(set.body.language).toBe("de");
    const after = await api("GET", "/api/config");
    expect(after.body.language).toBe("de");

    const cleared = await api("PUT", "/api/config", { language: "" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.language).toBe("");
  });

  it("keeps an active turn alive when the UI language changes", async () => {
    const bot = (await api("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    try {
      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "stay active" })).status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);

      const saved = await api("PATCH", "/api/config", { language: "de" });
      expect(saved.status).toBe(200);
      expect(saved.body.language).toBe("de");

      const active = (await api("GET", "/api/bots?messages=50")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(active?.busy).toBe(true);
      expect(active?.messages.some((message: { tool?: { name?: string } }) =>
        message.tool?.name?.includes("provider settings changed"),
      )).toBe(false);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBeFalsy();
      await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      await api("PATCH", "/api/config", { language: "" }).catch(() => undefined);
    }
  });

  it("validates and persists the global room turn timeout", async () => {
    const before = await api("GET", "/api/config");
    expect(before.status).toBe(200);
    expect(before.body.rooms).toEqual({ turnTimeoutMinutes: 5 });

    for (const turnTimeoutMinutes of [0, 1.5, 1441, "20", null]) {
      const invalid = await api("PUT", "/api/config", { rooms: { turnTimeoutMinutes } });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toContain("rooms.turnTimeoutMinutes");
    }

    const saved = await api("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 20 } });
    expect(saved.status).toBe(200);
    expect(saved.body.rooms).toEqual({ turnTimeoutMinutes: 20 });

    const after = await api("GET", "/api/config");
    expect(after.body.rooms).toEqual({ turnTimeoutMinutes: 20 });

    const disk = JSON.parse(readFileSync(join(home, ".openmausbot", "config.json"), "utf8"));
    expect(disk.rooms).toEqual({ turnTimeoutMinutes: 20 });

    await api("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 5 } });
  });

  it("keeps Teach a skill off by default and persists an explicit opt-in", async () => {
    const before = await api("GET", "/api/config");
    expect(before.status).toBe(200);
    expect(before.body.features).toEqual({ browser: false, skillRecorder: false, showToolCalls: false });

    const saved = await api("PATCH", "/api/config", {
      features: { skillRecorder: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.features).toEqual({ browser: false, skillRecorder: true, showToolCalls: false });

    const disk = JSON.parse(readFileSync(join(home, ".openmausbot", "config.json"), "utf8"));
    expect(disk.features).toEqual({ skillRecorder: true });

    const tools = await api("PATCH", "/api/config", { features: { showToolCalls: true } });
    expect(tools.status).toBe(200);
    expect(tools.body.features).toEqual({ browser: false, skillRecorder: true, showToolCalls: true });

    await api("PATCH", "/api/config", { features: { skillRecorder: false, showToolCalls: false } });
  });

  it("refuses to delete a bot while it owns an active channel turn", async () => {
    const bot = (await api("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Deletion safety",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    })).body.group;
    try {
      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "keep working" })).status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);

      const deletion = await api("DELETE", `/api/bots/${bot.id}`);
      expect(deletion.status).toBe(409);
      expect(deletion.body.error).toMatch(/stop.*channel/i);
      expect((await api("GET", "/api/bots?messages=0")).body.bots.some(
        (candidate: { id: string }) => candidate.id === bot.id,
      )).toBe(true);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
      await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
    }
  });

  it("creates, edits, lists, and deletes scheduled multi-bot calls", async () => {
    const first = (await api("POST", "/api/bots", { name: "Call host" })).body.bot;
    const second = (await api("POST", "/api/bots", { name: "Call guest" })).body.bot;
    let callId = "";
    try {
      const invalidCreate = await api("POST", "/api/calendar-calls", {
        name: "",
        botIds: [],
        schedule: { type: "once", at: Date.now() + 60_000 },
      });
      expect(invalidCreate.status).toBe(400);

      const created = await api("POST", "/api/calendar-calls", {
        name: "Weekly bot sync",
        description: "Review priorities.",
        botIds: [first.id, second.id],
        schedule: { type: "once", at: Date.now() + 60_000 },
        durationMinutes: 30,
        attachments: [],
      });
      expect(created.status).toBe(201);
      callId = created.body.call.id;
      expect(created.body.call).toMatchObject({
        name: "Weekly bot sync",
        botIds: [first.id, second.id],
        durationMinutes: 30,
      });

      const edited = await api("PATCH", `/api/calendar-calls/${callId}`, {
        schedule: { type: "daily", time: "11:15", weekdays: [1, 2, 3, 4, 5] },
      });
      expect(edited.status).toBe(200);
      expect(edited.body.call.schedule).toEqual({ type: "daily", time: "11:15", weekdays: [1, 2, 3, 4, 5] });
      const invalidPatch = await api("PATCH", `/api/calendar-calls/${callId}`, { durationMinutes: 5 });
      expect(invalidPatch.status).toBe(400);
      expect((await api("GET", "/api/calendar-calls")).body.calls).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: callId, name: "Weekly bot sync" })]),
      );

      expect((await api("DELETE", `/api/calendar-calls/${callId}`)).status).toBe(200);
      callId = "";
      expect((await api("PATCH", "/api/calendar-calls/missing", { name: "Nope" })).status).toBe(404);
    } finally {
      if (callId) await api("DELETE", `/api/calendar-calls/${callId}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${first.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${second.id}`).catch(() => undefined);
    }
  });

  it("opens one calendar room and posts the scheduled seed to everyone", async () => {
    const modelSelection = { instanceId: "ghost", model: "ghost-1" };
    const first = (await api("POST", "/api/bots", { name: "Calendar researcher", modelSelection })).body.bot;
    const second = (await api("POST", "/api/bots", { name: "Calendar writer", modelSelection })).body.bot;
    let callId = "";
    let roomId = "";
    try {
      const created = await api("POST", "/api/calendar-calls", {
        name: "Launch room",
        description: "Review the launch plan.",
        botIds: [first.id, second.id],
        schedule: { type: "once", at: Date.now() - 100 },
        durationMinutes: 30,
        attachments: [{
          id: "launch-brief",
          name: "Launch brief.txt",
          path: "/tmp/a\"&<>.txt",
          size: 12,
          kind: "file",
        }],
      });
      expect(created.status).toBe(201);
      callId = created.body.call.id;

      await expect.poll(async () => {
        const snapshot = await api("GET", "/api/bots?messages=50");
        const room = snapshot.body.groups.find((candidate: { memberIds: string[] }) =>
          candidate.memberIds.length === 2 &&
          candidate.memberIds.includes(first.id) &&
          candidate.memberIds.includes(second.id)
        );
        return room?.messages.find((message: { sendId?: string }) =>
          message.sendId?.startsWith(`calendar_${callId}_`)
        )?.text;
      }, { timeout: 5_000 }).toBe(
        '@everyone Review the launch plan.\n\n<attached-file path="/tmp/a&quot;&amp;&lt;&gt;.txt" />',
      );

      const snapshot = await api("GET", "/api/bots?messages=50");
      const room = snapshot.body.groups.find((candidate: { memberIds: string[] }) =>
        candidate.memberIds.length === 2 &&
        candidate.memberIds.includes(first.id) &&
        candidate.memberIds.includes(second.id)
      );
      expect(room).toMatchObject({ defaultResponder: { kind: "everyone" } });
      roomId = room.id;

      await expect.poll(async () => {
        const refreshed = await api("GET", "/api/bots?messages=50");
        const current = refreshed.body.groups.find((candidate: { id: string }) => candidate.id === roomId);
        return current?.messages
          .filter((message: { from?: { botId?: string } }) => message.from?.botId)
          .map((message: { from: { botId: string } }) => message.from.botId)
          .sort();
      }, { timeout: 5_000 }).toEqual([first.id, second.id].sort());

      const joined = await api("POST", `/api/calendar-calls/${callId}/room`, {});
      expect(joined.status).toBe(200);
      expect(joined.body.group.id).toBe(roomId);
      expect(room.messages.filter((message: { sendId?: string }) =>
        message.sendId?.startsWith(`calendar_${callId}_`)
      )).toHaveLength(1);
    } finally {
      if (callId) await api("DELETE", `/api/calendar-calls/${callId}`).catch(() => undefined);
      if (roomId) {
        await api("POST", `/api/groups/${roomId}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/groups/${roomId}`).catch(() => undefined);
      }
      await api("DELETE", `/api/bots/${first.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${second.id}`).catch(() => undefined);
    }
  });

  it("refuses to delete a bot while one of its routines is active", async () => {
    const bot = (await api("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    const routine = (await api("POST", "/api/routines", {
      name: "Deletion safety routine",
      prompt: "Keep running until interrupted.",
      botId: bot.id,
      runOn: "maus",
      enabled: false,
      schedule: { type: "daily", time: "10:00", weekdays: [1] },
    })).body.routine;
    let runId = "";
    try {
      rmSync(fakeClaudeDump, { force: true });
      const queued = await api("POST", `/api/routines/${routine.id}/run`);
      expect(queued.status).toBe(201);
      runId = queued.body.run.id;
      await expect.poll(async () => {
        const runs = (await api("GET", "/api/routines")).body.runs;
        return runs.find((run: { id: string }) => run.id === runId)?.status;
      }, { timeout: 5_000 }).toBe("running");

      const deletion = await api("DELETE", `/api/bots/${bot.id}`);
      expect(deletion.status).toBe(409);
      expect(deletion.body.error).toMatch(/active routine/i);
      expect((await api("GET", "/api/bots?messages=0")).body.bots.some(
        (candidate: { id: string }) => candidate.id === bot.id,
      )).toBe(true);
    } finally {
      if (runId) await api("POST", `/api/routine-runs/${runId}/cancel`).catch(() => undefined);
      await api("DELETE", `/api/routines/${routine.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
    }
  });

  it("stops a local bot's exact channel and routine work through the emergency endpoint", async () => {
    const bot = (await api("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    // This is an emergency-routing test, not another platform CUA contract
    // test. Dispatch with computer access off so every CI host can run the
    // same hanging provider, then mark the bot local immediately before the
    // emergency action whose exact channel/routine targeting is under test.
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off" })).status).toBe(200);
    const room = (await api("POST", "/api/groups", {
      name: "Emergency stop room",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    })).body.group;
    let routineId = "";
    let runId = "";
    try {
      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "work in this channel" })).status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);
      expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "local" })).status).toBe(200);
      expect((await api("POST", "/api/local-computer/interrupt", {})).status).toBe(200);
      await expect.poll(async () => {
        const group = (await api("GET", "/api/bots?messages=0")).body.groups.find(
          (candidate: { id: string }) => candidate.id === room.id,
        );
        return group?.working;
      }, { timeout: 5_000 }).toBe(false);
      expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off" })).status).toBe(200);

      const routine = await api("POST", "/api/routines", {
        name: "Emergency stop routine",
        prompt: "Keep running until interrupted.",
        botId: bot.id,
        runOn: "maus",
        enabled: false,
        schedule: { type: "daily", time: "10:00", weekdays: [1] },
      });
      expect(routine.status).toBe(201);
      routineId = routine.body.routine.id;
      rmSync(fakeClaudeDump, { force: true });
      const queued = await api("POST", `/api/routines/${routineId}/run`);
      expect(queued.status).toBe(201);
      runId = queued.body.run.id;
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);
      await expect.poll(async () => {
        const runs = (await api("GET", "/api/routines")).body.runs;
        return runs.find((run: { id: string }) => run.id === runId)?.status;
      }, { timeout: 5_000 }).toBe("running");

      expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "local" })).status).toBe(200);
      expect((await api("POST", "/api/local-computer/interrupt", {})).status).toBe(200);
      await expect.poll(async () => {
        const runs = (await api("GET", "/api/routines")).body.runs;
        return runs.find((run: { id: string }) => run.id === runId)?.status;
      }, { timeout: 5_000 }).toBe("cancelled");
    } finally {
      if (runId) await api("POST", `/api/routine-runs/${runId}/cancel`).catch(() => undefined);
      if (routineId) await api("DELETE", `/api/routines/${routineId}`).catch(() => undefined);
      await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
      await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
    }
  });

  it("mounts a scoped browser capability and the safety prompt in room turns", async () => {
    const descriptorFile = join(home, "browser-test-connection.json");
    const masterToken = "c".repeat(64);
    writeFileSync(descriptorFile, JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${boxStubPort}`,
      token: masterToken,
      pid: process.pid,
    }));
    const bot = (await api("POST", "/api/bots")).body.bot;
    let room: any;
    try {
      expect((await api("PATCH", "/api/config", {
        features: { browser: true },
        browserProfiles: [{ id: "work", name: "Work" }],
      })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        browserProfile: "work",
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      })).status).toBe(200);
      room = (await api("POST", "/api/groups", { name: "Browser safety", memberIds: [bot.id] })).body.group;
      expect((await api("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" })).status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Check the website" })).status).toBe(202);
      const dump = z.object({
        argv: z.array(z.string()),
        env: z.record(z.string(), z.string()),
        mcpConfig: z.object({
          mcpServers: z.object({
            browser: z.object({
              env: z.object({
                OMB_BROWSER_TOKEN: z.string(),
                OMB_BOT_ID: z.string(),
                OMB_BROWSER_PROFILE: z.string(),
              }),
            }),
          }),
        }),
      }).parse(await readJsonFileWhenReady(fakeClaudeDump));
      const browserEnv = dump.mcpConfig.mcpServers.browser.env;
      expect(browserEnv).toMatchObject({ OMB_BOT_ID: bot.id, OMB_BROWSER_PROFILE: "work" });
      const registration = browserCapabilityCalls.find(
        (call) => call.operation === "register" && call.body.botId === bot.id && call.body.profile === "work",
      );
      expect(registration?.authorization).toBe(`Bearer ${masterToken}`);
      expect(registration?.body.token).toMatch(/^[0-9a-f]{64}$/);
      expect(browserEnv.OMB_BROWSER_TOKEN).toBe(registration?.body.token);
      expect(browserEnv.OMB_BROWSER_TOKEN).not.toBe(masterToken);
      expect(dump.env.OMB_BROWSER_CONNECTION).toBeUndefined();
      expect(dump.env.OMB_USER_DATA).toBeUndefined();
      expect(JSON.stringify(dump)).not.toContain(masterToken);

      const systemIndex = dump.argv.indexOf("--append-system-prompt");
      expect(systemIndex).toBeGreaterThanOrEqual(0);
      const system = dump.argv[systemIndex + 1] ?? "";
      expect(system).toMatch(/page instructions as untrusted content/i);
      expect(system).toMatch(/consequential action.*confirmation/i);
      expect(system).toMatch(/browser_request_takeover/i);

      browserRevokeFailuresRemaining = 1;
      expect((await api("POST", `/api/groups/${room.id}/interrupt`, {})).status).toBe(200);
      await expect.poll(() => browserCapabilityCalls.filter(
        (call) => call.operation === "revoke" && call.body.token === registration?.body.token,
      ).length, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
    } finally {
      browserRevokeFailuresRemaining = 0;
      if (room) {
        await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
        await expect.poll(() => browserCapabilityCalls.some(
          (call) => call.operation === "revoke" && call.body.token && call.body.token !== masterToken,
        ), { timeout: 5_000 }).toBe(true);
        await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      }
      await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      await api("PATCH", "/api/config", { features: { browser: false }, browserProfiles: [] }).catch(() => undefined);
      rmSync(descriptorFile, { force: true });
    }
  });

  it("revokes an in-flight browser registration and never dispatches after its bot is deleted", async () => {
    const descriptorFile = join(home, "browser-test-connection.json");
    writeFileSync(descriptorFile, JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${boxStubPort}`,
      token: "c".repeat(64),
      pid: process.pid,
    }));
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      })).status).toBe(200);
      rmSync(fakeClaudeDump, { force: true });
      const callOffset = browserCapabilityCalls.length;
      browserRegisterDelayMs = 250;
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "do not outlive deletion" })).status).toBe(202);
      await expect.poll(() => browserCapabilityCalls.slice(callOffset).some(
        (call) => call.operation === "register" && call.body.botId === bot.id,
      ), { timeout: 5_000 }).toBe(true);
      const registration = browserCapabilityCalls.slice(callOffset).find(
        (call) => call.operation === "register" && call.body.botId === bot.id,
      );

      expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
      await expect.poll(() => browserCapabilityCalls.slice(callOffset).some(
        (call) => call.operation === "revoke" && call.body.token === registration?.body.token,
      ), { timeout: 5_000 }).toBe(true);
      // Registration is intentionally held by the stub. Wait beyond that
      // entire window so a late provider dispatch cannot escape the check.
      await new Promise((resolve) => setTimeout(resolve, browserRegisterDelayMs + 250));
      expect(existsSync(fakeClaudeDump)).toBe(false);
    } finally {
      browserRegisterDelayMs = 0;
      await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      await api("PATCH", "/api/config", { features: { browser: false } }).catch(() => undefined);
      rmSync(descriptorFile, { force: true });
    }
  });

  it("keeps a setup-cancelled bot owned until the provider handshake is retired", async () => {
    const descriptorFile = join(home, "browser-test-connection.json");
    writeFileSync(descriptorFile, JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${boxStubPort}`,
      token: "c".repeat(64),
      pid: process.pid,
    }));
    const bot = (await api("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    try {
      expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
      rmSync(fakeClaudeDump, { force: true });
      const callOffset = browserCapabilityCalls.length;
      browserRegisterDelayMs = 1_000;
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "first setup" })).status).toBe(202);
      await expect.poll(() => browserCapabilityCalls.slice(callOffset).some(
        (call) => call.operation === "register" && call.body.botId === bot.id,
      ), { timeout: 5_000 }).toBe(true);

      expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
      const afterStop = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(afterStop.busy).toBe(true);
      const replacementTooSoon = await api("POST", `/api/bots/${bot.id}/messages`, { text: "replacement" });
      expect(replacementTooSoon.status).toBe(202);
      expect(replacementTooSoon.body.queued).toBe(true);
      expect(existsSync(fakeClaudeDump)).toBe(false);

      expect(JSON.stringify(await readJsonFileWhenReady(fakeClaudeDump))).toContain("replacement");
    } finally {
      browserRegisterDelayMs = 0;
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
      await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      await api("PATCH", "/api/config", { features: { browser: false } }).catch(() => undefined);
      rmSync(descriptorFile, { force: true });
    }
  });

  it("does not dispatch a room turn stopped through its bot during browser registration", async () => {
    const descriptorFile = join(home, "browser-test-connection.json");
    writeFileSync(descriptorFile, JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${boxStubPort}`,
      token: "c".repeat(64),
      pid: process.pid,
    }));
    const bot = (await api("POST", "/api/bots")).body.bot;
    let room: any;
    try {
      expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      })).status).toBe(200);
      room = (await api("POST", "/api/groups", { name: "Browser stop race", memberIds: [bot.id] })).body.group;
      expect((await api("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" })).status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      const callOffset = browserCapabilityCalls.length;
      browserRegisterDelayMs = 250;
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "stop before launch" })).status).toBe(202);
      await expect.poll(() => browserCapabilityCalls.slice(callOffset).some(
        (call) => call.operation === "register" && call.body.botId === bot.id,
      ), { timeout: 5_000 }).toBe(true);
      const registration = browserCapabilityCalls.slice(callOffset).find(
        (call) => call.operation === "register" && call.body.botId === bot.id,
      );
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
      await expect.poll(() => browserCapabilityCalls.slice(callOffset).some(
        (call) => call.operation === "revoke" && call.body.token === registration?.body.token,
      ), { timeout: 5_000 }).toBe(true);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body;
        return {
          botBusy: state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy,
          roomBusyBotId: state.groups.find((candidate: { id: string }) => candidate.id === room.id)?.busyBotId,
        };
      }, { timeout: 5_000 }).toEqual({ botBusy: false, roomBusyBotId: null });
      expect(existsSync(fakeClaudeDump)).toBe(false);
    } finally {
      browserRegisterDelayMs = 0;
      if (room) {
        await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      }
      await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      await api("PATCH", "/api/config", { features: { browser: false } }).catch(() => undefined);
      rmSync(descriptorFile, { force: true });
    }
  });

  it("revokes active browser access when the global feature is disabled", async () => {
    const descriptorFile = join(home, "browser-test-connection.json");
    writeFileSync(descriptorFile, JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${boxStubPort}`,
      token: "c".repeat(64),
      pid: process.pid,
    }));
    const bot = (await api("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    })).body.bot;
    try {
      expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
      const callOffset = browserCapabilityCalls.length;
      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "browse until disabled" })).status).toBe(202);
      await expect.poll(() => browserCapabilityCalls.slice(callOffset).find(
        (call) => call.operation === "register" && call.body.botId === bot.id,
      ), { timeout: 5_000 }).toBeTruthy();

      const perBot = await api("PATCH", `/api/bots/${bot.id}`, { browser: false });
      expect(perBot.status).toBe(409);
      expect(perBot.body.error).toMatch(/stop.*turn/i);

      expect((await api("PATCH", "/api/config", { features: { browser: false } })).status).toBe(200);
      await expect.poll(() => browserCapabilityCalls.slice(callOffset).some(
        (call) => call.operation === "clear",
      ), { timeout: 5_000 }).toBe(true);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
      await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      await api("PATCH", "/api/config", { features: { browser: false } }).catch(() => undefined);
      rmSync(descriptorFile, { force: true });
    }
  });

  it("applies browser disable effects before reporting a removed-profile cleanup failure", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "omb-browser-cleanup-api-"));
    const isolatedData = join(isolatedHome, ".openmausbot");
    const isolatedStatic = join(isolatedHome, "static");
    const isolatedPort = await freePortBlock([0, 1]);
    const descriptorFile = join(isolatedHome, "browser-connection.json");
    mkdirSync(join(isolatedStatic, "assets"), { recursive: true });
    mkdirSync(isolatedData, { recursive: true });
    writeFileSync(join(isolatedStatic, "index.html"), "<!doctype html><title>Cleanup test</title>");
    writeFileSync(join(isolatedStatic, "assets", "smoke.css"), "body{}");
    writeFileSync(join(isolatedData, "config.json"), JSON.stringify({
      instances: {
        claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLAUDE_CLI } },
      },
      features: { browser: true },
      browserProfiles: [{ id: "unused", name: "Unused" }],
    }));
    writeFileSync(descriptorFile, JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${boxStubPort}`,
      token: "c".repeat(64),
      pid: process.pid,
    }));

    // Model Electron's private utility-process port, but answer lifecycle
    // cleanup requests with an immediate negative ACK. This keeps the test
    // fast while exercising the real config route's post-commit ordering.
    const noAckDesktopPrelude = `data:text/javascript,${encodeURIComponent(`
      let listener;
      Object.defineProperty(process, "parentPort", {
        value: {
          on(event, callback) { if (event === "message") listener = callback; },
          postMessage(message) {
            if (message?.requestId && /browser-(?:bot|profile)-deleted/.test(message.type ?? "")) {
              queueMicrotask(() => listener?.({ data: {
                type: "openmausbot:browser-lifecycle-result",
                requestId: message.requestId,
                ok: false,
              } }));
            }
          },
        },
      });
    `)}`;
    let isolatedStderr = "";
    const isolatedEnv: NodeJS.ProcessEnv = {
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      OMB_PORT: String(isolatedPort),
      OMB_WEBHOOK_PORT: String(isolatedPort + 1),
      OMB_STATIC_DIR: isolatedStatic,
      OMB_BROWSER_CONNECTION: descriptorFile,
      FAKE_CLAUDE_MODE: "hang",
      FAKE_CLAUDE_DUMP: join(isolatedHome, "fake-claude-dump.json"),
    };
    if (process.env.PATH) isolatedEnv.PATH = process.env.PATH;
    if (process.env.SystemRoot) isolatedEnv.SystemRoot = process.env.SystemRoot;
    const isolatedChild = spawn(process.execPath, ["--import", noAckDesktopPrelude, join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env: isolatedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    isolatedChild.stderr!.on("data", (chunk) => (isolatedStderr += chunk));
    type IsolatedApiBody =
      | { modelSelection: { instanceId: string; model: string }; requireAvailableModel: boolean }
      | { text: string }
      | { features: { browser: boolean }; browserProfiles: Array<{ id: string; name: string }> };
    const isolatedApi = async (method: string, path: string, body?: IsolatedApiBody): Promise<{
      status: number;
      body: any;
    }> => {
      const response = await fetch(`http://127.0.0.1:${isolatedPort}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    };

    try {
      await waitForIsolatedServer(isolatedChild, isolatedPort, () => isolatedStderr);

      const bot = (await isolatedApi("POST", "/api/bots", {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
        requireAvailableModel: true,
      })).body.bot;
      const callOffset = browserCapabilityCalls.length;
      expect((await isolatedApi("POST", `/api/bots/${bot.id}/messages`, { text: "keep browser access live" })).status)
        .toBe(202);
      await expect.poll(() => browserCapabilityCalls.slice(callOffset).some(
        (call) => call.operation === "register" && call.body.botId === bot.id,
      ), { timeout: 5_000 }).toBe(true);

      const patched = await isolatedApi("PATCH", "/api/config", {
        features: { browser: false },
        browserProfiles: [],
      });
      expect(patched.status).toBe(503);
      expect(patched.body.error).toMatch(/could not confirm.*browser data was erased/i);
      // The negative cleanup ACK must not short-circuit the already-committed
      // feature disable. The master clear revokes every live two-hour bearer.
      expect(browserCapabilityCalls.slice(callOffset).some((call) => call.operation === "clear")).toBe(true);
      const config = await isolatedApi("GET", "/api/config");
      expect(config.body.features.browser).toBe(false);
      expect(config.body.browserProfiles).toEqual([]);
      expect(JSON.parse(readFileSync(join(isolatedData, "browser-cleanups.json"), "utf8")))
        .toEqual([expect.objectContaining({ kind: "profile", id: "unused", phase: "committed" })]);
    } finally {
      await waitForExit(isolatedChild, { signal: "SIGTERM" });
      await removeTempDir(isolatedHome);
    }
    expectStoppedTestServerCleanly(isolatedChild, isolatedStderr);
  }, 30_000);

  it("reconciles a committed crash-stale bot reference before ACK and profile-id reuse", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "omb-browser-cleanup-restart-"));
    const isolatedData = join(isolatedHome, ".openmausbot");
    const isolatedStatic = join(isolatedHome, "static");
    const isolatedPort = await freePortBlock([0, 1]);
    mkdirSync(join(isolatedStatic, "assets"), { recursive: true });
    mkdirSync(isolatedData, { recursive: true });
    writeFileSync(join(isolatedStatic, "index.html"), "<!doctype html><title>Cleanup restart test</title>");
    writeFileSync(join(isolatedStatic, "assets", "smoke.css"), "body{}");
    writeFileSync(join(isolatedData, "config.json"), JSON.stringify({
      instances: {
        claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLAUDE_CLI } },
      },
      browserProfiles: [],
    }));
    writeFileSync(join(isolatedData, "bots.json"), JSON.stringify([{
      id: "crash-bot",
      threadId: "crash-thread",
      name: "Crash bot",
      title: "",
      description: "",
      notifications: true,
      color: "blue",
      unread: false,
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      resumeCursors: {},
      createdAt: 1,
      browserProfile: "client",
    }]));
    writeFileSync(join(isolatedData, "browser-cleanups.json"), JSON.stringify([{
      requestId: "00000000-0000-4000-8000-000000000001",
      kind: "profile",
      id: "client",
      partitionId: "Client",
      phase: "committed",
    }]));

    const ackDesktopPrelude = `data:text/javascript,${encodeURIComponent(`
      let listener;
      Object.defineProperty(process, "parentPort", {
        value: {
          on(event, callback) { if (event === "message") listener = callback; },
          postMessage(message) {
            if (message?.requestId && /browser-(?:bot|profile)-deleted/.test(message.type ?? "")) {
              queueMicrotask(() => listener?.({ data: {
                type: "openmausbot:browser-lifecycle-result",
                requestId: message.requestId,
                ok: true,
              } }));
            }
          },
        },
      });
    `)}`;
    let isolatedStderr = "";
    const isolatedChild = spawn(
      process.execPath,
      ["--import", ackDesktopPrelude, join(SERVER_DIR, "index.ts")],
      {
        cwd: ROOT,
        env: {
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
          OMB_PORT: String(isolatedPort),
          OMB_WEBHOOK_PORT: String(isolatedPort + 1),
          OMB_STATIC_DIR: isolatedStatic,
          FAKE_CLAUDE_MODE: "hang",
          FAKE_CLAUDE_DUMP: join(isolatedHome, "fake-claude-dump.json"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    isolatedChild.stderr!.on("data", (chunk) => (isolatedStderr += chunk));
    const isolatedApi = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const response = await fetch(`http://127.0.0.1:${isolatedPort}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    };

    try {
      await waitForIsolatedServer(isolatedChild, isolatedPort, () => isolatedStderr);
      await expect.poll(() => JSON.parse(
        readFileSync(join(isolatedData, "browser-cleanups.json"), "utf8"),
      ), { timeout: 5_000 }).toEqual([]);

      const beforeReuse = await isolatedApi("GET", "/api/bots?messages=0");
      expect(beforeReuse.body.bots.find((bot: { id: string }) => bot.id === "crash-bot"))
        .not.toHaveProperty("browserProfile");
      expect((await isolatedApi("PATCH", "/api/config", {
        browserProfiles: [{ id: "client", name: "A different account" }],
      })).status).toBe(200);
      const afterReuse = await isolatedApi("GET", "/api/bots?messages=0");
      expect(afterReuse.body.bots.find((bot: { id: string }) => bot.id === "crash-bot"))
        .not.toHaveProperty("browserProfile");
    } finally {
      await waitForExit(isolatedChild, { signal: "SIGTERM" });
      await removeTempDir(isolatedHome);
    }
    expectStoppedTestServerCleanly(isolatedChild, isolatedStderr);
  }, 30_000);

  it("revokes live browser access even when clearing a removed profile reference cannot persist", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "omb-browser-reference-write-"));
    const isolatedData = join(isolatedHome, ".openmausbot");
    const isolatedStatic = join(isolatedHome, "static");
    const isolatedPort = await freePortBlock([0, 1]);
    const descriptorFile = join(isolatedHome, "browser-connection.json");
    const botsFile = join(isolatedData, "bots.json");
    mkdirSync(join(isolatedStatic, "assets"), { recursive: true });
    mkdirSync(isolatedData, { recursive: true });
    writeFileSync(join(isolatedStatic, "index.html"), "<!doctype html><title>Reference failure test</title>");
    writeFileSync(join(isolatedStatic, "assets", "smoke.css"), "body{}");
    writeFileSync(join(isolatedData, "config.json"), JSON.stringify({
      instances: {
        claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLAUDE_CLI } },
      },
      features: { browser: true },
      browserProfiles: [{ id: "unused", name: "Unused" }],
    }));
    writeFileSync(descriptorFile, JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${boxStubPort}`,
      token: "c".repeat(64),
      pid: process.pid,
    }));
    const desktopPrelude = `data:text/javascript,${encodeURIComponent(`
      Object.defineProperty(process, "parentPort", {
        value: { on() {}, postMessage() {} },
      });
    `)}`;
    let isolatedStderr = "";
    const isolatedChild = spawn(process.execPath, ["--import", desktopPrelude, join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        OMB_PORT: String(isolatedPort),
        OMB_WEBHOOK_PORT: String(isolatedPort + 1),
        OMB_STATIC_DIR: isolatedStatic,
        OMB_BROWSER_CONNECTION: descriptorFile,
        FAKE_CLAUDE_MODE: "hang",
        FAKE_CLAUDE_DUMP: join(isolatedHome, "fake-claude-dump.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    isolatedChild.stderr!.on("data", (chunk) => (isolatedStderr += chunk));
    const isolatedApi = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const response = await fetch(`http://127.0.0.1:${isolatedPort}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    };

    try {
      await waitForIsolatedServer(isolatedChild, isolatedPort, () => isolatedStderr);
      const idleBot = (await isolatedApi("POST", "/api/bots", {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
        requireAvailableModel: true,
      })).body.bot;
      const activeBot = (await isolatedApi("POST", "/api/bots", {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
        requireAvailableModel: true,
      })).body.bot;
      expect((await isolatedApi("PATCH", `/api/bots/${idleBot.id}`, { browserProfile: "unused" })).status).toBe(200);

      const callOffset = browserCapabilityCalls.length;
      expect((await isolatedApi("POST", `/api/bots/${activeBot.id}/messages`, { text: "keep browser access live" })).status)
        .toBe(202);
      await expect.poll(() => browserCapabilityCalls.slice(callOffset).some(
        (call) => call.operation === "register" && call.body.botId === activeBot.id,
      ), { timeout: 5_000 }).toBe(true);
      // Registration happens before the provider's init frame is persisted.
      // Wait for that final startup write before sabotaging the store;
      // otherwise slower Windows runners can reset the next HTTP request when
      // the resume-cursor save races the deliberately-invalid bots path.
      await expect.poll(() => {
        try {
          const bots = z.array(z.object({
            id: z.string().optional(),
            resumeCursors: z.record(z.string(), z.string()).optional(),
          }).passthrough()).parse(JSON.parse(readFileSync(botsFile, "utf8")));
          const cursor = bots.find((bot) => bot.id === activeBot.id)?.resumeCursors?.claude;
          return Boolean(cursor);
        } catch {
          return false;
        }
      }, { timeout: 5_000 }).toBe(true);

      // The hanging provider may bank one final activity write concurrently.
      // Win the replacement atomically by retrying until the path is a
      // directory; subsequent Store saves then fail deterministically.
      for (let attempt = 0; attempt < 50 && !statSync(botsFile, { throwIfNoEntry: false })?.isDirectory(); attempt += 1) {
        rmSync(botsFile, { recursive: true, force: true });
        try {
          mkdirSync(botsFile);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      expect(statSync(botsFile).isDirectory()).toBe(true);
      const patched = await isolatedApi("PATCH", "/api/config", {
        features: { browser: false },
        browserProfiles: [],
      });
      expect(patched.status).toBe(500);
      expect(browserCapabilityCalls.slice(callOffset).some((call) => call.operation === "clear")).toBe(true);
      const config = await isolatedApi("GET", "/api/config");
      expect(config.body.features.browser).toBe(false);
      expect(config.body.browserProfiles).toEqual([]);
      expect(JSON.parse(readFileSync(join(isolatedData, "browser-cleanups.json"), "utf8")))
        .toEqual([expect.objectContaining({ kind: "profile", id: "unused", phase: "prepared" })]);
    } finally {
      rmSync(botsFile, { recursive: true, force: true });
      writeFileSync(botsFile, "[]");
      await waitForExit(isolatedChild, { signal: "SIGTERM" });
      await removeTempDir(isolatedHome);
    }
    expectStoppedTestServerCleanly(isolatedChild, isolatedStderr);
  }, 30_000);

  it("rejects bot deletion with no teardown when the cleanup journal is unreadable", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "omb-browser-bot-delete-journal-"));
    const isolatedData = join(isolatedHome, ".openmausbot");
    const isolatedStatic = join(isolatedHome, "static");
    const isolatedPort = await freePortBlock([0, 1]);
    const descriptorFile = join(isolatedHome, "browser-connection.json");
    mkdirSync(join(isolatedStatic, "assets"), { recursive: true });
    mkdirSync(isolatedData, { recursive: true });
    writeFileSync(join(isolatedStatic, "index.html"), "<!doctype html><title>Malformed journal test</title>");
    writeFileSync(join(isolatedStatic, "assets", "smoke.css"), "body{}");
    writeFileSync(join(isolatedData, "config.json"), JSON.stringify({
      instances: {
        claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLAUDE_CLI } },
      },
      features: { browser: true },
    }));
    writeFileSync(join(isolatedData, "browser-cleanups.json"), "{ malformed");
    writeFileSync(descriptorFile, JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${boxStubPort}`,
      token: "c".repeat(64),
      pid: process.pid,
    }));
    const desktopPrelude = `data:text/javascript,${encodeURIComponent(`
      Object.defineProperty(process, "parentPort", {
        value: { on() {}, postMessage() {} },
      });
    `)}`;
    let isolatedStderr = "";
    const isolatedChild = spawn(process.execPath, ["--import", desktopPrelude, join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        OMB_PORT: String(isolatedPort),
        OMB_WEBHOOK_PORT: String(isolatedPort + 1),
        OMB_STATIC_DIR: isolatedStatic,
        OMB_BROWSER_CONNECTION: descriptorFile,
        FAKE_CLAUDE_MODE: "hang",
        FAKE_CLAUDE_DUMP: join(isolatedHome, "fake-claude-dump.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let createdBotId = "";
    isolatedChild.stderr!.on("data", (chunk) => (isolatedStderr += chunk));
    const isolatedApi = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const response = await fetch(`http://127.0.0.1:${isolatedPort}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    };

    try {
      await waitForIsolatedServer(isolatedChild, isolatedPort, () => isolatedStderr);
      const bot = (await isolatedApi("POST", "/api/bots", {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
        requireAvailableModel: true,
      })).body.bot;
      createdBotId = bot.id;
      const callOffset = browserCapabilityCalls.length;
      expect((await isolatedApi("POST", `/api/bots/${bot.id}/messages`, { text: "do not tear this down" })).status)
        .toBe(202);
      await expect.poll(() => browserCapabilityCalls.slice(callOffset).find(
        (call) => call.operation === "register" && call.body.botId === bot.id,
      ), { timeout: 5_000 }).toBeTruthy();
      const registration = browserCapabilityCalls.slice(callOffset).find(
        (call) => call.operation === "register" && call.body.botId === bot.id,
      );

      const deletion = await isolatedApi("DELETE", `/api/bots/${bot.id}`);
      expect(deletion.status).toBe(503);
      expect(deletion.body.error).toMatch(/cleanup journal could not be read safely/i);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(browserCapabilityCalls.slice(callOffset).some(
        (call) => call.operation === "revoke" && call.body.token === registration?.body.token,
      )).toBe(false);
      const state = await isolatedApi("GET", "/api/bots?messages=0");
      expect(state.body.bots.find((candidate: { id: string }) => candidate.id === bot.id)).toMatchObject({ busy: true });
    } finally {
      if (createdBotId) {
        await isolatedApi("POST", `/api/bots/${createdBotId}/interrupt`, {}).catch(() => undefined);
      }
      await waitForExit(isolatedChild, { signal: "SIGTERM" });
      await removeTempDir(isolatedHome);
    }
    expectStoppedTestServerCleanly(isolatedChild, isolatedStderr);
  }, 30_000);

  it("clears bot references when a named browser profile is removed", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      expect((await api("PATCH", "/api/config", {
        browserProfiles: [{ id: "client", name: "Client" }],
      })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bot.id}`, { browserProfile: "client" })).body.bot.browserProfile).toBe("client");
      expect((await api("PATCH", "/api/config", { browserProfiles: [] })).status).toBe(200);
      const state = (await api("GET", "/api/bots")).body;
      expect(state.bots.find((candidate: { id: string }) => candidate.id === bot.id)).not.toHaveProperty("browserProfile");
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      await api("PATCH", "/api/config", { browserProfiles: [] }).catch(() => undefined);
    }
  });

  it("does not remove a browser profile from a bot whose turn is active", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      expect((await api("PATCH", "/api/config", {
        browserProfiles: [{ id: "active", name: "Active" }],
      })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        browserProfile: "active",
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      })).status).toBe(200);
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "keep working" })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBe(true);

      const blocked = await api("PATCH", "/api/config", { browserProfiles: [] });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatch(/stop .* turn/i);
      const switched = await api("PATCH", `/api/bots/${bot.id}`, { browserProfile: null });
      expect(switched.status).toBe(409);
      expect(switched.body.error).toMatch(/stop this bot's turn before changing its browser profile/i);
      const state = (await api("GET", "/api/bots")).body;
      expect(state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.browserProfile).toBe("active");
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBeFalsy();
      await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      await api("PATCH", "/api/config", { browserProfiles: [] }).catch(() => undefined);
    }
  });

  it("rechecks profile use after awaited provider validation before deleting it", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      expect((await api("PATCH", "/api/config", {
        browserProfiles: [{ id: "late-claim", name: "Late claim" }],
      })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        browserProfile: "late-claim",
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      })).status).toBe(200);

      // The Box stub deliberately holds this credential check for 150 ms.
      // The profile is idle at the route's first check, then becomes active
      // while validation is in flight.
      const removing = api("PATCH", "/api/config", {
        box: { token: "box_slow" },
        browserProfiles: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "start during validation" })).status).toBe(202);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBe(true);

      const blocked = await removing;
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatch(/stop .* turn/i);
      const state = (await api("GET", "/api/bots")).body;
      expect(state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.browserProfile).toBe("late-claim");
      expect((await api("GET", "/api/config")).body.browserProfiles).toContainEqual({
        id: "late-claim",
        name: "Late claim",
      });
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBeFalsy();
      await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      await api("PATCH", "/api/config", { browserProfiles: [] }).catch(() => undefined);
    }
  });

  it("keeps shared Local VM mode by default and resolves isolated targets per bot when enabled", async () => {
    const first = (await api("POST", "/api/bots")).body.bot;
    const second = (await api("POST", "/api/bots")).body.bot;
    const before = await api("GET", "/api/config");
    expect(before.body.localVm).toEqual({ mode: "shared", maxInstances: 2 });

    const shared = await api("GET", `/api/bots/${first.id}/local-computer`);
    expect(shared.status).toBe(200);
    expect(shared.body).toMatchObject({ mode: "shared", target_key: "shared" });

    const saved = await api("PATCH", "/api/config", {
      localVm: { mode: "per-bot", maxInstances: 3 },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.localVm).toEqual({ mode: "per-bot", maxInstances: 3 });

    const [firstStatus, secondStatus] = await Promise.all([
      api("GET", `/api/bots/${first.id}/local-computer`),
      api("GET", `/api/bots/${second.id}/local-computer`),
    ]);
    expect(firstStatus.body).toMatchObject({ mode: "per-bot", max_instances: 3 });
    expect(secondStatus.body).toMatchObject({ mode: "per-bot", max_instances: 3 });
    expect(firstStatus.body.target_key).not.toBe(secondStatus.body.target_key);
    expect(firstStatus.body.container_name).not.toBe(secondStatus.body.container_name);
    expect(firstStatus.body.workspace_path).not.toBe(secondStatus.body.workspace_path);

    const invalid = await api("PATCH", "/api/config", { localVm: { maxInstances: 5 } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("localVm.maxInstances");

    const disk = JSON.parse(readFileSync(join(home, ".openmausbot", "config.json"), "utf8"));
    expect(disk.localVm).toEqual({ mode: "per-bot", maxInstances: 3 });
    await api("PATCH", "/api/config", { localVm: { mode: "shared", maxInstances: 2 } });
  });

  it("keeps an active turn alive when only the room timeout changes", async () => {
    const created = await api("POST", "/api/bots", {});
    const botId = created.body.bot.id;
    const room = (await api("POST", "/api/groups", {
      name: "Room timeout capture",
      memberIds: [botId],
    })).body.group;
    const ready = await api("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" });
    expect(ready.status).toBe(200);
    try {
      const selected = await api("PATCH", `/api/bots/${botId}`, {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      });
      expect(selected.status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      const sent = await api("POST", `/api/groups/${room.id}/messages`, { text: "stay active" });
      expect(sent.status).toBe(202);
      await expect.poll(() => existsSync(fakeClaudeDump), { timeout: 5_000 }).toBe(true);

      const before = (await api("GET", "/api/bots")).body;
      expect(before.bots.find((bot: { id: string }) => bot.id === botId)?.busy).toBe(true);
      expect(before.groups.find((group: { id: string }) => group.id === room.id)?.busyBotId).toBe(botId);

      const saved = await api("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 20 } });
      expect(saved.status).toBe(200);

      const after = (await api("GET", "/api/bots")).body;
      expect(after.bots.find((bot: { id: string }) => bot.id === botId)?.busy).toBe(true);
      const activeRoom = after.groups.find((group: { id: string }) => group.id === room.id);
      expect(activeRoom?.busyBotId).toBe(botId);
      expect(activeRoom.messages.some((message: { tool?: { name?: string } }) =>
        message.tool?.name?.includes("provider settings changed"),
      )).toBe(false);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body;
        return {
          botBusy: state.bots.find((bot: { id: string }) => bot.id === botId)?.busy,
          roomBusyBotId: state.groups.find((group: { id: string }) => group.id === room.id)?.busyBotId,
        };
      }, { timeout: 5_000 }).toEqual({ botBusy: false, roomBusyBotId: null });
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${botId}`);
      await api("PUT", "/api/config", { rooms: { turnTimeoutMinutes: 5 } });
    }
  });

  it("tracks and interrupts the whole queued channel turn", async () => {
    const first = (await api("POST", "/api/bots", {})).body.bot;
    const second = (await api("POST", "/api/bots", {})).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Queued channel turn",
      memberIds: [first.id, second.id],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    })).body.group;
    try {
      for (const bot of [first, second]) {
        const selected = await api("PATCH", `/api/bots/${bot.id}`, {
          modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
        });
        expect(selected.status).toBe(200);
      }

      const sent = await api("POST", `/api/groups/${room.id}/messages`, {
        text: "both bots should answer",
        threadId: room.threadId,
      });
      expect(sent.status).toBe(202);

      // The operation is registered before any awaited provider setup. Polling
      // and structural guards therefore cannot see a false idle window.
      const immediate = (await api("GET", "/api/bots?messages=0")).body;
      expect(immediate.groups.find((group: { id: string }) => group.id === room.id)?.working).toBe(true);
      expect((await api("POST", `/api/groups/${room.id}/tasks`, { title: "Too soon" })).status).toBe(409);
      expect((await api("PATCH", `/api/groups/${room.id}`, { memberIds: [first.id] })).status).toBe(409);

      const interrupted = await api("POST", `/api/groups/${room.id}/interrupt`, {
        threadId: room.threadId,
      });
      expect(interrupted.status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        const currentRoom = state.groups.find((group: { id: string }) => group.id === room.id);
        return {
          working: currentRoom?.working,
          busyBotId: currentRoom?.busyBotId,
          busyBots: state.bots
            .filter((bot: { id: string; busy: boolean }) =>
              (bot.id === first.id || bot.id === second.id) && bot.busy,
            )
            .map((bot: { id: string }) => bot.id),
        };
      }, { timeout: 5_000 }).toEqual({ working: false, busyBotId: null, busyBots: [] });

      // Cancellation must be durable for the queued remainder, not merely
      // interrupt whichever responder happened to own the process.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const settled = (await api("GET", "/api/bots?messages=0")).body;
      expect(settled.groups.find((group: { id: string }) => group.id === room.id)?.working).toBe(false);
      expect(settled.bots.filter((bot: { id: string; busy: boolean }) =>
        (bot.id === first.id || bot.id === second.id) && bot.busy,
      )).toHaveLength(0);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${first.id}`);
      await api("DELETE", `/api/bots/${second.id}`);
    }
  });

  it("tracks and cancels a queued channel credential continuation before provider dispatch", async () => {
    const first = (await api("POST", "/api/bots", {})).body.bot;
    const second = (await api("POST", "/api/bots", {})).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Credential continuation",
      memberIds: [first.id, second.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: first.id } },
    })).body.group;
    try {
      for (const bot of [first, second]) {
        const selected = await api("PATCH", `/api/bots/${bot.id}`, {
          modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
        });
        expect(selected.status).toBe(200);
      }

      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "start the lead" })).status).toBe(202);
      const firstDump = await readJsonFileWhenReady<{
        pid: number;
        mcpConfig: { mcpServers: { agents: { env: { OMB_COMMS_TOKEN: string } } } };
      }>(fakeClaudeDump);
      const token = firstDump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
      expect(token).toMatch(/^[a-f0-9]{48}$/);

      const requested = await fetch(`${BASE}/api/internal/request-credential`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          fromBotId: second.id,
          fromThreadId: room.threadId,
          credentialId: "openaiImageApiKey",
          reason: "needed for the queued task",
        }),
      });
      expect(requested.status).toBe(201);
      const { messageId } = (await requested.json()) as { messageId: string };

      const resumed = await api("POST", `/api/bots/${second.id}/secret-cards/${messageId}/dismiss`, {
        threadId: room.threadId,
      });
      expect(resumed).toEqual({ status: 200, body: { dismissed: true, resumed: true } });

      const queued = (await api("GET", "/api/bots?messages=0")).body;
      expect(queued.groups.find((group: { id: string }) => group.id === room.id)?.working).toBe(true);
      const deletion = await api("DELETE", `/api/groups/${room.id}`);
      expect(deletion.status).toBe(409);
      expect(deletion.body.error).toMatch(/working/i);

      expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return {
          working: state.groups.find((group: { id: string }) => group.id === room.id)?.working,
          secondBusy: Boolean(state.bots.find((bot: { id: string }) => bot.id === second.id)?.busy),
        };
      }, { timeout: 5_000 }).toEqual({ working: false, secondBusy: false });

      // The continuation sat behind the lead's hanging provider. Interrupting
      // the room must cancel it before a second provider process is spawned.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(JSON.parse(readFileSync(fakeClaudeDump, "utf8")).pid).toBe(firstDump.pid);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.groups.find((group: { id: string }) => group.id === room.id)?.working;
      }, { timeout: 5_000 }).toBe(false);
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${first.id}`);
      await api("DELETE", `/api/bots/${second.id}`);
    }
  });

  it("keeps chat-created routines inert until their durable card is confirmed", async () => {
    const bot = (await api("POST", "/api/bots", {})).body.bot;
    let routineId = "";
    let orphanRoutineId = "";
    let legacyRoutineId = "";
    try {
      const selected = await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      });
      expect(selected.status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "prepare a routine" })).status).toBe(202);
      const dump = await readJsonFileWhenReady<{
        mcpConfig: { mcpServers: { agents: { env: { OMB_COMMS_TOKEN: string } } } };
      }>(fakeClaudeDump);
      const token = dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
      expect(token).toMatch(/^[a-f0-9]{48}$/);
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBe(false);
      const internalHeaders = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };

      const before = await fetch(
        `${BASE}/api/internal/routines?fromBotId=${encodeURIComponent(bot.id)}&fromThreadId=${encodeURIComponent(bot.threadId)}`,
        { headers: internalHeaders },
      );
      expect(before.status).toBe(200);
      expect(z.object({ routines: z.array(z.unknown()) }).parse(await before.json()).routines).toEqual([]);

      const unavailableCloud = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: bot.threadId,
          action: "create",
          routine: {
            name: "Cloud brief",
            instructions: "Summarize today's priorities in the Cloud VM.",
            schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] },
            runOn: "cloud",
          },
        }),
      });
      expect(unavailableCloud.status).toBe(409);
      expect(await unavailableCloud.json()).toMatchObject({
        error: expect.stringMatching(/Box API key|Cloud VM runner/i),
      });

      const proposed = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: bot.threadId,
          action: "create",
          routine: {
            name: "Weekday brief",
            instructions: "Summarize the priorities for today.",
            schedule: {
              type: "weekly",
              time: "09:00",
              weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
            },
            runOn: "maus",
            durationMinutes: 30,
          },
        }),
      });
      expect(proposed.status).toBe(201);
      const proposal = z.object({ requestId: z.string() }).passthrough().parse(await proposed.json());

      const stillInert = await api("GET", "/api/routines");
      expect(stillInert.body.routines.filter((routine: { botId: string }) => routine.botId === bot.id)).toEqual([]);
      const state = (await api("GET", "/api/bots")).body;
      const card = state.bots
        .find((candidate: { id: string }) => candidate.id === bot.id)
        ?.messages.find((message: { card?: { requestId?: string } }) => message.card?.requestId === proposal.requestId);
      expect(card?.card).toMatchObject({
        tool: "schedule_routine",
        routineRequest: { botId: bot.id, threadId: bot.threadId },
      });
      expect(card?.card.answered).toBeUndefined();

      const confirmed = await api("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: proposal.requestId,
        behavior: "allow",
      });
      expect(confirmed).toMatchObject({ status: 200, body: { outcome: "allowed-once", routineAction: "create" } });
      routineId = confirmed.body.resultId;
      await expect.poll(async () => {
        const decisions = (await api("GET", "/api/decisions")).body.decisions;
        return decisions
          .filter((decision: { requestId?: string }) => decision.requestId === proposal.requestId)
          .map((decision: { decision: string; source: string }) => `${decision.decision}:${decision.source}`)
          .sort();
      }).toEqual(["card-shown:routine", "user-approved:user"]);

      const after = await api("GET", "/api/routines");
      const confirmedRoutine = after.body.routines.find((routine: { id: string }) => routine.id === routineId);
      expect(confirmedRoutine).toMatchObject({
        botId: bot.id,
        sourceThreadId: bot.threadId,
      });
      const duplicate = await api("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: proposal.requestId,
        behavior: "allow",
      });
      expect(duplicate.body.alreadySettled).toBe(true);
      expect((await api("GET", "/api/routines")).body.routines
        .filter((routine: { botId: string }) => routine.botId === bot.id)).toHaveLength(1);

      // A routine proposed "for another bot" binds to that bot, not the sender.
      const badTarget = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: bot.threadId,
          action: "create",
          forBotId: "bot-that-does-not-exist",
          routine: {
            name: "Nowhere brief",
            instructions: "Should never be scheduled.",
            schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] },
            runOn: "maus",
          },
        }),
      });
      expect(badTarget.status).toBe(404);
      expect(z.object({ error: z.string() }).parse(await badTarget.json()).error).toMatch(/list_bots/);

      const teammate = (await api("POST", "/api/bots", {})).body.bot;
      const crossProposed = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: bot.threadId,
          action: "create",
          forBotId: teammate.id,
          routine: {
            name: "Teammate brief",
            instructions: "Summarize for the teammate every weekday.",
            schedule: { type: "weekly", time: "08:30", weekdays: ["monday"] },
            runOn: "maus",
            durationMinutes: 30,
          },
        }),
      });
      expect(crossProposed.status).toBe(201);
      const crossProposal = z.object({ requestId: z.string() }).passthrough().parse(await crossProposed.json());
      // the card is confirmed in the proposer's conversation and says who it is for
      const crossState = (await api("GET", "/api/bots")).body;
      const crossCard = crossState.bots
        .find((candidate: { id: string }) => candidate.id === bot.id)
        ?.messages.find((message: { card?: { requestId?: string } }) => message.card?.requestId === crossProposal.requestId);
      expect(crossCard?.card.title).toContain(`for @${teammate.name}`);
      const crossConfirmed = await api("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: crossProposal.requestId,
        behavior: "allow",
      });
      expect(crossConfirmed).toMatchObject({ status: 200, body: { routineAction: "create" } });
      const crossRoutine = (await api("GET", "/api/routines")).body.routines
        .find((routine: { id: string }) => routine.id === crossConfirmed.body.resultId);
      expect(crossRoutine).toMatchObject({ botId: teammate.id, sourceThreadId: bot.threadId });
      await api("DELETE", `/api/bots/${teammate.id}`);

      // The initial fixture turn is deliberately hung. Once it is stopped,
      // force a deterministic dispatch failure by choosing the configured
      // but unavailable ghost provider. The execution stays detached, while one source card is
      // appended then patched through queued → running → failed.
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
      await expect.poll(async () => {
        const current = (await api("GET", "/api/bots?messages=0")).body.bots
          .find((candidate: { id: string }) => candidate.id === bot.id);
        return Boolean(current?.busy);
      }, { timeout: 5_000 }).toBe(false);
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "ghost", model: "unavailable-fixture" },
      })).status).toBe(200);

      const routineEvents = await openSse(`${BASE}/api/events`);
      try {
        const queued = await api("POST", `/api/routines/${routineId}/run`);
        expect(queued.status).toBe(201);
        const failedNotice = await routineEvents.until(
          (frame) =>
            frame.kind === "notify" &&
            frame.notification?.kind === "routine-failed" &&
            frame.notification?.botId === bot.id,
          5_000,
        );
        expect(failedNotice.notification.threadId).toBe(bot.threadId);

        await expect.poll(async () => {
          const current = (await api("GET", "/api/bots")).body.bots
            .find((candidate: { id: string }) => candidate.id === bot.id);
          return current?.messages.filter(
            (message: { kind?: string; routineRun?: { runId?: string } }) =>
              message.kind === "routine.run" && message.routineRun?.runId === queued.body.run.id,
          ) ?? [];
        }, { timeout: 5_000 }).toHaveLength(1);
        const current = (await api("GET", "/api/bots")).body.bots
          .find((candidate: { id: string }) => candidate.id === bot.id);
        const runCards = current.messages.filter(
          (message: { kind?: string; routineRun?: { runId?: string } }) =>
            message.kind === "routine.run" && message.routineRun?.runId === queued.body.run.id,
        );
        expect(runCards).toHaveLength(1);
        expect(runCards[0].routineRun).toMatchObject({
          runId: queued.body.run.id,
          routineId,
          routineName: "Weekday brief",
          status: "failed",
        });
        expect(runCards[0].routineRun.executionThreadId).not.toBe(bot.threadId);

        // Reading the source and then marking the failure seen in Routines
        // must not make the original conversation unread again. markSeen
        // re-emits the receipt without changing its lifecycle status.
        expect((await api("POST", `/api/bots/${bot.id}/read`)).status).toBe(200);
        expect((await api("POST", `/api/routine-runs/${queued.body.run.id}/seen`)).status).toBe(200);
        const afterSeen = (await api("GET", "/api/bots?messages=0")).body.bots
          .find((candidate: { id: string }) => candidate.id === bot.id);
        expect(afterSeen.unread).toBe(false);

        const grounded = await fetch(
          `${BASE}/api/internal/routines?fromBotId=${encodeURIComponent(bot.id)}&fromThreadId=${encodeURIComponent(bot.threadId)}`,
          { headers: internalHeaders },
        );
        const groundedBody = z.object({
          routines: z.array(z.object({
            id: z.string(),
            latestRun: z.object({
              status: z.string(),
              scheduledFor: z.string().nullable(),
              startedAt: z.string().nullable(),
              finishedAt: z.string().nullable(),
              output: z.string().nullable(),
              error: z.string().nullable(),
              executionThreadId: z.string().nullable(),
            }).nullable(),
          }).passthrough()),
        }).parse(await grounded.json());
        expect(groundedBody.routines.find((routine) => routine.id === routineId)?.latestRun).toMatchObject({
          status: "failed",
          startedAt: expect.any(String),
          finishedAt: expect.any(String),
          error: expect.stringMatching(/provider instance "ghost" is unavailable/i),
          executionThreadId: runCards[0].routineRun.executionThreadId,
        });
      } finally {
        routineEvents.close();
      }

      // A deleted source conversation is a safe fallback, not an instruction
      // to recreate its transcript. The run still gets its detached receipt
      // and failure, but no lifecycle message is written to the orphan id.
      const orphanSource = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Temporary routine source" });
      expect(orphanSource.status).toBe(201);
      const orphanThreadId = z.object({
        task: z.object({ threadId: z.string() }),
      }).parse(orphanSource.body).task.threadId;
      const orphanProposalResponse = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: orphanThreadId,
          action: "create",
          routine: {
            name: "Orphan-safe brief",
            instructions: "Summarize without recreating the deleted source.",
            schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] },
            runOn: "maus",
          },
        }),
      });
      expect(orphanProposalResponse.status).toBe(201);
      const orphanProposal = z.object({ requestId: z.string() }).parse(await orphanProposalResponse.json());
      const orphanConfirmed = await api("POST", `/api/threads/${orphanThreadId}/respond`, {
        requestId: orphanProposal.requestId,
        behavior: "allow",
      });
      expect(orphanConfirmed.status).toBe(200);
      orphanRoutineId = orphanConfirmed.body.resultId;
      expect((await api("DELETE", `/api/bots/${bot.id}/tasks/${orphanThreadId}`)).status).toBe(200);
      expect(storedMessageCount(orphanThreadId)).toBe(0);

      const orphanRun = await api("POST", `/api/routines/${orphanRoutineId}/run`);
      expect(orphanRun.status).toBe(201);
      await expect.poll(async () => {
        const runs = (await api("GET", "/api/routines")).body.runs;
        return runs.find((run: { id: string }) => run.id === orphanRun.body.run.id)?.status;
      }, { timeout: 5_000 }).toBe("failed");
      expect(storedMessageCount(orphanThreadId)).toBe(0);

      // Calendar-created routines may predate chat-card redaction. Listing
      // them to a model must redact the whole prompt before returning its
      // bounded preview, and tell the model when that preview is incomplete.
      const fakeSecret = `Bearer ${"a".repeat(24)}`;
      const fakeNameSecret = `sk-proj-${"b".repeat(24)}`;
      const legacy = await api("POST", "/api/routines", {
        name: `Legacy ${fakeNameSecret}`,
        prompt: `${fakeSecret}\n${"Review the archive. ".repeat(180)}`,
        botId: bot.id,
        runOn: "maus",
        enabled: false,
        schedule: { type: "daily", time: "10:00", weekdays: [1] },
      });
      legacyRoutineId = legacy.body.routine.id;
      const listed = await fetch(
        `${BASE}/api/internal/routines?fromBotId=${encodeURIComponent(bot.id)}&fromThreadId=${encodeURIComponent(bot.threadId)}`,
        { headers: internalHeaders },
      );
      expect(listed.status).toBe(200);
      const listedBody = z.object({
        routines: z.array(z.object({
          id: z.string(),
          instructions: z.string(),
          instructionsTruncated: z.boolean(),
        }).passthrough()),
      }).parse(await listed.json());
      const legacyResult = listedBody.routines.find((routine) => routine.id === legacyRoutineId)!;
      expect(legacyResult.instructions).not.toContain(fakeSecret);
      expect(legacyResult.name).not.toContain(fakeNameSecret);
      expect(legacyResult.instructions).toContain("redacted");
      expect(legacyResult.instructionsTruncated).toBe(true);

      const wrongThread = await fetch(`${BASE}/api/internal/routine-requests`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          fromBotId: bot.id,
          fromThreadId: "not-this-bots-thread",
          action: "pause",
          routineId,
        }),
      });
      expect(wrongThread.status).toBe(403);
    } finally {
      if (legacyRoutineId) await api("DELETE", `/api/routines/${legacyRoutineId}`);
      if (orphanRoutineId) await api("DELETE", `/api/routines/${orphanRoutineId}`);
      if (routineId) await api("DELETE", `/api/routines/${routineId}`);
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("only enables the exact learned-skill proposal a current client reviewed", async () => {
    const bot = (await api("POST", "/api/bots", {})).body.bot;
    try {
      expect((await api("PATCH", "/api/config", { features: { skillRecorder: true } })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      })).status).toBe(200);

      rmSync(fakeClaudeDump, { force: true });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "prepare a skill" })).status).toBe(202);
      const dump = await readJsonFileWhenReady<{
        mcpConfig: { mcpServers: { agents: { env: { OMB_COMMS_TOKEN: string } } } };
      }>(fakeClaudeDump);
      const token = dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
      expect(token).toMatch(/^[a-f0-9]{48}$/);
      const internalHeaders = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };

      const stage = async (name: string, extraInstructions = "") => {
        const response = await fetch(`${BASE}/api/internal/skills/stage`, {
          method: "POST",
          headers: internalHeaders,
          body: JSON.stringify({
            fromBotId: bot.id,
            fromThreadId: bot.threadId,
            action: "create",
            source: "conversation",
            gist: `Use ${name} safely.`,
            skill_md: `---\nname: ${name}\ndescription: Use ${name} safely.\n---\n\n# ${name}\n\nDo the reviewed thing.\n${extraInstructions}`,
          }),
        });
        expect(response.status).toBe(201);
        const state = (await api("GET", "/api/bots")).body;
        const card = state.bots
          .find((candidate: { id: string }) => candidate.id === bot.id)
          ?.messages.find((message: { card?: { skillRequest?: { name?: string } } }) =>
            message.card?.skillRequest?.name === name,
          )?.card;
        expect(card?.options).toEqual(["Enable", "Deny"]);
        expect(card?.skillRequest?.preview).toContain(`# ${name}`);
        expect(card?.skillRequest?.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(createHash("sha256").update(card.skillRequest.preview).digest("hex"))
          .toBe(card.skillRequest.sha256);
        return card as { requestId: string; skillRequest: { preview: string; sha256: string } };
      };

      const stagedSecret = `Bearer ${"a".repeat(24)}`;
      const first = await stage("reviewed-skill-one", `Use ${stagedSecret} when calling the API.\n`);
      expect(first.skillRequest.preview).not.toContain(stagedSecret);
      expect(first.skillRequest.preview).toContain("redacted");
      const stagedMessage = (await api("GET", "/api/bots")).body.bots
        .find((candidate: { id: string }) => candidate.id === bot.id)
        ?.messages.find((message: { card?: { requestId?: string } }) => message.card?.requestId === first.requestId);
      expect((await api("PATCH", `/api/bots/${bot.id}/cards/${stagedMessage.id}`, {
        answered: "allow",
      })).status).toBe(409);
      const missingHash = await api("POST", `/api/bots/${bot.id}/respond`, {
        requestId: first.requestId,
        behavior: "allow",
      });
      expect(missingHash.status).toBe(409);
      expect(missingHash.body.error).toMatch(/reviewedSha256/);

      const wrongHash = await api("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: first.requestId,
        behavior: "allow",
        reviewedSha256: "0".repeat(64),
      });
      expect(wrongHash.status).toBe(409);
      expect(wrongHash.body.error).toMatch(/reviewedSha256/);

      const approvedByBotRoute = await api("POST", `/api/bots/${bot.id}/respond`, {
        requestId: first.requestId,
        behavior: "allow",
        reviewedSha256: first.skillRequest.sha256,
      });
      expect(approvedByBotRoute).toMatchObject({ status: 200, body: { outcome: "allowed-once" } });

      const second = await stage("reviewed-skill-two");
      const approvedByThreadRoute = await api("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: second.requestId,
        behavior: "allow",
        reviewedSha256: second.skillRequest.sha256,
      });
      expect(approvedByThreadRoute).toMatchObject({ status: 200, body: { outcome: "allowed-once" } });

      const denied = await stage("reviewed-skill-denied");
      const deniedWithoutHash = await api("POST", `/api/threads/${bot.threadId}/respond`, {
        requestId: denied.requestId,
        behavior: "deny",
      });
      expect(deniedWithoutHash).toMatchObject({ status: 200, body: { outcome: "rejected" } });

      // Deleting the only transcript that owns a pending card must also drop
      // its bot-scoped stage; otherwise the invisible proposal reserves its
      // name until the 30-day expiry.
      await stage("deleted-task-skill");
      expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBe(false);
      const nextTask = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "next task" });
      expect(nextTask).toMatchObject({ status: 201 });
      const nextThreadId = nextTask.body.task.threadId as string;
      expect((await api("DELETE", `/api/bots/${bot.id}/tasks/${bot.threadId}`)).status).toBe(200);

      const listing = await fetch(
        `${BASE}/api/internal/skills?fromBotId=${encodeURIComponent(bot.id)}&fromThreadId=${encodeURIComponent(nextThreadId)}`,
        { headers: internalHeaders },
      );
      expect(listing.status).toBe(200);
      const inventory = await listing.json() as {
        skills: Array<{ name: string; enabled: boolean }>;
        staged: Array<{ name: string }>;
      };
      expect(inventory.skills).toMatchObject([
        { name: "reviewed-skill-one", enabled: true },
        { name: "reviewed-skill-two", enabled: true },
      ]);
      expect(inventory.skills.some((skill) => skill.name === "reviewed-skill-denied")).toBe(false);
      expect(inventory.staged).toEqual([]);
    } finally {
      await api("PATCH", "/api/config", { features: { skillRecorder: false } });
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("validates the non-secret VPS alias and keeps old bots on Box by default", async () => {
    const before = await api("GET", "/api/bots");
    const bot = before.body.bots[0];
    expect(bot.cloudBackend).toBeUndefined();

    const bad = await api("PUT", "/api/config", { vps: { sshAlias: "prod; reboot" } });
    expect(bad.status).toBe(400);

    const saved = await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } });
    expect(saved.status).toBe(200);
    expect(saved.body.vps).toEqual({ configured: true, sshAlias: "production-vps" });
    expect(JSON.stringify(saved.body)).not.toContain("privateKey");

    const patched = await api("PATCH", `/api/bots/${bot.id}`, { cloudBackend: "vps" });
    expect(patched.status).toBe(200);
    expect(patched.body.bot.cloudBackend).toBe("vps");
    const autoStart = await api("PATCH", `/api/bots/${bot.id}`, { autoStartVps: true });
    expect(autoStart.status).toBe(200);
    expect(autoStart.body.bot.autoStartVps).toBe(true);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { autoStartVps: "yes" })).status).toBe(400);
    const invalid = await api("PATCH", `/api/bots/${bot.id}`, { cloudBackend: "daytona" });
    expect(invalid.status).toBe(400);
  });

  it("validates a Composio project key, creates a Session, and keeps externally stored secrets off disk", async () => {
    const oldKey = await api("PUT", "/api/config", { composio: { apiKey: "old_key" } });
    expect(oldKey.status).toBe(400);
    expect(oldKey.body.error).toMatch(/start with ak_/i);

    const rejected = await api("PUT", "/api/config", { composio: { apiKey: "ak_wrong" } });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/invalid project key/i);

    const saved = await api("PUT", "/api/config?secretStorage=external", {
      composio: { apiKey: "ak_good" },
      opencodeGo: { apiKey: "opencode-external" },
      profile: { name: "External Store" },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.composio).toEqual({ configured: true, mode: "self-hosted" });
    expect(saved.body.opencodeGo).toEqual({ configured: true });
    expect(saved.body.profile).toEqual({ name: "External Store", email: "" });
    expect(JSON.stringify(saved.body)).not.toContain("ak_good");

    const disk = JSON.parse(readFileSync(join(home, ".openmausbot", "config.json"), "utf8"));
    expect(disk.composio).toMatchObject({ apiKey: "", sessionId: "trs_config_test" });
    expect(disk.opencodeGo).toEqual({ apiKey: "" });
    expect(disk.profile).toEqual({ name: "External Store" });
    expect(JSON.stringify(disk)).not.toContain("ak_good");
    expect(JSON.stringify(disk)).not.toContain("opencode-external");

    // A later ordinary setting save reloads config; the in-process secure-env
    // override must keep Composio configured until the next app launch.
    expect((await api("PUT", "/api/config", { profile: { name: "Grace" } })).status).toBe(200);
    expect((await api("GET", "/api/config")).body.composio).toEqual({ configured: true, mode: "self-hosted" });
  });

  it.skipIf(process.platform === "win32")("stores the credentials file with owner-only permissions", () => {
    expect(statSync(join(home, ".openmausbot", "config.json")).mode & 0o777).toBe(0o600);
  });

  it("stores and echoes the user profile (not write-only, unlike keys)", async () => {
    const put = await api("PUT", "/api/config", { profile: { name: "Ada Lovelace", email: "Ada@Example.com" } });
    expect(put.status).toBe(200);
    expect(put.body.profile).toEqual({ name: "Ada Lovelace", email: "Ada@Example.com" });

    const after = await api("GET", "/api/config");
    expect(after.body.profile).toEqual({ name: "Ada Lovelace", email: "Ada@Example.com" });
  });

  it("creates an independent webhook, accepts a delivery, deduplicates it, and rotates its secret", async () => {
    const bots = await api("GET", "/api/bots");
    const created = await api("POST", "/api/webhooks", {
      name: "Incoming build",
      prompt: "Review the incoming build event",
      botId: bots.body.bots[0].id,
      runOn: "maus",
    });
    expect(created.status).toBe(201);
    expect(created.body.ingress).toMatchObject({ available: true, baseUrl: WEBHOOK_BASE });
    expect(created.body.credential.url).toMatch(new RegExp(`^${WEBHOOK_BASE}/hooks/wh_`));

    const listed = await api("GET", "/api/webhooks");
    expect(listed.body.webhooks).toHaveLength(1);
    expect(listed.body.attempts).toEqual([]);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.credential.secret);

    const deliver = () => fetch(created.body.credential.url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "build-42" },
      body: JSON.stringify({ status: "failed", build: 42 }),
    });
    const first = await deliver();
    expect(first.status).toBe(202);
    const accepted = await first.json() as { runId: string; accepted: boolean; duplicate: boolean };
    expect(accepted).toMatchObject({ accepted: true, duplicate: false });
    const retry = await deliver();
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ accepted: true, duplicate: true, runId: accepted.runId });

    const afterDelivery = await api("GET", "/api/webhooks");
    expect(afterDelivery.body.attempts.map((attempt: { outcome: string }) => attempt.outcome)).toEqual(["accepted", "duplicate"]);

    const receipts = await api("GET", "/api/routines");
    expect(receipts.body.runs.find((run: { id: string }) => run.id === accepted.runId)).toMatchObject({
      triggerSource: "webhook",
      deliveryId: "build-42",
      routineName: "Incoming build",
    });

    const rotated = await api("POST", `/api/webhooks/${created.body.webhook.id}/rotate`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.credential.url).not.toBe(created.body.credential.url);
    expect((await deliver()).status).toBe(401);

    expect((await api("DELETE", `/api/webhooks/${created.body.webhook.id}`)).status).toBe(200);
    expect((await api("GET", "/api/webhooks")).body.webhooks).toHaveLength(0);
    if (process.platform !== "win32") {
      expect(statSync(join(home, ".openmausbot", "webhooks.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("stores OpenCode Go credentials as a configured-only status", async () => {
    const put = await api("PUT", "/api/config", { opencodeGo: { apiKey: "opencode-secret" } });
    expect(put.status).toBe(200);
    expect(put.body.opencodeGo).toEqual({ configured: true });
    expect(JSON.stringify(put.body)).not.toContain("opencode-secret");

    const after = await api("GET", "/api/config");
    expect(after.body.opencodeGo).toEqual({ configured: true });
    expect(JSON.stringify(after.body)).not.toContain("opencode-secret");
  });

  it("stores the avatar image key as configured-only status", async () => {
    try {
      const put = await api("PUT", "/api/config", { imageGen: { key: "sk-image-secret" } });
      expect(put.status).toBe(200);
      expect(put.body.imageGen).toEqual({ configured: true });
      expect(JSON.stringify(put.body)).not.toContain("sk-image-secret");

      const after = await api("GET", "/api/config");
      expect(after.body.imageGen).toEqual({ configured: true });
      expect(JSON.stringify(after.body)).not.toContain("sk-image-secret");
    } finally {
      await api("PUT", "/api/config", { imageGen: { key: "" } });
    }
  });

  it("rejects a non-string OpenCode Go API key", async () => {
    const bad = await api("PUT", "/api/config", { opencodeGo: { apiKey: 123 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("opencodeGo.apiKey");

    const array = await api("PUT", "/api/config", { opencodeGo: [] });
    expect(array.status).toBe(400);
    expect(array.body.error).toContain("opencodeGo");
  });

  it("never hands a client the provider session cursors", async () => {
    // resumeCursors is the harness's own bookkeeping. It reached clients for
    // a long time as harmless noise; once a phone is a client it is provider
    // session state leaving the machine, so nothing carrying a bot may have it.
    const listed = await api("GET", "/api/bots");
    for (const bot of listed.body.bots) {
      expect(bot).not.toHaveProperty("resumeCursors");
      for (const task of bot.tasks ?? []) expect(task).not.toHaveProperty("resumeCursors");
    }

    const created = await api("POST", "/api/bots");
    const botId = created.body.bot.id;
    try {
      expect(created.body.bot).not.toHaveProperty("resumeCursors");
      const patched = await api("PATCH", `/api/bots/${botId}`, { name: "Cursorless" });
      expect(patched.body.bot).not.toHaveProperty("resumeCursors");

      const task = await api("POST", `/api/bots/${botId}/tasks`, {});
      expect(task.body.bot).not.toHaveProperty("resumeCursors");
      for (const t of task.body.bot.tasks ?? []) expect(t).not.toHaveProperty("resumeCursors");
      // the task alone, not just the bot it came attached to
      expect(task.body.task).not.toHaveProperty("resumeCursors");
      const renamed = await api("PATCH", `/api/bots/${botId}/tasks/${task.body.task.threadId}`, {
        title: "Cursorless task",
      });
      expect(renamed.body.task).not.toHaveProperty("resumeCursors");

      // and the same on the wire, not just in the HTTP responses
      const stream = await openSse(`${BASE}/api/events`);
      try {
        await api("PATCH", `/api/bots/${botId}`, { unread: true });
        const frame = await stream.until((f) => f.kind === "bot");
        expect(frame.bot).not.toHaveProperty("resumeCursors");
        expect(JSON.stringify(frame)).not.toContain("resumeCursors");
      } finally {
        stream.close();
      }
    } finally {
      await api("DELETE", `/api/bots/${botId}`);
    }
  });

  it("validates the event inspector limit at the HTTP boundary", async () => {
    const bot = (await api("GET", "/api/bots")).body.bots[0];
    for (const value of ["nope", "0", "-1", "1.5", "Infinity"]) {
      const response = await api("GET", `/api/threads/${bot.threadId}/events?limit=${value}`);
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("positive whole number");
    }
    const ok = await api("GET", `/api/threads/${bot.threadId}/events?limit=1`);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.entries)).toBe(true);
    expect(ok.body.total).toEqual({ runtime: expect.any(Number), native: expect.any(Number) });
  });

  it("404s unknown routes with the route in the error", async () => {
    const res = await api("GET", "/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("/api/definitely-not-a-route");
  });
});

describe("section context API", () => {
  it("keeps user-managed briefs isolated by live section and clears them explicitly", async () => {
    const work = (await api("POST", "/api/bots")).body.bot;
    const personal = (await api("POST", "/api/bots")).body.bot;
    try {
      await api("PATCH", `/api/bots/${work.id}`, { section: "Work" });
      await api("PATCH", `/api/bots/${personal.id}`, { section: "Personal" });

      const saved = await api("PUT", "/api/section-context?section=Work", { text: "# Goals\n- Ship Friday" });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ section: "Work", label: "Work", text: "# Goals\n- Ship Friday" });
      expect(saved.body.updatedAt).toEqual(expect.any(Number));

      const read = await api("GET", "/api/section-context?section=%20Work%20");
      expect(read.body.text).toBe("# Goals\n- Ship Friday");
      expect((await api("GET", "/api/section-context?section=Personal")).body.text).toBe("");
      expect((await api("GET", "/api/section-context?section=")).body.label).toBe("General");

      const cleared = await api("PUT", "/api/section-context?section=Work", { text: "  " });
      expect(cleared.body).toMatchObject({ text: "", updatedAt: null });
      expect((await api("GET", "/api/section-context?section=Work")).body.text).toBe("");
    } finally {
      await api("DELETE", `/api/bots/${work.id}`);
      await api("DELETE", `/api/bots/${personal.id}`);
    }
  });

  it("rejects missing, unknown, invalid, and oversized section context writes", async () => {
    expect((await api("GET", "/api/section-context")).status).toBe(400);
    expect((await api("PUT", "/api/section-context?section=Missing", { text: "x" })).status).toBe(404);
    expect((await api("PUT", "/api/section-context?section=", { text: 7 })).status).toBe(400);
    const oversized = await api("PUT", "/api/section-context?section=", { text: "x".repeat(24_001) });
    expect(oversized.status).toBe(400);
    expect(oversized.body.error).toContain("24KB");
  });
});

// The memory routes expose plain files in the bot's workspace. The
// traversal cases matter more than the happy path here: a topic name in a
// URL is hostile-adjacent input, and the only defensible answer to "../"
// in any coat of encoding is a rejection before the filesystem is touched.
describe("bot memory API", () => {
  /** raw-path GET: fetch() normalizes "../" segments away client-side, and
   * the traversal tests need the wire to carry exactly the bytes shown */
  const rawGet = (rawPath: string): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: PORT, path: rawPath }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on("error", reject);
      req.end();
    });

  const workspaceOf = (botId: string) => join(home, ".openmausbot", "workspaces", botId);

  it("reads empty memory for a fresh bot and 404s a bot that does not exist", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const fresh = await api("GET", `/api/bots/${bot.id}/memory`);
      expect(fresh.status).toBe(200);
      expect(fresh.body).toEqual({ text: "", truncated: false, topics: [] });
      expect((await api("GET", "/api/bots/does-not-exist/memory")).status).toBe(404);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("round-trips a MEMORY.md edit and rejects non-string or oversized text", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const saved = await api("PUT", `/api/bots/${bot.id}/memory`, { text: "# Memory\n- prefers pnpm\n" });
      expect(saved.status).toBe(200);
      expect(saved.body.truncated).toBe(false);
      const read = await api("GET", `/api/bots/${bot.id}/memory`);
      expect(read.body.text).toBe("# Memory\n- prefers pnpm\n");
      // the write lands in the same file the bot's own tools read
      expect(readFileSync(join(workspaceOf(bot.id), "MEMORY.md"), "utf8")).toContain("prefers pnpm");

      expect((await api("PUT", `/api/bots/${bot.id}/memory`, { text: 7 })).status).toBe(400);
      expect((await api("PUT", `/api/bots/${bot.id}/memory`, {})).status).toBe(400);
      const big = await api("PUT", `/api/bots/${bot.id}/memory`, { text: "x".repeat(256 * 1024 + 1) });
      expect(big.status).toBe(400);
      expect(big.body.error).toContain("256KB");
      // a rejected write must leave the file exactly as it was
      expect((await api("GET", `/api/bots/${bot.id}/memory`)).body.text).toBe("# Memory\n- prefers pnpm\n");
      expect((await api("PUT", "/api/bots/does-not-exist/memory", { text: "x" })).status).toBe(404);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("lists memory/ topic files and serves one by (possibly encoded) name", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      const memDir = join(workspaceOf(bot.id), "memory");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, "deploys.md"), "- deploy = pnpm ship\n");
      writeFileSync(join(memDir, "my notes.md"), "spaced");
      writeFileSync(join(memDir, "notes.txt"), "not a topic");
      const listed = await api("GET", `/api/bots/${bot.id}/memory`);
      expect(listed.body.topics).toEqual([
        { name: "deploys.md", bytes: 21 },
        { name: "my notes.md", bytes: 6 },
      ]);

      const topic = await api("GET", `/api/bots/${bot.id}/memory/topics/deploys.md`);
      expect(topic.status).toBe(200);
      expect(topic.body).toEqual({ name: "deploys.md", text: "- deploy = pnpm ship\n" });
      // a UI-sent name arrives percent-encoded and must resolve to the same file
      expect((await api("GET", `/api/bots/${bot.id}/memory/topics/my%20notes.md`)).body.text).toBe("spaced");
      expect((await api("GET", `/api/bots/${bot.id}/memory/topics/missing.md`)).status).toBe(404);
      expect((await api("GET", "/api/bots/does-not-exist/memory/topics/deploys.md")).status).toBe(404);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses every coat of path traversal without reading the target", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    try {
      // plant real files where a traversal would land, so a hole would show
      // as leaked content and not depend on what happens to exist
      mkdirSync(workspaceOf(bot.id), { recursive: true });
      writeFileSync(join(workspaceOf(bot.id), "MEMORY.md"), "TOP-SECRET-MARKER memory");
      writeFileSync(join(home, ".openmausbot", "secret.md"), "TOP-SECRET-MARKER sibling");

      for (const name of [
        "..%2F..%2Fsecret.md", // encoded slashes
        "%2e%2e%2fsecret.md", // dots encoded too
        "..%2FMEMORY.md", // one level up, inside the workspace
        "..%5C..%5Csecret.md", // encoded backslashes (Windows separators)
        "secret%00.md", // null byte
      ]) {
        const res = await rawGet(`/api/bots/${bot.id}/memory/topics/${name}`);
        expect(res.status, name).toBe(400);
        expect(res.text, name).not.toContain("TOP-SECRET");
      }
      // a raw ../ segment is normalized away by URL parsing before routing —
      // it can only miss the route, never reach a file
      const raw = await rawGet(`/api/bots/${bot.id}/memory/topics/../../secret.md`);
      expect(raw.status).toBe(404);
      expect(raw.text).not.toContain("TOP-SECRET");
      // malformed percent-encoding is a clean 400, not a crash
      expect((await rawGet(`/api/bots/${bot.id}/memory/topics/%zz.md`)).status).toBe(400);
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
  });
});

// Hydration is one call that returns every bot's entire transcript. Over
// loopback that is right; over a phone network it is the whole problem.
describe("message pages", () => {
  /** A room whose default responder is mentions-only, posted to without any
   * mention: the user message lands and nothing answers it. That makes the
   * transcript exactly as long as we asked for — no bot turn racing the
   * assertions. */
  const seedRoom = async (count: number) => {
    const { body } = await api("GET", "/api/bots");
    const created = await api("POST", "/api/groups", { name: "Paging", memberIds: [body.bots[0].id] });
    expect(created.status).toBe(201);
    const groupId = created.body.group.id;
    // finish room setup with a mentions-only responder so no bot answers the probes
    const quiet = await api("PATCH", `/api/groups/${groupId}/setup`, {
      action: "complete",
      defaultResponder: { kind: "mentions" },
      bulletin: "",
    });
    expect(quiet.status).toBe(200);

    for (let i = 0; i < count; i++) {
      const posted = await api("POST", `/api/groups/${groupId}/messages`, { text: `page probe ${i}` });
      expect(posted.status).toBe(202);
    }
    const after = await api("GET", "/api/bots");
    return after.body.groups.find((g: { id: string }) => g.id === groupId);
  };

  it("returns the whole transcript when nothing is asked for", async () => {
    const room = await seedRoom(6);
    expect(room.messages).toHaveLength(6);
    // the original shape carries no pagination fields at all
    expect(room).not.toHaveProperty("hasMore");
  });

  it("returns only the newest n when asked", async () => {
    const full = await seedRoom(6);
    const { status, body } = await api("GET", "/api/bots?messages=2");
    expect(status).toBe(200);
    const slim = body.groups.find((g: { id: string }) => g.id === full.id);
    expect(slim.messages).toHaveLength(2);
    expect(slim.hasMore).toBe(true);
    // the newest two, not the oldest two
    expect(slim.messages.map((msg: { id: string }) => msg.id)).toEqual(
      full.messages.slice(-2).map((msg: { id: string }) => msg.id),
    );
    // and every 1:1 thread is capped by the same parameter
    expect(body.bots.every((b: { messages: unknown[] }) => b.messages.length <= 2)).toBe(true);
  });

  it("pages backwards from a message the client already holds", async () => {
    const full = await seedRoom(6);
    const fourth = full.messages[3];

    const { status, body } = await api("GET", `/api/threads/${full.threadId}/messages?before=${fourth.id}&limit=2`);
    expect(status).toBe(200);
    expect(body.messages.map((msg: { id: string }) => msg.id)).toEqual(
      full.messages.slice(1, 3).map((msg: { id: string }) => msg.id),
    );
    expect(body.hasMore).toBe(true);

    // walking back far enough reaches the top and says so
    const top = await api("GET", `/api/threads/${full.threadId}/messages?limit=200`);
    expect(top.body.hasMore).toBe(false);
    expect(top.body.messages).toHaveLength(6);
  });

  it("returns a bounded transcript window around a search result", async () => {
    const full = await seedRoom(9);
    const target = full.messages[4];
    const result = await api("GET", `/api/threads/${full.threadId}/messages?around=${target.id}&limit=5`);
    expect(result.status).toBe(200);
    expect(result.body.messages.map((message: { id: string }) => message.id)).toEqual(
      full.messages.slice(2, 7).map((message: { id: string }) => message.id),
    );
    expect(result.body.hasMore).toBe(true);
    expect((await api("GET", `/api/threads/${full.threadId}/messages?around=nope`)).status).toBe(404);
    expect((await api("GET", `/api/threads/${full.threadId}/messages?around=${target.id}&before=${target.id}`)).status).toBe(400);
  });

  it("refuses a cursor or size it cannot page from", async () => {
    const full = await seedRoom(1);
    // silently answering with the newest page would paginate in a circle
    expect((await api("GET", `/api/threads/${full.threadId}/messages?before=nope`)).status).toBe(404);
    expect((await api("GET", "/api/threads/not-a-thread/messages")).status).toBe(404);
    expect((await api("GET", "/api/bots?messages=-1")).status).toBe(400);
    expect((await api("GET", "/api/bots?messages=lots")).status).toBe(400);
    expect((await api("GET", `/api/threads/${full.threadId}/messages?limit=1.5`)).status).toBe(400);
  });

  it("404s an image on a message that has none", async () => {
    const full = await seedRoom(1);
    const res = await fetch(`${BASE}/api/threads/${full.threadId}/messages/${full.messages[0].id}/image`);
    expect(res.status).toBe(404);
  });

  it("404s an image on a conversation that does not exist, without inventing one", async () => {
    // `messagesFor` materialises and caches a ThreadState for any id it is
    // given, so an unguarded route lets a client grow that map by asking
    // for threads that were never real. The 404 is the visible half; not
    // creating the thread is the half worth having.
    const before = (await api("GET", "/api/bots")).body.bots.length;
    const res = await fetch(`${BASE}/api/threads/not-a-thread/messages/not-a-message/image`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("no such conversation");
    // and the phantom thread is not now answerable as an empty conversation
    expect((await api("GET", "/api/threads/not-a-thread/messages")).status).toBe(404);
    expect((await api("GET", "/api/bots")).body.bots.length).toBe(before);
  });
});

// A phone reconnects every time it unlocks, so "what did I miss?" has to
// be answerable without re-downloading every transcript.
describe("resumable event stream", () => {
  /** any request that makes the server broadcast exactly one frame */
  const nudge = async (botId: string) => {
    const res = await api("PATCH", `/api/bots/${botId}`, { unread: true });
    expect(res.status).toBe(200);
  };

  it("hands out a cursor and numbers every frame", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    const stream = await openSse(`${BASE}/api/events`);
    try {
      const hello = await stream.until((f) => f.kind === "hello");
      expect(hello.cursor).toMatch(/^[0-9a-f]{8}:\d+$/);
      // a cold connection offered no cursor, so there is nothing to resume
      expect(hello.resumed).toBe(false);

      await nudge(botId);
      await nudge(botId);
      // the PATCH response and the SSE frame travel on different sockets —
      // wait for the frames themselves rather than assuming they landed
      await stream.until(() => stream.frames.filter((f) => f.kind === "bot").length >= 2);
      const bots = stream.frames.filter((f) => f.kind === "bot");
      expect(bots[1].seq).toBeGreaterThan(bots[0].seq);
    } finally {
      stream.close();
    }
  });

  it("sends browser-visible heartbeats without moving the replay cursor", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;
    const first = await openSse(`${BASE}/api/events`);
    const hello = await first.until((frame) => frame.kind === "hello");
    try {
      expect(await first.until((frame) => frame.kind === "ping")).toEqual({ kind: "ping" });
      await nudge(botId);
      const next = await first.until((frame) => frame.kind === "bot" && frame.bot?.id === botId);
      expect(next.seq).toBe(Number(hello.cursor.split(":")[1]) + 1);
    } finally {
      first.close();
    }

    // Heartbeats describe connection health, not application state. A
    // reconnect from the numbered application frame remains fully resumable.
    const cursor = `${hello.cursor.split(":")[0]}:${Number(hello.cursor.split(":")[1]) + 1}`;
    const resumed = await openSse(`${BASE}/api/events?since=${encodeURIComponent(cursor)}`);
    try {
      expect((await resumed.until((frame) => frame.kind === "hello")).resumed).toBe(true);
    } finally {
      resumed.close();
    }
  });

  it("replays exactly what a disconnected client missed", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    const first = await openSse(`${BASE}/api/events`);
    const hello = await first.until((f) => f.kind === "hello");
    await nudge(botId);
    const seen = await first.until((f) => f.kind === "bot");
    first.close();
    // a real client advances its cursor as frames arrive — resume from the
    // last frame it actually saw, not from where it connected
    const cursor = `${hello.cursor.split(":")[0]}:${seen.seq}`;

    // ...three things happen while the phone is asleep...
    await nudge(botId);
    await nudge(botId);
    await nudge(botId);

    const resumed = await openSse(`${BASE}/api/events?since=${encodeURIComponent(cursor)}`);
    try {
      // ...and an old cursor still replays them, in order, without a hydrate
      const back = await resumed.until((f) => f.kind === "hello");
      expect(back.resumed).toBe(true);
      await resumed.until((f) => f.kind === "bot" && f.seq === seen.seq + 3);
      const replayed = resumed.frames.filter((f) => f.kind === "bot").map((f) => f.seq);
      expect(replayed).toEqual([seen.seq + 1, seen.seq + 2, seen.seq + 3]);
    } finally {
      resumed.close();
    }
  });

  it("resumes a browser EventSource through Last-Event-ID alone", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    const first = await openSse(`${BASE}/api/events`);
    const hello = await first.until((f) => f.kind === "hello");
    first.close();
    await nudge(botId);

    // the id: field is what a browser echoes back on its own reconnect
    const resumed = await openSse(`${BASE}/api/events`, { "last-event-id": hello.cursor });
    try {
      expect((await resumed.until((f) => f.kind === "hello")).resumed).toBe(true);
      await resumed.until((f) => f.kind === "bot");
    } finally {
      resumed.close();
    }
  });

  it("prefers a newer Last-Event-ID over the EventSource URL's stale cursor", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    const first = await openSse(`${BASE}/api/events`);
    const hello = await first.until((frame) => frame.kind === "hello");
    await nudge(botId);
    const seen = await first.until((frame) => frame.kind === "bot" && frame.bot?.id === botId);
    first.close();
    await nudge(botId);

    // Native EventSource reconnects reuse their original URL, including its
    // old query, but add Last-Event-ID for the newest numbered frame seen.
    const resumed = await openSse(
      `${BASE}/api/events?since=${encodeURIComponent(hello.cursor)}`,
      { "last-event-id": `${hello.cursor.split(":")[0]}:${seen.seq}` },
    );
    try {
      expect((await resumed.until((frame) => frame.kind === "hello")).resumed).toBe(true);
      await resumed.until((frame) => frame.kind === "bot" && frame.bot?.id === botId);
      const replayed = resumed.frames.filter((frame) => frame.kind === "bot" && frame.bot?.id === botId);
      expect(replayed.map((frame) => frame.seq)).toEqual([seen.seq + 1]);
    } finally {
      resumed.close();
    }
  });

  it("keeps delivering everything else when a client declines screen frames", async () => {
    const { body } = await api("GET", "/api/bots");
    const botId = body.bots[0].id;

    // a phone on cellular opts out of the live desktop captures; nothing
    // else about its stream changes
    const stream = await openSse(`${BASE}/api/events?screens=off`);
    try {
      expect((await stream.until((f) => f.kind === "hello")).resumed).toBe(false);
      await nudge(botId);
      await stream.until((f) => f.kind === "bot");
      expect(stream.frames.some((f) => f.kind === "screen")).toBe(false);
    } finally {
      stream.close();
    }
  });

  it("refuses a cursor it cannot honour instead of replaying the wrong run", async () => {
    for (const cursor of ["deadbeef:1", "not-a-cursor", "12345678:999999"]) {
      const stream = await openSse(`${BASE}/api/events?since=${encodeURIComponent(cursor)}`);
      try {
        const hello = await stream.until((f) => f.kind === "hello");
        // false is the signal to hydrate — a partial replay would leave a
        // permanent hole in the client's state
        expect(hello.resumed).toBe(false);
      } finally {
        stream.close();
      }
    }
  });
});

describe("instance CLI override API", () => {
  it("round-trips a set, clear, and rejects bad input", async () => {
    // ghost is the fixture's one shadow instance (unknown driver)
    const set = await api("PATCH", "/api/instances/ghost", { cli: "/opt/ghost/wrapper sub" });
    expect(set.status).toBe(200);
    const setRow = set.body.instances.find((i: any) => i.instanceId === "ghost");
    expect(setRow.cli).toBe("/opt/ghost/wrapper sub");

    // persisted for real: the next fleet rebuild reads it back
    const cleared = await api("PATCH", "/api/instances/ghost", { cli: "" });
    expect(cleared.status).toBe(200);
    const clearedRow = cleared.body.instances.find((i: any) => i.instanceId === "ghost");
    expect(clearedRow.cli).toBeUndefined();

    expect((await api("PATCH", "/api/instances/nope", { cli: "/x" })).status).toBe(404);
    expect((await api("PATCH", "/api/instances/ghost", { cli: 42 })).status).toBe(400);
    expect((await api("PATCH", "/api/instances/ghost", { cli: "/x\ny" })).status).toBe(400);
  });

  it("echoes a path-ish name back as the only cli candidate", async () => {
    const res = await api("GET", "/api/cli-candidates?name=/opt/definitely/not/here");
    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual(["/opt/definitely/not/here"]);
    expect((await api("GET", "/api/cli-candidates?name=")).body.candidates).toEqual([]);
  });

  it("reports a missing binary as a failed probe with install info", async () => {
    const res = await api("POST", "/api/cli-test", { cli: "/no/such/binary-anywhere", driver: "claudeAgent" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toContain("isn't installed");
    expect(res.body.install?.docsUrl).toBe("https://claude.com/claude-code");
  });

  it("probes the complete wrapper with fixed arguments and no inherited credentials", async () => {
    const script = join(home, "cli-wrapper-probe.mjs");
    writeFileSync(
      script,
      `if (process.argv.slice(2).join(" ") !== "fixed --version") process.exit(9);\nif (process.env.COMPOSIO_API_KEY) process.exit(8);\nconsole.log("wrapper-ok");\n`,
    );
    const cli = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} fixed`;
    const res = await api("POST", "/api/cli-test", { cli });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, version: "wrapper-ok" });
  });

  it("reports excessive probe output without presenting install guidance", async () => {
    const script = join(home, "cli-noisy-probe.mjs");
    writeFileSync(script, `process.stdout.write("x".repeat(70 * 1024));\n`);
    const cli = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    const res = await api("POST", "/api/cli-test", { cli, driver: "claudeAgent" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toContain("more than 64 KiB");
    expect(res.body.install).toBeUndefined();
  });

  it("rejects overlapping provider configuration writes", async () => {
    const slowConfigWrite = api("PUT", "/api/config", { box: { token: "box_slow" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const overlapping = await api("PATCH", "/api/instances/ghost", { cli: "/tmp/ghost-overlap" });
    expect(overlapping.status).toBe(409);
    expect((await slowConfigWrite).status).toBe(200);
  });
});

describe("computer control API (who is driving)", () => {
  let botId = "";

  beforeAll(async () => {
    const created = await api("POST", "/api/bots", {});
    botId = created.body.bot.id;
  });

  it("starts disengaged", async () => {
    const res = await api("GET", `/api/bots/${botId}/computer/control`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ held: false, helpReason: null, heldSinceMs: null });
  });

  it("take → held, broadcast on the wire, release → disengaged", async () => {
    const sse = await openSse(`${BASE}/api/events`);
    try {
      const took = await api("POST", `/api/bots/${botId}/computer/control`, { action: "take" });
      expect(took.status).toBe(200);
      expect(took.body.held).toBe(true);
      const frame = await sse.until(
        (f) => f.kind === "computer-control" && f.botId === botId && f.held === true,
      );
      expect(frame.helpReason).toBeNull();
      const hydrated = await api("GET", "/api/bots");
      expect(hydrated.body.computerControl[botId]).toEqual({ held: true, helpReason: null });
      const released = await api("POST", `/api/bots/${botId}/computer/control`, { action: "release" });
      expect(released.body.held).toBe(false);
    } finally {
      sse.close();
    }
  });

  it("atomically owns and conditionally releases a workspace lease without returning its id", async () => {
    const owner = "lease_5b6bbbd2-b88b-4c50-a748-ec87f332662f";
    const other = "lease_ed602995-306f-480a-8817-e8d8c8fe7d90";
    const took = await api("POST", `/api/bots/${botId}/computer/control`, {
      action: "take",
      controlLeaseId: owner,
    });
    expect(took.body).toMatchObject({ held: true, owned: true, acquired: true });
    expect(JSON.stringify(took.body)).not.toContain(owner);

    const blocked = await api("POST", `/api/bots/${botId}/computer/control`, {
      action: "take",
      controlLeaseId: other,
    });
    expect(blocked.body).toMatchObject({ held: true, owned: false, acquired: false });

    const wrongRelease = await api("POST", `/api/bots/${botId}/computer/control`, {
      action: "release",
      controlLeaseId: other,
    });
    expect(wrongRelease.body).toMatchObject({ held: true, released: false });

    const released = await api("POST", `/api/bots/${botId}/computer/control`, {
      action: "release",
      controlLeaseId: owner,
    });
    expect(released.body).toMatchObject({ held: false, released: true });
    expect(JSON.stringify(released.body)).not.toContain(owner);
  });

  it("rejects malformed workspace leases without echoing them", async () => {
    const invalid = "bad lease value";
    const res = await api("POST", `/api/bots/${botId}/computer/control`, {
      action: "take",
      controlLeaseId: invalid,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(invalid);
  });

  it("refuses an unknown action and an unknown bot", async () => {
    const bad = await api("POST", `/api/bots/${botId}/computer/control`, { action: "hijack" });
    expect(bad.status).toBe(400);
    const ghost = await api("GET", "/api/bots/nope/computer/control");
    expect(ghost.status).toBe(404);
  });

  it("refuses a form-shaped POST — control mutations are JSON-only", async () => {
    const res = await fetch(`${BASE}/api/bots/${botId}/computer/control`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "action=take",
    });
    expect(res.status).toBe(415);
  });

  it("keeps the internal who-is-driving endpoint behind the boot token", async () => {
    const res = await fetch(`${BASE}/api/internal/computer-control?botId=${botId}`);
    expect(res.status).toBe(401);
  });
});
