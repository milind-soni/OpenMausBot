import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { fromB64u, utf8 } from "./bytes.ts";
import { credentialHash, keyId, psk } from "./credentials.ts";
import { HttpError, MAX_HEAD, streamFetch } from "./http.ts";
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
  let fin!: () => void;
  const stream: E2EStream = {
    id: 1,
    ended: new Promise<void>((resolve) => (fin = resolve)),
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
  return {
    open: () => stream,
    state,
    /** Ends the reply now, for a fake made with endAfter false. */
    finish: () => source.close(),
    /** The computer's FIN arriving, whether or not the reply has been read. */
    fin: () => fin(),
    sent: () => new TextDecoder().decode(Uint8Array.from(written.flatMap((part) => [...part]))) };
}

/** A wire string as its single bytes (0xA0 stays one byte), as the computer would send it. */
const bytes = (wire: string) => Uint8Array.from(wire, (char) => char.charCodeAt(0));

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

  it("echoes 6 MB, more than both stream windows, reading the reply while the upload is still going", async () => {
    const body = pattern(6 * 1024 * 1024);
    const res = await fetchOver({ method: "POST", path: "/echo", body, signal: AbortSignal.timeout(30_000) });
    const echoed = new Uint8Array(await res.arrayBuffer());
    expect(echoed.length).toBe(body.length);
    expect(Buffer.from(echoed).equals(Buffer.from(body))).toBe(true);
  }, 40_000);

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
    // Chunk edges need not match events: read until the first whole one is in.
    let seen = "";
    while (!seen.includes("data: start\n\n")) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`the reply ended before its first event: ${seen}`);
      seen += new TextDecoder().decode(value);
    }
    const pending = reader.read();
    abort.abort(new Error("left the page"));
    await expect(pending).rejects.toThrow("left the page");
    expect((await fetchOver({ path: "/api/health" })).status).toBe(200);
  });

  it("frees the stream of every reply nobody reads, so 100 of them do not use up the session's 64", async () => {
    for (let i = 0; i < 100; i++) {
      // Each reply's head is in; its body (a chunked echo) is left unread, as a caller that only checks the status does.
      expect((await fetchOver({ method: "POST", path: "/echo", body: `read ${i}` })).status).toBe(200);
    }
    expect(await (await fetchOver({ method: "POST", path: "/echo", body: "last" })).text()).toBe("last");
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

  it("ends the request side once the computer's FIN is in, though nobody reads the reply", async () => {
    const fake = fakeStream(["HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi"]);
    await streamFetch(fake.open, { method: "POST", path: "/api/bots/b/read", body: "{}" });
    expect(fake.state.ended).toBe(false);
    fake.fin();
    await vi.waitFor(() => expect(fake.state.ended).toBe(true));
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
    ["chunked with two different lengths", ["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n"], "bad content-length"],
    ["a content-length padded with a 0xA0 byte", [bytes("HTTP/1.1 200 OK\r\nContent-Length: \u00a05\r\n\r\nhello")], "bad content-length"],
    ["a transfer coding padded with a 0xA0 byte", [bytes("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\u00a0\r\n\r\n0\r\n\r\n")], "unsupported transfer-encoding"],
    ["a NUL in the reason phrase", ["HTTP/1.1 200 O\0K\r\nContent-Length: 0\r\n\r\n"], "bad status line"],
    ["a switch of protocols", ["HTTP/1.1 101 Switching Protocols\r\n\r\n"], "switched protocols"],
    ["a stream that ends inside the head", ["HTTP/1.1 200 OK\r\n"], "ended inside the reply head"],
  ])("refuses %s and resets the stream", async (_what, reply, message) => {
    const fake = fakeStream(reply as (string | Uint8Array)[]);
    await expect(streamFetch(fake.open, { path: "/" })).rejects.toThrow(message);
    expect(fake.state.reset).toBe(true);
  });

  it.each([
    [{ path: "/", headers: { Host: "elsewhere" } }, "host is set by the stream client"],
    [{ path: "/", headers: { "Content-Length": "5" } }, "content-length is set by the stream client"],
    [{ path: "/a b" }, "origin-form"],
    [{ path: "http://x/" }, "origin-form"],
    [{ path: "/a#b" }, "origin-form"],
    [{ method: "GE T", path: "/" }, "bad method"],
  ])("refuses a request that could split or reframe, before opening a stream (%#)", async (request, message) => {
    let opened = false;
    await expect(streamFetch(() => ((opened = true), fakeStream([]).open()), request)).rejects.toThrow(message);
    expect(opened).toBe(false);
  });

  it("keeps %23 and the query in the path", async () => {
    const fake = fakeStream(["HTTP/1.1 204 No Content\r\n\r\n"]);
    await streamFetch(fake.open, { path: "/a%23b?q=%23&r=1" });
    expect(fake.sent().startsWith("GET /a%23b?q=%23&r=1 HTTP/1.1\r\n")).toBe(true);
  });

  it("writes header values as their bytes and percent-encodes a path's non-ASCII as UTF-8, as fetch does", async () => {
    const fake = fakeStream(["HTTP/1.1 204 No Content\r\n\r\n"]);
    await streamFetch(fake.open, { path: "/\u00e9?q=\u65e5", headers: { "X-Label": "\u00e9" } });
    const head = Uint8Array.from(fake.state.written.flatMap((part) => [...part]));
    expect(String.fromCharCode(...head)).toBe("GET /%C3%A9?q=%E6%97%A5 HTTP/1.1\r\nHost: companion\r\nx-label: \u00e9\r\nConnection: close\r\n\r\n");
  });

  it("strips only spaces and tabs around a reply header value, keeping its 0xA0 bytes", async () => {
    const wire = "HTTP/1.1 204 No Content\r\nX-Label: \t\u00a0v\u00a0 \t\r\n\r\n";
    const res = await streamFetch(fakeStream([Uint8Array.from(wire, (char) => char.charCodeAt(0))]).open, { path: "/" });
    expect(res.headers.get("x-label")).toBe("\u00a0v\u00a0");
  });

  it("refuses a head the moment no ending can still fit, without waiting for more bytes", async () => {
    const line = "HTTP/1.1 200 OK\r\nX-Big: ";
    const fake = fakeStream([line + "a".repeat(MAX_HEAD + 4 - line.length)], { endAfter: false });
    const tooLate = new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 500));
    expect(await Promise.race([streamFetch(fake.open, { path: "/" }).catch((error: Error) => error.message), tooLate])).toContain("reply head is over");
    expect(fake.state.reset).toBe(true);
  });

  it.each([
    ["a trailer with no colon", "0\r\nno colon\r\n\r\n"],
    ["a trailer with a NUL", "0\r\nX-T: a\0b\r\n\r\n"],
  ])("errors the body on %s, and resets the stream", async (_what, end) => {
    const fake = fakeStream([`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n${end}`]);
    const res = await streamFetch(fake.open, { path: "/" });
    await expect(res.text()).rejects.toThrow(HttpError);
    expect(fake.state.reset).toBe(true);
  });

  it("errors the body when its trailers together pass MAX_HEAD, though each one is small", async () => {
    const trailers = Array.from({ length: 200 }, (_, i) => `X-T${i}: ${"t".repeat(90)}\r\n`).join("");
    const fake = fakeStream([`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n0\r\n${trailers}\r\n`]);
    const res = await streamFetch(fake.open, { path: "/" });
    await expect(res.text()).rejects.toThrow("trailer section is over");
    expect(fake.state.reset).toBe(true);
  });

  it("still reads a few small trailers and ends the stream", async () => {
    const fake = fakeStream(["HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n0\r\nX-A: 1\r\nX-B: 2\r\n\r\n"]);
    expect(await (await streamFetch(fake.open, { path: "/" })).text()).toBe("hi");
    expect(fake.state).toMatchObject({ ended: true, reset: false });
  });

  it("resets, not ends, the stream when the reply is done before the upload is (the computer stopped reading)", async () => {
    const fake = fakeStream(["HTTP/1.1 413 Payload Too Large\r\nContent-Length: 3\r\n\r\nbig"]);
    const open = () => ({ ...fake.open(), write: (bytes: Uint8Array) => (bytes.length === 5 ? new Promise<void>(() => {}) : Promise.resolve()) });
    const res = await streamFetch(open, { method: "POST", path: "/", body: "abcde" });
    expect(await res.text()).toBe("big");
    expect(fake.state).toMatchObject({ ended: false, reset: true });
  });

  it("errors the body with the abort reason, even for bytes already read past the head", async () => {
    const fake = fakeStream(["HTTP/1.1 200 OK\r\n\r\nabc"], { endAfter: false });
    const abort = new AbortController();
    const res = await streamFetch(fake.open, { path: "/", signal: abort.signal });
    abort.abort(new Error("gone"));
    await expect(res.body!.getReader().read()).rejects.toThrow("gone");
    expect(fake.state.reset).toBe(true);
  });

  it("gives the reply once its head is in, while the upload waits for the reply to be read (an echo past both windows)", async () => {
    // The computer takes no more upload until this side reads what it echoed: waiting for the upload first never ends.
    const fake = fakeStream(["HTTP/1.1 200 OK\r\n\r\n", "echo"], { endAfter: false });
    let taken!: () => void;
    const upload = new Promise<void>((resolve) => (taken = resolve));
    const open = () => ({ ...fake.open(), write: (bytes: Uint8Array) => (bytes.length === 4 ? upload : Promise.resolve()) });
    const tooLate = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000));
    const res = await Promise.race([streamFetch(open, { method: "POST", path: "/echo", body: "abcd" }), tooLate]);
    expect(res).not.toBeNull();
    const reader = res!.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("echo");
    taken();
    await upload;
    fake.finish();
    expect((await reader.read()).done).toBe(true);
    expect(fake.state).toMatchObject({ ended: true, reset: false });
  });

  it("errors the body when the upload fails after the head is in", async () => {
    const fake = fakeStream(["HTTP/1.1 200 OK\r\n\r\n"], { endAfter: false });
    let failUpload!: (error: Error) => void;
    const open = () => ({ ...fake.open(), write: (bytes: Uint8Array) => (bytes.length === 3 ? new Promise<void>((_, reject) => (failUpload = reject)) : Promise.resolve()) });
    const res = await streamFetch(open, { method: "POST", path: "/", body: "abc" });
    expect(res.status).toBe(200);
    failUpload(new Error("stream reset"));
    await expect(res.text()).rejects.toThrow("stream reset");
    expect(fake.state.reset).toBe(true);
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
