import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("keeps independent fixture chats and health requests usable during queued history scans", async () => {
  const fixture = await launchVerificationServer();
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]);
    evidence.push({ command: args, result });
    return result;
  };
  try {
    const bots = [];
    for (const name of ["Search probe A", "Search probe B"]) {
      const result = await control(["new-bot", "--name", name]) as { bot: { id: string; activeTaskId: string } };
      bots.push({ id: result.bot.id, threadId: result.bot.activeTaskId });
    }
    // Only the new fixture's database. Seed an unowned historical thread:
    // searched by SQL, never returned to a viewer or used as a provider prompt.
    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    try {
      const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('synthetic-history',?,1,'user','text',?,?)");
      const text = "synthetic archive ".repeat(60);
      db.exec("BEGIN");
      for (let i = 0; i < 50_000; i++) {
        insert.run(`m-${i}`, text, JSON.stringify({ id: `m-${i}`, at: 1, role: "user", kind: "text", text }));
        // Slow CI disks can outlast HTTP keep-alive during fixture setup.
        // Let the client process closed sockets before it sends chat requests.
        if (i % 1000 === 999) await setImmediate();
      }
      db.exec("COMMIT");
    } finally { db.close(); }
    await Promise.all(bots.map((bot, i) => control(["send", "--bot", bot.id, "--text", `concurrent-search-probe-${i}`])));
    let completed = 0;
    const scans = Array.from({ length: 8 }, async () => {
      const response = await fetch(`${fixture.info.url}/api/search?q=absent-benchmark-query`);
      const body = await response.json();
      completed++;
      expect(response.status).toBe(200);
      expect(body).toEqual({ hits: [] });
    });
    const at = performance.now();
    const health = await fetch(`${fixture.info.url}/api/health`);
    const healthMs = performance.now() - at;
    expect(health.status).toBe(200);
    evidence.push({ healthMs, completedScansAtHealth: completed });
    expect(completed).toBeLessThan(scans.length);
    await Promise.all(scans);
    for (const bot of bots) {
      const wait = await control(["wait", "--bot", bot.id, "--timeout", "30"]);
      expect(wait).toMatchObject({ status: "settled", messages: expect.arrayContaining([
        expect.objectContaining({ role: "bot", text: "hello from fake claude" }),
      ]) });
      await control(["messages", "--bot", bot.id, "--limit", "10"]);
      const response = await fetch(`${fixture.info.url}/api/search?q=concurrent-search-probe&threadId=${bot.threadId}`);
      expect(response.status).toBe(200);
      const body = await response.json() as { hits: { threadId: string; onActivePath: boolean }[] };
      expect(body.hits.length).toBeGreaterThan(0);
      expect(body.hits.every(hit => hit.threadId === bot.threadId && hit.onActivePath)).toBe(true);
      evidence.push({ search: body });
    }
  } finally {
    const evidencePath = `${fixture.info.logPath}.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ evidencePath }));
    await fixture.close();
  }
}, 60_000);
