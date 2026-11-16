#!/usr/bin/env node
// Offline stand-in for an ACP engine during its own browser sign-in: on `authenticate` it holds the request open
// the way Mistral Vibe does, until the FAKE_VIBE_READY file appears (the person finished in their browser) or the
// process is killed. Modes: ok (answers authenticate once the ready file appears) | never (never answers) |
// exit-after-init (closes before answering) | no-methods (initialize offers none) | refused (answers authenticate
// with an error carrying a token, which must never reach the person). No network, no real credential.
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_VIBE_MODE || "ok";
const ready = () => process.env.FAKE_VIBE_READY;
const replyOk = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    const methods = mode === "no-methods" ? [] : [{ id: "browser-auth", name: "Sign in" }];
    replyOk(message.id, { protocolVersion: 1, authMethods: methods });
    if (mode === "exit-after-init") setImmediate(() => process.exit(3));
    return;
  }
  if (message.method !== "authenticate") return;
  if (mode === "refused") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -1, message: "sign-in failed: secret-token-do-not-leak" } })}\n`);
    return;
  }
  const hold = setInterval(() => {
    if (mode === "ok" && existsSync(ready())) {
      clearInterval(hold);
      replyOk(message.id, {});
    }
  }, 50);
});
