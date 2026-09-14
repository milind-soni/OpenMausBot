// A minimal fake MCP stdio server for tests — newline-delimited JSON-RPC,
// speaking just enough of the protocol for server/mcp-stdio-client.ts:
// initialize, tools/list, tools/call. Behavior is env/scripted so tests can
// exercise success, errors, images, and slow replies without a network.
import { createInterface } from "node:readline";

const mode = process.env.FAKE_MCP_MODE ?? "ok";
if (mode === "exit-immediately") {
  // The spawn-failure path: the server dies before any handshake.
  process.exit(1);
}

const tools = JSON.parse(process.env.FAKE_MCP_TOOLS ?? "[]");
const rl = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined || message.id === null) return; // notification — nothing to answer
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "0.0.1" } },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: mode === "no-tools" ? [] : tools } });
    return;
  }
  if (message.method === "tools/call") {
    if (mode === "silent") return; // never answers — exercises the call timeout
    const args = message.params?.arguments ?? {};
    const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
    if (args.mode === "error") return reply({ isError: true, content: [{ type: "text", text: String(args.text ?? "boom") }] });
    if (args.mode === "slow") return setTimeout(() => reply({ content: [{ type: "text", text: "slow-done" }] }), 200);
    if (args.mode === "image") {
      return reply({
        content: [
          { type: "text", text: "screenshot taken" },
          { type: "image", data: "aWNvbg==", mimeType: "image/png" },
        ],
      });
    }
    return reply({ content: [{ type: "text", text: String(args.echo ?? "ok") }] });
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method ${String(message.method)}` } });
});
