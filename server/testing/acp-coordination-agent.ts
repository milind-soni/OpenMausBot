// Adapt the real ACP-injected MCP entry to the shared coordination fixture.
// Files stay beside the disposable plan; no provider/user configuration is used.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { runRoomHandoffAgent } from "./room-handoff-agent.ts";

export async function runAcpCoordinationAgent(
  entry: { command: string; args?: string[]; env?: Array<{ name: string; value: string }> },
  system: string,
  planPath: string,
): Promise<string> {
  const scratch = mkdtempSync(join(dirname(planPath), "acp-coordination-"));
  try {
    const config = join(scratch, "mcp.json");
    const prompt = join(scratch, "system.txt");
    writeFileSync(config, JSON.stringify({ mcpServers: { agents: {
      command: entry.command, args: entry.args ?? [], env: Object.fromEntries((entry.env ?? []).map(item => [item.name, item.value])),
    } } }));
    writeFileSync(prompt, system);
    return await runRoomHandoffAgent(["--mcp-config", config, "--append-system-prompt-file", prompt], planPath, system);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
