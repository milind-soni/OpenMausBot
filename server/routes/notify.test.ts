import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import { createNotifyRoutes } from "./notify.ts";
import type { Notification } from "../../shared/notification.ts";
import type { RouteContext } from "./http.ts";

function fakeReq(body: unknown): IncomingMessage {
  const req = new EventEmitter();
  setImmediate(() => {
    req.emit("data", JSON.stringify(body));
    req.emit("end");
  });
  return req as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { status: number; payload: any } {
  const res = {
    status: 0,
    payload: undefined,
    writeHead(status: number) {
      res.status = status;
    },
    end(data?: unknown) {
      res.payload = data === undefined ? undefined : JSON.parse(String(data));
    },
  };
  return res as unknown as ServerResponse & { status: number; payload: any };
}

function rctx(path = "/api/notify", method = "POST"): RouteContext {
  return { method, path, url: new URL("http://127.0.0.1:8799" + path), auth: {} as RouteContext["auth"] };
}

function makeStore() {
  return {
    bots: [
      { id: "bot-1", name: "Ada", threadId: "thread-main" },
      { id: "bot-2", name: "Bo", threadId: "thread-other" },
    ],
    tasks: (botId: string) =>
      botId === "bot-1" ? [{ threadId: "thread-task" }] : [],
  };
}

describe("POST /api/notify", () => {
  it("requires a title", async () => {
    const seen: Notification[] = [];
    const handler = createNotifyRoutes({ notify: (n) => seen.push(n), store: makeStore() });
    const res = fakeRes();
    expect(await handler(fakeReq({ botId: "bot-1" }), res, rctx())).toBe(true);
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("rejects oversized titles and bodies with 413", async () => {
    const handler = createNotifyRoutes({ notify: () => {}, store: makeStore() });
    const longTitle = fakeRes();
    expect(await handler(fakeReq({ botId: "bot-1", title: "x".repeat(201) }), longTitle, rctx())).toBe(true);
    expect(longTitle.status).toBe(413);
    const longBody = fakeRes();
    expect(await handler(fakeReq({ botId: "bot-1", title: "hi", body: "x".repeat(2001) }), longBody, rctx())).toBe(true);
    expect(longBody.status).toBe(413);
  });

  it("404s for unknown bots and threads, 400s for a bot/thread mismatch", async () => {
    const handler = createNotifyRoutes({ notify: () => {}, store: makeStore() });
    const unknownBot = fakeRes();
    expect(await handler(fakeReq({ botId: "nope", title: "hi" }), unknownBot, rctx())).toBe(true);
    expect(unknownBot.status).toBe(404);
    const unknownThread = fakeRes();
    expect(await handler(fakeReq({ threadId: "nope", title: "hi" }), unknownThread, rctx())).toBe(true);
    expect(unknownThread.status).toBe(404);
    const mismatch = fakeRes();
    expect(await handler(fakeReq({ botId: "bot-1", threadId: "thread-other", title: "hi" }), mismatch, rctx())).toBe(true);
    expect(mismatch.status).toBe(400);
  });

  it("notifies on the bot's own thread when resolved by botId", async () => {
    const seen: Notification[] = [];
    const handler = createNotifyRoutes({ notify: (n) => seen.push(n), store: makeStore() });
    const res = fakeRes();
    expect(await handler(fakeReq({ botId: "bot-1", title: "  build broke  " }), res, rctx())).toBe(true);
    expect(res.status).toBe(202);
    expect(res.payload).toEqual({ accepted: true, threadId: "thread-main" });
    expect(seen).toEqual([
      {
        kind: "question",
        botId: "bot-1",
        botName: "Ada",
        threadId: "thread-main",
        title: "build broke",
        body: "",
      },
    ]);
  });

  it("resolves a bot by any of its threads, including task threads", async () => {
    const seen: Notification[] = [];
    const handler = createNotifyRoutes({ notify: (n) => seen.push(n), store: makeStore() });
    const res = fakeRes();
    expect(await handler(fakeReq({ threadId: "thread-task", title: "hi", body: "details" }), res, rctx())).toBe(true);
    expect(res.status).toBe(202);
    expect(res.payload).toEqual({ accepted: true, threadId: "thread-task" });
    expect(seen[0]).toMatchObject({ kind: "question", botId: "bot-1", threadId: "thread-task", body: "details" });
  });

  it("accepts a botId plus one of that bot's threads", async () => {
    const seen: Notification[] = [];
    const handler = createNotifyRoutes({ notify: (n) => seen.push(n), store: makeStore() });
    const res = fakeRes();
    expect(await handler(fakeReq({ botId: "bot-1", threadId: "thread-task", title: "hi" }), res, rctx())).toBe(true);
    expect(res.status).toBe(202);
    expect(seen[0]).toMatchObject({ botId: "bot-1", threadId: "thread-task" });
  });

  it("ignores paths and methods it does not own", async () => {
    const handler = createNotifyRoutes({ notify: () => {}, store: makeStore() });
    expect(await handler(fakeReq({ title: "hi" }), fakeRes(), rctx("/api/notify", "GET"))).toBe(false);
    expect(await handler(fakeReq({ title: "hi" }), fakeRes(), rctx("/api/notify/other"))).toBe(false);
  });
});
