import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RouteContext } from "./routes/table.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { allowedPushEndpoint, createWebPush } from "./web-push.ts";

const dirs: string[] = [];
afterEach(() => Promise.all(dirs.splice(0).map(removeTempDir)).then(() => {}));

it("restricts outbound requests to HTTPS push services", () => {
  expect(allowedPushEndpoint("https://web.push.apple.com/Q123")).toBe(true);
  for (const url of ["https://127.0.0.1", "https://web.push.apple.com.evil.test", "https://fcm.googleapis.com:123/a", "http://web.push.apple.com/a"]) expect(allowedPushEndpoint(url)).toBe(false);
});

it("restores registrations and delivers only to a live session with access, then drops expired endpoints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-web-push-"));
  dirs.push(dir);
  const live = new Set(["a", "b", "c"]);
  const send = vi.fn().mockRejectedValue({ statusCode: 410 });
  const create = () => createWebPush(dir, (id) => live.has(id), send);
  const service = create();
  for (const id of live) {
    const json = vi.fn();
    await service.route({
      method: "PUT", path: "/api/push/web", req: { headers: { "content-type": "application/json" } }, res: { setHeader: vi.fn() },
      auth: { kind: "session", session: { id, cookieOnly: true } }, json,
      readBody: async () => ({ subscription: { endpoint: "https://web.push.apple.com/" + id, keys: { p256dh: "B" + "a".repeat(86), auth: "a".repeat(22) } }, silent: true }),
    } as unknown as RouteContext);
    expect(json.mock.calls[0]?.[1]).toBe(200);
  }
  live.delete("c");
  const restored = create();
  const notice = { kind: "done" as const, title: "Bot", body: "Finished", threadId: "thread", botId: "bot", botName: "Bot" };
  await restored.offer(notice, "message", (id) => id !== "b");
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0].endpoint).toBe("https://web.push.apple.com/a");
  expect(JSON.parse(send.mock.calls[0]?.[1])).toMatchObject({ threadId: "thread", messageId: "message", silent: true });
  expect(Object.keys(JSON.parse(readFileSync(join(dir, "web-push.json"), "utf8")).devices)).toEqual(["b"]);
});
