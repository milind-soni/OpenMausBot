import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { holdBodyDeadline } from "./body-deadline.ts";

let server: Server | null = null;

afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function listen(baseMs: number): Promise<number> {
  server = createServer((req, res) => {
    holdBodyDeadline(req, res, baseMs);
    let bytes = 0;
    req.on("data", (chunk: Buffer) => { bytes += chunk.length; });
    req.on("end", () => res.end(String(bytes)));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function send(port: number, head: string, chunks: Array<{ after: number; data: string }>): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(head);
      for (const { after, data } of chunks) setTimeout(() => socket.writable && socket.write(data), after);
    });
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8");
      if (/\r\n\r\n\d+$/.test(text)) socket.end();
    });
    socket.on("close", () => resolve(text));
    socket.on("error", reject);
  });
}

describe("holdBodyDeadline", () => {
  it("answers 408 and closes a request whose body stops arriving", async () => {
    const port = await listen(200);
    const answer = await send(port, "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\nab", []);
    expect(answer).toMatch(/^HTTP\/1\.1 408 Request Timeout/);
    expect(answer).toContain("The request took too long.");
  });

  it("gives a large upload time in proportion to its size", async () => {
    const port = await listen(200);
    const piece = "x".repeat(64 * 1024);
    const answer = await send(port, `POST / HTTP/1.1\r\nHost: x\r\nContent-Length: ${piece.length * 4}\r\n\r\n`,
      [0, 300, 600, 900].map((after) => ({ after, data: piece })));
    expect(answer).toMatch(/^HTTP\/1\.1 200/);
    expect(answer).toMatch(/262144$/);
  });

  it("never times a request without a body", async () => {
    const port = await listen(50);
    server!.removeAllListeners("request");
    server!.on("request", (req, res) => {
      holdBodyDeadline(req, res, 50);
      setTimeout(() => res.end("late"), 300);
    });
    const answer = await send(port, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", []);
    expect(answer).toMatch(/^HTTP\/1\.1 200/);
  });
});
