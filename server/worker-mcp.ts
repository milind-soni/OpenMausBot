// Stable worker-only MCP server. It talks solely to OpenMausBot's per-turn
// loopback endpoints; those own SSH, approval state, leases, and the native
// CUA capability. Other IDE/CLI MCP bridges never enter this path.
import { createInterface } from "node:readline";

import { createControlClient } from "./control-client.ts";
import { createWorkerTaskClient } from "./worker-task-client.ts";
import { handleWorkerMcpFrame } from "./worker-mcp-protocol.ts";

const task = createWorkerTaskClient();
const control = createControlClient();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

void (async () => {
  for await (const line of lines) {
    if (!line.trim()) continue;
    let frame: Record<string, any>;
    try {
      frame = JSON.parse(line) as Record<string, any>;
    } catch {
      // Malformed stdio is not a request with a trustworthy id. Ignore it and
      // keep the session available for the next complete JSON-RPC frame.
      continue;
    }
    try {
      const reply = await handleWorkerMcpFrame(frame, task, control);
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
    } catch (error) {
      // This process stays alive after a bad frame, so leave an operator-safe
      // breadcrumb now. Only the error class is included: messages may contain
      // task text, paths, or driver output and must not cross this boundary.
      const rawKind = error instanceof Error ? error.name : "UnknownError";
      const kind = rawKind.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || "Error";
      process.stderr.write(`[worker-mcp] request handler failed (${kind})\n`);
      if (frame.id !== undefined && frame.id !== null) {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            content: [{ type: "text", text: "The worker request failed safely and was not performed." }],
            isError: true,
          },
        })}\n`);
      }
    }
  }
})().catch(() => {
  process.exitCode = 1;
});
