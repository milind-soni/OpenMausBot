import { afterEach, describe, expect, it, vi } from "vitest";

import type { RelayLink, RelayRequest } from "./e2e/relay-link";
import { openLiveEvents } from "./live-events";
import { api } from "@/state/api";
import { relayEventSource, serverFetch, setRelayLink } from "./relay-server";

type Sent = { path: string; request: RelayRequest };

/** A RelayLink that answers each request with `answer`, recording what it was asked. */
function fakeLink(answer: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const link = {
    fetch: vi.fn(async (path: string, request: RelayRequest = {}) => {
      const one = { path, request };
      sent.push(one);
      return answer(one);
    }),
    close: vi.fn(),
  };
  return { link: link as unknown as RelayLink, sent, close: link.close };
}

/** An event stream whose chunks the test pushes. */
function eventStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
    cancel: cancelled,
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    cancelled,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  setRelayLink(null);
  vi.unstubAllGlobals();
});

describe("serverFetch", () => {
  it("is a plain fetch while no relay link is set, and for paths outside /api", async () => {
    const plain = vi.fn(async (_path: string) => new Response("plain"));
    vi.stubGlobal("fetch", plain);
    await serverFetch("/api/bots");
    const { link, sent } = fakeLink(() => new Response("relayed"));
    setRelayLink(link);
    await serverFetch("/apiary");
    await serverFetch("/assets/app.js");
    expect(plain.mock.calls.map(([path]) => path)).toEqual(["/api/bots", "/apiary", "/assets/app.js"]);
    expect(sent).toEqual([]);
  });

  it("sends /api requests through the link, with the method, headers and body as bytes", async () => {
    const plain = vi.fn();
    vi.stubGlobal("fetch", plain);
    const { link, sent } = fakeLink(() => Response.json({ ok: true }));
    setRelayLink(link);

    const reply = await serverFetch("/api/bots?x=1", {
      method: "post",
      headers: { "content-type": "application/json", "x-omb-background": "1" },
      body: JSON.stringify({ name: "Ada" }),
    });
    expect(await reply.json()).toEqual({ ok: true });
    expect(plain).not.toHaveBeenCalled();
    expect(sent[0].path).toBe("/api/bots?x=1");
    expect(sent[0].request.method).toBe("POST");
    const headers = new Headers(sent[0].request.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-omb-background")).toBe("1");
    expect(new TextDecoder().decode(sent[0].request.body as Uint8Array)).toBe('{"name":"Ada"}');

    await serverFetch("/api/auth/session");
    expect(sent[1].request).toMatchObject({ method: "GET", body: null });
  });

  it("gives a form upload its multipart content type and bytes", async () => {
    const { link, sent } = fakeLink(() => new Response(null, { status: 204 }));
    setRelayLink(link);
    const form = new FormData();
    form.set("file", new Blob(["hello"], { type: "text/plain" }), "a.txt");
    await serverFetch("/api/files", { method: "POST", body: form });
    const type = new Headers(sent[0].request.headers).get("content-type") ?? "";
    expect(type).toMatch(/^multipart\/form-data; boundary=/);
    const text = new TextDecoder().decode(sent[0].request.body as Uint8Array);
    expect(text).toContain('filename="a.txt"');
    expect(text).toContain("hello");
  });

  it("sends the environment descriptor through the link too, as it describes the paired server", async () => {
    const plain = vi.fn();
    vi.stubGlobal("fetch", plain);
    const { link, sent } = fakeLink(() => Response.json({ environmentId: "env-1" }));
    setRelayLink(link);

    expect(await (await serverFetch("/.well-known/openmausbot/environment")).json()).toEqual({ environmentId: "env-1" });
    await serverFetch("/.well-known/openmausbot/environmental");
    expect(sent.map(({ path }) => path)).toEqual(["/.well-known/openmausbot/environment"]);
    expect(plain.mock.calls.map(([path]) => path)).toEqual(["/.well-known/openmausbot/environmental"]);
  });

  it("forwards the normalized target: unsafe characters encoded, no fragment", async () => {
    const { link, sent } = fakeLink(() => new Response("{}"));
    setRelayLink(link);
    await serverFetch("/api/bots?name=A B#section");
    await serverFetch("/api/files/a b.txt");
    expect(sent.map((one) => one.path)).toEqual(["/api/bots?name=A%20B", "/api/files/a%20b.txt"]);
  });

  it("sends an absolute URL on this page's own origin and /api through the link; other origins stay plain", async () => {
    const plain = vi.fn(async (_path: string) => new Response("plain"));
    vi.stubGlobal("fetch", plain);
    vi.stubGlobal("location", { origin: "https://app.example" });
    const { link, sent } = fakeLink(() => new Response(null, { status: 204 }));
    setRelayLink(link);
    await serverFetch("https://app.example/api/bots/b1/browser/upload?chooser=c1&token=t", { method: "POST", body: new FormData() });
    await serverFetch("https://APP.example:443/api/bots");
    await serverFetch("https://other.example/api/bots");
    await serverFetch("https://app.example/apiary");
    expect(sent.map((one) => one.path)).toEqual(["/api/bots/b1/browser/upload?chooser=c1&token=t", "/api/bots"]);
    expect(plain.mock.calls.map(([path]) => path)).toEqual(["https://other.example/api/bots", "https://app.example/apiary"]);
  });

  it("passes the caller's signal to the link", async () => {
    const { link, sent } = fakeLink(() => new Response("{}"));
    setRelayLink(link);
    const stop = new AbortController();
    await serverFetch("/api/bots", { signal: stop.signal });
    expect(sent[0].request.signal).toBe(stop.signal);
  });

  it("closes a link that is replaced or cleared", () => {
    const first = fakeLink(() => new Response());
    const second = fakeLink(() => new Response());
    setRelayLink(first.link);
    setRelayLink(first.link);
    expect(first.close).not.toHaveBeenCalled();
    setRelayLink(second.link);
    expect(first.close).toHaveBeenCalledTimes(1);
    setRelayLink(null);
    expect(second.close).toHaveBeenCalledTimes(1);
  });
});

describe("api through a relay link", () => {
  it("sends the app's JSON requests through the link", async () => {
    const plain = vi.fn();
    vi.stubGlobal("fetch", plain);
    const { link, sent } = fakeLink(() => Response.json([{ id: "b1" }]));
    setRelayLink(link);
    expect(await api("/api/bots")).toEqual([{ id: "b1" }]);
    expect(plain).not.toHaveBeenCalled();
    expect(sent.map(({ path }) => path)).toEqual(["/api/bots"]);
  });
});

describe("relayEventSource", () => {
  it("opens, then hands each unnamed or message event to onmessage across chunk and line-ending splits", async () => {
    const stream = eventStream();
    const { link, sent } = fakeLink(() => stream.response);
    const source = relayEventSource(link, "/api/events?since=7");
    const opened = vi.fn();
    const messages: Array<{ data: string; lastEventId?: string }> = [];
    source.onopen = opened;
    source.onmessage = (event) => messages.push(event);
    source.onerror = vi.fn();

    await tick();
    expect(sent[0].path).toBe("/api/events?since=7");
    expect(new Headers(sent[0].request.headers).get("accept")).toBe("text/event-stream");
    expect(opened).toHaveBeenCalledTimes(1);

    stream.push(": keepalive\n\nid: 8\ndata: {\"kind\":\"pi");
    stream.push("ng\"}\n\nevent: other\ndata: skipped\n\ndata: a\r\ndata:b\r");
    stream.push("\n\r\nretry: 10\nid: 9\ndata\n\n");
    await tick();
    expect(messages).toEqual([
      { data: '{"kind":"ping"}', lastEventId: "8" },
      { data: "a\nb", lastEventId: "8" },
      { data: "", lastEventId: "9" },
    ]);
    expect(source.onerror).not.toHaveBeenCalled();
  });

  it("delivers an event whose last line ends in a CR at once, and counts a CRLF split across chunks once", async () => {
    const stream = eventStream();
    const { link } = fakeLink(() => stream.response);
    const source = relayEventSource(link, "/api/events");
    const messages: string[] = [];
    source.onmessage = (event) => messages.push(event.data);
    source.onerror = vi.fn();
    await tick();

    stream.push("data: x\r\r");
    await tick();
    expect(messages).toEqual(["x"]);

    stream.push("data: y\r");
    stream.push("\ndata: z\r");
    stream.push("\n\r\n");
    await tick();
    expect(messages).toEqual(["x", "y\nz"]);
    expect(source.onerror).not.toHaveBeenCalled();
  });

  it("reports onerror once when the stream ends, so live events reconnect", async () => {
    const stream = eventStream();
    const { link } = fakeLink(() => stream.response);
    const source = relayEventSource(link, "/api/events");
    source.onerror = vi.fn();
    await tick();
    stream.end();
    await tick();
    expect(source.onerror).toHaveBeenCalledTimes(1);
  });

  it("reports onerror without opening for a refusal or a reply that isn't an event stream, and for a failed request", async () => {
    for (const answer of [
      () => Response.json({ error: "unauthorized" }, { status: 401 }),
      () => Response.json({ ok: true }),
      () => Promise.reject(new Error("relay unreachable")),
    ]) {
      const { link } = fakeLink(answer);
      const source = relayEventSource(link, "/api/events");
      source.onopen = vi.fn();
      source.onerror = vi.fn();
      await tick();
      expect(source.onopen).not.toHaveBeenCalled();
      expect(source.onerror).toHaveBeenCalledTimes(1);
    }
  });

  it("stops delivering and cancels the stream on close, with no onerror", async () => {
    const stream = eventStream();
    const { link, sent } = fakeLink(() => stream.response);
    const source = relayEventSource(link, "/api/events");
    source.onmessage = vi.fn();
    source.onerror = vi.fn();
    await tick();
    source.close();
    expect(sent[0].request.signal?.aborted).toBe(true);
    stream.push("data: late\n\n");
    await tick();
    expect(source.onmessage).not.toHaveBeenCalled();
    expect(source.onerror).not.toHaveBeenCalled();
    expect(stream.cancelled).toHaveBeenCalled();
  });
});

describe("live events through a relay link", () => {
  it("opens the live events stream through the link when one is set, even with no EventSource in the page", async () => {
    vi.stubGlobal("EventSource", undefined);
    const stream = eventStream();
    const { link, sent } = fakeLink(() => stream.response);
    setRelayLink(link);
    const frames: string[] = [];
    const opened = vi.fn();
    const stop = openLiveEvents({ onOpen: opened, onFrame: (frame) => frames.push(frame.kind), onSnapshotRequired: async () => true });
    await tick();
    expect(sent[0].path).toMatch(/^\/api\/events/);
    expect(opened).toHaveBeenCalledTimes(1);
    stream.push('id: c1\ndata: {"kind":"relay-test"}\n\n');
    await tick();
    expect(frames).toEqual(["relay-test"]);
    stop();
    expect(sent[0].request.signal?.aborted).toBe(true);
  });
});
