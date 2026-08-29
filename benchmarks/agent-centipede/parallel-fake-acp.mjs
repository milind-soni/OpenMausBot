/* Local-only ACP provider for production-route benchmarks. It deliberately
 * returns no external data, writes only timing evidence, and never contacts
 * another agent or provider. */
import { appendFileSync } from "node:fs";

const dump = process.env.FAKE_ACP_EVENT_DUMP;
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const result = (id, value) => write({ jsonrpc: "2.0", id, result: value });
const record = (event) => { if (dump) appendFileSync(dump, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...event })}\n`); };
let buffer = "";

const args = process.argv.slice(2);
if (args[0] === "status" || args[0] === "whoami") {
  process.stdout.write('{"isAuthenticated":true}\n');
  process.exit(0);
}
if (args[0] === "models" || args.includes("--list-models")) {
  process.stdout.write("auto - Auto (local fixture)\n");
  process.exit(0);
}

async function handle(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.method !== "string") return;
  switch (message.method) {
    case "initialize":
      result(message.id, { protocolVersion: 1, authMethods: [] });
      return;
    case "authenticate":
    case "session/set_model":
    case "session/set_mode":
    case "session/set_config_option":
      result(message.id, {});
      return;
    case "session/new":
    case "session/load":
      result(message.id, { sessionId: `parallel-fixture-${process.pid}`, models: { currentModelId: "auto", availableModels: [{ modelId: "auto", name: "Auto" }] } });
      return;
    case "session/prompt": {
      record({ event: "start" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      write({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "Synthetic production-route worker completed with local evidence." } } } });
      result(message.id, { stopReason: "end_turn", _meta: { inputTokens: 40, outputTokens: 12 } });
      record({ event: "end" });
      return;
    }
    case "session/cancel":
      return;
    default:
      if (message.id !== undefined) write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try { void handle(JSON.parse(line)); } catch { /* malformed protocol input is ignored */ }
    }
    newline = buffer.indexOf("\n");
  }
});
