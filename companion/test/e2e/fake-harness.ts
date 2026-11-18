// A harness for the sidecar to front in tests: health, an event stream with resume, uploads, a Range download and a
// long wait before headers.
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeHarness {
  port: number;
  /** Appends an event to the log; every open stream gets it. Returns its id. */
  emit(data: unknown): number;
  /** How long the secret-card `provide` route waits before answering. */
  provideWaitMs: number;
  keepaliveMs: number;
  close(): Promise<void>;
}

export const ATTACHMENT_BYTES = 1024 * 1024;
export const attachmentByte = (index: number) => (index * 7) % 256;

export async function startFakeHarness(): Promise<FakeHarness> {
  const log: Array<{ id: number; text: string }> = [];
  const streams = new Set<ServerResponse>();
  const state = { provideWaitMs: 0, keepaliveMs: 200 };
  const write = (res: ServerResponse, event: { id: number; text: string }) => res.write(`id: ${event.id}\ndata: ${event.text}\n\n`);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://harness");
    const path = url.pathname;
    if (path === "/api/health") return void res.writeHead(200, { "content-type": "application/json" }).end('{"app":"openmausbot"}');
    if (path === "/api/config") return void res.writeHead(200, { "content-type": "application/json" }).end('{"computerName":"Test Mac"}');
    if (path === "/api/events") {
      const since = Number(req.headers["last-event-id"] ?? url.searchParams.get("since") ?? 0) || 0;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const event of log) if (event.id > since) write(res, event);
      streams.add(res);
      const keepalive = setInterval(() => res.write(": keepalive\n\n"), state.keepaliveMs);
      res.on("close", () => {
        clearInterval(keepalive);
        streams.delete(res);
      });
      return;
    }
    if (req.method === "POST" && path === "/api/files") {
      const hash = createHash("sha256");
      let bytes = 0;
      req.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        hash.update(chunk);
      });
      req.on("end", () => res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ bytes, sha256: hash.digest("hex") })));
      return;
    }
    const soak = /^\/api\/attachments\/soak-(\d+)\.mp3$/.exec(path);
    if (soak) {
      // A long screen stream in small frames: `total` bytes in 12 KiB writes, byte i = i % 251.
      const total = Number(soak[1]);
      const frame = Buffer.from(Array.from({ length: 12 * 1024 * 251 }, (_, index) => index % 251));
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": total });
      let sent = 0;
      const pump = () => {
        while (sent < total) {
          const size = Math.min(12 * 1024, total - sent);
          const offset = sent % 251;
          const more = res.write(frame.subarray(offset, offset + size));
          sent += size;
          if (!more) return void res.once("drain", pump);
        }
        res.end();
      };
      return pump();
    }
    if (path.startsWith("/api/attachments/")) {
      const body = Buffer.from(Array.from({ length: ATTACHMENT_BYTES }, (_, index) => attachmentByte(index)));
      const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
      if (!range) return void res.writeHead(200, { "content-type": "audio/mpeg", "content-length": body.length }).end(body);
      const [start, end] = [Number(range[1]), Number(range[2])];
      return void res
        .writeHead(206, { "content-type": "audio/mpeg", "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": end - start + 1 })
        .end(body.subarray(start, end + 1));
    }
    if (req.method === "POST" && /\/secret-cards\/[\w-]+\/provide$/.test(path)) {
      req.resume();
      const timer = setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end('{"provided":true}'), state.provideWaitMs);
      return void res.on("close", () => clearTimeout(timer));
    }
    res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    emit(data) {
      const event = { id: log.length + 1, text: JSON.stringify(data) };
      log.push(event);
      for (const res of streams) write(res, event);
      return event.id;
    },
    get provideWaitMs() {
      return state.provideWaitMs;
    },
    set provideWaitMs(value: number) {
      state.provideWaitMs = value;
    },
    get keepaliveMs() {
      return state.keepaliveMs;
    },
    set keepaliveMs(value: number) {
      state.keepaliveMs = value;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
