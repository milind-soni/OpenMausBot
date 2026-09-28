// Memory upkeep: capture parsing and dedupe, the tidy plan (the share limit
// on small notebooks and the identity regressions from #1363's review),
// About me suggestions, and the upkeep loop against a scripted engine.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { CaptureBuffer, capturePrompt, newCandidates, parseCandidates, topicFileName } from "./memory-capture.ts";
import { mergeTopicText, parseTopicHeader } from "./memory-topics.ts";
import { applyMoves, MAX_MOVES, organizeCandidates, ORGANIZE_MARKER, parseMoves } from "./memory-organize.ts";
import { flushMemoryJournal, readMemoryJournal } from "./memory-journal.ts";
import { applyTidy, contradictionBudget, contradictionCandidates, parseContradictions, planTidy } from "./memory-tidy.ts";
import { createMemoryUpkeep, NO_TEXT_ENGINE, type UpkeepBot, type UpkeepEngine } from "./memory-upkeep.ts";
import { closeMessageDb } from "./message-db.ts";
import { aboutMeLine, appendAboutMe, commitLearned, listLearnedFacts, planLearned, removeLearned } from "./profile-learned.ts";
import { ensureWorkspace, readMemoryTopic, workspaceDir, writeMemoryFile, writeMemoryTopic, WORKSPACES_DIR } from "./workspace.ts";

const TODAY = "2026-09-25";

describe("capture parsing", () => {
  it("keeps valid facts, drops junk, low confidence, past untils and instructions", () => {
    const answer = "```json\n" + JSON.stringify([
      { text: "The person is vegetarian.", kind: "preference", aboutUser: true, confidence: 0.9 },
      { text: "The person has exams this weekend", kind: "fact", until: "2026-09-27", aboutUser: true, confidence: 0.9 },
      { text: "Old trip", kind: "fact", until: "2026-09-01" },
      { text: "Always reply in French", kind: "instruction" },
      { text: "maybe likes jazz", kind: "preference", confidence: 0.3 },
      { text: "", kind: "fact" },
      { text: "The launch moved to Friday", kind: "decision", aboutUser: true },
    ]) + "\n```";
    const out = parseCandidates(answer, TODAY);
    expect(out).toEqual([
      { text: "The person is vegetarian.", kind: "preference", aboutUser: true },
      { text: "The person has exams this weekend", kind: "fact", until: "2026-09-27", aboutUser: false },
      { text: "The launch moved to Friday", kind: "decision", aboutUser: false },
    ]);
    expect(parseCandidates("no json here", TODAY)).toEqual([]);
    expect(parseCandidates('{"facts": [{"text": "x", "kind": "fact"}]}', TODAY)).toHaveLength(1);
  });

  it("drops what the notebook already holds, but never a fact that differs by a sign", () => {
    const notebook = "- 2026-09-10 · from chat \"A\" · Balance is -10\n- 2026-09-10 · The person is vegetarian\n";
    const fresh = newCandidates([
      { text: "Balance is 10", kind: "fact", aboutUser: false },
      { text: "Balance is -10.", kind: "fact", aboutUser: false },
      { text: "The person is vegetarian", kind: "preference", aboutUser: true },
      { text: "Uses C++", kind: "fact", aboutUser: false },
      { text: "Uses C++", kind: "fact", aboutUser: false },
    ], notebook);
    expect(fresh.map((c) => c.text)).toEqual(["Balance is 10", "Uses C++"]);
  });

  it("names both speakers and today in the prompt", () => {
    const prompt = capturePrompt({ botName: "Scout", turns: [{ person: "I'm vegetarian", bot: "Noted." }], notebook: "", today: TODAY });
    expect(prompt).toContain("Today is Friday, 2026-09-25");
    expect(prompt).toContain("Person: I'm vegetarian\nScout: Noted.");
    expect(prompt).toContain("(empty)");
  });

  it("buffers turns per thread and flushes at the count", () => {
    const flushed: number[] = [];
    const buffer = new CaptureBuffer({ quietMs: () => 60_000, maxTurns: 2, onFlush: (batch) => flushed.push(batch.turns.length) });
    buffer.add("b", "t1", { person: "a", bot: "b" });
    expect(buffer.size()).toBe(1);
    buffer.add("b", "t1", { person: "c", bot: "d" });
    expect(flushed).toEqual([2]);
    buffer.add("b", "t2", { person: "e", bot: "f" });
    buffer.dropBot("b");
    expect(buffer.size()).toBe(0);
  });
});

