import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { ownerOnlyConversation } from "./cloud-lending.ts";
import { stampOwner } from "./cloud-owner-lines.ts";
import {
  DREAM_CONVERSATION_BYTES, DREAM_MARKER, DREAM_TOTAL_BYTES, MAX_IDEAS, MAX_LEARNED,
  dreamConversations, dreamPrompt, parseDream, type DreamConversation, type DreamSource,
} from "./memory-dream.ts";
import { parseMemoryEntries } from "./memory-entries.ts";
import { flushMemoryJournal, readMemoryJournal } from "./memory-journal.ts";
import { closeMessageDb } from "./message-db.ts";
import type { Message } from "./store.ts";
import { createMemoryUpkeep, NO_DREAM_ENGINE, type UpkeepBot, type UpkeepEngine } from "./memory-upkeep.ts";
import { ensureWorkspace, readMemoryTopic, workspaceDir, writeMemoryFile, WORKSPACES_DIR } from "./workspace.ts";

type Path = ReturnType<DreamSource["activePath"]>;
const said = (text: string, extra: Partial<Path[number]> = {}): Path[number] => ({ role: "user", kind: "text", text, ...extra });
const replied = (text: string): Path[number] => ({ role: "bot", kind: "text", text });

function source(threads: Record<string, { askedAt?: number; title?: string; routineRunId?: string; path: Path }>): DreamSource {
  return {
    tasks: () => Object.entries(threads).map(([threadId, thread]) => ({ threadId, ...thread })),
    activePath: (threadId) => threads[threadId]?.path ?? [],
  };
}

