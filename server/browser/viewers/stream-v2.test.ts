import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import type { BrowserService } from "../service.ts";
import type { Viewer } from "./core.ts";
import { STREAM_CLOSE, StreamV2, type StreamRequest } from "./stream-v2.ts";

const wire = vi.hoisted(() => ({ socket: null as WebSocket | null }));
vi.mock("ws", () => ({ WebSocketServer: class {
  handleUpgrade(_req: unknown, _socket: unknown, _head: unknown, accept: (socket: WebSocket) => void) { accept(wire.socket!); }
} }));

class Client extends EventEmitter {
  send = vi.fn();
  ping = vi.fn();
  close = vi.fn((code: number) => { this.emit("close", code); });
  input(message: object) { this.emit("message", Buffer.from(JSON.stringify(message)), false); }
}
const streams: StreamV2[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const stream of streams.splice(0)) stream.closeAll(); vi.clearAllTimers(); vi.useRealTimers(); });

function fixture() {
  let current = true;
  let attached!: (viewer: Viewer) => void;
  const attaching = new Promise<Viewer>(resolve => { attached = resolve; });
  const viewer = { input: vi.fn(async (_message: unknown) => {}), close: vi.fn(async (_options?: { dropped?: boolean }) => {}), options: { person: "member" } };
  const service = { attachViewer: vi.fn(() => attaching), restart: vi.fn(async () => {}) };
  const stream = new StreamV2({ service: service as unknown as BrowserService }); streams.push(stream);
  const client = new Client(); wire.socket = client as unknown as WebSocket;
  stream.open({
    target: { session: "browser", key: "bot:browser" }, botId: "bot", owner: "session", person: "member", canOperate: true,
    params: new URLSearchParams(), req: {} as StreamRequest["req"], socket: { destroy: vi.fn() } as unknown as StreamRequest["socket"], head: Buffer.alloc(0),
    isCurrent: () => current, restartRefusal: () => null,
  });
  return { stream, client, viewer, service, expire: () => { current = false; }, attach: async () => { attached(viewer as unknown as Viewer); await attaching; } };
}

it.each([{ type: "text", text: "queued input" }, { type: "restart" }])("drops queued $type when access expires while the viewer attaches", async message => {
  const h = fixture();
  h.client.input(message);
  expect(h.viewer.input).not.toHaveBeenCalled();
  h.expire();
  await h.attach();
  expect(h.viewer.input).not.toHaveBeenCalled();
  expect(h.service.restart).not.toHaveBeenCalled();
  expect(h.viewer.close).toHaveBeenCalledWith({ dropped: false });
  expect(h.client.close).toHaveBeenCalledWith(STREAM_CLOSE.gone, expect.any(String));
  expect(h.stream.size).toBe(0);
});

it("closes a late viewer whose access expired even without queued input", async () => {
  const h = fixture();
  h.expire();
  await h.attach();
  expect(h.viewer.close).toHaveBeenCalledWith({ dropped: false });
  expect(h.client.close).toHaveBeenCalledWith(STREAM_CLOSE.gone, expect.any(String));
  expect(h.stream.size).toBe(0);
});

it("delivers queued input in order while the view remains current", async () => {
  const h = fixture();
  const messages = [{ type: "text", text: "one" }, { type: "text", text: "two" }];
  messages.forEach(message => h.client.input(message));
  await h.attach();
  expect(h.viewer.input.mock.calls.map(([message]) => message)).toEqual(messages);
  expect(h.viewer.close).not.toHaveBeenCalled();
  expect(h.client.close).not.toHaveBeenCalled();
  expect(h.stream.size).toBe(1);
});