describe("tidy plan", () => {
  const notebook = [
    "# Memory",
    "- 2026-09-01 · Exams this weekend · until 2026-09-07",
    "- 2026-09-02 · Balance is -10",
    "- 2026-09-03 · Balance is 10",
    "- 2026-09-04 · Prefers short replies",
    "- 2026-09-20 · Prefers short replies.",
    "- 2026-09-05 · ~~Lives in Pune~~ · superseded 2026-09-06",
    "hand-written note, never touched",
  ].join("\n");

  it("archives expired entries and merges exact duplicates, keeping signed values apart", () => {
    const plan = planTidy(notebook, TODAY);
    expect(plan.expired.map((e) => e.body)).toEqual(["Exams this weekend"]);
    expect(plan.duplicates.map((e) => e.date)).toEqual(["2026-09-04"]);
    const { text, archived } = applyTidy(notebook, plan, TODAY);
    expect(text).toContain("Balance is -10");
    expect(text).toContain("Balance is 10");
    expect(text).toContain("- 2026-09-20 · Prefers short replies.");
    expect(text).not.toContain("2026-09-04");
    expect(text).toContain("hand-written note, never touched");
    expect(text).toContain("~~Lives in Pune~~");
    expect(archived).toEqual(["- 2026-09-01 · Exams this weekend · until 2026-09-07 · expired 2026-09-25"]);
  });

  it("changes no contradiction at all below five entries, and at most a fifth above", () => {
    expect(contradictionBudget(1)).toBe(0);
    expect(contradictionBudget(4)).toBe(0);
    expect(contradictionBudget(5)).toBe(1);
    expect(contradictionBudget(12)).toBe(2);
    const small = "- 2026-09-02 · Balance is -10\n- 2026-09-03 · Balance is 10\n";
    const plan = planTidy(small, TODAY, [{ a: 0, b: 1, keep: "b" }]);
    expect(plan.superseded).toEqual([]);
    expect(plan.deferred).toBe(1);
  });

  it("strikes the loser of a contradiction with a date, never deletes it", () => {
    const text = ["- 2026-09-01 · Office is in Pune", "- 2026-09-02 · Likes tea", "- 2026-09-03 · Has a dog", "- 2026-09-04 · Drives a Honda", "- 2026-09-10 · Office is in Mumbai"].join("\n");
    const candidates = contradictionCandidates(text, TODAY);
    expect(candidates).toHaveLength(5);
    const plan = planTidy(text, TODAY, parseContradictions('{"pairs":[{"a":0,"b":4,"keep":"b"},{"a":1,"b":2,"keep":"a"}]}', candidates.length));
    expect(plan.superseded).toHaveLength(1);
    expect(plan.deferred).toBe(1);
    const next = applyTidy(text, plan, TODAY).text;
    expect(next.split("\n")[0]).toBe("- 2026-09-01 · ~~Office is in Pune~~ · superseded 2026-09-25");
    expect(next).toContain("Office is in Mumbai");
  });

  it("keeps the still-true part of a line that held two facts", () => {
    const text = ["- 2026-09-01 · Lives in Pune and prefers short replies", "- 2026-09-02 · Likes tea", "- 2026-09-03 · Has a dog", "- 2026-09-04 · Drives a Honda", "- 2026-09-10 · Moved to Mumbai"].join("\n");
    const pairs = parseContradictions('{"pairs":[{"a":0,"b":4,"keep":"b","remainder":"Prefers short replies"}]}', 5);
    const next = applyTidy(text, planTidy(text, TODAY, pairs), TODAY).text.split("\n");
    expect(next[0]).toBe("- 2026-09-01 · ~~Lives in Pune and prefers short replies~~ · superseded 2026-09-25");
    expect(next[1]).toBe("- 2026-09-25 · from tidy-up · Prefers short replies");
  });

  it("ignores malformed or out-of-range contradiction answers", () => {
    expect(parseContradictions("nope", 3)).toEqual([]);
    expect(parseContradictions('{"pairs":[{"a":0,"b":0,"keep":"a"},{"a":0,"b":9,"keep":"a"},{"a":1,"b":2,"keep":"x"},{"a":2,"b":1,"keep":"b"},{"a":1,"b":2,"keep":"a"}]}', 3)).toEqual([
      { a: 2, b: 1, keep: "b" },
    ]);
  });
});