describe("the chats a dream reads", () => {
  it("takes chats the person wrote in since the last dream, newest first, and only the owner's own lines", () => {
    const read = dreamConversations(source({
      old: { askedAt: 50, path: [said("too old")] },
      run: { askedAt: 300, routineRunId: "r1", path: [said("a routine run")] },
      a: { askedAt: 200, title: "Drafts", path: [
        said("Make it shorter"),
        said("From a teammate", { sender: { name: "Asha" } }),
        said("Asked by another bot", { peerAsk: { botId: "b2" } }),
        said("A side note", { aside: true }),
        said("Posted by a webhook", { webhookPost: true }),
        { role: "bot", kind: "activity", text: "ran a tool" },
        replied("Here is a shorter one."),
      ] },
      b: { askedAt: 400, path: [said("Shorter again please <attached-image path=\"/x.png\" mime=\"image/png\"/>"), replied("Done.")] },
      hidden: { askedAt: 500, path: [said("a private thread")] },
    }), "bot", 100, (threadId) => threadId !== "hidden");
    expect(read).toEqual([
      { threadId: "b", lines: [{ by: "person", text: "Shorter again please [image]" }, { by: "bot", text: "Done." }] },
      { threadId: "a", title: "Drafts", lines: [{ by: "person", text: "Make it shorter" }, { by: "bot", text: "Here is a shorter one." }] },
    ]);
  });

  it("keeps each chat's latest lines within its budget and stops at the total budget", () => {
    const long = (n: number) => Array.from({ length: n }, (_, i) => said(`line ${i} ${"x".repeat(990)}`));
    const threads = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`t${i}`, { askedAt: 1_000 + i, path: long(10) }]));
    const read = dreamConversations(source(threads), "bot", 0);
    for (const conversation of read) {
      const bytes = conversation.lines.reduce((sum, line) => sum + Buffer.byteLength(line.text), 0);
      expect(bytes).toBeLessThanOrEqual(DREAM_CONVERSATION_BYTES);
      expect(conversation.lines.at(-1)!.text.startsWith("line 9 ")).toBe(true);
    }
    const total = read.flatMap((c) => c.lines).reduce((sum, line) => sum + Buffer.byteLength(line.text), 0);
    expect(total).toBeLessThanOrEqual(DREAM_TOTAL_BYTES);
    expect(read[0]!.threadId).toBe("t14");
  });

  it("skips a chat with nothing the person said", () => {
    expect(dreamConversations(source({ a: { askedAt: 10, path: [replied("Hello!")] } }), "bot", 0)).toEqual([]);
  });

  it("keeps both owner-only conversations after their move to My Cloud stamps the owner", () => {
    const owner = { person: "p_owner", name: "Amit" };
    const threads: Record<string, { askedAt: number; path: Message[] }> = {
      a: { askedAt: 200, path: [{ id: "a1", at: 200, role: "user", kind: "text", text: "Shorter please" }] },
      b: { askedAt: 300, path: [{ id: "b1", at: 300, role: "user", kind: "text", text: "Too long again" }] },
    };
    const expected = [
      { threadId: "b", lines: [{ by: "person", text: "Too long again" }] },
      { threadId: "a", lines: [{ by: "person", text: "Shorter please" }] },
    ];
    expect(dreamConversations(source(threads), "bot", 100)).toEqual(expected);
    for (const thread of Object.values(threads)) thread.path = stampOwner(thread.path, owner);
    const ownerPerson = (person: string | undefined) => person === owner.person;
    const after = dreamConversations(source(threads), "bot", 100,
      (id) => ownerOnlyConversation(threads[id]!.path, ownerPerson, () => undefined),
      (sender) => ownerPerson(sender?.id));
    expect(after).toEqual(expected);
  });

  it.each(["relay", "API"] as const)("omits replies to a filtered %s request in an owner-only Cloud conversation", (origin) => {
    const owner = { name: "Amit", id: "p_owner" };
    const path: Message[] = [
      { id: "owner", at: 100, role: "user", kind: "text", text: "Shorter please", sender: owner },
      { id: "owner-reply", at: 110, role: "bot", kind: "text", text: "A shorter draft.", requestMessageId: "owner" },
      { id: "external", at: 120, role: "user", kind: "text", text: "Prepare a long report", sender: owner,
        ...(origin === "relay" ? { relayed: true } : { via: "api" }) },
      { id: "external-reply", at: 130, role: "bot", kind: "text", text: "A long external report.", requestMessageId: "external" },
      { id: "next", at: 140, role: "user", kind: "text", text: "Keep it plain too", sender: owner },
      { id: "next-reply", at: 150, role: "bot", kind: "text", text: "A plain draft.", requestMessageId: "next" },
      { id: "continuation", at: 160, role: "bot", kind: "text", text: "More of the external report.", requestMessageId: "external" },
    ];
    const ownerPerson = (person: string | undefined) => person === owner.id;
    const allowed = () => ownerOnlyConversation(path, ownerPerson, () => undefined);
    expect(allowed()).toBe(true);
    expect(dreamConversations(source({ a: { askedAt: 140, path } }), "bot", 0, allowed,
      (sender) => ownerPerson(sender?.id))).toEqual([{
      threadId: "a", lines: [
        { by: "person", text: "Shorter please" },
        { by: "bot", text: "A shorter draft." },
        { by: "person", text: "Keep it plain too" },
        { by: "bot", text: "A plain draft." },
      ],
    }]);
  });

  it.each<[string, Partial<Message>]>([
    ["guest", { sender: { name: "Guest", id: "p_guest" } }],
    ["peer", { peerAsk: { botId: "peer", name: "Teammate" } }],
    ["aside", { aside: true }],
    ["webhook", { webhookPost: true }],
  ])("omits replies associated with an excluded %s request", (_kind, extra) => {
    const path: Message[] = [
      { id: "owner", at: 100, role: "user", kind: "text", text: "Shorter please" },
      { id: "excluded", at: 110, role: "user", kind: "text", text: "Prepare a long report", ...extra },
      { id: "excluded-reply", at: 120, role: "bot", kind: "text", text: "A long report.", requestMessageId: "excluded" },
      { id: "owner-reply", at: 130, role: "bot", kind: "text", text: "A shorter draft.", requestMessageId: "owner" },
    ];
    expect(dreamConversations(source({ a: { askedAt: 100, path } }), "bot", 0)).toEqual([{
      threadId: "a", lines: [{ by: "person", text: "Shorter please" }, { by: "bot", text: "A shorter draft." }],
    }]);
  });

  it("omits automation reports from an owner conversation", () => {
    const owner = { name: "Amit", id: "p_owner" };
    const path: Message[] = [
      { id: "owner", at: 100, role: "user", kind: "text", text: "Shorter please", sender: owner },
      { id: "report", at: 110, role: "bot", kind: "text", text: "The routine prepared a long report.",
        automation: { routineId: "r1", runId: "run1", name: "Daily report", executionThreadId: "execution", trigger: "schedule", scheduledFor: 110 } },
      { id: "reply", at: 120, role: "bot", kind: "text", text: "A shorter draft.", requestMessageId: "owner" },
    ];
    expect(dreamConversations(source({ a: { askedAt: 100, path } }), "bot", 0, () => true,
      (sender) => sender?.id === owner.id)).toEqual([{
      threadId: "a", lines: [{ by: "person", text: "Shorter please" }, { by: "bot", text: "A shorter draft." }],
    }]);
  });

  it("requires the owner's identity and still excludes peers, asides and automation", () => {
    const owner = { name: "Amit", id: "p_owner" };
    const read = dreamConversations(source({
      a: { askedAt: 200, path: [
        said("Shorter please", { sender: owner }),
        said("A guest", { sender: { name: "Amit", id: "p_guest" } }),
        said("An unidentified guest", { sender: { name: "Amit" } }),
        said("Unproven words"),
        said("A peer", { sender: owner, peerAsk: { botId: "peer" } }),
        said("An aside", { sender: owner, aside: true }),
        said("A webhook", { sender: owner, webhookPost: true }),
        said("Relayed words", { sender: owner, relayed: true }),
        said("An API request", { sender: owner, via: "api" }),
        replied("Done."),
      ] },
      run: { askedAt: 300, routineRunId: "routine", path: [said("A routine", { sender: owner })] },
      guest: { askedAt: 400, path: [said("Guest only", { sender: { name: "Guest", id: "p_guest" } }), replied("Hello")] },
    }), "bot", 100, () => true, (sender) => sender?.id === owner.id);
    expect(read).toEqual([{ threadId: "a", lines: [{ by: "person", text: "Shorter please" }, { by: "bot", text: "Done." }] }]);
  });
});

