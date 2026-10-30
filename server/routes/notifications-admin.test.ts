import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NotificationLogEntry } from "../../shared/notification.ts";
import { DATA_DIR } from "../config.ts";
import { json, readBody } from "../harness/http.ts";
import { closeMessageDb, insertNotificationLog, recentNotificationLog } from "../message-db.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { createNotificationRoutes, readThreadNotifications } from "./notifications.ts";
import { dispatchRoutes } from "./table.ts";

const session: SessionRecord = { id: "fixture", tokenHash: "0".repeat(64), label: "Fixture", scopes: ["client"],
  createdAt: 1, lastSeenAt: 1, expiresAt: Number.MAX_SAFE_INTEGER };
const client: RequestAuth = { kind: "session", session, via: "bearer", scopes: ["client"] };
const callers: Array<{ label: string; auth: RequestAuth; admin: boolean }> = [
  { label: "Team Cloud member", auth: { ...client, session: { ...session, email: "bob@notifications.test",
    membershipAuthority: "team", teamRole: "member" } }, admin: false },
  { label: "guest", auth: { ...client, via: "cookie" }, admin: false },
  { label: "paired client", auth: client, admin: false },
  { label: "service loopback", auth: { kind: "loopback", trust: "service", scopes: ["client"] }, admin: false },
  { label: "owner loopback", auth: { kind: "loopback", scopes: ["admin", "client"] }, admin: true },
  { label: "admin session", auth: { ...client, session: { ...session, scopes: ["admin", "client"] },
    scopes: ["admin", "client"] }, admin: true },
];
const sample: NotificationLogEntry = { id: "done", at: 1, kind: "done", botId: "scout", botName: "Scout",
  threadId: "shared", title: "Done", body: "", read: false };
let server: Server | undefined;

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  for (const entry of [sample, { ...sample, id: "spend", kind: "spend" as const, body: "$12 of $20 spent this month" },
    { ...sample, id: "workspace-spend", kind: "spend" as const, threadId: "" }]) insertNotificationLog(entry);
});
afterEach(async () => {
  if (server) await new Promise((done) => server!.close(done));
  server = undefined;
});

async function serve(auth: RequestAuth) {
  const routes = [createNotificationRoutes()];
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) {
      json(res, 404, { error: "no such route" });
    }
  });
  await new Promise<void>((ready) => server!.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/notifications`;
}

describe.each(callers)("$label notification feed", ({ auth, admin }) => {
  it("automatically reads spend alerts in a conversation only for admins", () => {
    const frames: Record<string, unknown>[] = [];
    readThreadNotifications("shared", (frame) => frames.push(frame), auth);
    expect(recentNotificationLog().filter((entry) => entry.read).map((entry) => entry.id).sort())
      .toEqual(admin ? ["done", "spend"] : ["done"]);
    expect(frames.map((frame) => ({ ...frame, ids: (frame.ids as string[]).sort() })))
      .toEqual([{ kind: "notifications.read", threadId: "shared", ids: admin ? ["done", "spend"] : ["done"] }]);
  });

  it("lists spend alerts only for admins, including alerts in visible shared conversations", async () => {
    const url = await serve(auth);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const { notifications } = await res.json() as { notifications: NotificationLogEntry[] };
    expect(notifications.map((entry) => entry.id).sort()).toEqual(admin ? ["done", "spend", "workspace-spend"] : ["done"]);
  });

  it("allows only admins to mark a spend alert read", async () => {
    const url = await serve(auth);
    for (const id of ["spend", "workspace-spend"]) {
      expect((await fetch(`${url}/${id}/read`, { method: "POST" })).status, id).toBe(admin ? 200 : 404);
    }
    expect(recentNotificationLog().filter((entry) => entry.read).map((entry) => entry.id).sort())
      .toEqual(admin ? ["spend", "workspace-spend"] : []);
  });

  it("preserves admin-only unread alerts when a non-admin reads all", async () => {
    const url = await serve(auth);
    expect((await fetch(`${url}/read-all`, { method: "POST" })).status).toBe(200);
    expect(recentNotificationLog().filter((entry) => entry.read).map((entry) => entry.id).sort())
      .toEqual(admin ? ["done", "spend", "workspace-spend"] : ["done"]);
    expect(recentNotificationLog().filter((entry) => !entry.read).map((entry) => entry.id).sort())
      .toEqual(admin ? [] : ["spend", "workspace-spend"]);
  });
});
