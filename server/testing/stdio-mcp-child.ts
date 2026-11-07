// The computer's side of a command server's link stream: answers lines as a stdio MCP server does.
import type { LinkStream } from "../../electron/device-link-protocol.mjs";
import { createLineSplitter } from "../mcp-bridge.ts";

export interface StdioChild { lines: string[]; closed: boolean; end(): void }

/** `initialize` and `tools/list` are answered; `tools/call` first sends a `notifications/message` and a `roots/list`
 * request under the call's own id, then its result; any other request is never answered. */
export function stdioChild(): { child: StdioChild; link: LinkStream } {
  let ending = () => {};
  const child: StdioChild = { lines: [], closed: false, end: () => ending() };
  const link: LinkStream = {
    join(socket) {
      ending = () => socket.end();
      const reply = (message: object) => socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      const lines = createLineSplitter((line) => {
        child.lines.push(line);
        const { id, method } = JSON.parse(line) as { id?: unknown; method?: string };
        if (method === "initialize") reply({ id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
        if (method === "tools/list") reply({ id, result: { tools: [{ name: "charge", inputSchema: { type: "object" } }, { name: "refund", inputSchema: { type: "object" } }] } });
        if (method === "tools/call") {
          reply({ method: "notifications/message", params: { level: "info", data: "charging" } });
          reply({ id, method: "roots/list" });
          reply({ id, result: { content: [{ type: "text", text: "charged" }] } });
        }
      });
      socket.on("data", (chunk: Buffer) => lines.push(chunk));
      socket.on("close", () => { child.closed = true; });
    },
    cancel() {},
  };
  return { child, link };
}
