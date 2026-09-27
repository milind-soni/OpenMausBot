// Only a revocable turn capability crosses into the tool process. All provider
// credentials, machine ids and ownership resolution stay in the server.
import { createInterface } from "node:readline";

const harness = process.env.OMB_HARNESS_URL ?? "";
const token = process.env.NATION_COMPUTER_TOKEN ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(harness) || !token) throw new Error("Missing computer capability");
const tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  { name: "screenshot", description: "Inspect your assigned remote desktop. Observe before and after clicking or typing.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "execute", description: "Run a Linux shell command on your assigned persistent computer. Use for files, git, builds and tests, or xdotool for desktop input. The command times out after 60 seconds; run longer jobs in the background and inspect their logs.",
    inputSchema: { type: "object", properties: { command: { type: "string", minLength: 1, maxLength: 4000 } }, required: ["command"], additionalProperties: false } },
];
if (process.env.NATION_CODING_TOOLS === "1") tools.push(
  { name: "code_start", description: "Start a developer task on your assigned isolated computer. Edits and tests happen in a persistent named project. Give the full user request and relevant context. Then call code_status until completed, failed or cancelled; do not finish your chat turn while it is running. Never claim work succeeded without its result. Only request pushes or publishing when the user explicitly authorized them.",
    inputSchema: { type: "object", properties: { project: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$" }, prompt: { type: "string", minLength: 1, maxLength: 8000 } }, required: ["project", "prompt"], additionalProperties: false } },
  { name: "code_status", description: "Wait for your coding task's result (up to 60 seconds). Keep checking while running. Files persist on this computer; failed or cancelled work must be inspected before retrying. Stopping your chat turn revokes the coding task.",
    inputSchema: { type: "object", properties: { taskId: { type: "string", pattern: "^[a-f0-9]{32}$" } }, required: ["taskId"], additionalProperties: false } },
);
const reply = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
async function handle(line: string) {
  const frame = JSON.parse(line);
  if (frame.id === undefined) return;
  if (frame.method === "initialize") return reply(frame.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "nation-computer", version: "1" } });
  if (frame.method === "ping") return reply(frame.id, {});
  if (frame.method === "tools/list") return reply(frame.id, { tools });
  const name = frame.params?.name;
  if (frame.method !== "tools/call" || !tools.some(t => t.name === name)) return reply(frame.id, { isError: true, content: [{ type: "text", text: "Unknown computer operation" }] });
  try {
    const res = await fetch(`${harness}/api/internal/hosted-computer/${name}`, { method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(frame.params.arguments ?? {}), signal: AbortSignal.timeout(100_000) });
    const result = await res.json() as { error?: string; png?: string; format?: string; exitCode?: number; state?: string };
    if (!res.ok) return reply(frame.id, { isError: true, content: [{ type: "text", text: result.error ?? "Computer operation unavailable" }] });
    return reply(frame.id, name === "screenshot"
      ? { content: [{ type: "image", data: result.png, mimeType: result.format === "jpeg" ? "image/jpeg" : "image/png" }] }
      : { isError: name === "execute" ? result.exitCode !== 0 : result.state === "failed" || result.state === "cancelled", content: [{ type: "text", text: JSON.stringify(result) }] });
  } catch { reply(frame.id, { isError: true, content: [{ type: "text", text: "Computer operation could not be confirmed. Inspect its state before retrying." }] }); }
}
let pending = Promise.resolve<unknown>(undefined);
createInterface({ input: process.stdin }).on("line", line => {
  if (line.length > 64 * 1024) { process.exitCode = 1; process.stdin.destroy(); return; }
  pending = pending.then(() => handle(line)).catch(() => { process.exitCode = 1; process.stdin.destroy(); });
});