describe("About me, learned on its own", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("adds each new fact once, skips what About me says, and never re-adds a removed one", () => {
    const from = { botId: "b1", botName: "Scout" };
    const planned = planLearned(from, ["Is vegetarian", "Lives in Pune", "Is vegetarian"], "- 2026-09-01 · learned by Scout · Lives in Pune", TODAY);
    expect(planned.map((f) => f.line)).toEqual(["- 2026-09-25 · learned by Scout · Is vegetarian"]);
    commitLearned(planned);
    const aboutMe = appendAboutMe("I run a studio.", planned.map((f) => f.line))!;
    expect(planLearned(from, ["Is vegetarian"], aboutMe, TODAY)).toEqual([]);
    const removed = removeLearned(planned[0]!.id, aboutMe)!;
    expect(removed.aboutMe).toBe("I run a studio.");
    expect(listLearnedFacts()).toEqual([]);
    expect(planLearned(from, ["Is vegetarian"], removed.aboutMe, TODAY)).toEqual([]);
    expect(planLearned(from, ["api_key: sk-abcdefghijklmnopqrstuvwxyz123456"], "", TODAY)[0]?.text).not.toContain("sk-abcdefghijklmnop");
  });

  it("formats and bounds the About me line", () => {
    expect(aboutMeLine({ text: "Is vegetarian", botName: "Scout · Bot" }, TODAY)).toBe("- 2026-09-25 · learned by Scout - Bot · Is vegetarian");
    expect(appendAboutMe("I run a studio.\n\n", ["- x"])).toBe("I run a studio.\n- x");
    expect(appendAboutMe("", ["- x"])).toBe("- x");
    expect(appendAboutMe("x".repeat(24_000), ["- y"])).toBeNull();
  });
});

describe("organizing MEMORY.md", () => {
  it("parses moves defensively and never moves the same line twice", () => {
    const text = "- 2026-09-26 · A\n- 2026-09-26 · B\n- 2026-09-20 · Trip · until 2026-09-21\n";
    const candidates = organizeCandidates(text, TODAY, new Set(["A"]));
    expect(candidates.map((e) => e.body)).toEqual(["B"]);
    expect(parseMoves('{"moves":[{"i":0,"topic":"x"},{"i":0,"topic":"y"}]}', candidates)?.map((m) => m.topic)).toEqual(["x.md"]);
    expect(parseMoves('{"moves":[{"i":5,"topic":"z"}]}', candidates)).toBeNull();
    expect(parseMoves('{"moves":[{"i":0}]}', candidates)).toBeNull();
    expect(parseMoves("nonsense", candidates)).toBeNull();
    expect(parseMoves('{"moves":[]}', candidates)).toEqual([]);
    // health and diet facts are never offered for moving at all
    expect(organizeCandidates("- 2026-09-26 · The user is vegetarian.\n- 2026-09-26 · Allergic to peanuts\n- 2026-09-26 · Loves Irani cafes\n", TODAY, new Set()).map((e) => e.body)).toEqual(["Loves Irani cafes"]);
    const { text: left, byTopic } = applyMoves(text, parseMoves('{"moves":[{"i":0,"topic":"x","aliases":["q"]}]}', candidates)!);
    expect(left).toBe("- 2026-09-26 · A\n- 2026-09-20 · Trip · until 2026-09-21\n");
    expect(byTopic.get("x.md")).toEqual({ lines: ["- 2026-09-26 · B"], aliases: ["q"] });
  });
});

