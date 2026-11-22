import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bytes } from "./bytes.ts";
import type { SessionKeys } from "./noise.ts";

// The computer's side of the handshake is replaced, so these tests drive only dial()'s timing and queueing.
vi.mock("./noise.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("./noise.ts")>()), phoneHello: vi.fn() }));

const { phoneHello } = await import("./noise.ts");
const { dial, SessionClosed } = await import("./session.ts");

class FakeSocket {
  static last: FakeSocket;
  binaryType = "blob";
  bufferedAmount = 0;
  sent: unknown[] = [];
  closes: Array<number | undefined> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closes.push(code);
  }
  message(data: string | Uint8Array) {
    this.onmessage!({ data: typeof data === "string" ? data : data.slice().buffer } as MessageEvent);
  }
}

const keys = {
  send: { seal: async (plaintext: Bytes) => plaintext },
  receive: { open: async (record: Bytes) => record },
} as unknown as SessionKeys;
const base = { remoteStatic: new Uint8Array(65), psk: new Uint8Array(32), app: "web-test/1" };
/** Ping {SYN} 7 from the computer. */
const PING = Uint8Array.of(0, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 7);

let finishKeys: ((keys: SessionKeys) => void) | undefined;

beforeEach(() => {
  finishKeys = undefined;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.mocked(phoneHello).mockResolvedValue({
    message1: Uint8Array.of(1),
    finish: () => new Promise<SessionKeys>((resolve) => (finishKeys = resolve)),
  } as unknown as Awaited<ReturnType<typeof phoneHello>>);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settled = (promise: Promise<unknown>) => {
  const state: { error?: unknown; done: boolean } = { done: false };
  promise.then(
    () => (state.done = true),
    (error: unknown) => Object.assign(state, { done: true, error }),
  );
  return state;
};

/** Opens the socket and hands dial() a message 2 to check; the check waits for finishKeys. */
async function atMessage2(options: Partial<Parameters<typeof dial>[0]> = {}) {
  const attempt = dial({ ...base, url: "wss://computer.test/e2e", pingIntervalMs: 60_000, ...options });
  const socket = FakeSocket.last;
  socket.onopen!();
  await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
  socket.message(new Uint8Array(96));
  return { attempt, socket };
}

describe("dial: the handshake deadline", () => {
  it("gives the handshake its own 10 s from the relay's ready, inside the attempt's 20 s", async () => {
    vi.useFakeTimers();
    const relay = { hostId: new Uint8Array(16), adm: new Uint8Array(16) };
    const attempt = settled(dial({ ...base, url: "wss://relay.test/v1/phone", relay }));
    const socket = FakeSocket.last;
    socket.onopen!();
    // A slow node: ready comes 8 s in.
    await vi.advanceTimersByTimeAsync(8_000);
    socket.message(JSON.stringify({ t: "ready" }));
    await vi.advanceTimersByTimeAsync(9_900);
    expect(attempt.done).toBe(false);
    expect(socket.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(attempt.error).toBeInstanceOf(SessionClosed);
    expect(attempt.error).toMatchObject({ code: 4002 });
    expect(socket.closes).toEqual([4002]);
  });
});

describe("dial: records that arrive while message 2 is checked", () => {
  it("replays a few in order once message 2 checks out", async () => {
    const { attempt, socket } = await atMessage2();
    for (let i = 0; i < 3; i++) socket.message(PING);
    await vi.waitFor(() => expect(finishKeys).toBeDefined());
    finishKeys!(keys);
    const session = await attempt;
    // Message 1, then an ACK for each ping.
    await vi.waitFor(() => expect(socket.sent).toHaveLength(4));
    session.close(1000);
  });

  it("refuses the session, holding nothing, when more arrive than a session's start can need", async () => {
    const { attempt, socket } = await atMessage2();
    const state = settled(attempt);
    for (let i = 0; i < 65; i++) socket.message(PING);
    await vi.waitFor(() => expect(finishKeys).toBeDefined());
    finishKeys!(keys);
    await vi.waitFor(() => expect(state.done).toBe(true));
    expect(state.error).toMatchObject({ code: 4000 });
    expect(socket.closes).toEqual([4000]);
    expect(socket.sent).toHaveLength(1);
  });
});
