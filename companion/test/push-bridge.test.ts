import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";

import { dispatchPushNotification, parsePushEvent, startPushBridge } from "../src/push-bridge.ts";

const notification = {
  id: "stream:8",
  kind: "approval",
  botId: "chief",
  botName: "Chief",
  threadId: "thread-1",
  title: "Chief needs approval",
  body: "Allow this action?",
} as const;

describe("companion push bridge", () => {
  it("accepts only bounded notify events and binds the SSE id for dedupe", () => {
    expect(parsePushEvent("stream:8", { kind: "notify", notification: { ...notification, id: undefined } })).toEqual(notification);
    expect(parsePushEvent("stream:8", { kind: "message", notification })).toBeNull();
    expect(parsePushEvent("stream:8", { kind: "notify", notification: { ...notification, title: "x".repeat(300) } })).toBeNull();
    expect(parsePushEvent("", { kind: "notify", notification })).toBeNull();
  });

  it("sends one copy to every target and revokes only an invalid target", async () => {
    const send = vi.fn(async (token: string) => token.startsWith("bad")
      ? { kind: "invalid-target" as const }
      : { kind: "delivered" as const });
    const clear = vi.fn();

    await dispatchPushNotification({
      notification,
      targets: [
        { deviceId: "phone-a", token: "good-token-abcdefghijklmnopqrstuvwxyz" },
        { deviceId: "phone-b", token: "bad-token-abcdefghijklmnopqrstuvwxyz" },
      ],
      send,
      clear,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(clear).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledWith("phone-b");
  });

  it("keeps a private harness subscription and delivers a live notification while the phone is closed", async () => {
    let finish: (() => void) | undefined;
    const delivered = new Promise<void>((resolve) => { finish = resolve; });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`id: stream:8\ndata: ${JSON.stringify({ kind: "notify", notification })}\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const send = vi.fn(async () => {
      finish?.();
      return { kind: "delivered" as const };
    });
    const stop = startPushBridge({
      harnessPort: address.port,
      targets: () => [{ deviceId: "phone-a", token: "good-token-abcdefghijklmnopqrstuvwxyz" }],
      send,
      clear: vi.fn(),
    });
    try {
      await Promise.race([
        delivered,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("push was not delivered")), 2_000)),
      ]);
      expect(send).toHaveBeenCalledExactlyOnceWith("good-token-abcdefghijklmnopqrstuvwxyz", notification);
    } finally {
      stop();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