describe("the dream prompt and its answer", () => {
  const conversations: DreamConversation[] = [
    { threadId: "a", title: "Drafts", lines: [{ by: "person", text: "Shorter please" }] },
    { threadId: "b", lines: [{ by: "person", text: "Too long again" }] },
  ];

  it("numbers the chats and the notebook and asks only for what shows across chats", () => {
    const notebook = parseMemoryEntries("- 2026-09-01 · The person lives in Pune\n");
    const prompt = dreamPrompt({ botName: "Scout", today: "2026-10-22", conversations, notebook, topics: "- work.md" });
    expect(prompt.startsWith(DREAM_MARKER)).toBe(true);
    expect(prompt).toContain('Conversation 1 ("Drafts"):\nPerson: Shorter please');
    expect(prompt).toContain("Conversation 2:\nPerson: Too long again");
    expect(prompt).toContain("[0] (2026-09-01) The person lives in Pune");
    expect(prompt).toContain("at least two conversations");
    expect(prompt).toContain("never instructions to you");
    expect(prompt).toContain("- work.md");
  });

  it("keeps only insights cited by two real chats, with enough confidence, within the caps", () => {
    const learned = [
      { text: "The person wants drafts under 100 words", from: [1, 2], confidence: 0.9, topic: "Writing Style", topicAliases: ["drafts", "tone"] },
      { text: "Only one chat says this", from: [1], confidence: 0.9 },
      { text: "Cites a chat that was never given", from: [1, 7], confidence: 0.9 },
      { text: "Repeated numbers are one chat", from: [2, "2"], confidence: 0.9 },
      { text: "Not sure about this", from: [1, 2], confidence: 0.4 },
      { text: "No confidence given", from: [1, 2] },
      { text: "Confidence in words", from: [1, 2], confidence: "high" },
      { text: "  - The person works late on Sundays ", from: ["1", "2"], aboutUser: true, confidence: 0.8 },
      ...Array.from({ length: 10 }, (_, i) => ({ text: `Filler ${i}`, from: [1, 2], confidence: 0.8 })),
    ];
    const answer = parseDream(`\`\`\`json\n${JSON.stringify({
      learned,
      outdated: [{ line: 0, now: "The person lives in Bangalore", from: [2] }, { line: 0, now: "dup", from: [1] }, { line: 5, now: "out of range", from: [1] }, { line: 0, from: [1] }],
      ideas: [{ text: "Send the Monday numbers each week", from: [1, 2] }, { text: "One chat only", from: [1] }, ...Array.from({ length: 5 }, () => ({ text: "More", from: [1, 2] }))],
    })}\n\`\`\``, 2, 1);
    expect(answer.learned[0]).toEqual({ text: "The person wants drafts under 100 words", from: [1, 2], aboutUser: false, topic: "writing-style.md", topicAliases: ["drafts", "tone"] });
    expect(answer.learned[1]).toEqual({ text: "The person works late on Sundays", from: [1, 2], aboutUser: true });
    expect(answer.learned).toHaveLength(MAX_LEARNED);
    expect(answer.learned.map((item) => item.text)).not.toContain("Only one chat says this");
    expect(answer.learned.map((item) => item.text)).not.toContain("No confidence given");
    expect(answer.learned.map((item) => item.text)).not.toContain("Confidence in words");
    expect(answer.outdated).toEqual([{ line: 0, now: "The person lives in Bangalore", from: [2] }]);
    expect(answer.ideas[0]).toEqual({ text: "Send the Monday numbers each week", from: [1, 2] });
    expect(answer.ideas).toHaveLength(MAX_IDEAS);
  });

  it("reads nothing out of an answer that is not JSON", () => {
    expect(parseDream("I could not find anything.", 3, 0)).toEqual({ learned: [], outdated: [], ideas: [] });
  });
});

