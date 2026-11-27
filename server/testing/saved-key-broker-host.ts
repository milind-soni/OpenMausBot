// A stand-in for a Cloud home's start, run as its own process by broker-headers.test.ts: the credential broker opens, a
// health route answers, and every enabled URL MCP server in config.json, read as it is saved on disk, is checked through
// the broker the way mcp-servers-host.ts checks them at boot (the request a bad saved key crashed the home with). It
// prints its addresses as one JSON line, then serves until killed: POST /check runs the start check again.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { openCredentialBroker } from "../bot-box/broker.ts";
import { brokeredServer } from "../bot-box/broker-probe.ts";
import type { AppConfig } from "../config.ts";
import { enabledUrlServers } from "../host/mcp-servers-host.ts";
import { initializeAnswer } from "../host/mcp-url-checks.ts";

const dataDir = process.argv[2]!;
const cfg = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as AppConfig;
const credentials = await openCredentialBroker({ socketPath: join(dataDir, "broker.sock") });
const path = { broker: { port: 18080, mintForThread: credentials.mintForThread, revokeThread: credentials.revokeThread }, socketPath: credentials.socketPath };

async function startCheck(): Promise<Record<string, boolean>> {
  const answers: Record<string, boolean> = {};
  for (const [name, server] of Object.entries(enabledUrlServers(cfg))) {
    const brokered = brokeredServer(path, name, server);
    try {
      answers[name] = (await initializeAnswer({ ...server, url: brokered.url, headers: {} }, { fetch: brokered.fetch, timeoutMs: 10_000 })).ok;
    } finally {
      await brokered.done();
    }
  }
  return answers;
}

const first = startCheck();
const health = createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200, { "content-type": "text/plain" }).end("ok"); return; }
  if (req.url === "/check" && req.method === "POST") {
    void startCheck().then((answers) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answers)));
    return;
  }
  res.writeHead(404).end();
});
health.listen(0, "127.0.0.1", () => {
  void first.then((answers) => console.log(JSON.stringify({ port: (health.address() as { port: number }).port, answers })));
});
