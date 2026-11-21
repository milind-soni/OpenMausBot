import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fromB64u, utf8 } from "./bytes.ts";
import { credentialHash, keyId, psk } from "./credentials.ts";
import { HttpError, streamFetch } from "./http.ts";
import { dial, type E2EStream, type PhoneSession } from "./session.ts";

const SERVER = fileURLToPath(new URL("../../../companion/src/e2e/interop-server.ts", import.meta.url));

let child: ChildProcess;
let session: PhoneSession;

beforeAll(async () => {
  child = spawn(process.execPath, [SERVER, "--port", "0", "--exit-with-stdin"], { stdio: ["pipe", "pipe", "ignore"] });
  const ready = await new Promise<{ direct: string; k: string; deviceToken: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("interop server did not say ready in 10 s")), 10_000);
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split("\n").slice(0, -1).find((candidate) => candidate.startsWith("{"));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`interop server exited ${code}`)));
  });
  const remoteStatic = fromB64u(ready.k)!;
  const key = await psk(await credentialHash(ready.deviceToken), await keyId(remoteStatic));
  session = await dial({ url: ready.direct, remoteStatic, psk: key, app: "web-test/1" });
});

afterAll(() => {
  session?.close(1000);
  child?.kill("SIGTERM");
});

const fetchOver = (request: Parameters<typeof streamFetch>[1]) => streamFetch(() => session.open(), request);

/** A stream the test plays the computer for: what the client wrote, and a reply fed in parts. */
function fakeStream(reply: (string | Uint8Array)[], { endAfter = true } = {}) {
  const written: Uint8Array[] = [];
  const state = { ended: false, reset: false, written };
  const parts = reply.map((part) => (typeof part === "string" ? utf8(part) : part));
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const stream: E2EStream = {
    id: 1,
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
      pull(controller) {
        const next = parts.shift();
        if (next) controller.enqueue(next);
        else if (endAfter) controller.close();
      },
    }),
    write: async (bytes) => void written.push(bytes),
    end: () => void (state.ended = true),
    reset: () => {
      // As a real stream does: a reset errors what is still unread.
      state.reset = true;
      try {
        source.error(new Error("stream reset"));
      } catch {
        /* already closed */
      }
    },
  };
  return { open: () => stream, state, sent: () => new TextDecoder().decode(Uint8Array.from(written.flatMap((part) => [...part]))) };
}

const pattern = (n: number, from = 0) => Uint8Array.from({ length: n }, (_, i) => (from + i) % 251);

