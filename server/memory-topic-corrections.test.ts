import { rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import { createMemoryUpkeep } from "./memory-upkeep.ts";
import { writeMemoryTopic, readMemoryTopic, ensureWorkspace } from "./workspace.ts";
import { memoryPassages, selectMemoryPassages, type RecallPassage } from "./recall.ts";
import { TIDY_MARKER } from "./memory-tidy.ts";
beforeEach(() => { closeMessageDb(); rmSync(DATA_DIR, { recursive: true, force: true }); });
const bot = { id: "learning", name: "Editor" };

it("reconciles a correction in a two-entry project topic, retaining the old version in the file", async () => {
  ensureWorkspace(bot.id);
  writeMemoryTopic(bot.id, "tapa.md", "---\ntitle: Tapa\n---\n- 2026-10-01 · Use blue treatment\n- 2026-10-02 · Use orange treatment\n");
  const upkeep = createMemoryUpkeep({ bots: () => [bot], bot: () => bot,
    engine: () => ({ generateText: async prompt => prompt.includes(TIDY_MARKER) ? '{"pairs":[{"a":0,"b":1,"keep":"b"}]}' : '{"moves":[]}' }),
    busy: () => false, addToAboutMe: () => 0, sourceLabel: () => "fixture", quietMs: () => 60_000, tidyHour: () => 3 });
  const report = await upkeep.tidy(bot.id);
  expect(report.superseded).toBe(1);
  expect(report.note).toBeUndefined();
  expect(readMemoryTopic(bot.id, "tapa.md")).toContain("~~Use blue treatment~~");
  expect(memoryPassages(bot.id, "blue treatment").some(hit => hit.snippet.includes("blue"))).toBe(false);
  expect(memoryPassages(bot.id, "orange treatment")[0]?.snippet).toContain("orange");
  upkeep.stop();
});


it("reserves named topics while preferring their actual matching passage", () => {
  const passage = (label: string, snippet: string): RecallPassage => ({ source: "memory", label, snippet });
  const unrelated = [1, 2, 3, 4].map(n => passage(`memory/${n}.md`, "matching words"));
  const named = passage("memory/tapa.md", "topic opening");
  expect(selectMemoryPassages(unrelated, [named])).toContainEqual(named);
  const answer = passage(named.label, "the answer deep in the topic");
  expect(selectMemoryPassages([...unrelated, answer], [named])[0]).toEqual(answer);
  expect(selectMemoryPassages(unrelated, [named])).toHaveLength(4);
});

it("bounds topic model calls and rotates deferred topics into the next tidy", async () => {
  ensureWorkspace(bot.id);
  for (let i = 0; i < 6; i++) writeMemoryTopic(bot.id, `topic-${i}.md`, `- 2026-10-01 · Topic ${i} blue treatment\n- 2026-10-02 · Topic ${i} orange treatment\n`);
  const prompts: string[] = [];
  const upkeep = createMemoryUpkeep({ bots: () => [bot], bot: () => bot,
    engine: () => ({ generateText: async prompt => { if (prompt.includes(TIDY_MARKER)) prompts.push(prompt); return '{"pairs":[],"moves":[]}'; } }),
    busy: () => false, addToAboutMe: () => 0, sourceLabel: () => "fixture", quietMs: () => 60_000, tidyHour: () => 3 });
  try {
    const first = await upkeep.tidy(bot.id);
    expect(first.topicChecks).toBe(4);
    expect(first.topicsDeferred).toBe(2);
    expect(prompts).toHaveLength(4);
    prompts.length = 0;
    await upkeep.tidy(bot.id);
    expect(prompts).toHaveLength(4);
    expect(prompts[0]).toContain("Topic 4");
    expect(prompts[1]).toContain("Topic 5");
  } finally { upkeep.stop(); }
});
