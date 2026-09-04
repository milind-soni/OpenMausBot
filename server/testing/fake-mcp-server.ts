// A stdio MCP server for tests. Speaks just enough of the protocol to be
// mounted: initialize, tools/list, tools/call. Modes, via env:
//   FAKE_MCP_MODE      healthy (default) | silent | malformed | slow |
//                      exit-after-init | error
//   FAKE_MCP_TOOL_NAME the one tool it exposes (default read_notes) — set the
//                      same name on two servers to test collisions
//   FAKE_MCP_DELAY_MS  how long `slow` holds a tools/call (default 2000)
//   FAKE_MCP_DESCRIPTION  the tool's description
import { createInterface } from "node:readline";

const mode = process.env.FAKE_MCP_MODE ?? "healthy";
const toolName = process.env.FAKE_MCP_TOOL_NAME ?? "read_notes";
const delayMs = Number(process.env.FAKE_MCP_DELAY_MS ?? "2000");

const reply = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);

if (mode === "silent") setInterval(() => {}, 60_000);
else {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const frame = JSON.parse(line) as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (frame.method === "initialize") {
      reply({
        jsonrpc: "2.0",
        id: frame.id,
        result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "1" } },
      });
      // a server that dies right after the handshake: the mount must record
      // the failure, not hang the turn
      if (mode === "exit-after-init") setTimeout(() => process.exit(0), 20);
      return;
    }
    if (frame.method === "tools/list") {
      // a frame the client cannot parse; the SDK must surface an error
      // rather than wedge on it
      if (mode === "malformed") {
        process.stdout.write("this is not json\n");
        return;
      }
      reply({
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          tools: [{
            name: toolName,
            description: process.env.FAKE_MCP_DESCRIPTION ?? "Read saved notes",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
          }],
        },
      });
      return;
    }
    if (frame.method === "tools/call") {
      const text = String(frame.params?.arguments?.text ?? "");
      const send = () =>
        reply(
          mode === "error"
            ? { jsonrpc: "2.0", id: frame.id, result: { content: [{ type: "text", text: "simulated tool failure" }], isError: true } }
            : { jsonrpc: "2.0", id: frame.id, result: { content: [{ type: "text", text: `echoed: ${text}` }] } },
        );
      if (mode === "slow") setTimeout(send, delayMs);
      else send();
    }
  });
}
