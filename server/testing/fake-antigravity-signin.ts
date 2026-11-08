#!/usr/bin/env node
// Offline stand-in for Google's Antigravity ACP server during a Google sign-in: on `authenticate` it opens its OAuth
// callback listener on 127.0.0.1 (a free port, as the runtime does), announces the Google link on stderr the way the
// runtime does, and when the callback arrives with state `fixture` and a code it writes the profile's token file into
// GEMINI_HOME and answers `authenticate`. Every other request gets an empty result. No network, no real credential.
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";

const PREFIX = "Open the following link to authenticate the ACP server: ";
const reply = (id: unknown, result: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
let pending: unknown = null;

const callback = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.searchParams.get("state") !== "fixture" || !url.searchParams.get("code")) {
    res.writeHead(400);
    res.end();
    return;
  }
  const directory = join(process.env.GEMINI_HOME!, "antigravity-acp");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "acp_token.json"), `${JSON.stringify({ fixture: "offline, not a credential" })}\n`, { mode: 0o600 });
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Signed in");
  if (pending !== null) reply(pending, {});
});

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as { id?: unknown; method?: string };
  if (message.method !== "authenticate") return void reply(message.id, {});
  pending = message.id;
  callback.listen(0, "127.0.0.1", () => {
    const { port } = callback.address() as { port: number };
    const redirect = encodeURIComponent(`http://127.0.0.1:${port}/`);
    process.stderr.write(`${PREFIX}https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=fixture&redirect_uri=${redirect}\n`);
  });
});