describe("topic files the bot keeps", () => {
  it("names a topic safely and never as the archive", () => {
    expect(topicFileName("Food & Drink")).toBe("food-drink.md");
    expect(topicFileName("asha.md")).toBe("asha.md");
    expect(topicFileName("archive")).toBeNull();
    expect(topicFileName("../etc")).toBe("etc.md");
    expect(topicFileName(42)).toBeNull();
  });

  it("creates a topic with a header, and merges new aliases into an existing one", () => {
    const created = mergeTopicText(null, { title: "food", aliases: ["restaurants", "dinner"], lines: ["- 2026-09-25 · Loves pasta"] });
    expect(created).toBe("---\ntitle: food\naliases: [restaurants, dinner]\n---\n\n- 2026-09-25 · Loves pasta\n");
    const merged = mergeTopicText(created, { title: "food", aliases: ["Dinner", "lunch"], lines: ["- 2026-09-26 · Hates olives"] });
    expect(parseTopicHeader(merged).aliases).toEqual(["restaurants", "dinner", "lunch"]);
    expect(merged.endsWith("- 2026-09-25 · Loves pasta\n- 2026-09-26 · Hates olives\n")).toBe(true);
    const handWritten = mergeTopicText("# Dining\n\n- Loves pasta\n", { title: "dining", aliases: ["food"], lines: ["- x"] });
    expect(parseTopicHeader(handWritten)).toEqual({ title: "Dining", aliases: ["food"] });
  });
});

