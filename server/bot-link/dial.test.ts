import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDialer, WAKE_MS, WAKE_TRIES, WAKES_PER_HOUR } from "./dial.ts";
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
    await (action === "sleep" ? dialer.sleep(Date.now()) : dialer[action]());
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
    await (action === "sleep" ? dialer.sleep(Date.now()) : dialer[action]());
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
function sleepyLink(origin: string, { sleeps = true }: { sleeps?: boolean } = {}) {
  let wanted: (person: boolean) => void = () => {};
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
    sleeps: () => sleeps,
    setWaking: (_peer: string, on: boolean) => { waking.push(on); },
    setTransfer: vi.fn(),
    onOutgoing: () => () => {},
    onWanted: (listener: (person: boolean) => void) => { wanted = listener; return () => { wanted = () => {}; }; },
    ended: () => [],
    forgetEnded: vi.fn(),
  };
  return { link: link as unknown as BotLink, observed: link, want: (person = true) => wanted(person), waking };
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

  it("this server starting asks nothing of the Cloud, even one the link never saw asleep, until the app says it is awake", async () => {
    const sleepy = await sleepyCloud();
    const { link } = sleepyLink(sleepy.origin, { sleeps: false });
    const dialer = createDialer({ link, holdMs: 200, firstRetryMs: 1 });
    cleanups.push(() => dialer.close());
    dialer.start({ gentle: true });
    await settle();
    expect(dialer.state()).toMatchObject({ running: true, asleep: true });
    expect(sleepy.seen, "a stopped Cloud is not started by this server starting").toEqual([]);
  });

  it("an awake the app heard before the link parked starts nothing; one heard after it asks the Cloud once", async () => {
    let clock = 50_000;
    const sleepy = await sleepyCloud();
    const { link } = sleepyLink(sleepy.origin);
    const dialer = createDialer({ link, holdMs: 5_000, firstRetryMs: 1, now: () => clock });
    cleanups.push(() => dialer.close());
    dialer.start({ gentle: true });
    expect(dialer.state()).toMatchObject({ asleep: true, parkedAt: 50_000 });
    clock = 60_000;
    dialer.start({ heardAt: 20_000 });
    dialer.start({ heardAt: 50_000 });
    await settle();
    expect(sleepy.seen, "the Admin's awake from before the Cloud went to sleep is stale").toEqual([]);
    expect(dialer.state()).toMatchObject({ asleep: true });
    dialer.start({ heardAt: 60_000 });
    await sleepy.requests(1);
    expect(sleepy.seen[0], "the first ask since the park, as background work; the held poll that follows is the link's own").toEqual({ background: true, wait: 0 });
    expect(dialer.state()).toMatchObject({ asleep: false });
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

  it("the Cloud's own asleep answer is kept for the app to hold, apart from a park the app asked for", async () => {
    let clock = 70_000;
    const sleepy = await sleepyCloud(() => "asleep");
    const { link } = sleepyLink(sleepy.origin);
    const dialer = createDialer({ link, firstRetryMs: 1, now: () => clock });
    cleanups.push(() => dialer.close());
    dialer.start({ gentle: true });
    expect(dialer.state()).not.toHaveProperty("cloudAsleepAt");
    clock = 80_000;
    dialer.start({ heardAt: 80_000 });
    await sleepy.requests(1);
    await settle();
    expect(dialer.state()).toMatchObject({ asleep: true, cloudAsleepAt: 80_000 });
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

/** A transport to a Cloud that cannot answer (a network error, or the provider's 502), with a clock each request moves on. */
function unanswering(kind: "network" | "502", clock: { at: number }, step: number, answerAfter = Infinity) {
  const calls: Array<{ foreground: boolean }> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push({ foreground: !(init.headers as Record<string, string>)["x-omb-background"] });
    clock.at += step;
    // Once it answers, it answers that exchange, then holds each idle poll open until it is hung up.
    if (calls.length > answerAfter + 1) return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    if (calls.length > answerAfter) return new Response(JSON.stringify({ session: "session-1", frames: [] }), { status: 200, headers: { "content-type": "application/json" } });
    if (kind === "network") throw new TypeError("fetch failed");
    return new Response("bad gateway", { status: 502 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("a wake for work is bounded", () => {
  it("fails once, then answers: the work still goes, and the app's asleep meanwhile parks nothing", async () => {
    const clock = { at: 1_000_000 };
    const cloudSide = unanswering("502", clock, 1_000, 1);
    const { link, observed, want } = sleepyLink("https://cloud.invalid");
    const dialer = createDialer({ link, fetch: cloudSide.fetch, firstRetryMs: 1, holdMs: 60_000, now: () => clock.at });
    cleanups.push(() => dialer.close());
    dialer.start({ gentle: true });
    want();
    await vi.waitFor(() => expect(observed.setOnline).toHaveBeenCalledWith("cloud-peer", true));
    expect(cloudSide.calls.slice(0, 2)).toEqual([{ foreground: true }, { foreground: true }]);
    dialer.sleep(clock.at - 10_000);
    expect(dialer.state()).toMatchObject({ asleep: false });
  });

  for (const kind of ["network", "502"] as const) {
    it(`never answers (${kind}): at most ${WAKE_TRIES} foreground asks a wake, then it parks; the app's asleep parks it; ${WAKES_PER_HOUR} wakes an hour`, async () => {
      const clock = { at: 1_000_000 };
      const cloudSide = unanswering(kind, clock, 1_000);
      const { link, want, waking } = sleepyLink("https://cloud.invalid");
      const dialer = createDialer({ link, fetch: cloudSide.fetch, firstRetryMs: 1, now: () => clock.at });
      cleanups.push(() => dialer.close());
      dialer.start({ gentle: true });
      const foreground = () => cloudSide.calls.filter((call) => call.foreground).length;
      for (let wake = 1; wake <= WAKES_PER_HOUR; wake += 1) {
        clock.at += 60_000;
        want();
        await vi.waitFor(() => expect(dialer.state().asleep).toBe(true), { timeout: 5_000 });
        expect(foreground()).toBe(wake * WAKE_TRIES);
        expect(waking.at(-1)).toBe(false);
      }
      await settle();
      expect(cloudSide.calls).toHaveLength(WAKES_PER_HOUR * WAKE_TRIES);
      // A fourth in the same hour is no wake: the link stays parked and asks nothing.
      want();
      await settle();
      expect(cloudSide.calls).toHaveLength(WAKES_PER_HOUR * WAKE_TRIES);
      expect(dialer.state()).toMatchObject({ asleep: true });
      expect(foreground()).toBe(WAKES_PER_HOUR * WAKE_TRIES);
      // An hour on, work may wake it again.
      clock.at += 60 * 60_000;
      want();
      await vi.waitFor(() => expect(foreground()).toBe((WAKES_PER_HOUR + 1) * WAKE_TRIES), { timeout: 5_000 });
    });
  }

  it("a person's work past the wakes an hour allows waits, says when it goes, and wakes the Cloud by itself once the hour has passed", async () => {
    const clock = { at: 1_000_000 };
    const cloudSide = unanswering("network", clock, 0);
    const { link, observed, want } = sleepyLink("https://cloud.invalid");
    const later = vi.fn();
    Object.assign(observed, { wakeLater: later, personWaiting: () => true });
    const dialer = createDialer({ link, fetch: cloudSide.fetch, firstRetryMs: 1, now: () => clock.at });
    cleanups.push(() => dialer.close());
    dialer.start({ gentle: true });
    const foreground = () => cloudSide.calls.filter((call) => call.foreground).length;
    for (let wake = 1; wake <= WAKES_PER_HOUR; wake += 1) {
      want();
      await vi.waitFor(() => expect(foreground()).toBe(wake * WAKE_TRIES), { timeout: 5_000 });
      await vi.waitFor(() => expect(dialer.state().asleep).toBe(true), { timeout: 5_000 });
    }
    clock.at += 60 * 60_000 - 200;
    want();
    await settle();
    expect(foreground(), "past the limit: nothing now").toBe(WAKES_PER_HOUR * WAKE_TRIES);
    expect(later).toHaveBeenLastCalledWith("cloud-peer", 1_200);
    clock.at += 1_000;
    await vi.waitFor(() => expect(foreground()).toBe((WAKES_PER_HOUR + 1) * WAKE_TRIES), { timeout: 5_000 });
    expect(later).toHaveBeenLastCalledWith("cloud-peer", 0);
  });

  it("a wake that runs out of time parks, and the app's asleep is no longer put off", async () => {
    const clock = { at: 1_000_000 };
    const cloudSide = unanswering("network", clock, 0);
    const { link, want } = sleepyLink("https://cloud.invalid");
    const dialer = createDialer({ link, fetch: cloudSide.fetch, firstRetryMs: 60_000, now: () => clock.at });
    cleanups.push(() => dialer.close());
    dialer.start({ gentle: true });
    want();
    await vi.waitFor(() => expect(cloudSide.calls).toHaveLength(1));
    dialer.sleep(clock.at);
    expect(dialer.state()).toMatchObject({ asleep: false });
    clock.at += WAKE_MS;
    dialer.sleep(clock.at);
    expect(dialer.state()).toMatchObject({ asleep: true });
    expect(cloudSide.calls).toHaveLength(1);
  });

  it("work no person waits on (a routine's) never wakes a parked link: nothing is asked until the app says the Cloud is awake", async () => {
    let clock = 5_000;
    const sleepy = await sleepyCloud(() => "asleep");
    const { link, want, waking } = sleepyLink(sleepy.origin);
    const dialer = createDialer({ link, now: () => clock });
    cleanups.push(() => dialer.close());
    dialer.start({ gentle: true });
    want(false);
    await settle();
    expect(sleepy.seen).toEqual([]);
    expect(waking).toEqual([]);
    expect(dialer.state()).toMatchObject({ asleep: true });
    clock = 6_000;
    dialer.start({ heardAt: 6_000 });
    await sleepy.requests(1);
    expect(sleepy.seen[0]).toEqual({ background: true, wait: 0 });
  });

  it("asked to sign in again while waking: the wake ends, and after pairing again the first ask is background", async () => {
    let status = 401;
    const seen: boolean[] = [];
    const origin = await cloud((request, response) => {
      request.resume();
      seen.push(request.headers["x-omb-background"] === "1");
      if (status === 200 && seen.length > 2) return;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(status === 200 ? JSON.stringify({ session: "session-1", frames: [] }) : JSON.stringify({ error: "no" }));
    });
    const { link, want, waking } = sleepyLink(origin);
    const dialer = createDialer({ link, holdMs: 5_000 });
    cleanups.push(() => dialer.close());
    dialer.start({ gentle: true });
    want();
    await vi.waitFor(() => expect(dialer.state().needsPairing).toBe(true));
    expect(seen).toEqual([false]);
    expect(waking).toEqual([true, false]);
    status = 200;
    dialer.start();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(1));
    expect(seen[1]).toBe(true);
  });
});
