import { existsSync, mkdtempSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

import { ClaudeDriver } from "./drivers/claude.ts";
import { createMemoryUpkeep } from "./memory-upkeep.ts";
import { workspaceDir } from "./workspace.ts";

it("lets a Claude dream outlive the helper's default minute, but still stops it at three minutes", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-dream-timeout-"));
  const dump = join(scratch, "helper.json");
  const bot = { id: "dream-timeout-test", name: "Scout", memoryUpkeep: true };
  const engine = await ClaudeDriver.create({
    instanceId: "dream-timeout", displayName: "Claude", enabled: true,
    config: {
      cli: join(dirname(fileURLToPath(import.meta.url)), "testing/fake-claude-cli.ts"),
      permissionMode: "acceptEdits", requireApiKey: true,
    },
    environment: {
      HOME: scratch, USERPROFILE: scratch, ANTHROPIC_API_KEY: "fixture-key",
      FAKE_CLAUDE_TEXT_HANG: "1", FAKE_CLAUDE_TEXT_DUMP: dump,
    },
  });
  const loop = createMemoryUpkeep({
    bots: () => [bot], bot: () => bot, engine: () => engine, busy: () => false,
    addToAboutMe: () => 0, sourceLabel: () => "fixture", quietMs: () => 60_000, tidyHour: () => 3,
    conversations: () => [
      { threadId: "a", lines: [{ by: "person", text: "Keep drafts short." }] },
      { threadId: "b", lines: [{ by: "person", text: "Shorter again, please." }] },
    ],
  });
  const realTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let ready!: () => void;
  const launched = new Promise<void>((resolve, reject) => {
    const timer = realTimeout(() => reject(new Error("Claude background CLI never started")), 10_000);
    ready = () => { realClearTimeout(timer); resolve(); };
  });
  const watcher = watch(scratch, () => { if (existsSync(dump)) ready(); });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let settled = false;
  const dream = loop.dream(bot.id).then((report) => { settled = true; return report; });
  try {
    await launched;
    expect(existsSync(dump), "the real Claude driver launched its background CLI").toBe(true);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(settled, "a dream still has budget after the helper's default minute").toBe(false);
    await vi.advanceTimersByTimeAsync(118_000);
    expect(settled, "a dream retains its budget until three minutes").toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await dream).toMatchObject({ conversations: 2, note: "The dream did not answer in time." });
  } finally {
    watcher.close();
    await vi.advanceTimersByTimeAsync(180_000);
    await dream;
    vi.useRealTimers();
    loop.stop();
    await engine.dispose();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(workspaceDir(bot.id), { recursive: true, force: true });
  }
});
