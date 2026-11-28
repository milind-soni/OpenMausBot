import { mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("names a real fixture conversation from both its request and reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-title-e2e-"));
  const title = join(dir, "title.txt"), dump = join(dir, "title-dump.json");
  writeFileSync(title, "Payroll | export fix");
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TEXT_FILE: title, FAKE_CLAUDE_TEXT_DUMP: dump });
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    const { bot } = await control("new-bot", "--name", "Title fixture");
    await control("send", "--bot", bot.id, "--text", "Fix payroll export");
    expect((await control("wait", "--bot", bot.id, "--timeout", "30")).status).toBe("settled");
    await expect.poll(async () => {
      const result = await control("bots");
      return result.bots.find((candidate: any) => candidate.id === bot.id)?.tasks.find((task: any) => task.taskId === bot.activeTaskId)?.title;
    }, { timeout: 15_000 }).toBe("Payroll | export fix");
    const { prompt } = JSON.parse(readFileSync(dump, "utf8"));
    expect(prompt).toContain("User: Fix payroll export");
    expect(prompt).toContain("Bot:");
  } finally {
    await fixture.close();
    rmSync(title, { force: true });
    rmSync(dump, { force: true });
    rmdirSync(dir);
  }
}, 120_000);
