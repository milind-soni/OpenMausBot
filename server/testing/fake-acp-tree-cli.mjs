import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const root = process.env.FAKE_ACP_TREE;
const helper = spawn(process.execPath, ["-e", `
  const fs = require('node:fs');
  process.on('SIGTERM', () => {});
  const root = ${JSON.stringify(root)};
  const timer = setInterval(() => {
    if (!fs.existsSync(root + '/release')) return;
    fs.writeFileSync(root + '/effect', 'effect');
    clearInterval(timer);
  }, 10);
  fs.writeFileSync(root + '/descendant', String(process.pid));
`], { detached: process.env.FAKE_ACP_TREE_DETACHED === "1", stdio: ["ignore", process.env.FAKE_ACP_TREE_EXIT_PROMPT === "1" ? "inherit" : "ignore", "ignore"] });
helper.unref();
let next = 0;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const result = (value) => send({ id: message.id, result: value });
  if (message.method === "initialize") {
    const timer = setInterval(() => {
      if (!existsSync(root + "/descendant")) return;
      clearInterval(timer);
      result({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: true } }, authMethods: [] });
    }, 10);
  } else if (message.method === "session/new") result({ sessionId: `s${++next}` });
  else if (message.method === "session/prompt") {
    if (message.params.sessionId === "s1") send({ method: "session/update", params: {
      sessionId: "s1", update: { sessionUpdate: "tool_call", toolCallId: "gated-tool", status: "in_progress", title: "fixture" },
    } });
    writeFileSync(root + `/prompt-${message.params.sessionId}`, "1");
    if (message.params.sessionId === "s2" && process.env.FAKE_ACP_TREE_EXIT_PROMPT === "1") process.exit(0);
  }
  else if (message.method === "session/close") process.exit(0);
  else if (message.id !== undefined) result({});
});
