import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDialer } from "./dial.ts";
import type { BotLink } from "./link.ts";
import { HOLD_MS, type Numbered } from "./protocol.ts";

const cleanups: Array<() => void | Promise<void>> = [];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function cloud(handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function linkAt(origin: string) {
  let outbox: Numbered[] = [{ seq: 1, frame: { t: "result", id: "sent-result", ok: true, text: "Finished" } }];
  let outgoing: () => void = () => {};
  const received = deferred<void>();
  const link = {
    dial: () => ({ origin, token: "fixture-link-token" }),
    cloudPeer: () => "cloud-peer",
    sessionStarted: vi.fn(),
    outgoing: vi.fn((_peer: string, ack: number) => { outbox = outbox.filter((entry) => entry.seq > ack); return [...outbox]; }),
    hasOutgoing: () => outbox.length > 0,
    receive: vi.fn(() => received.resolve()),
    setOnline: vi.fn(),
    setLevel: vi.fn(),
    setSleeps: vi.fn(),
    sleeps: () => false,
    setTransfer: vi.fn(),
    onOutgoing: (listener: () => void) => { outgoing = listener; return () => { outgoing = () => {}; }; },
    onWanted: () => () => {},
    ended: () => [],
    forgetEnded: vi.fn(),
  };
  return {
    link: link as unknown as BotLink,
    observed: link,
    received: received.promise,
    queue() { outbox.push({ seq: 2, frame: { t: "cancel", id: "cancelled-work" } }); outgoing(); },
  };
}

function observeFetch() {
  const reading = deferred<void>();
  const signals: AbortSignal[] = [];
  const fetchObserved: typeof fetch = async (input, init) => {
    signals.push(init!.signal!);
    const response = await fetch(input, init);
    const json = response.json.bind(response);
    vi.spyOn(response, "json").mockImplementation(() => { reading.resolve(); return json(); });
    return response;
  };
  return { fetch: fetchObserved, reading: reading.promise, signals };
}

describe("bot-link exchange lifetime", () => {
  it("bounds a stalled JSON body and retries without acknowledging the unfinished exchange", async () => {
    const first = deferred<ServerResponse>();
    let requests = 0;
    const origin = await cloud((request, response) => {
      request.resume();
      requests += 1;
      if (requests === 1) {
        response.writeHead(200, { "content-type": "application/json" });
        response.write("{");
        first.resolve(response);
      } else if (requests === 2) {
        response.end(JSON.stringify({ session: "session-1", frames: [{ seq: 1, frame: { t: "done", id: "received-result" } }] }));
      }
    });
    const { link, observed, received } = linkAt(origin);
    const transport = observeFetch();
    const retrying = deferred<void>();
    const dialer = createDialer({ link, fetch: transport.fetch, firstRetryMs: 1, log: () => retrying.resolve() });
    cleanups.push(() => dialer.close());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    dialer.start();
    await first.promise;
    await transport.reading;
    expect(observed.outgoing.mock.calls.every(([, ack]) => ack === 0)).toBe(true);
    vi.advanceTimersByTime(HOLD_MS + 15_000);
    expect(transport.signals[0]!.aborted).toBe(true);
    vi.useRealTimers();
    await retrying.promise;
    await received;
    expect(observed.outgoing.mock.calls.filter(([, ack]) => ack === 1)).toHaveLength(1);
    expect(observed.receive).toHaveBeenCalledExactlyOnceWith("cloud-peer", [{ t: "done", id: "received-result" }]);
    expect(observed.sessionStarted).toHaveBeenCalledTimes(2);
  });

  it.each(["stop", "close", "sleep"] as const)("%s aborts a request that has not returned headers", async (action) => {
    const requested = deferred<void>();
    const origin = await cloud((request) => { request.resume(); requested.resolve(); });
    const { link, observed } = linkAt(origin);
    const transport = observeFetch();
    const dialer = createDialer({ link, fetch: transport.fetch });
    cleanups.push(() => dialer.close());
    dialer.start();
    await requested.promise;
    await dialer[action]();
    expect(transport.signals[0]!.aborted).toBe(true);
    expect(observed.receive).not.toHaveBeenCalled();
    expect(observed.setOnline).not.toHaveBeenCalledWith("cloud-peer", true);
    expect(observed.outgoing.mock.calls.every(([, ack]) => ack === 0)).toBe(true);
  });

  it.each(["stop", "close", "sleep"] as const)("%s aborts an exchange while its JSON body is incomplete", async (action) => {
    const origin = await cloud((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
    });
    const { link, observed } = linkAt(origin);
    const transport = observeFetch();
    const dialer = createDialer({ link, fetch: transport.fetch });
    cleanups.push(() => dialer.close());
    dialer.start();
    await transport.reading;
    await dialer[action]();
    expect(transport.signals[0]!.aborted).toBe(true);
    expect(observed.receive).not.toHaveBeenCalled();
    expect(observed.setOnline).not.toHaveBeenCalledWith("cloud-peer", true);
    expect(observed.outgoing.mock.calls.every(([, ack]) => ack === 0)).toBe(true);
  });

  it("acknowledges and delivers a complete response once, then clears its deadline", async () => {
    const partial = deferred<ServerResponse>();
    let requests = 0;
    const origin = await cloud((request, response) => {
      request.resume();
      if (++requests !== 1) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"session":"session-1","frames":[');
      partial.resolve(response);
    });
    const { link, observed, received } = linkAt(origin);
    const transport = observeFetch();
    const dialer = createDialer({ link, fetch: transport.fetch });
    cleanups.push(() => dialer.close());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    dialer.start();
    const response = await partial.promise;
    await transport.reading;
    expect(observed.receive).not.toHaveBeenCalled();
    expect(observed.outgoing.mock.calls.every(([, ack]) => ack === 0)).toBe(true);
    response.end('{"seq":1,"frame":{"t":"done","id":"received-result"}}]}');
    await received;
    expect(observed.receive).toHaveBeenCalledExactlyOnceWith("cloud-peer", [{ t: "done", id: "received-result" }]);
    expect(observed.outgoing.mock.calls.filter(([, ack]) => ack === 1)).toHaveLength(1);
    dialer.close();
    vi.advanceTimersByTime(HOLD_MS + 15_000);
    expect(transport.signals[0]!.aborted).toBe(false);
  });

  it("still wakes a held poll when new outgoing work is queued", async () => {
    const held = deferred<void>();
    const sent = deferred<{ wait: number; fresh: boolean; frames: unknown[] }>();
    let requests = 0;
    const origin = await cloud((request, response) => {
      const index = ++requests;
      if (index === 1) {
        request.resume();
        response.end(JSON.stringify({ session: "session-1", frames: [] }));
      } else if (index === 2) {
        request.resume();
        held.resolve();
      } else if (index === 3) {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => sent.resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      }
    });
    const { link, queue } = linkAt(origin);
    const transport = observeFetch();
    const dialer = createDialer({ link, fetch: transport.fetch });
    cleanups.push(() => dialer.close());
    dialer.start();
    await held.promise;
    queue();
    const payload = await sent.promise;
    expect(transport.signals[1]!.aborted).toBe(true);
    expect(payload).toMatchObject({ fresh: false, wait: 0, frames: [{ t: "cancel", id: "cancelled-work" }] });
  });
});
