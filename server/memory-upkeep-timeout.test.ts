import { rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { createMemoryUpkeep, DREAM_TIMEOUT_MS, MODEL_TIMEOUT_MS } from "./memory-upkeep.ts";
import { ensureWorkspace, WORKSPACES_DIR } from "./workspace.ts";

const BOT = { id: "upkeep-timeout", name: "Scout", memoryUpkeep: true, memoryEnabled: true };

describe("model call budgets", () => {
  it("gives the dream its own budget instead of the driver's default", async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
    ensureWorkspace(BOT.id);
    const generateText = vi.fn(async (_prompt: string, _options?: { signal?: AbortSignal; timeoutMs?: number }) => "{}");
    const loop = createMemoryUpkeep({
      bots: () => [BOT],
      bot: () => BOT,
      engine: () => ({ generateText }),
      busy: () => false,
      addToAboutMe: () => 0,
      sourceLabel: () => "chat",
      quietMs: () => 60_000,
      tidyHour: () => 3,
      conversations: () => ["a", "b"].map((threadId) => ({ threadId, lines: [{ by: "person", text: "Keep project updates brief." }] })),
    });
    try {
      await loop.dream(BOT.id);
      expect(generateText).toHaveBeenCalledTimes(1);
      expect(generateText.mock.calls[0]![1]).toMatchObject({ timeoutMs: DREAM_TIMEOUT_MS });
      expect(DREAM_TIMEOUT_MS).toBeGreaterThan(MODEL_TIMEOUT_MS);
    } finally {
      loop.stop();
      await loop.idle();
    }
  });
});
