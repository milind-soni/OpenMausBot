#!/usr/bin/env node
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export interface FakeImageApi {
  url: string;
  requests: Array<Record<string, unknown>>;
  stop(): Promise<void>;
}

export async function startFakeImageApi(options: { port?: number } = {}): Promise<FakeImageApi> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/images/generations")) {
        res.writeHead(404).end();
        return;
      }
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(body) as Record<string, unknown>; } catch {}
      requests.push(parsed);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ b64_json: PNG_1X1 }] }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fake = await startFakeImageApi({ port: Number(process.argv[2]) || 0 });
  process.stdout.write(`${fake.url}\n`);
}
