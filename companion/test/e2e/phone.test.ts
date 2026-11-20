import { describe, expect, it, vi } from "vitest";

import { webSocketTransport } from "../../src/e2e/phone.ts";

/** Stands in for the built-in WebSocket client; only what the transport reads. */
const fakeSocket = (readyState: number, bufferedAmount: number) =>
  ({ readyState, bufferedAmount, send: () => {}, close: () => {} }) as unknown as WebSocket;

describe("the built-in WebSocket transport", () => {
  it("answers a drain wait on a later turn when the socket is no longer open", () => {
    // A closing socket never drains. Answering synchronously here re-enters
    // MuxStream.flush, which finds the session congested again and waits again, until the
    // stack overflows; the close event that would end the session also never gets a turn.
    vi.useFakeTimers();
    try {
      const transport = webSocketTransport(fakeSocket(WebSocket.CLOSING, 4 * 1024 * 1024));
      const listener = vi.fn();

      transport.onceDrained(listener);

      expect(listener).not.toHaveBeenCalled();
      vi.advanceTimersByTime(50);
      expect(listener).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
