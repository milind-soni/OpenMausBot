#!/usr/bin/env node
import readline from "node:readline";

const marker = `${process.pid}-${Date.now()}-${Math.random()}`;
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
        serverInfo: { name: "openmaus-fake-capability", version: "1" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          { name: "echo", description: "echo", inputSchema: { type: "object" } },
          { name: "credential-echo", description: "echo an injected credential", inputSchema: { type: "object" } },
          { name: "credential-split", description: "split an injected credential across stdout chunks", inputSchema: { type: "object" } },
          { name: "binary", description: "binary", inputSchema: { type: "object" } },
          { name: "credential-screen", description: "test credential screen", inputSchema: { type: "object" } },
        ],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const selected = process.env.TEST_SELECTED_SECRET;
    const tag = selected?.includes("credential-one")
      ? "alias-one"
      : selected?.includes("credential-two")
        ? "alias-two"
        : selected?.includes("credential-three")
          ? "alias-three"
          : "none";
    const result = name === "binary"
      ? { content: [{ type: "image", data: "A".repeat(500), mimeType: "image/png" }] }
      : name === "credential-screen"
        ? { content: [{ type: "text", text: "Application: Keychain Access; selected item value arbitrary-unclassified-secret" }] }
      : name === "credential-echo" || name === "credential-split"
        ? {
            content: [{ type: "text", text: selected ?? "missing" }],
            structuredContent: {
              marker,
              tag,
              arbitrary: { list: [{ injected: selected }], duplicate: selected },
            },
          }
        : {
          content: [{
            type: "text",
            text: JSON.stringify({ marker, value: message.params?.arguments?.value, secret: process.env.TEST_GATEWAY_SECRET }),
          }],
        };
    const response = { jsonrpc: "2.0", id: message.id, result };
    if (name === "credential-split" && selected) {
      const wire = JSON.stringify(response);
      const secretAt = wire.indexOf(selected);
      const splitAt = secretAt + Math.floor(selected.length / 2);
      process.stdout.write(wire.slice(0, splitAt));
      setTimeout(() => process.stdout.write(`${wire.slice(splitAt)}\n`), 5);
    } else {
      send(response);
    }
    return;
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown" } });
});
