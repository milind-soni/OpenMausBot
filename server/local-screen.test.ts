import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { captureLocalScreenFrame } from "./local-screen.ts";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = undefined;
});

describe("local screen capture bridge", () => {
  it("reads only the authenticated loopback image endpoint", async () => {
    const frame = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(700), Buffer.from([0xff, 0xd9])]);
    server = createServer((request, response) => {
      expect(request.headers.authorization).toBe("Bearer private-token");
      response.writeHead(200, { "content-type": "image/jpeg" });
      response.end(frame);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind");

    await expect(captureLocalScreenFrame({
      url: `http://127.0.0.1:${address.port}/frame`,
      token: "private-token",
    })).resolves.toEqual({ png: frame.toString("base64"), format: "jpeg" });
  });

  it("refuses non-loopback endpoints before making a request", async () => {
    const request = async () => { throw new Error("must not fetch"); };
    await expect(captureLocalScreenFrame({
      url: "https://example.com/frame",
      token: "private-token",
      request: request as typeof fetch,
    })).rejects.toThrow("unavailable");
  });
});
