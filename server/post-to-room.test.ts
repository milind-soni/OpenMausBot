// Room-addressed peer comms, end to end against a real harness.
//
// Three things live here because they share one boot and one rule set:
//
//   1. ask_bot from inside a room turn — the source conversation a bot
//      speaks from may be a room, not only its own task
//   2. list_rooms — the only way a bot ever learns a room id
//   3. post_to_room — the first way a bot writes into a shared channel
//      without a turn being started for it
//
// (3) is why the file is careful. Everything the harness knows about who a
// bot may address is enforced server-side here, so a test that only checks
// the happy path would pass against a tool that trusts its own arguments.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");

let PORT = 0;
let WEBHOOK_PORT = 0;
let BASE = "";
let child: ChildProcess;
let home: string;
let fakeClaudeDump = "";
let stderr = "";
/** The loopback bearer the agents proxy is handed for this boot. */
let commsToken = "";

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

const api = async (method: string, path: string, body?: unknown): Promise<ApiResult> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const parsed: unknown = await res.json().catch(() => ({}));
  // SAFETY: the harness answers every /api route with a JSON object; a body
  // that is not one is a bug this cast surfaces as a failed assertion.
  return { status: res.status, body: (parsed ?? {}) as Record<string, unknown> };
};

const internal = async (method: string, path: string, body?: unknown): Promise<ApiResult> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${commsToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const parsed: unknown = await res.json().catch(() => ({}));
  // SAFETY: same contract as `api` above — internal routes answer JSON too.
  return { status: res.status, body: (parsed ?? {}) as Record<string, unknown> };
};

/** Read a value out of an untyped JSON body without reaching for `any`. */
const field = (body: Record<string, unknown>, ...path: string[]): unknown => {
  let cursor: unknown = body;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
};

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** A bot with a name and a section, ready to be put in a room. */
const makeBot = async (name: string, section: string): Promise<{ id: string; threadId: string }> => {
  const created = await api("POST", "/api/bots");
  const id = str(field(created.body, "bot", "id"));
  const patched = await api("PATCH", `/api/bots/${id}`, {
    name,
    section,
    modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
  });
  expect(patched.status).toBe(200);
  return { id, threadId: str(field(created.body, "bot", "threadId")) };
};

const makeRoom = async (name: string, memberIds: string[], section: string): Promise<{ id: string; threadId: string }> => {
  const created = await api("POST", "/api/groups", {
    name,
    memberIds,
    section,
    // A room whose setup the person never finished is not open for business;
    // finishing it here keeps every case in this file about posting rules.
    setup: { bulletin: "", defaultResponder: { kind: "mentions" } },
  });
  expect(created.status).toBe(201);
  return {
    id: str(field(created.body, "group", "id")),
    threadId: str(field(created.body, "group", "threadId")),
  };
};

beforeAll(async () => {
  const base = await freePortBlock([0, 1]);
  PORT = base;
  WEBHOOK_PORT = base + 1;
  BASE = `http://127.0.0.1:${PORT}`;
  home = mkdtempSync(join(tmpdir(), "omb-post-to-room-"));
  fakeClaudeDump = join(home, "fake-claude-dump.json");
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(
    join(home, ".openmausbot", "config.json"),
    JSON.stringify({
      instances: {
        claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLAUDE_CLI } },
      },
    }),
  );
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_WEBHOOK_PORT: String(WEBHOOK_PORT),
      FAKE_CLAUDE_DUMP: fakeClaudeDump,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    await new Promise((wake) => setTimeout(wake, 150));
  }

  // The loopback token is minted per boot and only ever handed to the agents
  // proxy. One throwaway turn makes the fake CLI write the mcpConfig it was
  // launched with, which is where these tests read it from.
  const seed = await makeBot("Token Seed", "Seeds");
  rmSync(fakeClaudeDump, { force: true });
  expect((await api("POST", `/api/bots/${seed.id}/messages`, { text: "hello" })).status).toBe(202);
  const dumpDeadline = Date.now() + 15_000;
  while (!existsSync(fakeClaudeDump)) {
    if (Date.now() > dumpDeadline) throw new Error(`the fake CLI never wrote its dump. stderr:\n${stderr}`);
    await new Promise((wake) => setTimeout(wake, 100));
  }
  const dump: unknown = JSON.parse(readFileSync(fakeClaudeDump, "utf8"));
  // SAFETY: the fake CLI writes the mcpConfig it received verbatim.
  commsToken = str(field(dump as Record<string, unknown>, "mcpConfig", "mcpServers", "agents", "env", "OMB_COMMS_TOKEN"));
  expect(commsToken).not.toBe("");
  await api("POST", `/api/bots/${seed.id}/interrupt`);
  await api("PATCH", `/api/bots/${seed.id}`, { hidden: true });
}, 60_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("peer comms from a room turn", () => {
  it("lets a bot ask a peer while its source conversation is a room", async () => {
    const asker = await makeBot("Room Asker", "Room comms");
    const helper = await makeBot("Room Helper", "Room comms");
    const room = await makeRoom("Ask room", [asker.id, helper.id], "Room comms");

    const asked = await internal("POST", "/api/internal/ask-bot", {
      fromBotId: asker.id,
      fromThreadId: room.threadId,
      toBotId: helper.id,
      message: "what is the status?",
      depth: 0,
    });
    expect(asked.status).toBe(200);
    expect(asked.body.error, `ask from a room was refused: ${JSON.stringify(asked.body)}`).toBeUndefined();
    expect(str(asked.body.text)).toContain("hello from fake claude");

    await api("POST", `/api/bots/${helper.id}/interrupt`);
  }, 40_000);

  it("refuses a conversation the sender does not belong to", async () => {
    const outsider = await makeBot("Outsider", "Room comms");
    const insider = await makeBot("Insider", "Room comms");
    const helper = await makeBot("Private Helper", "Room comms");
    const closed = await makeRoom("Closed room", [insider.id, helper.id], "Room comms");

    const throughRoom = await internal("POST", "/api/internal/ask-bot", {
      fromBotId: outsider.id,
      fromThreadId: closed.threadId,
      toBotId: helper.id,
      message: "let me in",
      depth: 0,
    });
    expect(throughRoom.status).toBe(403);
    expect(str(throughRoom.body.error)).toContain("does not belong to sender");

    const throughPeerTask = await internal("POST", "/api/internal/ask-bot", {
      fromBotId: outsider.id,
      fromThreadId: insider.threadId,
      toBotId: helper.id,
      message: "borrowing your thread",
      depth: 0,
    });
    expect(throughPeerTask.status).toBe(403);
    expect(str(throughPeerTask.body.error)).toContain("does not belong to sender");
  }, 40_000);
});