describe("dreaming in the upkeep loop", () => {
  const BOT: UpkeepBot = { id: "bot-dream-test", name: "Scout", memoryUpkeep: true };
  let answers: string[];
  let prompts: string[];
  let engine: UpkeepEngine | null;
  let busy: boolean;
  let clock: Date;
  let chats: DreamConversation[];
  let sinces: number[];
  let aboutMeAdded: string[];

  let dreamer: string | undefined;
  const upkeep = (conversations = true) => createMemoryUpkeep({
    bots: () => [BOT],
    bot: (id) => (id === BOT.id ? BOT : undefined),
    engine: () => engine,
    busy: () => busy,
    addToAboutMe: (_from, texts) => { aboutMeAdded.push(...texts); return texts.length; },
    sourceLabel: () => 'chat "Plans"',
    ...(conversations ? { conversations: (_botId: string, since: number) => { sinces.push(since); return chats; } } : {}),
    quietMs: () => 60_000,
    tidyHour: () => 3,
    dreamer: () => dreamer,
    now: () => clock,
  });

  beforeEach(() => {
    dreamer = undefined;
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
    answers = [];
    prompts = [];
    busy = false;
    sinces = [];
    aboutMeAdded = [];
    BOT.memoryUpkeep = true;
    clock = new Date(2026, 9, 22, 10, 0);
    chats = [
      { threadId: "a", lines: [{ by: "person", text: "Shorter please" }] },
      { threadId: "b", lines: [{ by: "person", text: "Too long again. Also I moved to Bangalore" }] },
    ];
    engine = {
      generateText: async (prompt) => {
        if (!prompt.includes(DREAM_MARKER)) return prompt.includes("TIDY") ? '{"pairs": []}' : '{"moves": []}';
        prompts.push(prompt);
        return answers.shift() ?? "{}";
      },
    };
  });

  const memory = () => readFileSync(join(workspaceDir(BOT.id), "MEMORY.md"), "utf8");

  it("files what it learned as dream entries, updates an outdated note, journals both, and reports it", async () => {
    ensureWorkspace(BOT.id);
    writeMemoryFile(BOT.id, "# Memory\n\n- 2026-09-01 · The person lives in Pune\n");
    answers.push(JSON.stringify({
      learned: [
        { text: "The person wants drafts under 100 words", from: [1, 2], confidence: 0.9 },
        { text: "The person reviews drafts with their editor", from: [1, 2], topic: "work", topicAliases: ["editor"], confidence: 0.8 },
        { text: "The person prefers plain words", from: [1, 2], aboutUser: true, confidence: 0.8 },
      ],
      outdated: [{ line: 0, now: "The person lives in Bangalore", from: [2] }],
      ideas: [{ text: "Keep a short-draft checklist as a skill", from: [1, 2] }],
    }));
    const report = await upkeep().dream(BOT.id);
    expect(report).toMatchObject({
      conversations: 2,
      learned: [
        { text: "The person wants drafts under 100 words", where: "MEMORY.md" },
        { text: "The person prefers plain words", where: "MEMORY.md" },
        { text: "The person reviews drafts with their editor", where: "memory/work.md" },
      ],
      outdated: [{ was: "The person lives in Pune", now: "The person lives in Bangalore" }],
      ideas: ["Keep a short-draft checklist as a skill"],
      aboutMe: 1,
    });
    expect(memory()).toContain("~~The person lives in Pune~~ · superseded 2026-10-22");
    expect(memory()).toContain("- 2026-10-22 · from dream across 2 chats · The person lives in Bangalore");
    expect(memory()).toContain("- 2026-10-22 · from dream across 2 chats · The person wants drafts under 100 words");
    expect(readMemoryTopic(BOT.id, "work.md")).toContain("The person reviews drafts with their editor");
    expect(aboutMeAdded).toEqual(["The person prefers plain words"]);
    await flushMemoryJournal(BOT.id);
    const rows = readMemoryJournal(BOT.id, 10).filter((row) => row.via === "dream");
    expect(rows.map((row) => row.path)).toEqual(expect.arrayContaining(["MEMORY.md", "memory/work.md"]));
    expect(rows.every((row) => row.actor === "upkeep")).toBe(true);
    expect(upkeep().status(BOT.id)).toMatchObject({ lastDream: { conversations: 2 } });
  });

  it("the next dream reads only the chats after the last one that answered", async () => {
    answers.push("{}");
    await upkeep().dream(BOT.id);
    clock = new Date(2026, 9, 23, 10, 0);
    await upkeep().dream(BOT.id);
    expect(sinces).toEqual([new Date(2026, 9, 15, 10, 0).getTime(), new Date(2026, 9, 22, 10, 0).getTime()]);
  });

  it("leaves outdated notes alone when the notes changed during the call", async () => {
    ensureWorkspace(BOT.id);
    writeMemoryFile(BOT.id, "# Memory\n\n- 2026-09-01 · The person lives in Pune\n");
    engine = {
      generateText: async (prompt) => {
        if (!prompt.includes(DREAM_MARKER)) return "{}";
        writeMemoryFile(BOT.id, "# Memory\n\n- 2026-10-22 · The person has a cat\n- 2026-09-01 · The person lives in Pune\n");
        return JSON.stringify({ outdated: [{ line: 0, now: "The person lives in Bangalore", from: [2] }] });
      },
    };
    const report = await upkeep().dream(BOT.id);
    expect(report.outdated).toEqual([]);
    expect(report.note).toContain("changed during the dream");
    expect(memory()).not.toContain("~~");
  });

  it("does not call the model without two chats, with upkeep off, or without an engine that can", async () => {
    chats = chats.slice(0, 1);
    expect((await upkeep().dream(BOT.id)).note).toContain("at least 2 chats");
    chats = [...chats, { threadId: "b", lines: [{ by: "person", text: "hi" }] }];
    BOT.memoryUpkeep = false;
    expect((await upkeep().dream(BOT.id)).note).toContain("off or paused");
    BOT.memoryUpkeep = true;
    expect((await upkeep(false).dream(BOT.id)).note).toContain("not available");
    engine = {};
    expect((await upkeep().dream(BOT.id)).note).toBe(NO_DREAM_ENGINE);
    expect(prompts).toEqual([]);
  });

  it("a failure deciding whether a bot is due is logged for that bot and never stops the loop", async () => {
    const logged: string[] = [];
    const loop = createMemoryUpkeep({
      bots: () => [BOT],
      bot: (id) => (id === BOT.id ? BOT : undefined),
      engine: () => engine,
      busy: () => false,
      addToAboutMe: () => 0,
      sourceLabel: () => "chat",
      conversations: () => { throw new Error("store unavailable"); },
      quietMs: () => 60_000,
      tidyHour: () => 3,
      dreamer: () => BOT.id,
      now: () => clock,
      log: (line) => logged.push(line),
    });
    await expect(loop.tick()).resolves.toBeUndefined();
    expect(logged.some((line) => line.includes("dream failed") && line.includes("store unavailable"))).toBe(true);
  });

  it("dreams on its own once a night, only as the dreamer, after the tidy hour and while the bot is free", async () => {
    const loop = upkeep();
    await loop.tick();
    expect(prompts).toHaveLength(0);
    dreamer = "someone-else";
    await loop.tick();
    expect(prompts).toHaveLength(0);
    dreamer = BOT.id;
    clock = new Date(2026, 9, 22, 2, 0);
    await loop.tick();
    expect(prompts).toHaveLength(0);
    clock = new Date(2026, 9, 22, 4, 0);
    busy = true;
    await loop.tick();
    expect(prompts).toHaveLength(0);
    busy = false;
    await loop.tick();
    expect(prompts).toHaveLength(1);
    clock = new Date(2026, 9, 22, 23, 0);
    await loop.tick();
    expect(prompts).toHaveLength(1);
    clock = new Date(2026, 9, 23, 4, 0);
    chats = chats.slice(0, 1);
    await loop.tick();
    expect(prompts).toHaveLength(1);
  });

  it("offers the last dream's ideas for a day, then drops them", async () => {
    answers.push(JSON.stringify({ ideas: [{ text: "Make the Friday report a routine", from: [1, 2] }] }));
    const loop = upkeep();
    expect(loop.ideas(BOT.id)).toEqual({ ideas: [], conversations: 0 });
    await loop.dream(BOT.id);
    expect(loop.ideas(BOT.id)).toEqual({ ideas: ["Make the Friday report a routine"], conversations: 2 });
    clock = new Date(clock.getTime() + 25 * 60 * 60_000);
    expect(loop.ideas(BOT.id)).toEqual({ ideas: [], conversations: 0 });
  });
});
