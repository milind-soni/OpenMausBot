import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

import { openSse } from "./sse.ts";

describe("SSE recorder", () => {
  it("rejects pending waits as soon as the remote stream ends", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      setTimeout(() => res.end(), 10);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");

    try {
      const recorder = await openSse(`http://127.0.0.1:${address.port}`);
      await expect(recorder.until(() => false, 5_000)).rejects.toThrow(/stream closed/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
