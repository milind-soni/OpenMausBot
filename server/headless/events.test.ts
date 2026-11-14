import "../testing/scrub-ambient-omb-env.ts";

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_EVENT_KINDS, frameThreads, sseFrames, wantFrame } from "./events.ts";
import { runHeadless } from "./main.ts";
import type { HeadlessIo } from "./output.ts";

const kinds = new Set(DEFAULT_EVENT_KINDS);

describe("which frames are printed", () => {
  it("knows the conversations a frame is about", () => {
    expect(frameThreads({ kind: "message", threadId: "t1" })).toEqual(["t1"]);
    expect(frameThreads({ kind: "runtime", event: { threadId: "t2" } })).toEqual(["t2"]);
    expect(frameThreads({ kind: "bot", bot: { threadId: "t3", tasks: [{ threadId: "t4" }] } })).toEqual(["t3", "t4"]);
    expect(frameThreads({ kind: "group", group: { threadId: "r1", tasks: [{ threadId: "r2" }] } })).toEqual(["r1", "r2"]);
    expect(frameThreads({ kind: "config" })).toEqual([]);
  });

  it("prints hello always, never pings, and otherwise filters by kind and conversation", () => {
    const threads = new Set(["t1"]);
    expect(wantFrame({ kind: "hello", resumed: false }, kinds, threads)).toBe(true);
    expect(wantFrame({ kind: "ping" }, kinds, null)).toBe(false);
    expect(wantFrame({ kind: "message", threadId: "t1" }, kinds, threads)).toBe(true);
    expect(wantFrame({ kind: "message", threadId: "t9" }, kinds, threads)).toBe(false);
    expect(wantFrame({ kind: "message", threadId: "t9" }, kinds, null)).toBe(true);
    expect(wantFrame({ kind: "bot", bot: { threadId: "t0", tasks: [{ threadId: "t1" }] } }, kinds, threads)).toBe(true);
    expect(wantFrame({ kind: "runtime", event: { threadId: "t1" } }, kinds, threads)).toBe(false);
    expect(wantFrame({ kind: "runtime", event: { threadId: "t1" } }, new Set(["runtime"]), threads)).toBe(true);
  });
});

describe("sseFrames", () => {
  it("reads id and data across chunks, skipping comments and heartbeats without data", async () => {
    const text = ': keepalive\n\nid: s1:7\ndata: {"kind":"message","threadId":"t1"}\n\ndata: {"kind":"ping"}\n\nid: s1:8\r\ndata: {"kind":"thread",\r\ndata: "threadId":"t2"}\r\n\r\n';
    const bytes = new TextEncoder().encode(text);
    async function* chunks() { for (let i = 0; i < bytes.length; i += 5) yield bytes.slice(i, i + 5); }
    const frames = [];
    for await (const frame of sseFrames(chunks())) frames.push(frame);
    expect(frames).toEqual([
      { id: "s1:7", data: '{"kind":"message","threadId":"t1"}' },
      { data: '{"kind":"ping"}' },
      { id: "s1:8", data: '{"kind":"thread",\n"threadId":"t2"}' },
    ]);
  });
});

describe("events against a server", () => {
  let server: Server;
  let origin: string;
  let answer: (req: IncomingMessage, res: ServerResponse, n: number) => void = () => undefined;
  const asked: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => { asked.push(req.url ?? ""); answer(req, res, asked.length); });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: HeadlessIo = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: async () => "" };
    return { io, out, err };
  };
  const stream = (res: ServerResponse, frames: string[], end: boolean) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of frames) res.write(frame);
    if (end) res.end();
  };

  it("ends with the refusal when the stream is refused (an expired token), instead of asking again forever", async () => {
    asked.length = 0;
    answer = (_req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized: this session has expired or was revoked" })); };
    const { io, out } = capture();
    const code = await runHeadless(["events", "--json"], { io, env: { OPENMAUSBOT_URL: origin, OPENMAUSBOT_TOKEN: "omb_sess_expired" } });
    expect(code).toBe(5);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ ok: false, exitCode: 5, error: "this server needs a credential and did not accept the one given" });
    expect(asked).toHaveLength(1);
  });

  it("ends with the job when its last change brings no frame of its own: a heartbeat reads it again", async () => {
    asked.length = 0;
    let reads = 0;
    const timers: Array<ReturnType<typeof setInterval>> = [];
    answer = (req, res) => {
      if (req.url?.startsWith("/api/threads/t1/job")) {
        reads += 1;
        res.writeHead(200, { "content-type": "application/json" });
        // running for the first read and the one after the message frame; done after that
        return res.end(JSON.stringify({ threadId: "t1", since: 1_000, version: `v${reads}`, state: reads <= 2 ? "running" : "completed",
          reason: reads <= 2 ? "Room Lead is working" : "Room Lead finished", counts: {}, nodes: [] }));
      }
      stream(res, ['id: c1\ndata: {"kind":"hello","resumed":false}\n\n'], false);
      // then nothing but the server's heartbeat
      timers.push(setInterval(() => res.write('data: {"kind":"ping"}\n\n'), 100));
      res.on("close", () => timers.forEach(clearInterval));
    };
    const { io, out } = capture();
    try {
      const code = await runHeadless(["events", "--job", "t1", "--until-settled"], { io, env: { OPENMAUSBOT_URL: origin } });
      expect(code).toBe(0);
      expect(JSON.parse(out.at(-1)!)).toMatchObject({ kind: "job", threadId: "t1", state: "completed" });
      expect(reads).toBeGreaterThanOrEqual(3);
    } finally {
      timers.forEach(clearInterval);
    }
  }, 15_000);

  it("asks again after a dropped stream or a server error, from where it was, and keeps only the conversations named", async () => {
    asked.length = 0;
    answer = (_req, res, n) => {
      if (n === 1) return stream(res, ['id: c1\ndata: {"kind":"hello","resumed":false}\n\n', 'id: c2\ndata: {"kind":"message","threadId":"t1","n":1}\n\n'], true);
      if (n === 2) { res.writeHead(503); return res.end(); }
      stream(res, ['id: c3\ndata: {"kind":"hello","resumed":true}\n\n', 'id: c4\ndata: {"kind":"message","threadId":"t2"}\n\n',
        'id: c5\ndata: {"kind":"message","threadId":"t1","n":2}\n\n'], false);
    };
    const { io, out, err } = capture();
    const controller = new AbortController();
    const ran = runHeadless(["events", "--thread", "t1"], { io, env: { OPENMAUSBOT_URL: origin }, signal: controller.signal });
    await expect.poll(() => out.length, { timeout: 10_000 }).toBe(4);
    controller.abort();
    expect(await ran).toBe(130);
    expect(out.map((line) => JSON.parse(line))).toEqual([
      { kind: "hello", resumed: false }, { kind: "message", threadId: "t1", n: 1 }, { kind: "hello", resumed: true }, { kind: "message", threadId: "t1", n: 2 }]);
    expect(asked).toEqual(["/api/events?screens=off", "/api/events?screens=off&since=c2", "/api/events?screens=off&since=c2"]);
    expect(err.map((line) => JSON.parse(line).event)).toEqual(["reconnecting", "reconnecting"]);
  }, 15_000);
});
