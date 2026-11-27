import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("lets a self-hosted owner open one linked outside-workspace file only on explicit confirmation, never non-owners, hosted workspaces, app data, folders, or unlinked paths", async () => {
    const store = new Store(() => sonnet);
    const bot = store.createBot({ name: "Scout" }, { seedMessages: false });
    const root = join(DATA_DIR, "task-workspaces", bot.id, bot.threadId);
    const outsideDir = join(tmpdir(), `omb-route-outside-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, "shared-plan.md");
    const appFile = join(DATA_DIR, "private-store.json");
    const unlinkedFile = join(outsideDir, "unlinked.md");
    writeFileSync(outsideFile, "outside ok\n");
    writeFileSync(appFile, "secret\n");
    writeFileSync(unlinkedFile, "nope\n");
    try {
      const message = store.appendMessage(bot.threadId, {
        role: "bot",
        kind: "text",
        text: `[plan](<${pathToFileURL(outsideFile).href}>) [dir](<${pathToFileURL(outsideDir).href}>) [app](<${pathToFileURL(appFile).href}>)`,
      });
      const callRoute = async (opts: {
        body?: Record<string, unknown>;
        method?: "POST" | "GET";
        query?: string;
        caller?: RequestAuth;
        hostedWorkspace?: boolean;
        ownerOutsideFileRefuse?: readonly string[];
      }) => {
        const chunks: Buffer[] = [];
        let statusCode = 0;
        const headers: Record<string, string> = {};
        const res = Object.assign(new Writable({
          write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
        }), {
          writeHead(code: number, hdrs?: Record<string, string>) {
            statusCode = code;
            if (hdrs) Object.assign(headers, hdrs);
            return res;
          },
          setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; return res; },
        }) as unknown as ServerResponse;
        const handle = createThreadRoutes({
          store,
          viewerFor: () => ({}),
          visibleTo: () => ({ bot: () => true, group: () => true, thread: () => true }),
          workspaceAccess: () => null,
          desktopMutationToken: () => undefined,
          companionMutationToken: () => undefined,
          cliOwnerToken: () => undefined,
          messageFileRootsForThread: () => [root],
          hostedWorkspace: opts.hostedWorkspace ?? false,
          ...(opts.ownerOutsideFileRefuse ? { ownerOutsideFileRefuse: opts.ownerOutsideFileRefuse } : {}),
        } as unknown as ThreadRouteDeps);
        const path = `/api/threads/${bot.threadId}/messages/${message.id}/file`;
        const url = new URL(`${path}${opts.query ?? ""}`, "http://127.0.0.1");
        const req = Readable.from(opts.method === "GET" ? [] : [Buffer.from(JSON.stringify(opts.body ?? {}))]) as IncomingMessage;
        req.headers = { "content-type": "application/json" };
        req.method = opts.method ?? "POST";
        try {
          await handle({ req, res, url, path, method: opts.method ?? "POST", auth: opts.caller ?? auth, json, readBody });
        } catch (err) {
          const status = (err as { status?: number } | null)?.status ?? 500;
          const code = (err as { code?: string } | null)?.code;
          return {
            statusCode: status,
            headers,
            body: JSON.stringify({ error: err instanceof Error ? err.message : String(err), ...(code ? { code } : {}) }),
          };
        }
        return { statusCode, headers, body: Buffer.concat(chunks).toString("utf8") };
      };

      // Self-hosted owner gets canOpenOutside hint on initial click, then opens on allowOutsideWorkspace.
      const first = await callRoute({ body: { path: outsideFile, listFolder: true }, ownerOutsideFileRefuse: [DATA_DIR] });
      expect(first.statusCode).toBe(403);
      expect(JSON.parse(first.body)).toMatchObject({ code: "outside_workspace", canOpenOutside: true });

      const opened = await callRoute({ body: { path: outsideFile, allowOutsideWorkspace: true }, ownerOutsideFileRefuse: [DATA_DIR] });
      expect(opened.statusCode).toBe(200);
      expect(opened.body).toBe("outside ok\n");

      // Folder links, listFolder + allowOutsideWorkspace, app data, and unlinked files remain refused without canOpenOutside.
      const folderHint = await callRoute({ body: { path: outsideDir, listFolder: true }, ownerOutsideFileRefuse: [DATA_DIR] });
      expect(folderHint.statusCode).toBe(403);
      expect(JSON.parse(folderHint.body).canOpenOutside).toBeUndefined();

      const folderBypass = await callRoute({ body: { path: outsideDir, listFolder: true, allowOutsideWorkspace: true }, ownerOutsideFileRefuse: [DATA_DIR] });
      expect(folderBypass.statusCode).toBe(403);

      const appDataRefusal = await callRoute({ body: { path: appFile, allowOutsideWorkspace: true }, ownerOutsideFileRefuse: [DATA_DIR] });
      expect(appDataRefusal.statusCode).toBe(403);

      const unlinkedRefusal = await callRoute({ body: { path: unlinkedFile, allowOutsideWorkspace: true }, ownerOutsideFileRefuse: [DATA_DIR] });
      expect(unlinkedRefusal.statusCode).toBe(403);

      // Non-admin callers, service loopback, hosted workspaces, and cloud deployments (no ownerOutsideFileRefuse) cannot open outside files.
      const nonOwner = { kind: "session", session: { id: "member-1", membershipAuthority: "local" }, scopes: [] } as unknown as RequestAuth;
      const serviceLoopback = { kind: "loopback", trust: "service", scopes: [] } as unknown as RequestAuth;
      for (const caller of [nonOwner, serviceLoopback]) {
        const res = await callRoute({ body: { path: outsideFile }, caller, ownerOutsideFileRefuse: [DATA_DIR] });
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body).canOpenOutside).toBeUndefined();
        expect((await callRoute({ body: { path: outsideFile, allowOutsideWorkspace: true }, caller, ownerOutsideFileRefuse: [DATA_DIR] })).statusCode).toBe(403);
      }
      expect((await callRoute({ body: { path: outsideFile, allowOutsideWorkspace: true }, hostedWorkspace: true, ownerOutsideFileRefuse: [DATA_DIR] })).statusCode).toBe(403);
      expect((await callRoute({ body: { path: outsideFile, allowOutsideWorkspace: true } })).statusCode).toBe(403);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
