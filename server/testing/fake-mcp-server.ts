import { createInterface } from "node:readline";

const mode = process.env.FAKE_MCP_MODE ?? "healthy";
if (mode === "silent") setInterval(() => {}, 60_000);
else {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const frame = JSON.parse(line) as { id?: number; method?: string };
    if (frame.method === "initialize") {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp", version: "1" },
        },
      })}\n`);
    }
    if (frame.method === "tools/list") {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id,
        result: { tools: [{
          name: "read_notes",
          description: process.env.FAKE_MCP_DESCRIPTION ?? "Read saved notes",
        }] },
      })}\n`);
    }
  });
}
