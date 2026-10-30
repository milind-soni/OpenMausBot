import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import * as atomic from "../atomic.ts";
import { flushDecisionLog } from "../decision-log.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { SessionRegistry } from "../sessions.ts";
import type { BotRecord } from "../store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createPhones } from "./phones.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "phone-session-revocation-"));
  const sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  const paired = sessions.exchange({ code: sessions.openPairing({ scopes: ["admin", "client"] }).credential, label: "Fixture phone", source: "127.0.0.1" });
  if (!paired.ok) throw new Error(paired.error);
  const session = sessions.authenticate(paired.token)!;
  const bot = { id: "helper", name: "Helper", phoneApps: { calendar: "write" } } as BotRecord;
  const phones = createPhones({
    dataDir: dir, shared: false, cloudHome: true, cloudOwnerKey: "owner", loopbackTrust: "owner", sharedMembership: () => false,
    store: { bot: () => bot, groupByThread: () => undefined, messagesFor: () => [], appendMessage: (_thread, message) => ({ ...message, id: "message-1", at: message.at ?? Date.now() }) },
    sessions, routines: () => null, ownerOrAdmin: () => true, cloudOwnerSession: () => true,
    cloudLendingRefusal: () => null, cloudLendingTurn: () => { throw new Error("unused on Cloud home"); },
    originIsUser: () => true, request: () => undefined, nudge: () => {}, mint: () => "fixture-token", harnessUrl: "http://127.0.0.1:1", active: () => true,
  });
  let pollStarted!: () => void;
  const polling = new Promise<void>(resolve => { pollStarted = resolve; });
  const server = createServer(async (req, res) => {
    const session = sessions.authenticate(req.headers.authorization?.replace(/^Bearer /, ""));
    if (!session) return json(res, 401, { error: "Session expired" });
    const auth: RequestAuth = { kind: "session", session, via: "bearer", scopes: session.scopes };
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const dispatched = dispatchRoutes([phones.routes], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (url.pathname === "/api/phones/self/jobs") pollStarted();
      await dispatched;
    } catch (error) { json(res, (error as { status?: number }).status ?? 500, { error: (error as Error).message }); }
  });
  cleanups.push(async () => {
    phones.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await flushDecisionLog(dir); await removeTempDir(dir);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { authorization: `Bearer ${paired.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  expect((await call("PUT", "/api/phones/self", {
    installId: "install-0001", name: "Fixture phone", platform: "ios", appVersion: "1.0.0", timeZone: "UTC", capabilities: { calendar: "full" },
  })).status).toBe(200);
  const request = () => phones.handle({ method: "tools/call", params: {
    name: "PHONE_CREATE_EVENT", arguments: { title: "Private appointment", start: "2026-10-28T10:00:00Z", end: "2026-10-28T11:00:00Z" },
  } }, { botId: bot.id, threadId: "thread-1", generation: "gen-1" }, () => {});
  return { dir, phones, sessions, paired, session, call, polling, request };
}

it("revoking a session removes its phone and ends its pending poll before a later job", async () => {
  const h = await fixture();
  const poll = h.call("GET", "/api/phones/self/jobs");
  await h.polling;
  expect(h.sessions.revoke(h.paired.session.id)).toBe(true);
  const later = h.request();
  expect(await poll).toMatchObject({ status: 401 });
  expect(await later).toMatchObject({ isError: true });
  expect((await h.call("GET", "/api/phones/self")).status).toBe(401);
  expect(h.phones.fromPhone({ kind: "session", session: h.session, via: "bearer", scopes: ["admin", "client"] })).toBe(false);
});

it("revoking a session fails both a leased job and a queued job", async () => {
  const h = await fixture();
  const first = h.request();
  const { body: { job } } = await h.call("GET", "/api/phones/self/jobs");
  expect((await h.call("POST", `/api/phones/self/jobs/${job.id}/lease`)).body).toEqual({ active: true });
  const second = h.request();
  h.sessions.revoke(h.paired.session.id);
  const ended = await Promise.race([
    Promise.all([first, second]),
    new Promise<null>(resolve => { const timer = setTimeout(() => resolve(null), 1000); timer.unref(); }),
  ]);
  expect(ended).toEqual([expect.objectContaining({ isError: true }), expect.objectContaining({ isError: true })]);
});

it("a phone save failure does not interrupt session revocation or leave its job waiting", async () => {
  const h = await fixture();
  const pending = h.request();
  const write = atomic.writeFileAtomic;
  vi.spyOn(atomic, "writeFileAtomic").mockImplementation((file, ...args) => {
    if (file === join(h.dir, "phones.json")) throw Object.assign(new Error("fixture permission denied"), { code: "EACCES" });
    write(file, ...args);
  });
  let notified = false;
  h.sessions.onSessionRevoked(() => { notified = true; });
  expect(() => h.sessions.revoke(h.paired.session.id)).not.toThrow();
  expect(notified).toBe(true);
  expect(new SessionRegistry({ file: join(h.dir, "sessions.json") }).isLive(h.paired.session.id)).toBe(false);
  expect(await pending).toMatchObject({ isError: true });
});
