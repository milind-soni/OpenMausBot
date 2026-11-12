// API smoke test: boots the real harness server (node server/index.ts)
// against a throwaway home directory and exercises the HTTP surface the
// app depends on. The config pins one deliberately-unknown driver so the
// suite is deterministic with or without agent CLIs installed — and pins
// the shadow-instance behavior end to end while it's at it.
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess;
let home: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "gbs-api-test-"));
  // a fleet of exactly one unknown driver: no CLI probes, no network
  mkdirSync(join(home, ".gbs"), { recursive: true });
  writeFileSync(
    join(home, ".gbs", "config.json"),
    JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }),
  );

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      GBS_PORT: String(PORT),
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
  child?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
    setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
  });
  rmSync(home, { recursive: true, force: true });
});

describe("harness HTTP API", () => {
  it("registers and creates host projects for browser clients", async () => {
    const parentPath = join(home, "workspace");
    const existingPath = join(parentPath, "existing-app");
    mkdirSync(existingPath, { recursive: true });

    const added = await api("POST", "/api/projects/add-existing", { projectPath: existingPath });
    expect(added.status).toBe(201);
    expect(added.body.project).toMatchObject({ path: realpathSync(existingPath), source: "existing", missing: false });

    const duplicate = await api("POST", "/api/projects/add-existing", { projectPath: existingPath });
    expect(duplicate.body.project.id).toBe(added.body.project.id);

    const created = await api("POST", "/api/projects/create", { parentPath, name: "new-app" });
    expect(created.status).toBe(201);
    expect(created.body.project).toMatchObject({ path: join(realpathSync(parentPath), "new-app"), source: "created" });
    expect(existsSync(join(parentPath, "new-app"))).toBe(true);

    const listed = await api("GET", "/api/projects");
    expect(listed.body.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: added.body.project.id, source: "existing", available: true }),
      expect.objectContaining({ id: created.body.project.id, source: "created", available: true }),
    ]));

    expect((await api("POST", "/api/projects/create", { parentPath, name: "../escape" })).status).toBe(400);
    expect((await api("POST", "/api/projects/clone", { repositoryUrl: "https://example.com/a/b", destinationPath: join(parentPath, "clone") })).status).toBe(400);
  });

  it("limits browser create and clone destinations to the real home directory", async () => {
    const outside = mkdtempSync(join(tmpdir(), "gbs-outside-home-"));
    try {
      const create = await api("POST", "/api/projects/create", { parentPath: outside, name: "blocked-create" });
      expect(create.status).toBe(400);
      expect(create.body.error).toMatch(/inside your home directory/);
      expect(existsSync(join(outside, "blocked-create"))).toBe(false);

      const clone = await api("POST", "/api/projects/clone", {
        repositoryUrl: "https://github.com/example/repo",
        destinationPath: join(outside, "blocked-clone"),
      });
      expect(clone.status).toBe(400);
      expect(clone.body.error).toMatch(/inside your home directory/);
      expect(existsSync(join(outside, "blocked-clone"))).toBe(false);

      if (process.platform !== "win32") {
        const link = join(home, "outside-link");
        symlinkSync(outside, link, "dir");
        const viaLink = await api("POST", "/api/projects/create", { parentPath: link, name: "blocked-link" });
        expect(viaLink.status).toBe(400);
        expect(viaLink.body.error).toMatch(/inside your home directory/);
        expect(existsSync(join(outside, "blocked-link"))).toBe(false);
      }

      const registered = await api("POST", "/api/projects/add-existing", { projectPath: outside });
      expect(registered.status).toBe(201);
      expect(registered.body.project.path).toBe(realpathSync(outside));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("guards every browser project mutation before routing", async () => {
    const parentPath = join(home, "workspace");
    const existingPath = join(parentPath, "existing-app");
    const routes = [
      ["/api/projects/add-existing", { projectPath: existingPath }],
      ["/api/projects/create", { parentPath, name: "cross-origin-create" }],
      ["/api/projects/clone", { repositoryUrl: "https://github.com/example/repo", destinationPath: join(parentPath, "cross-origin-clone") }],
    ] as const;
    for (const [route, body] of routes) {
      const response = await fetch(`${BASE}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify(body),
      });
      expect(response.status, route).toBe(403);
      expect(((await response.json()) as { error: string }).error).toMatch(/cross-origin/);
    }
    expect(existsSync(join(parentPath, "cross-origin-create"))).toBe(false);
    expect(existsSync(join(parentPath, "cross-origin-clone"))).toBe(false);

    const fetchMetadata = await fetch(`${BASE}/api/projects/create`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ parentPath, name: "cross-site-create" }),
    });
    expect(fetchMetadata.status).toBe(403);
    expect(existsSync(join(parentPath, "cross-site-create"))).toBe(false);
  });

  it("identifies itself on /api/health", async () => {
    const { status, body } = await api("GET", "/api/health");
    expect(status).toBe(200);
    expect(body.app).toBe("gerer-build-studio");
    expect(typeof body.pid).toBe("number");
  });

  it("seeds the default team with greetings", async () => {
    const { status, body } = await api("GET", "/api/bots");
    expect(status).toBe(200);
    expect(body.bots.length).toBeGreaterThanOrEqual(1);
    expect(body.bots[0].messages.length).toBeGreaterThanOrEqual(2);
  });

  it("creates, updates, conflicts, broadcasts, and deletes shared tasks", async () => {
    const streamAbort = new AbortController();
    const stream = await fetch(`${BASE}/api/events`, { signal: streamAbort.signal });
    const reader = stream.body!.getReader();
    const nextTaskFrame = (kind: string) => new Promise<any>((resolve, reject) => {
      const decoder = new TextDecoder();
      let buffer = "";
      const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${kind}`)), 2_000);
      const read = async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) throw new Error("event stream ended");
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";
          for (const chunk of chunks) {
            const line = chunk.split("\n").find((entry) => entry.startsWith("data: "));
            if (!line) continue;
            const frame = JSON.parse(line.slice(6));
            if (frame.kind === kind) {
              clearTimeout(timeout);
              resolve(frame);
              return;
            }
          }
        }
      };
      void read().catch(reject);
    });

    const createdFrame = nextTaskFrame("task.created");
    const created = await api("POST", "/api/tasks", {
      title: "Build shared board",
      type: "feature",
      priority: "high",
      tags: ["agents"],
    });
    expect(created.status).toBe(201);
    expect(created.body.task).toMatchObject({ title: "Build shared board", revision: 1, status: "todo" });
    await expect(createdFrame).resolves.toMatchObject({ kind: "task.created", task: { id: created.body.task.id } });

    const listed = await api("GET", "/api/tasks");
    expect(listed.body.tasks).toContainEqual(expect.objectContaining({ id: created.body.task.id }));
    expect(Array.isArray(listed.body.projects)).toBe(true);

    const projectsRes = await api("GET", "/api/projects");
    expect(projectsRes.status).toBe(200);
    expect(Array.isArray(projectsRes.body.projects)).toBe(true);

    const updatedFrame = nextTaskFrame("task.updated");
    const updated = await api("PATCH", `/api/tasks/${created.body.task.id}`, {
      revision: created.body.task.revision,
      patch: { status: "doing", priority: "urgent" },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.task).toMatchObject({ status: "doing", priority: "urgent", revision: 2 });
    await expect(updatedFrame).resolves.toMatchObject({ task: { revision: 2 } });

    const stale = await api("PATCH", `/api/tasks/${created.body.task.id}`, {
      revision: 1,
      patch: { title: "Overwrite" },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.latest).toMatchObject({ title: "Build shared board", revision: 2 });

    const bots = (await api("GET", "/api/bots")).body.bots;
    const delegated = await api("POST", `/api/tasks/${created.body.task.id}/delegate`, {
      revision: 2,
      botId: bots[0].id,
    });
    expect(delegated.status).toBe(200);
    expect(delegated.body.task.assigneeBotId).toBe(bots[0].id);
    expect((await api("POST", `/api/tasks/${created.body.task.id}/delegate`, { revision: 3, botId: "missing" })).status).toBe(404);

    const deleted = await api("DELETE", `/api/tasks/${created.body.task.id}`, { revision: delegated.body.task.revision });
    expect(deleted).toEqual({ status: 200, body: { ok: true } });
    expect((await api("GET", "/api/tasks")).body.tasks.find((task: { id: string }) => task.id === created.body.task.id)).toBeUndefined();
    streamAbort.abort();
  });

  it("reconciles an externally replaced task file on the next board request", async () => {
    const created = await api("POST", "/api/tasks", { title: "Created through the API" });
    const file = join(home, ".gbs", "tasks.json");
    const records = JSON.parse(readFileSync(file, "utf8"));
    const imported = { ...records.find((task: { id: string }) => task.id === created.body.task.id), id: "external-import", title: "Imported externally" };
    writeFileSync(file, JSON.stringify([...records, imported], null, 2));

    const listed = await api("GET", "/api/tasks");

    expect(listed.status).toBe(200);
    expect(listed.body.tasks).toContainEqual(expect.objectContaining({ id: "external-import", title: "Imported externally" }));
    await api("DELETE", `/api/tasks/${created.body.task.id}`, { revision: created.body.task.revision });
    await api("DELETE", "/api/tasks/external-import", { revision: imported.revision });
  });

  it("keeps agent task routes behind the internal bearer token", async () => {
    const listed = await api("GET", "/api/internal/tasks");
    expect(listed).toEqual({ status: 401, body: { error: "unauthorized" } });
    const created = await api("POST", "/api/internal/tasks", { title: "Spoofed agent task" });
    expect(created).toEqual({ status: 401, body: { error: "unauthorized" } });
    const deleted = await api("DELETE", "/api/internal/tasks/some-id", { revision: 1 });
    expect(deleted).toEqual({ status: 401, body: { error: "unauthorized" } });
  });

  it("describes the configured fleet, shadows included", async () => {
    const { status, body } = await api("GET", "/api/instances");
    expect(status).toBe(200);
    expect(body.instances).toHaveLength(1);
    expect(body.instances[0]).toMatchObject({
      instanceId: "ghost",
      driverKind: "not-a-real-driver",
      displayName: "Ghost",
      snapshot: { state: "unavailable" },
    });
    expect(body.instances[0].snapshot.reason).toContain("not-a-real-driver");
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

    const deleted = await api("DELETE", `/api/bots/${bot.id}`);
    expect(deleted.status).toBe(200);
    const after = await api("GET", "/api/bots");
    expect(after.body.bots.find((b: { id: string }) => b.id === bot.id)).toBeUndefined();
  });

  it("clears direct and room history without deleting either conversation", async () => {
    const seeded = (await api("GET", "/api/bots")).body.bots[0];
    const created = await api("POST", "/api/bots");
    const bot = created.body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "History room",
      memberIds: [bot.id, seeded.id],
    })).body.group;
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "A room note without a mention" })).status).toBe(202);

    const dataDir = join(home, ".gbs");
    const eventLog = join(dataDir, "events", `${bot.threadId}.ndjson`);
    const nativeLog = join(dataDir, "native", `${bot.threadId}.ndjson`);
    writeFileSync(eventLog, "old event\n");
    writeFileSync(nativeLog, "old native event\n");

    const streamAbort = new AbortController();
    const stream = await fetch(`${BASE}/api/events`, { signal: streamAbort.signal });
    const reader = stream.body!.getReader();
    const clearedFrame = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new Error("event stream ended before thread.cleared");
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.split("\n").find((entry) => entry.startsWith("data: "));
          if (!line) continue;
          const frame = JSON.parse(line.slice(6));
          if (frame.kind === "thread.cleared" && frame.threadId === bot.threadId) return frame;
        }
      }
    })();

    const direct = await api("DELETE", `/api/threads/${bot.threadId}/messages`);
    expect(direct).toEqual({ status: 200, body: { ok: true } });
    await expect(Promise.race([
      clearedFrame,
      new Promise((_, reject) => setTimeout(() => reject(new Error("thread.cleared was not broadcast")), 2_000)),
    ])).resolves.toMatchObject({ kind: "thread.cleared", threadId: bot.threadId });
    streamAbort.abort();

    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: `@${bot.name} keep working` })).status).toBe(202);
    const activeClear = await api("DELETE", `/api/threads/${room.threadId}/messages`);
    expect(activeClear.status).toBe(409);
    expect(activeClear.body.error).toContain("finish");
    expect((await api("POST", `/api/groups/${room.id}/interrupt`)).status).toBe(200);

    const roomClear = await api("DELETE", `/api/threads/${room.threadId}/messages`);
    expect(roomClear.status).toBe(200);
    expect((await api("DELETE", "/api/threads/not-owned/messages")).status).toBe(404);

    const after = (await api("GET", "/api/bots")).body;
    expect(after.bots.find((candidate: { id: string }) => candidate.id === bot.id)).toMatchObject({
      id: bot.id,
      threadId: bot.threadId,
      messages: [],
      activeLeafId: null,
      unread: false,
      resumeCursors: {},
    });
    expect(after.groups.find((candidate: { id: string }) => candidate.id === room.id)).toMatchObject({
      id: room.id,
      threadId: room.threadId,
      messages: [],
      unread: false,
    });
    expect(existsSync(eventLog)).toBe(false);
    expect(existsSync(nativeLog)).toBe(false);
    expect((await api("DELETE", `/api/groups/${room.id}`)).status).toBe(200);
    expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
  });

  it("sets and clears a room's task-board project", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Project room", memberIds: [bot.id] })).body.group;
    expect(room.projectId).toBeUndefined();

    const set = await api("PATCH", `/api/groups/${room.id}`, { projectId: "demo-project" });
    expect(set.status).toBe(200);
    expect(set.body.group.projectId).toBe("demo-project");

    const refetched = (await api("GET", "/api/bots")).body.groups.find((g: { id: string }) => g.id === room.id);
    expect(refetched.projectId).toBe("demo-project");

    const cleared = await api("PATCH", `/api/groups/${room.id}`, { projectId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.group.projectId).toBeNull();

    const rejected = await api("PATCH", `/api/groups/${room.id}`, { projectId: 42 });
    expect(rejected.status).toBe(400);

    expect((await api("DELETE", `/api/groups/${room.id}`)).status).toBe(200);
    expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
  });

  it("persists an answered onboarding card", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const card = bot.messages.find((m: { kind: string }) => m.kind === "options");
    const res = await api("PATCH", `/api/bots/${bot.id}/cards/${card.id}`, { answered: card.card.options[0] });
    expect(res.status).toBe(200);
    expect(res.body.message.card.answered).toBe(card.card.options[0]);
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

  it("has no cloud computer routes or config fields", async () => {
    const { body } = await api("GET", "/api/bots");
    const id = body.bots[0].id;
    expect((await api("GET", `/api/bots/${id}/computer`)).status).toBe(404);
    for (const action of ["provision", "join", "sleep", "exec", "screenshot"]) {
      expect((await api("POST", `/api/bots/${id}/computer/${action}`, {})).status).toBe(404);
    }
    expect((await api("GET", "/api/config")).body).not.toHaveProperty("box");
    expect((await api("PUT", "/api/config", { box: { token: "obsolete-secret" } })).status).toBe(400);
  });

  it("serves usage through the request guard and persists display choices without reloading providers", async () => {
    const before = await api("GET", "/api/usage");
    expect(before.status).toBe(200);
    expect(before.body.engines).toEqual([expect.objectContaining({ instanceId: "ghost", status: "unknown", windows: [] })]);
    const controller = new AbortController();
    const stream = await fetch(`${BASE}/api/events`, { signal: controller.signal });
    try {
      const reader = stream.body!.getReader();
      let text = "";
      while (!text.includes('"kind":"usage"')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Stream ended before usage frame");
        text += new TextDecoder().decode(chunk.value);
      }
      expect(text).toContain('"instanceId":"ghost"');
    } finally { controller.abort(); }
    const rejected = await fetch(`${BASE}/api/usage`, { headers: { origin: "https://untrusted.example" } });
    expect(rejected.status).toBe(403);
    const saved = await api("PUT", "/api/config", { usageDisplay: { show: false, hiddenInstances: ["ghost"] } });
    expect(saved.status).toBe(200);
    expect((await api("GET", "/api/config")).body.usageDisplay).toEqual({ show: false, hiddenInstances: ["ghost"] });
    expect((await api("PUT", "/api/config", { usageDisplay: { show: "yes", hiddenInstances: [] } })).status).toBe(400);
  });

  it("saves config keys write-only and reports booleans", async () => {
    const before = await api("GET", "/api/config");
    expect(before.body.xai).toEqual({ configured: false });

    const put = await api("PUT", "/api/config", { xai: { key: "tok_secret_value" } });
    expect(put.status).toBe(200);
    expect(put.body.xai).toEqual({ configured: true });
    expect(JSON.stringify(put.body)).not.toContain("tok_secret_value");

    const after = await api("GET", "/api/config");
    expect(after.body.xai).toEqual({ configured: true });
    expect(JSON.stringify(after.body)).not.toContain("tok_secret_value");

    const nothing = await api("PUT", "/api/config", {});
    expect(nothing.status).toBe(400);
  });

  it("stores and echoes the user profile (not write-only, unlike keys)", async () => {
    const put = await api("PUT", "/api/config", { profile: { name: "Ada Lovelace", email: "Ada@Example.com" } });
    expect(put.status).toBe(200);
    expect(put.body.profile).toEqual({ name: "Ada Lovelace", email: "Ada@Example.com" });

    const after = await api("GET", "/api/config");
    expect(after.body.profile).toEqual({ name: "Ada Lovelace", email: "Ada@Example.com" });
  });

  it("connects Trello through the token callback and disconnects write-only, without a key or network", async () => {
    const before = await api("GET", "/api/config");
    expect(before.body.trello).toEqual({ keyConfigured: false, configured: false });

    // no API key yet — the browser authorize URL can't be built
    const noKey = await api("GET", "/api/trello/authorize-url");
    expect(noKey.status).toBe(400);

    const withKey = await api("PUT", "/api/config", { trello: { key: "app-key" } });
    expect(withKey.body.trello).toEqual({ keyConfigured: true, configured: false });

    const authorize = await api("GET", "/api/trello/authorize-url");
    expect(authorize.status).toBe(200);
    const url = new URL(authorize.body.url);
    expect(url.hostname).toBe("trello.com");
    expect(url.searchParams.get("key")).toBe("app-key");

    // the /trello/callback page hands the token to this route (see its inline script)
    const tokened = await api("POST", "/api/trello/token", { token: "user-token" });
    expect(tokened.status).toBe(200);
    expect(tokened.body.trello).toEqual({ keyConfigured: true, configured: true });
    expect(JSON.stringify(tokened.body)).not.toContain("user-token");

    // disconnect goes through the same write-only PUT convention as other keys
    const disconnected = await api("PUT", "/api/config", { trello: { token: "" } });
    expect(disconnected.body.trello).toEqual({ keyConfigured: true, configured: false });
  });

  it("serves the Trello callback page and gates board/link routes on connection state", async () => {
    const page = await fetch(`${BASE}/trello/callback`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("api/trello/token");

    const boards = await api("GET", "/api/trello/boards");
    expect(boards.body).toEqual({ configured: false, boards: [] });

    expect((await api("GET", "/api/trello/links")).body).toEqual({ links: [] });

    const linkMissingProject = await api("POST", "/api/trello/links/no-such-project", { createBoard: "New board" });
    expect(linkMissingProject.status).toBe(400); // Trello isn't connected yet in this isolated server instance

    expect((await api("DELETE", "/api/trello/links/no-such-project")).body).toEqual({ ok: true });
    expect((await api("POST", "/api/trello/links/no-such-project/sync")).status).toBe(404);
  });

  it("accepts messages with attachments even when text is empty and enforces validation", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];

    // Completely empty message (no text, no attachments) is rejected with 400
    const emptyRes = await api("POST", `/api/bots/${bot.id}/messages`, { text: "", attachments: [] });
    expect(emptyRes.status).toBe(400);
    expect(emptyRes.body.error).toContain("text or attachment required");

    const att = {
      id: "att-smoke-1",
      name: "sample.txt",
      mimeType: "text/plain",
      size: 14,
      dataUrl: "data:text/plain;base64,SGVsbG8gV29ybGQhCg==",
      textContent: "Hello World!\n",
    };

    // Bot route passes validation and attempts turn (which reports ghost instance unavailable)
    const botRes = await api("POST", `/api/bots/${bot.id}/messages`, {
      text: "",
      attachments: [att],
    });
    expect(botRes.status).toBe(409);
    expect(botRes.body.error).toContain("unavailable");

    // Group message with attachments returns 202 accepted
    const groupRes = await api("POST", "/api/groups", { memberIds: [bot.id], name: "Attachment Room" });
    expect(groupRes.status).toBe(201);
    const group = groupRes.body.group;

    const groupSend = await api("POST", `/api/groups/${group.id}/messages`, {
      text: "",
      attachments: [att],
    });
    expect(groupSend.status).toBe(202);

    const botsList = await api("GET", "/api/bots");
    const updatedGroup = botsList.body.groups.find((g: { id: string }) => g.id === group.id);
    const userGroupMsg = updatedGroup.messages.find((m: any) => m.role === "user");
    expect(userGroupMsg).toBeDefined();
    expect(userGroupMsg.attachments[0].name).toBe("sample.txt");
  });

  it("404s unknown routes with the route in the error", async () => {
    const res = await api("GET", "/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("/api/definitely-not-a-route");
  });
  it("refuses cross-origin, foreign-Host, and non-JSON requests", async () => {
    const crossOrigin = await fetch(`${BASE}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ profile: { name: "pwned" } }),
    });
    expect(crossOrigin.status).toBe(403);

    const textPlain = await fetch(`${BASE}/api/config`, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ profile: { name: "pwned" } }),
    });
    expect(textPlain.status).toBe(415);
    expect((await api("GET", "/api/config")).body.profile.name).not.toBe("pwned");

    // DNS rebinding: a loopback connection carrying an attacker's hostname
    const rebindStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: PORT, path: "/api/bots", headers: { host: `rebind.evil.example:${PORT}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(rebindStatus).toBe(403);
  });

  it("serves read-only project preview files, rejects outside paths/symlinks/bad types, and pushes reload events", async () => {
    const projectDir = join(home, "workspace", "preview-project");
    const outsideDir = mkdtempSync(join(tmpdir(), "gbs-preview-outside-"));
    mkdirSync(join(projectDir, "docs"), { recursive: true });
    writeFileSync(join(projectDir, "index.html"), "<!doctype html><h1>Hello Preview</h1>");
    writeFileSync(join(projectDir, "docs", "guide.md"), "# Guide\nPlain words.");
    for (const [name, content] of Object.entries({ "style.css": "body { color: red }", "app.js": "console.log('preview')", "module.mjs": "export const value = 1", "font.woff2": "font-data", "photo.png": "image-data", "report.pdf": "%PDF-1.4" })) {
      writeFileSync(join(projectDir, name), content);
    }
    writeFileSync(join(projectDir, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    writeFileSync(join(projectDir, "secret.env"), "API_KEY=top-secret");
    writeFileSync(join(outsideDir, "outside.html"), "<h1>Outside</h1>");

    try {
      const reg = await api("POST", "/api/projects/add-existing", { projectPath: projectDir });
      expect(reg.status).toBe(201);
      const projectId = reg.body.project.id as string;

      if (process.platform !== "win32") {
        symlinkSync(join(outsideDir, "outside.html"), join(projectDir, "escape.html"));
        symlinkSync(outsideDir, join(projectDir, "escape-dir"), "dir");
        symlinkSync(join(projectDir, "secret.env"), join(projectDir, "disguised.html"));
      }

      // 1. List previewable files (excludes secret.env and outside symlinks)
      const listRes = await api("GET", `/api/preview/files?projectId=${encodeURIComponent(projectId)}`);
      expect(listRes.status).toBe(200);
      const listedPaths = listRes.body.files.map((f: { path: string }) => f.path);
      expect(listedPaths).toEqual(expect.arrayContaining(["index.html", "docs/guide.md", "logo.svg"]));
      expect(listedPaths).not.toContain("secret.env");
      expect(listedPaths).not.toContain("escape.html");
      expect(listedPaths).not.toContain("disguised.html");

      // 2. Serve valid HTML and Markdown files
      const htmlRes = await fetch(
        `${BASE}/api/preview/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent("index.html")}`,
      );
      expect(htmlRes.status).toBe(200);
      expect(htmlRes.headers.get("content-type")).toContain("text/html");
      const htmlBody = await htmlRes.text();
      expect(htmlBody).toContain("Hello Preview");
      const assetBase = htmlBody.match(/<base href="([^"]+)">/)![1];
      const opaqueHeaders = { origin: "null", "sec-fetch-site": "cross-site" };
      for (const [name, mime] of [["style.css", "text/css"], ["app.js", "text/javascript"], ["module.mjs", "text/javascript"], ["font.woff2", "font/woff2"], ["photo.png", "image/png"]]) {
        const asset = await fetch(`${BASE}${assetBase}${name}`, { headers: opaqueHeaders });
        expect(asset.status).toBe(200);
        expect(asset.headers.get("content-type")).toContain(mime);
        expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
        expect(asset.headers.get("access-control-allow-origin")).toBe("*");
        expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(0);
      }
      expect(listedPaths).not.toContain("style.css");
      const assetSvg = await fetch(`${BASE}${assetBase}logo.svg`, { headers: opaqueHeaders });
      expect(assetSvg.headers.get("content-security-policy")).toContain("sandbox");
      expect(assetSvg.headers.get("content-security-policy")).not.toContain("allow-same-origin");
      const pdf = await fetch(`${BASE}/api/preview/file/${projectId}/report.pdf`);
      expect(pdf.headers.get("content-type")).toBe("application/pdf");
      expect(pdf.headers.get("content-security-policy")).not.toContain("sandbox");
      for (const target of ["secret.env", "%2e%2e%2foutside.html", "escape.html", "escape-dir/outside.html"]) {
        if (process.platform === "win32" && target.startsWith("escape")) continue;
        const denied = await fetch(`${BASE}${assetBase}${target}`, { headers: opaqueHeaders });
        expect([403, 415]).toContain(denied.status);
      }
      expect((await fetch(`${BASE}${assetBase.replace(/asset\/[a-f0-9]{64}/, `asset/${"0".repeat(64)}`)}style.css`, { headers: opaqueHeaders })).status).toBe(403);
      expect((await fetch(`${BASE}${assetBase}style.css`, { method: "POST", headers: opaqueHeaders })).status).toBe(403);
      for (const target of ["/api/bots", "/api/preview/files", `/api/preview/file/${projectId}/style.css`]) {
        expect((await fetch(`${BASE}${target}`, { headers: opaqueHeaders })).status).toBe(403);
      }
      expect((await fetch(`${BASE}/api/bots/probe/messages`, { method: "POST", headers: { ...opaqueHeaders, "content-type": "application/json" }, body: JSON.stringify({ text: "must never send" }) })).status).toBe(403);
      // Script in a previewed page must not run with the app's origin: an opaque
      // (sandboxed) origin makes its API calls fail the same-origin guard.
      const htmlCsp = htmlRes.headers.get("content-security-policy") ?? "";
      expect(htmlCsp).toMatch(/(^|;\s*)sandbox\b/);
      expect(htmlCsp).not.toContain("allow-same-origin");
      const svgRes = await fetch(`${BASE}/api/preview/file?projectId=${encodeURIComponent(projectId)}&path=logo.svg`);
      expect(svgRes.headers.get("content-security-policy") ?? "").toMatch(/(^|;\s*)sandbox\b/);
      const fromSandboxedPage = await fetch(`${BASE}/api/bots`, { headers: { origin: "null", "sec-fetch-site": "cross-site" } });
      expect(fromSandboxedPage.status).toBe(403);

      const mdRes = await fetch(
        `${BASE}/api/preview/file/${encodeURIComponent(projectId)}/docs/guide.md`,
      );
      expect(mdRes.status).toBe(200);
      expect(mdRes.headers.get("content-type")).toContain("text/markdown");
      expect(await mdRes.text()).toContain("Plain words.");

      // 3. Reject unregistered project, traversal outside project, and absolute paths
      expect((await api("GET", "/api/preview/file?projectId=unknown-proj&path=index.html")).status).toBe(404);
      expect(
        (await api("GET", `/api/preview/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent("../outside.html")}`)).status,
      ).toBe(403);
      expect(
        (await api("GET", `/api/preview/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(join(outsideDir, "outside.html"))}`)).status,
      ).toBe(403);

      // 4. Reject symlink escapes and disguised symlink to non-allowed file type
      if (process.platform !== "win32") {
        const escapeFile = await api(
          "GET",
          `/api/preview/file?projectId=${encodeURIComponent(projectId)}&path=escape.html`,
        );
        expect(escapeFile.status).toBe(403);

        const escapeDir = await api(
          "GET",
          `/api/preview/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent("escape-dir/outside.html")}`,
        );
        expect(escapeDir.status).toBe(403);

        const disguised = await api(
          "GET",
          `/api/preview/file?projectId=${encodeURIComponent(projectId)}&path=disguised.html`,
        );
        expect(disguised.status).toBe(415);
      }

      // 5. Reject disallowed file extensions (.env, .ts, .sh)
      const badEnv = await api(
        "GET",
        `/api/preview/file?projectId=${encodeURIComponent(projectId)}&path=secret.env`,
      );
      expect(badEnv.status).toBe(415);

      const badScript = await api(
        "GET",
        `/api/preview/file?projectId=${encodeURIComponent(projectId)}&path=run.sh`,
      );
      expect(badScript.status).toBe(415);

      // 6. Guard preview route against untrusted cross-origin requests
      const crossOriginPreview = await fetch(
        `${BASE}/api/preview/file?projectId=${encodeURIComponent(projectId)}&path=index.html`,
        { headers: { origin: "https://evil.example" } },
      );
      expect(crossOriginPreview.status).toBe(403);

      // 7. Auto-refresh file watcher pushes preview.reload over SSE and cleans up
      const streamAbort = new AbortController();
      const stream = await fetch(`${BASE}/api/events`, { signal: streamAbort.signal });
      const reader = stream.body!.getReader();
      const waitForReload = () =>
        new Promise<any>((resolve, reject) => {
          const decoder = new TextDecoder();
          let buffer = "";
          const timeout = setTimeout(() => reject(new Error("timed out waiting for preview.reload")), 3_000);
          const pump = async () => {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) throw new Error("event stream ended");
              buffer += decoder.decode(value, { stream: true });
              const chunks = buffer.split("\n\n");
              buffer = chunks.pop() ?? "";
              for (const chunk of chunks) {
                const line = chunk.split("\n").find((entry) => entry.startsWith("data: "));
                if (!line) continue;
                const frame = JSON.parse(line.slice(6));
                if (frame.kind === "preview.reload") {
                  clearTimeout(timeout);
                  resolve(frame);
                  return;
                }
              }
            }
          };
          void pump().catch(reject);
        });

      const watchRes = await api("POST", "/api/preview/watch", {
        clientId: "test-client",
        projectId,
        path: "index.html",
        enabled: true,
      });
      expect(watchRes).toEqual({
        status: 200,
        body: { ok: true, watching: true, projectId, path: "index.html" },
      });

      const reloadPromise = waitForReload();
      writeFileSync(join(projectDir, "index.html"), "<!doctype html><h1>Updated Preview</h1>");
      await expect(reloadPromise).resolves.toMatchObject({
        kind: "preview.reload",
        projectId,
        path: "index.html",
      });

      const unwatchRes = await api("POST", "/api/preview/watch", {
        clientId: "test-client",
        enabled: false,
      });
      expect(unwatchRes).toEqual({
        status: 200,
        body: { ok: true, watching: false },
      });
      streamAbort.abort();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
