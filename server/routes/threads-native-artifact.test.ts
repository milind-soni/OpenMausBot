import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import { resolveRequestAuth, type RequestAuth } from "../request-auth.ts";
import { SessionRegistry } from "../sessions.ts";
import { Store } from "../store.ts";
import { dispatchRoutes } from "./table.ts";
import { createThreadRoutes, type ThreadRouteDeps } from "./threads.ts";

const model: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const cleanup: Array<() => Promise<void>> = [];
const desktopToken = "fixture-desktop-owner";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

async function fixture({ paused = false, native = true } = {}) {
  const disposableHome = relative(realpathSync(tmpdir()), realpathSync(dirname(DATA_DIR)));
  if (!/^omb-test-home-[^\\/]+$/.test(disposableHome)) throw new Error("Native artifact tests require the setup-created temporary home.");
  const store = new Store(() => model);
  const bot = store.createBot({ name: "Scout" }, { seedMessages: false });
  const root = join(DATA_DIR, "native-artifacts");
  mkdirSync(root, { recursive: true });
  const file = join(root, "original page.html");
  writeFileSync(file, "<!doctype html><title>Original artifact</title><button>Use me</button>");
  const link = pathToFileURL(file).href;
  const message = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `[Original HTML](${link})` });
  const sessions = new SessionRegistry({ file: join(DATA_DIR, "native-sessions.json") });
  const owner = sessions.issue({ label: "Owner", scopes: ["admin", "client"] });
  const otherOwner = sessions.issue({ label: "Other owner", scopes: ["admin", "client"] });
  const member = sessions.issue({ label: "Member", scopes: ["client"] });
  const entered = deferred(), proceed = deferred(), handled = deferred(), disconnected = deferred();
  if (!paused) proceed.resolve();
  const opened: Array<{ botId: string; threadId: string; path: string; roots: readonly string[] }> = [];
  const errors: unknown[] = [];
  let visible = true;
  let mutationToken = desktopToken;
  let pendingRequest: IncomingMessage | null = null;
  let pendingResponse: ServerResponse | null = null;
  const nativeArtifact = async (_auth: RequestAuth, botId: string, threadId: string, path: string, roots: readonly string[], isCurrent?: () => void) => {
    entered.resolve();
    await proceed.promise;
    isCurrent?.();
    opened.push({ botId, threadId, path, roots });
    isCurrent?.();
  };
  const deps = {
    store, sessions, sessionCookie: "native_session", loopback: { trust: "owner", localBrowsers: false },
    viewerFor: () => ({ kind: "all" }), visibleTo: () => ({ thread: () => visible }), workspaceAccess: () => null,
    desktopMutationToken: () => mutationToken, companionMutationToken: () => undefined, cliOwnerToken: () => undefined,
    lendingEnabled: () => false, messageFileRootsForThread: () => [root],
    ...(native ? { nativeArtifact } : {}),
  } as unknown as ThreadRouteDeps;
  const routes = [createThreadRoutes(deps)];
  const server = createServer(async (req, res) => {
    pendingRequest = req;
    pendingResponse = res;
    res.once("close", () => { if (!res.writableEnded) disconnected.resolve(); });
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const current = resolveRequestAuth(req, {
        sessions, cookieName: "native_session", streamPath: "/api/events", url,
        loopbackMutationToken: mutationToken, loopbackTrust: "owner",
      });
      if (!current.auth) return json(res, current.status, { error: current.error });
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: current.auth, json, readBody })) {
        json(res, 404, { error: "No route" });
      }
    } catch (error) {
      errors.push(error);
      if (!res.destroyed) json(res, Number((error as { status?: number }).status) || 500, { error: String(error) });
    } finally {
      handled.resolve();
    }
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  cleanup.push(async () => {
    proceed.resolve();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    sessions.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const route = (threadId = bot.threadId, messageId = message.id) => `/api/threads/${threadId}/messages/${messageId}/file`;
  const post = (options: { token?: string | null; path?: string; threadId?: string; messageId?: string; native?: boolean } = {}) => fetch(`${base}${route(options.threadId, options.messageId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.token === null ? { "x-openmausbot-desktop-owner": desktopToken } : { authorization: `Bearer ${options.token ?? owner.token}` }) },
    body: JSON.stringify({ path: options.path ?? link, openNativeBrowser: options.native ?? true }),
  });
  return {
    store, bot, root, file, link, message, sessions, owner, member, base, route, post, entered, handled, disconnected, opened, errors,
    resume: proceed.resolve,
    hide: () => { visible = false; },
    rotateDesktopToken: () => { mutationToken = "rotated-fixture-desktop-owner"; },
    switchOwner: () => { pendingRequest!.headers.authorization = `Bearer ${otherOwner.token}`; },
    responseDestroyed: () => pendingResponse?.destroyed === true,
  };
}

describe("opening a message's original HTML in the native browser", () => {
  it.each(["paired owner", "desktop owner"])("opens only the exact linked file for its direct bot as %s", async (owner) => {
    const f = await fixture();
    const response = await f.post(owner === "desktop owner" ? { token: null } : {});
    expect([response.status, await response.json()]).toEqual([200, { nativeBrowserOpened: true, botId: f.bot.id }]);
    expect(f.opened).toEqual([{ botId: f.bot.id, threadId: f.bot.threadId, path: realpathSync(f.file), roots: [f.root] }]);
  });

  it.each([
    ["member", 403], ["wrong conversation", 404], ["wrong message", 404], ["unlinked file", 403],
    ["outside its workspace", 403], ["non-HTML file", 415], ["room", 403], ["hidden conversation", 403], ["unavailable native backend", 403],
  ] as const)("refuses %s without opening a native page", async (scenario, status) => {
    const f = await fixture({ native: scenario !== "unavailable native backend" });
    const options: Parameters<typeof f.post>[0] = {};
    if (scenario === "member") options.token = f.member.token;
    if (scenario === "wrong conversation") options.threadId = "missing-thread";
    if (scenario === "wrong message") options.messageId = "missing-message";
    if (scenario === "hidden conversation") f.hide();
    if (scenario === "unlinked file") {
      const file = join(f.root, "unlinked.html");
      writeFileSync(file, "<title>Unlinked</title>");
      options.path = pathToFileURL(file).href;
    }
    if (scenario === "outside its workspace" || scenario === "non-HTML file") {
      const file = scenario === "outside its workspace" ? join(DATA_DIR, "other-bot.html") : join(f.root, "notes.txt");
      writeFileSync(file, "Unrelated data");
      options.path = pathToFileURL(file).href;
      options.messageId = f.store.appendMessage(f.bot.threadId, { role: "bot", kind: "text", text: `[File](${options.path})` }).id;
    }
    if (scenario === "room") {
      const group = f.store.createGroup("Room", [f.bot.id]);
      options.threadId = group.threadId;
      options.messageId = f.store.appendMessage(group.threadId, {
        role: "bot", kind: "text", text: `[Original HTML](${f.link})`, from: { botId: f.bot.id, name: f.bot.name, color: f.bot.color },
      }).id;
    }
    const response = await f.post(options);
    expect(response.status).toBe(status);
    expect(f.opened).toEqual([]);
  });

  it.each(["revoked session", "hidden conversation", "different owner", "rotated desktop capability"])("cancels native side effects after %s while opening", async (change) => {
    const f = await fixture({ paused: true });
    const pending = f.post(change === "rotated desktop capability" ? { token: null } : {});
    await f.entered.promise;
    if (change === "revoked session") f.sessions.revoke(f.owner.session.id);
    if (change === "hidden conversation") f.hide();
    if (change === "different owner") f.switchOwner();
    if (change === "rotated desktop capability") f.rotateDesktopToken();
    f.resume();
    const response = await pending;
    expect(response.status).toBe(403);
    expect(f.opened).toEqual([]);
  });

  it("cancels native side effects when the client closes its response while opening", async () => {
    const f = await fixture({ paused: true });
    const client = request(`${f.base}${f.route()}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${f.owner.token}` },
    });
    client.on("error", () => {});
    client.end(JSON.stringify({ path: f.link, openNativeBrowser: true }));
    await f.entered.promise;
    client.destroy();
    await f.disconnected.promise;
    expect(f.responseDestroyed()).toBe(true);
    f.resume();
    await f.handled.promise;
    expect(f.opened).toEqual([]);
    expect(f.errors).toContainEqual(expect.objectContaining({ name: "AbortError" }));
  });

  it("leaves ordinary linked-file downloads on their existing route", async () => {
    const f = await fixture();
    const response = await f.post({ native: false });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(await response.text()).toContain("<title>Original artifact</title>");
    expect(f.opened).toEqual([]);
  });
});
