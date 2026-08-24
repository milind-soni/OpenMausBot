// API smoke test: boots the real harness server (node server/index.ts)
// against a throwaway home directory and exercises the HTTP surface the
// app depends on. The config pins one deliberately-unknown driver so the
// suite is deterministic with or without agent CLIs installed — and pins
// the shadow-instance behavior end to end while it's at it.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";
import { IMAGE_MAX_BYTES } from "./attachments.ts";

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

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
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
        expect(attempted.body.error).toMatch(/at least one bot/i);
      }
      const state = (await api("GET", "/api/bots")).body;
      expect(state.groups.find((group: { id: string }) => group.id === room.id).memberIds).toEqual([bot.id]);
    } finally {
      await api("DELETE", `/api/groups/${room.id}`);
      await api("DELETE", `/api/bots/${bot.id}`);
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
        modelSelection: { instanceId: "ghost" },
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
    expect(before.body.features).toEqual({ skillRecorder: false });

    const saved = await api("PATCH", "/api/config", {
      features: { skillRecorder: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.features).toEqual({ skillRecorder: true });

    const disk = JSON.parse(readFileSync(join(home, ".openmausbot", "config.json"), "utf8"));
    expect(disk.features).toEqual({ skillRecorder: true });

    await api("PATCH", "/api/config", { features: { skillRecorder: false } });
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
