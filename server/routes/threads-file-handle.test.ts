import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { createThreadRoutes, type ThreadRouteDeps } from "./threads.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const highWaterMark = 16 * 1024;
const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;

const captured = vi.hoisted(() => ({
  handles: [] as import("node:fs/promises").FileHandle[],
  path: "",
  hold: null as Promise<void> | null,
  signal: null as (() => void) | null,
}));

vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      if (captured.path !== "" && String(args[0]) === captured.path) {
        captured.handles.push(handle);
        captured.signal?.();
        if (captured.hold) await captured.hold;
      }
      return handle;
    },
  };
});

let releaseHold = () => {};
let pending: Promise<unknown> = Promise.resolve();

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  captured.handles.length = 0;
  captured.path = "";
  captured.hold = null;
  captured.signal = null;
  releaseHold = () => {};
  pending = Promise.resolve();
});

afterEach(async () => {
  releaseHold();
  await pending.catch(() => undefined);
  for (const handle of captured.handles) {
    if (handle.fd !== -1) await handle.close().catch(() => undefined);
  }
});

function response(onHead?: () => void): ServerResponse {
  const res = Object.assign(new Writable({
    highWaterMark,
    write() { /* a client that stopped reading */ },
  }), {
    writeHead() {
      onHead?.();
      return res;
    },
    setHeader() { return res; },
  });
  return res as unknown as ServerResponse;
}

async function fixture() {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" }, { seedMessages: false });
  const root = join(DATA_DIR, "task-workspaces", bot.id, bot.threadId);
  mkdirSync(root, { recursive: true });
  const inventory = join(root, "repo-inventory.md");
  writeFileSync(inventory, Buffer.alloc(highWaterMark * 4, 0x61));
  // The route opens the path fs/promises' realpath gives, which on Windows expands short (8.3) names; realpathSync does not.
  captured.path = realpathSync.native(inventory);
  const message = store.appendMessage(bot.threadId, {
    role: "bot",
    kind: "text",
    text: `[inventory](<${pathToFileURL(captured.path).href}>)`,
  });
  const deps = {
    store,
    viewerFor: () => ({}),
    visibleTo: () => ({ bot: () => true, group: () => true, thread: () => true }),
    workspaceAccess: () => null,
    desktopMutationToken: () => undefined,
    companionMutationToken: () => undefined,
    cliOwnerToken: () => undefined,
    messageFileRootsForThread: () => [root],
  } as unknown as ThreadRouteDeps;
  const handle = createThreadRoutes(deps);
  const path = `/api/threads/${bot.threadId}/messages/${message.id}/file`;
  const call = (res: ServerResponse) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ path: captured.path }))]) as IncomingMessage;
    req.headers = { "content-type": "application/json" };
    req.method = "POST";
    const result = handle({
      req, res, url: new URL(path, "http://127.0.0.1"), path, method: "POST", auth, json, readBody,
    });
    pending = result;
    return result;
  };
  return { call };
}

describe("POST /api/threads/:threadId/messages/:messageId/file", () => {
  it("closes the opened file when response setup throws", async () => {
    const { call } = await fixture();
    const sentinel = new Error("writeHead failed");
    await expect(call(response(() => { throw sentinel; }))).rejects.toBe(sentinel);
    expect(captured.handles).toHaveLength(1);
    expect(captured.handles[0]!.fd).toBe(-1);
  });

  it("closes the opened file when the client leaves while it is still being opened", async () => {
    const { call } = await fixture();
    let release!: () => void;
    const opened = new Promise<void>((resolve) => { captured.signal = resolve; });
    captured.hold = new Promise<void>((resolve) => { release = resolve; releaseHold = resolve; });
    const res = response();
    const result = call(res);
    await opened;
    expect(captured.handles).toHaveLength(1);
    expect(captured.handles[0]!.fd).toBeGreaterThan(-1);
    const closed = new Promise((resolve) => res.once("close", resolve));
    res.destroy();
    await closed;
    release();
    await result;
    expect(captured.handles[0]!.fd).toBe(-1);
  });

  it("allows owner to read a bot-linked file inside extraFileLinkRoots, while denying guests and unapproved paths", async () => {
    const store = new Store(() => sonnet);
    const bot = store.createBot({ name: "Scout" }, { seedMessages: false });
    const botRoot = join(DATA_DIR, "task-workspaces", bot.id, bot.threadId);
    const docsDir = join(DATA_DIR, "..", `omb-extra-docs-${Date.now()}`);
    const otherDir = join(DATA_DIR, "..", `omb-extra-other-${Date.now()}`);
    mkdirSync(botRoot, { recursive: true });
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    const allowedFile = join(docsDir, "NOTES.md");
    const blockedFile = join(otherDir, "SECRET.md");
    writeFileSync(allowedFile, "team notes");
    writeFileSync(blockedFile, "nope");
    try {
      const msg = store.appendMessage(bot.threadId, {
        role: "bot",
        kind: "text",
        text: `[notes](<${pathToFileURL(allowedFile).href}>) and [other](<${pathToFileURL(blockedFile).href}>)`,
      });
      const route = createThreadRoutes({
        store,
        viewerFor: () => ({}),
        visibleTo: () => ({ bot: () => true, group: () => true, thread: () => true }),
        workspaceAccess: () => null,
        desktopMutationToken: () => undefined,
        companionMutationToken: () => undefined,
        cliOwnerToken: () => undefined,
        messageFileRootsForThread: () => [botRoot],
        extraFileLinkRoots: async () => [dirname(allowedFile)],
      } as unknown as ThreadRouteDeps);
      const path = `/api/threads/${bot.threadId}/messages/${msg.id}/file`;

      const invoke = async (filePath: string, reqAuth: RequestAuth) => {
        let status = 0;
        let body: unknown = null;
        let streamed = "";
        const res = Object.assign(new Writable({
          write(chunk, _enc, cb) { streamed += chunk.toString(); cb(); },
        }), {
          writeHead(code: number) { status = code; return res; },
          setHeader() { return res; },
        }) as unknown as ServerResponse;
        const req = Readable.from([Buffer.from(JSON.stringify({ path: filePath }))]) as IncomingMessage;
        req.headers = { "content-type": "application/json" };
        req.method = "POST";
        await route({
          req, res, url: new URL(path, "http://127.0.0.1"), path, method: "POST", auth: reqAuth,
          json: (_r, s, b) => { status = s; body = b; },
          readBody,
        });
        return { status, body, streamed };
      };

      const ownerOk = await invoke(allowedFile, auth);
      expect(ownerOk.status).toBe(200);
      expect(ownerOk.streamed).toBe("team notes");

      const guestAuth = { kind: "session", session: { id: "g", scopes: ["client"], teamRole: "member" } as never, via: "bearer", scopes: ["client"] } as RequestAuth;
      await expect(invoke(allowedFile, guestAuth)).rejects.toMatchObject({ status: 403, code: "outside_workspace" });
      await expect(invoke(blockedFile, auth)).rejects.toMatchObject({ status: 403, code: "outside_workspace" });
    } finally {
      rmSync(docsDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
