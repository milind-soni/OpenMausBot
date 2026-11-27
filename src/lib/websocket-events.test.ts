import { afterEach, describe, expect, it, vi } from "vitest";
import { websocketEvents } from "./websocket-events";

class Socket {
  static current: Socket;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: URL) { Socket.current = this; }
}
afterEach(() => vi.unstubAllGlobals());

describe("WebSocket event envelopes", () => {
  it("preserves the cursor and rejects malformed envelopes", () => {
    vi.stubGlobal("window", { location: { href: "https://example.test/?liveTransport=auto" } });
    vi.stubGlobal("WebSocket", Socket);
    const source = websocketEvents("/api/events?since=epoch%3A3");
    const received = vi.fn();
    source.onmessage = received;
    expect(Socket.current.url.href).toBe("wss://example.test/api/events?since=epoch%3A3");
    for (const data of [null, "bad", "{}", '{"frame":null}', '{"frame":{"kind":3}}', '{"id":4,"frame":{"kind":"ping"}}']) Socket.current.onmessage?.({ data });
    expect(received).not.toHaveBeenCalled();
    Socket.current.onmessage?.({ data: '{"id":"epoch:4","frame":{"kind":"bot"}}' });
    expect(received).toHaveBeenCalledWith({ data: '{"kind":"bot"}', lastEventId: "epoch:4" });
    source.close();
    expect(Socket.current.close).toHaveBeenCalledOnce();
    expect(Socket.current.onmessage).toBeNull();
    expect(Socket.current.onerror).toBeNull();
    expect(Socket.current.onclose).toBeNull();
  });
});
