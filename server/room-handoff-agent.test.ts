import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { removeTempDir } from "./testing/cleanup.ts";
import { runRoomHandoffAgent } from "./testing/room-handoff-agent.ts";

it.each(["code", "signal"])("rejects pending MCP requests promptly after a child exits by %s", async mode => {
  const dir = mkdtempSync(join(tmpdir(), "room-mcp-exit-"));
  try {
    const config = join(dir, "mcp.json");
    const system = join(dir, "system.txt");
    const plan = join(dir, "plan.json");
    const script = `process.stdin.once('data', () => {
      ${mode === "code" ? "process.exit(7)" : "process.kill(process.pid, 'SIGTERM')"};
    });`;
    writeFileSync(config, JSON.stringify({ mcpServers: { agents: {
      command: process.execPath, args: ["-e", script], env: { OMB_BOT_ID: "fixture-bot", OMB_THREAD_ID: "fixture-thread" },
    } } }));
    writeFileSync(system, "Fixture system instructions");
    writeFileSync(plan, JSON.stringify({ "fixture-bot": {} }));
    await expect(runRoomHandoffAgent(["--mcp-config", config, "--append-system-prompt-file", system], plan))
      .rejects.toThrow("Fixture MCP exited unexpectedly");
    const evidence = JSON.parse(readFileSync(`${plan}.evidence.jsonl`, "utf8"));
    expect(evidence).toMatchObject({ botId: "fixture-bot", threadId: "fixture-thread", evidence: [] });
  } finally { await removeTempDir(dir); }
// This deadline is well below the 20-second MCP fallback, and includes cleanup.
}, 8_000);