describe("streamFetch over a real session (interop computer)", () => {
  it("reads a JSON reply", async () => {
    const res = await fetchOver({ path: "/api/health" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("sends a 200 KB body and reads it back whole", async () => {
    const body = pattern(200_000);
    const res = await fetchOver({ method: "POST", path: "/echo", body });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(body);
  });

  it("reads 300 KB byte for byte, and one Range as 206", async () => {
    expect(new Uint8Array(await (await fetchOver({ path: "/bytes?n=300000" })).arrayBuffer())).toEqual(pattern(300_000));
    const part = await fetchOver({ path: "/bytes?n=1000", headers: { Range: "bytes=500-509" } });
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(pattern(10, 500));
  });

  it("streams server-sent events to the end", async () => {
    const res = await fetchOver({ path: "/sse?events=5&size=100&gapMs=5" });
    const text = await res.text();
    expect(text.match(/^id: /gm)).toHaveLength(5);
    expect(text).toContain("event: end");
  });

  it("gives the first event of an endless reply, and abort resets the stream", async () => {
    const abort = new AbortController();
    const res = await fetchOver({ path: "/hang", signal: abort.signal });
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("start");
    const pending = reader.read();
    abort.abort(new Error("left the page"));
    await expect(pending).rejects.toThrow("left the page");
    expect((await fetchOver({ path: "/api/health" })).status).toBe(200);
  });
});

describe("streamFetch framing (fake computer)", () => {
  it("writes one closed request with its own Host, length and no FIN until the reply is read", async () => {
    const fake = fakeStream(["HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi"]);
    const res = await streamFetch(fake.open, { method: "post", path: "/api/x?y=1", headers: { "X-Thing": "a" }, body: "héllo" });
    expect(fake.sent()).toBe("POST /api/x?y=1 HTTP/1.1\r\nHost: companion\r\nx-thing: a\r\nContent-Length: 6\r\nConnection: close\r\n\r\nhéllo");
    expect(fake.state.ended).toBe(false);
    expect(await res.text()).toBe("hi");
    expect(fake.state.ended).toBe(true);
    expect(fake.state.reset).toBe(false);
  });

  it("decodes chunks split at odd places, with extensions and trailers", async () => {
    const wire = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;x=1\r\nhello\r\n1\r\n \r\nA\r\n0123456789\r\n0\r\nX-T: 1\r\n\r\n";
    const parts = wire.match(/[\s\S]{1,3}/g)!;
    expect(await (await streamFetch(fakeStream(parts).open, { path: "/" })).text()).toBe("hello 0123456789");
  });

  it("skips 100 Continue and gives 204 a null body", async () => {
    const res = await streamFetch(fakeStream(["HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n"]).open, { path: "/" });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it("reads to the end of the stream when the reply has no length", async () => {
    expect(await (await streamFetch(fakeStream(["HTTP/1.0 200 OK\r\n\r\nab", "cd"]).open, { path: "/" })).text()).toBe("abcd");
  });

  it("errors a reply cut short of its content-length, and resets the stream", async () => {
    const fake = fakeStream(["HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc"]);
    const res = await streamFetch(fake.open, { path: "/" });
    await expect(res.text()).rejects.toThrow(HttpError);
    expect(fake.state.reset).toBe(true);
  });

  it("errors a chunked reply that ends inside a chunk", async () => {
    const res = await streamFetch(fakeStream(["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nA\r\nabc"]).open, { path: "/" });
    await expect(res.text()).rejects.toThrow("ended inside a chunk");
  });

  it.each([
    ["a head over the limit", ["HTTP/1.1 200 OK\r\n", `X-Big: ${"a".repeat(20_000)}\r\n\r\n`], "reply head is over"],
    ["a folded header", ["HTTP/1.1 200 OK\r\nX-A: 1\r\n  2\r\n\r\n"], "bad header line"],
    ["a bad status line", ["HTTP/2 200\r\n\r\n"], "bad status line"],
    ["an unknown transfer coding", ["HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n"], "unsupported transfer-encoding"],
    ["two different lengths", ["HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n"], "bad content-length"],
    ["a switch of protocols", ["HTTP/1.1 101 Switching Protocols\r\n\r\n"], "switched protocols"],
    ["a stream that ends inside the head", ["HTTP/1.1 200 OK\r\n"], "ended inside the reply head"],
  ])("refuses %s and resets the stream", async (_what, reply, message) => {
    const fake = fakeStream(reply as string[]);
    await expect(streamFetch(fake.open, { path: "/" })).rejects.toThrow(message);
    expect(fake.state.reset).toBe(true);
  });

  it.each([
    [{ path: "/", headers: { Host: "elsewhere" } }, "host is set by the stream client"],
    [{ path: "/", headers: { "Content-Length": "5" } }, "content-length is set by the stream client"],
    [{ path: "/a b" }, "origin-form"],
    [{ path: "http://x/" }, "origin-form"],
    [{ method: "GE T", path: "/" }, "bad method"],
  ])("refuses a request that could split or reframe, before opening a stream (%#)", async (request, message) => {
    let opened = false;
    await expect(streamFetch(() => ((opened = true), fakeStream([]).open()), request)).rejects.toThrow(message);
    expect(opened).toBe(false);
  });

  it("rejects with the abort reason when aborted before the head arrives", async () => {
    const fake = fakeStream([], { endAfter: false });
    const abort = new AbortController();
    const pending = streamFetch(fake.open, { path: "/", signal: abort.signal });
    abort.abort(new Error("gone"));
    await expect(pending).rejects.toThrow("gone");
    expect(fake.state.reset).toBe(true);
  });
});
