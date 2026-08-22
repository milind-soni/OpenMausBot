#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const input = readline.createInterface({ input: process.stdin, terminal: false });

input.on("line", (line) => {
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-aos-fleet-bridge", version: "1" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    // Deliberately advertises dangerous tools. The observer gateway must
    // never project this backend-owned catalog to Ada.
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          { name: "task_submit", inputSchema: { type: "object" } },
          { name: "task_result", inputSchema: { type: "object" } },
          { name: "task_cancel", inputSchema: { type: "object" } },
          { name: "wake", inputSchema: { type: "object" } },
          { name: "shell_execute", inputSchema: { type: "object" } },
        ],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    const record = {
      name: message.params?.name,
      arguments: message.params?.arguments,
    };
    if (process.env.OBSERVER_CALL_RECEIPT) {
      appendFileSync(process.env.OBSERVER_CALL_RECEIPT, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(record) }],
        structuredContent: record,
      },
    });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown" } });
  }
});