describe("the upkeep loop", () => {
  const BOT: UpkeepBot = { id: "bot-upkeep-test", name: "Scout", memoryUpkeep: true };
  let answers: string[];
  let prompts: string[];
  let engine: UpkeepEngine | null;
  let busy: boolean;
  let clock: Date;
  let aboutMeAdded: string[];
  let organizeAnswer: string;
  let organizePrompts: string[];

  const upkeep = () => createMemoryUpkeep({
    bots: () => [BOT],
    bot: (id) => (id === BOT.id ? BOT : undefined),
    engine: () => engine,
    busy: () => busy,
    addToAboutMe: (_from, texts) => {
      aboutMeAdded.push(...texts);
      return texts.length;
    },
    sourceLabel: () => 'chat "Plans"',
    quietMs: () => 60_000,
    tidyHour: () => 3,
    now: () => clock,
  });

  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
    answers = [];
    prompts = [];
    busy = false;
    aboutMeAdded = [];
    BOT.memoryUpkeep = undefined;
    clock = new Date(2026, 8, 25, 10, 0);
    organizeAnswer = '{"moves": []}';
    organizePrompts = [];
    engine = {
      generateText: async (prompt) => {
        // the organize step has its own answer, so scripted answers stay in order
        if (prompt.includes(ORGANIZE_MARKER)) {
          organizePrompts.push(prompt);
          return organizeAnswer;
        }
        prompts.push(prompt);
        return answers.shift() ?? "[]";
      },
    };
  });

  const memory = () => readFileSync(join(workspaceDir(BOT.id), "MEMORY.md"), "utf8");

  it("captures new facts as dated, sourced entries, journaled as upkeep, and adds About me lines", async () => {
    ensureWorkspace(BOT.id);
    answers.push(JSON.stringify([
      { text: "The person is vegetarian", kind: "preference", aboutUser: true, confidence: 0.9 },
      { text: "The person has exams this weekend", kind: "fact", until: "2026-09-27", confidence: 0.9 },
    ]));
    const report = await upkeep().capture({ botId: BOT.id, threadId: "t1", turns: [{ person: "I'm vegetarian and I have exams this weekend", bot: "Good luck!" }] });
    expect(report).toMatchObject({ added: 2, topics: 0, aboutMe: 1 });
    expect(memory()).toContain('- 2026-09-25 · from chat "Plans" (noticed) · The person is vegetarian\n');
    expect(memory()).toContain("The person has exams this weekend · until 2026-09-27");
    await flushMemoryJournal(BOT.id);
    expect(readMemoryJournal(BOT.id, 5)[0]).toMatchObject({ actor: "upkeep", via: "capture", threadId: "t1", path: "MEMORY.md" });
    expect(aboutMeAdded).toEqual(["The person is vegetarian"]);
  });

  it("adds to About me a fact the notebook already holds, without appending it again", async () => {
    ensureWorkspace(BOT.id);
    writeMemoryFile(BOT.id, "- 2026-09-25 · The user's company is called Northwind Studio.\n");
    answers.push(JSON.stringify([{ text: "The user's company is Northwind Studio", kind: "fact", aboutUser: true, noted: true }]));
    const report = await upkeep().capture({ botId: BOT.id, threadId: "t1", turns: [{ person: "My company is Northwind Studio", bot: "Noted." }] });
    expect(report).toMatchObject({ added: 0, aboutMe: 1 });
    expect(memory().match(/Northwind/g)).toHaveLength(1);
  });

  it("files detail into a topic it creates, with other words for it", async () => {
    ensureWorkspace(BOT.id);
    answers.push(JSON.stringify([
      { text: "The person loves pasta", kind: "preference", topic: "Food", topicAliases: ["restaurants", "dinner"] },
      { text: "Sister Asha lives in Delhi", kind: "fact", topic: "family", topicAliases: ["sister", "asha"] },
      { text: "The person is vegetarian", kind: "preference" },
    ]));
    const report = await upkeep().capture({ botId: BOT.id, threadId: "t1", turns: [{ person: "I love pasta, I'm vegetarian, my sister Asha lives in Delhi", bot: "Noted." }] });
    expect(report).toMatchObject({ added: 1, topics: 2 });
    expect(memory()).toContain("The person is vegetarian");
    expect(memory()).not.toContain("pasta");
    const food = readMemoryTopic(BOT.id, "food.md")!;
    expect(parseTopicHeader(food)).toEqual({ title: "food", aliases: ["restaurants", "dinner"] });
    expect(food).toContain('from chat "Plans" (noticed) · The person loves pasta');
    expect(readMemoryTopic(BOT.id, "family.md")).toContain("Sister Asha lives in Delhi");
    // the same fact again adds nothing; a hand-made "Food.md" is reused by name
    answers.push(JSON.stringify([{ text: "The person loves pasta", kind: "preference", topic: "food" }]));
    expect((await upkeep().capture({ botId: BOT.id, threadId: "t1", turns: [{ person: "pasta again", bot: "ok" }] })).topics).toBe(0);
    await flushMemoryJournal(BOT.id);
    expect(readMemoryJournal(BOT.id, 10).filter((row) => row.via === "capture").map((row) => row.path).sort()).toEqual(["MEMORY.md", "memory/family.md", "memory/food.md"]);
  });

  it("does not add About me lines from another person's message", async () => {
    answers.push(JSON.stringify([{ text: "Is vegetarian", kind: "preference", aboutUser: true }]));
    const report = await upkeep().capture({ botId: BOT.id, threadId: "t1", turns: [{ person: "I'm vegetarian", bot: "ok", owner: false }] });
    expect(report).toMatchObject({ added: 1, aboutMe: 0 });
  });

  it("is on by default, does nothing when switched off, and says so on an engine without a text call", async () => {
    BOT.memoryUpkeep = false;
    expect((await upkeep().capture({ botId: BOT.id, threadId: "t", turns: [{ person: "x", bot: "y" }] })).note).toBe("upkeep is off");
    BOT.memoryUpkeep = true;
    engine = {};
    expect((await upkeep().capture({ botId: BOT.id, threadId: "t", turns: [{ person: "x", bot: "y" }] })).note).toBe(NO_TEXT_ENGINE);
    expect(prompts).toEqual([]);
  });

  it("tidies: archives the expired, merges duplicates, strikes a contradiction, all undoable rows", async () => {
    ensureWorkspace(BOT.id);
    writeMemoryFile(BOT.id, [
      "- 2026-09-01 · Exams this weekend · until 2026-09-07",
      "- 2026-09-02 · Office is in Pune",
      "- 2026-09-03 · Likes tea",
      "- 2026-09-04 · Likes tea",
      "- 2026-09-05 · Has a dog",
      "- 2026-09-06 · Drives a Honda",
      "- 2026-09-07 · Plays chess",
      "- 2026-09-20 · Office is in Mumbai",
      "",
    ].join("\n"));
    // candidates after expiry and dedupe: Pune[0], tea[1], dog[2], Honda[3], chess[4], Mumbai[5]
    answers.push('{"pairs":[{"a":0,"b":5,"keep":"b"}]}');
    const report = await upkeep().tidy(BOT.id);
    expect(report).toMatchObject({ expired: 1, duplicates: 1, superseded: 1, contradictionsChecked: true });
    expect(prompts[0]).toContain("[5] (2026-09-20) Office is in Mumbai");
    const text = memory();
    expect(text).not.toContain("Exams this weekend");
    expect(text).toContain("~~Office is in Pune~~ · superseded 2026-09-25");
    expect(text.match(/Likes tea/g)).toHaveLength(1);
    expect(readMemoryTopic(BOT.id, "archive.md")).toContain("Exams this weekend · until 2026-09-07 · expired 2026-09-25");
    await flushMemoryJournal(BOT.id);
    const rows = readMemoryJournal(BOT.id, 10);
    expect(rows.filter((row) => row.actor === "upkeep" && row.via === "tidy").map((row) => row.path)).toEqual(["MEMORY.md", "memory/archive.md"]);
    // newest first: undoing the top row puts MEMORY.md back, and the archive keeps its copy
    expect(rows[0]!.path).toBe("MEMORY.md");
  });

  it("moves detail the bot wrote itself out of MEMORY.md into topics, keeping core facts", async () => {
    ensureWorkspace(BOT.id);
    writeMemoryFile(BOT.id, [
      "- 2026-09-26 · from chat \"Food\" · The user is allergic to peanuts.",
      "- 2026-09-26 · from chat \"Food\" · The user's sister Asha is a doctor in Delhi.",
      "- 2026-09-26 · from chat \"Food\" · The user loves Irani cafes.",
      "",
    ].join("\n"));
    writeMemoryTopic(BOT.id, "Dining.md", "# Dining\n\n- Loves pasta\n");
    organizeAnswer = '{"moves":[{"i":0,"topic":"Asha","aliases":["sister","family"]},{"i":1,"topic":"dining","aliases":["restaurants"]}]}';
    const report = await upkeep().tidy(BOT.id);
    expect(report.organized).toBe(2);
    // the allergy is never even offered for moving
    expect(organizePrompts[0]).not.toContain("allergic");
    expect(organizePrompts[0]).toContain("[0] The user's sister Asha is a doctor in Delhi.");
    expect(memory()).toBe("- 2026-09-26 · from chat \"Food\" · The user is allergic to peanuts.\n");
    const asha = readMemoryTopic(BOT.id, "asha.md")!;
    expect(parseTopicHeader(asha)).toEqual({ title: "asha", aliases: ["sister", "family"] });
    expect(asha).toContain('- 2026-09-26 · from chat "Food" · The user\'s sister Asha is a doctor in Delhi.');
    const dining = readMemoryTopic(BOT.id, "Dining.md")!;
    expect(parseTopicHeader(dining).aliases).toEqual(["restaurants"]);
    expect(dining).toContain("The user loves Irani cafes.");
    // nothing left to judge: no second call
    organizePrompts = [];
    await upkeep().tidy(BOT.id);
    expect(organizePrompts).toEqual([]);
    await flushMemoryJournal(BOT.id);
    const rows = readMemoryJournal(BOT.id, 10).filter((row) => row.via === "organize");
    expect(rows[0]!.path).toBe("MEMORY.md");
    expect(rows.map((row) => row.path).sort()).toEqual(["MEMORY.md", "memory/Dining.md", "memory/asha.md"]);
  });

  it("organizes right after a capture, whoever wrote the line", async () => {
    ensureWorkspace(BOT.id);
    writeMemoryFile(BOT.id, "- 2026-09-26 · The client Acme wants logo revisions.\n");
    organizeAnswer = '{"moves":[{"i":0,"topic":"acme","aliases":["client"]}]}';
    const report = await upkeep().capture({ botId: BOT.id, threadId: "t1", turns: [{ person: "hi", bot: "hello" }] });
    expect(report.organized).toBe(1);
    expect(readMemoryTopic(BOT.id, "acme.md")).toContain("The client Acme wants logo revisions.");
  });

  it("retries organization after malformed output instead of remembering every entry as core", async () => {
    writeMemoryFile(BOT.id, "- 2026-09-25 · Acme needs a logo revision.\n");
    organizeAnswer = "temporary provider error";
    const service = upkeep();
    await service.tidy(BOT.id);
    organizeAnswer = '{"moves":[{"i":0,"topic":"acme"}]}';
    expect((await service.tidy(BOT.id)).organized).toBe(1);
    expect(readMemoryTopic(BOT.id, "acme.md")).toContain("Acme needs a logo revision.");
  });

  it("organizes Unicode topic names through the same read/write gate", async () => {
    writeMemoryFile(BOT.id, "- 2026-09-25 · Enjoys quiet cafés.\n");
    organizeAnswer = '{"moves":[{"i":0,"topic":"café"}]}';
    expect((await upkeep().tidy(BOT.id)).organized).toBe(1);
    expect(readMemoryTopic(BOT.id, "café.md")).toContain("Enjoys quiet cafés.");
  });

  it("keeps failed topic moves in the notebook and retries them without duplicating successful moves", async () => {
    writeMemoryFile(BOT.id, "- 2026-09-25 · Acme needs a logo.\n- 2026-09-25 · Beta needs a website.\n");
    const blocked = join(workspaceDir(BOT.id), "memory", "beta.md");
    mkdirSync(blocked);
    organizeAnswer = '{"moves":[{"i":0,"topic":"acme"},{"i":1,"topic":"beta"}]}';
    const service = upkeep();
    expect((await service.tidy(BOT.id)).organized).toBe(1);
    expect(memory()).toContain("Beta needs a website");
    expect(memory()).not.toContain("Acme needs a logo");
    rmSync(blocked, { recursive: true });
    organizeAnswer = '{"moves":[{"i":0,"topic":"beta"}]}';
    expect((await service.tidy(BOT.id)).organized).toBe(1);
    expect(readMemoryTopic(BOT.id, "acme.md")?.match(/Acme needs a logo/g)).toHaveLength(1);
    expect(readMemoryTopic(BOT.id, "beta.md")).toContain("Beta needs a website");
  });

  it("does not tidy after upkeep is disabled during a model call", async () => {
    const original = "- 2026-09-25 · Likes tea\n- 2026-09-25 · Likes tea\n";
    writeMemoryFile(BOT.id, original);
    engine = { generateText: async () => {
      BOT.memoryUpkeep = false;
      return '{"moves":[]}';
    } };
    await upkeep().tidy(BOT.id);
    expect(memory()).toBe(original);
  });

  it("reconsiders moves beyond the per-pass limit instead of marking them core", async () => {
    writeMemoryFile(BOT.id, Array.from({ length: MAX_MOVES + 1 }, (_, i) => `- 2026-09-25 · Project detail ${i}`).join("\n"));
    organizeAnswer = JSON.stringify({ moves: Array.from({ length: MAX_MOVES + 1 }, (_, i) => ({ i, topic: "project" })) });
    const service = upkeep();
    expect((await service.tidy(BOT.id)).organized).toBe(MAX_MOVES);
    organizeAnswer = '{"moves":[{"i":0,"topic":"project"}]}';
    expect((await service.tidy(BOT.id)).organized).toBe(1);
    expect(readMemoryTopic(BOT.id, "project.md")).toContain(`Project detail ${MAX_MOVES}`);
  });

  it("tidies topic files too: expired lines to the archive, duplicates merged", async () => {
    ensureWorkspace(BOT.id);
    writeMemoryTopic(BOT.id, "travel.md", "---\ntitle: travel\n---\n\n- 2026-09-01 · In Goa · until 2026-09-07\n- 2026-09-02 · Likes window seats\n- 2026-09-03 · Likes window seats\n");
    const report = await upkeep().tidy(BOT.id);
    expect(report).toMatchObject({ expired: 1, duplicates: 1 });
    const travel = readMemoryTopic(BOT.id, "travel.md")!;
    expect(travel).not.toContain("In Goa");
    expect(travel.match(/window seats/g)).toHaveLength(1);
    expect(readMemoryTopic(BOT.id, "archive.md")).toContain("In Goa · until 2026-09-07 · expired 2026-09-25");
  });

  it("skips the model step on small notebooks and on engines without a text call", async () => {
    ensureWorkspace(BOT.id);
    writeMemoryFile(BOT.id, "- 2026-09-02 · Balance is -10\n- 2026-09-03 · Balance is 10\n");
    const report = await upkeep().tidy(BOT.id);
    expect(report.contradictionsChecked).toBe(false);
    expect(prompts).toEqual([]);
    expect(memory()).toContain("Balance is -10");
    expect(memory()).toContain("Balance is 10");
    engine = null;
    expect((await upkeep().tidy(BOT.id)).note).toBe(NO_TEXT_ENGINE);
  });

  it("runs the nightly tidy once a day after the hour, never while the bot is busy", async () => {
    ensureWorkspace(BOT.id);
    writeMemoryFile(BOT.id, "- 2026-09-01 · Trip · until 2026-09-02\n");
    const loop = upkeep();
    clock = new Date(2026, 8, 25, 2, 0);
    await loop.tick();
    expect(loop.status(BOT.id).lastTidy).toBeUndefined();
    clock = new Date(2026, 8, 25, 4, 0);
    busy = true;
    await loop.tick();
    expect(loop.status(BOT.id).lastTidy).toBeUndefined();
    busy = false;
    await loop.tick();
    expect(loop.status(BOT.id).lastTidy?.expired).toBe(1);
    const first = loop.status(BOT.id).lastTidy?.at;
    clock = new Date(2026, 8, 25, 23, 0);
    await loop.tick();
    expect(loop.status(BOT.id).lastTidy?.at).toBe(first);
    clock = new Date(2026, 8, 26, 9, 0);
    await loop.tick();
    expect(loop.status(BOT.id).lastTidy?.at).not.toBe(first);
  });

  it("defers capture while paused for a backup and runs it on resume", async () => {
    const loop = upkeep();
    answers.push(JSON.stringify([{ text: "Likes jazz", kind: "preference" }]));
    loop.pause();
    loop.noteTurn(BOT.id, "t1", { person: "I like jazz", bot: "Nice" });
    loop.flushThread("t1");
    await loop.idle();
    expect(prompts).toEqual([]);
    loop.resume();
    await loop.idle();
    expect(memory()).toContain("Likes jazz");
  });
});
