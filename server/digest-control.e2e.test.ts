import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireMessage } from "../shared/wire.ts";

it("records independent turns and room speakers through the shared control fixture", async () => {
  const fixture = await launchVerificationServer({
    // The launcher keeps only OS launch variables and FAKE_CLAUDE_* knobs.
    // Windows shell hooks need COMSPEC/SYSTEMROOT; replacing the parent
    // environment with just fake knobs made every hook fall back to preview.
    ...process.env,
    FAKE_CLAUDE_HOOKS: "1",
    FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([{ name: "Bash", id: "reused-tool-id", input: { command: "echo receipt" }, output: "receipt", ok: true }]),
  });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]);
    evidence.push({ command: args, result });
    return result as any;
  };
  const messages = async (threadId: string) => {
    const response = await fetch(`${fixture.info.url}/api/threads/${threadId}/messages?limit=50`);
    expect(response.ok).toBe(true);
    return (await response.json() as { messages: WireMessage[] }).messages;
  };
  try {
    expect((await control(["doctor"])).ok).toBe(true);
    const first = (await control(["new-bot", "--name", "Digest one"])).bot;
    const second = (await control(["new-bot", "--name", "Digest two"])).bot;
    for (const text of ["First receipt", "Second receipt"]) {
      await control(["send", "--bot", first.id, "--text", text]);
      expect((await control(["wait", "--bot", first.id, "--timeout", "20"])).status).toBe("settled");
    }
    await control(["messages", "--bot", first.id, "--limit", "20"]);
    const provider = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    expect(JSON.stringify(provider.prompt)).not.toContain("Messages this conversation received");
    const direct = await messages(first.activeTaskId);
    const digests = direct.filter(row => row.kind === "digest");
    expect(digests).toHaveLength(2);
    expect(new Set(digests.map(row => row.turnId)).size).toBe(2);
    for (const row of digests) {
      expect(row.digest?.botId).toBe(first.id);
      expect(row.digest?.tools).toMatchObject([{ name: "Bash", count: 1, failed: 0 }]);
      expect(row.digest?.hookCoverage).toBe("full");
      const tool = direct.find(message => message.turnId === row.turnId && message.tool?.itemId);
      expect(tool?.tool?.fullResult).toBe(true);
      expect(tool?.tool).not.toHaveProperty("outputPath");
    }
    // The fake reuses tool ids across turns: each must have its own receipt
    // and spill file rather than inheriting evidence from its predecessor.
    expect(readdirSync(join(fixture.info.dataDir, "tool-results", first.activeTaskId))).toHaveLength(2);
    expect(JSON.stringify(direct)).not.toContain(fixture.info.dataDir);
    const channel = (await control(["new-channel", "--name", "Receipt room", "--members", `${first.id},${second.id}`])).channel;
    await control(["send-channel", "--channel", channel.id, "--text", "Each reply once"]);
    expect((await control(["wait", "--channel", channel.id, "--timeout", "30"])).status).toBe("settled");
    const transcript = await control(["messages", "--channel", channel.id, "--limit", "30"]);
    const roomDigests = transcript.messages.filter((row: WireMessage) => row.kind === "digest");
    expect(roomDigests.length).toBeGreaterThan(0);
    for (const row of roomDigests) expect([first.id, second.id]).toContain(row.from?.botId);
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE kind = 'digest.append' AND key LIKE ?").get(`${first.activeTaskId}:%`)?.count).toBe(2);
    } finally { db.close(); }
  } finally {
    try {
      const path = `${fixture.info.logPath}.digests.json`;
      writeFileSync(path, JSON.stringify(evidence, null, 2));
      console.log("Digest control evidence saved.");
    } finally { await fixture.close(); }
    expect(existsSync(fixture.info.dataDir)).toBe(false);
  }
}, 90_000);
