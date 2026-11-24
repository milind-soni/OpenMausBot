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
    setWaking: vi.fn(),
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

/** A Cloud that answers each exchange as `answer` says, and holds an idle poll open until it is hung up. */
async function sleepyCloud(answer: (request: { background: boolean; wait: number }) => "ok" | "asleep" | "hold" = ({ wait }) => (wait > 0 ? "hold" : "ok")) {
  const seen: Array<{ background: boolean; wait: number }> = [];
  const listeners = new Set<() => void>();
  const origin = await cloud((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { wait: number };
      const one = { background: request.headers["x-omb-background"] === "1", wait: body.wait };
      seen.push(one);
      for (const listener of listeners) listener();
      const said = answer(one);
      if (said === "asleep") { response.writeHead(503, { "content-type": "application/json", "x-omb-cloud-power": "asleep" }); response.end(JSON.stringify({ error: "asleep" })); }
      else if (said === "ok") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ session: "session-1", frames: [] })); }
    });
  });
  const requests = (count: number) => new Promise<void>((resolve) => {
    const check = () => { if (seen.length >= count) { listeners.delete(check); resolve(); } };
    listeners.add(check);
    check();
  });
  return { origin, seen, requests };
}

/** A computer's link whose Cloud sleeps: work can be wanted, and what the dialer says of waking is kept. */
function sleepyLink(origin: string) {
  let wanted: () => void = () => {};
  const waking: boolean[] = [];
  const link = {
    dial: () => ({ origin, token: "fixture-link-token" }),
    cloudPeer: () => "cloud-peer",
    sessionStarted: vi.fn(),
    outgoing: vi.fn(() => []),
    hasOutgoing: () => false,
    receive: vi.fn(),
    setOnline: vi.fn(),
    setLevel: vi.fn(),
    setSleeps: vi.fn(),
    sleeps: () => true,
    setWaking: (_peer: string, on: boolean) => { waking.push(on); },
    setTransfer: vi.fn(),
    onOutgoing: () => () => {},
    onWanted: (listener: () => void) => { wanted = listener; return () => { wanted = () => {}; }; },
    ended: () => [],
    forgetEnded: vi.fn(),
  };
  return { link: link as unknown as BotLink, observed: link, want: () => wanted(), waking };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe("a Cloud that sleeps", () => {
  it("parked, nothing is asked of it: not by time, not by directory news", async () => {
    const sleepy = await sleepyCloud();
    const { link } = sleepyLink(sleepy.origin);
    const dialer = createDialer({ link, holdMs: 200, firstRetryMs: 1 });
    cleanups.push(() => dialer.close());
    dialer.start({ gentle: true });
    await settle();
    expect(dialer.state()).toMatchObject({ running: true, asleep: true });
    expect(sleepy.seen).toEqual([]);
  });

  it("work a person waits on wakes it with an exchange that is not background; the idle polls after it are background again", async () => {
    const sleepy = await sleepyCloud();
    const { link, observed, want, waking } = sleepyLink(sleepy.origin);
    const dialer = createDialer({ link, holdMs: 5_000 });
    cleanups.push(() => dialer.close());
    dialer.start({ gentle: true });
    want();
    expect(waking).toEqual([true]);
    await sleepy.requests(2);
    expect(sleepy.seen).toEqual([{ background: false, wait: 0 }, { background: true, wait: 5_000 }]);
    expect(observed.setOnline).toHaveBeenCalledWith("cloud-peer", true);
  });

  it("a Cloud that answers even that exchange with asleep parks the link once, with no second ask", async () => {
    const sleepy = await sleepyCloud(() => "asleep");
    const { link, want, waking } = sleepyLink(sleepy.origin);
    const dialer = createDialer({ link, firstRetryMs: 1 });
    cleanups.push(() => dialer.close());
    dialer.start({ gentle: true });
    want();
    await sleepy.requests(1);
    await settle();
    expect(sleepy.seen).toEqual([{ background: false, wait: 0 }]);
    expect(dialer.state()).toMatchObject({ asleep: true });
    expect(waking).toEqual([true, false]);
  });

  it("the app's asleep heard before the Cloud last answered work parks nothing; one heard after it does", async () => {
    let clock = 10_000;
    const sleepy = await sleepyCloud();
    const { link, want } = sleepyLink(sleepy.origin);
    const transport = observeFetch();
    const dialer = createDialer({ link, fetch: transport.fetch, holdMs: 5_000, now: () => clock });
    cleanups.push(() => dialer.close());
    dialer.start({ gentle: true });
    want();
    await sleepy.requests(2);
    clock = 20_000;
    dialer.sleep(5_000);
    dialer.sleep(10_000);
    expect(dialer.state()).toMatchObject({ asleep: false });
    expect(transport.signals[1]!.aborted).toBe(false);
    dialer.sleep(10_001);
    expect(dialer.state()).toMatchObject({ asleep: true });
    expect(transport.signals[1]!.aborted).toBe(true);
    // Parked by the newer word: the old one is no longer stale, and a word without a time parks as before.
    dialer.start();
    await sleepy.requests(3);
    dialer.sleep(5_000);
    expect(dialer.state()).toMatchObject({ asleep: true });
  });

  it("while work is waking it, the app's asleep parks nothing, whenever it was heard", async () => {
    const sleepy = await sleepyCloud(() => "hold");
    const { link, want } = sleepyLink(sleepy.origin);
    const transport = observeFetch();
    const dialer = createDialer({ link, fetch: transport.fetch });
    cleanups.push(() => dialer.close());
    dialer.start({ gentle: true });
    want();
    await sleepy.requests(1);
    dialer.sleep(Date.now() + 60_000);
    dialer.sleep();
    expect(dialer.state()).toMatchObject({ asleep: false });
    expect(transport.signals[0]!.aborted).toBe(false);
  });

  it("an idle poll answered while the app says asleep proves nothing: the word parks it", async () => {
    let clock = 10_000;
    const sleepy = await sleepyCloud();
    const { link } = sleepyLink(sleepy.origin);
    const dialer = createDialer({ link, holdMs: 5_000, now: () => clock });
    cleanups.push(() => dialer.close());
    dialer.start();
    await sleepy.requests(2);
    expect(sleepy.seen.every((one) => one.background)).toBe(true);
    clock = 20_000;
    dialer.sleep(1);
    expect(dialer.state()).toMatchObject({ asleep: true });
  });
});
