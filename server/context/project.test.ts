import { describe, expect, it } from "vitest";

import type { CompactionRecord, Message } from "../store.ts";
import { makeContextBudget } from "./budget.ts";
import { projectActiveBranch, projectMessage } from "./project.ts";
import type { ContextBudget } from "./types.ts";

let seq = 0;
const make = (over: Partial<Message> & Pick<Message, "role" | "kind">): Message => ({
  id: `m${(seq += 1)}`,
  at: seq,
  ...over,
});
const user = (text: string, over: Partial<Message> = {}) => make({ role: "user", kind: "text", text, ...over });
const bot = (text: string, over: Partial<Message> = {}) => make({ role: "bot", kind: "text", text, ...over });
const tool = (name: string, over: Partial<Message["tool"]> = {}) =>
  make({ role: "bot", kind: "activity", tool: { name, ok: true, ...over } });

/** ~200 characters, about the length of a real chat turn. Three-word
 * fixtures are dominated by per-item framing and fit anywhere, which makes
 * a budget test pass without exercising the budget. */
const realistic = (label: string) => `${label}: ${"detail ".repeat(28)}`.trim();

const budgetOf = (contextWindow: number): ContextBudget =>
  makeContextBudget({ limits: { contextWindow, limitsSource: "pattern" } });

const project = (messages: Message[], budget = budgetOf(200_000), over: Partial<Parameters<typeof projectActiveBranch>[0]> = {}) =>
  projectActiveBranch({
    activeMessages: messages,
    allMessages: messages,
    excludeMessageIds: [],
    userName: "Omkar",
    budget,
    ...over,
  });

describe("projectMessage", () => {
  const noQuotes = new Map<string, Message>();

  it("keeps user and assistant text", () => {
    expect(projectMessage(user("hello"), noQuotes, "Omkar")).toMatchObject({ kind: "user-text", text: "hello" });
    expect(projectMessage(bot("hi"), noQuotes, "Omkar")).toMatchObject({ kind: "assistant-text", text: "hi" });
  });

  it("attributes a room speaker instead of flattening every bot into one voice", () => {
    const message = bot("on it", { from: { botId: "b1", name: "Wren", color: "#fff" } });
    expect(projectMessage(message, noQuotes, "Omkar")).toMatchObject({ kind: "assistant-text", speaker: "Wren" });
  });

  it("carries a tool observation, which the old transcript dropped entirely", () => {
    const item = projectMessage(tool("tool: Read"), noQuotes, "Omkar");
    expect(item).toMatchObject({ kind: "tool-observation", observation: { name: "tool: Read", ok: true } });
  });

  it("prefers the bounded snapshot when the driver recorded one", () => {
    const message = tool("tool: Edit", { context: { name: "Edit", outputSummary: "1 file changed", filesModified: ["a.ts"] } });
    expect(projectMessage(message, noQuotes, "Omkar")).toMatchObject({
      kind: "tool-observation",
      observation: { name: "Edit", outputSummary: "1 file changed" },
    });
  });

  it("drops an error chip — it is a failed turn, not work the model did", () => {
    expect(projectMessage(tool("error: engine crashed"), noQuotes, "Omkar")).toBeNull();
  });

  it("drops UI receipts and never inlines screen bytes", () => {
    for (const kind of ["options", "screen", "connector", "secret", "routine.run", "goal.run"] as const) {
      expect(projectMessage(make({ role: "bot", kind, png: "AAAA", text: "x" }), noQuotes, "Omkar")).toBeNull();
    }
  });

  it("drops empty text rather than sending a blank turn", () => {
    expect(projectMessage(user("   "), noQuotes, "Omkar")).toBeNull();
  });

  it("renders a compaction record as a summary item", () => {
    const compaction: CompactionRecord = {
      schemaVersion: 1,
      summary: "They are deploying to Vercel.",
      firstKeptId: "m1",
      throughId: "m0",
      sourceDigest: "d",
      estimatedTokensBefore: 1,
      targetContextWindow: 8_000,
      createdByInstanceId: "claude",
    };
    expect(projectMessage(make({ role: "bot", kind: "compaction", compaction }), noQuotes, "Omkar"))
      .toMatchObject({ kind: "summary", text: "They are deploying to Vercel." });
  });

  it("keeps a flat reply's quote, resolved across a fork", () => {
    const target = bot("the deploy finished at 14:02");
    const reply = user("which region?", { replyToId: target.id });
    const item = projectMessage(reply, new Map([[target.id, target]]), "Omkar");
    expect(item?.kind).toBe("user-text");
    expect((item as { text: string }).text).toContain("the deploy finished at 14:02");
    expect((item as { text: string }).text).toContain("which region?");
  });
});

describe("projectActiveBranch", () => {
  it("keeps conversation order and excludes withheld ids", () => {
    const current = user("the message being sent now");
    const out = project([user("one"), bot("two"), current], budgetOf(200_000), { excludeMessageIds: [current.id] });
    expect(out.messages.map((m) => (m as { text: string }).text)).toEqual(["one", "two"]);
  });

  it("has no fixed message count — a big window keeps far more than 40 turns", () => {
    // the behaviour the old `.slice(-40)` made impossible
    const many = Array.from({ length: 300 }, (_, i) =>
      i % 2 === 0 ? user(realistic(`turn ${i}`)) : bot(realistic(`turn ${i}`)));
    const out = project(many);
    expect(out.messages.length).toBeGreaterThan(40);
    expect(out.messages).toHaveLength(300);
    expect(out.clipped).toBe(false);
  });

  it("gives an 8k model less verbatim history than a 200k model, from the same branch", () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      i % 2 === 0 ? user(realistic(`turn ${i}`)) : bot(realistic(`turn ${i}`)));
    const small = project(many, budgetOf(8_000));
    const large = project(many, budgetOf(200_000));
    expect(small.messages.length).toBeLessThan(large.messages.length);
    expect(small.clipped).toBe(true);
    expect(small.estimatedTokens).toBeLessThanOrEqual(budgetOf(8_000).historyTokens);
  });

  it("drops the OLDEST turns, so the message being answered always survives", () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      i % 2 === 0 ? user(realistic(`turn ${i}`)) : bot(realistic(`turn ${i}`)));
    const out = project(many, budgetOf(8_000));
    const texts = out.messages.map((m) => (m as { text: string }).text);
    expect(texts.at(-1)).toBe(realistic("turn 299"));
    expect(texts).not.toContain(realistic("turn 0"));
  });

  it("keeps recent intent even when one huge turn cannot fit", () => {
    const out = project([user("x".repeat(200_000)), user("the thing I actually asked")], budgetOf(8_000));
    const texts = out.messages.map((m) => (m as { text: string }).text);
    expect(texts).toContain("the thing I actually asked");
    expect(out.clipped).toBe(true);
  });

  it("stops at the newest compaction divider — the summary already covers what is above", () => {
    const compaction: CompactionRecord = {
      schemaVersion: 1,
      summary: "Earlier: they chose Postgres over SQLite.",
      firstKeptId: "x",
      throughId: "y",
      sourceDigest: "d",
      estimatedTokensBefore: 9_000,
      targetContextWindow: 8_000,
      createdByInstanceId: "claude",
    };
    const out = project([
      user("ancient history"),
      bot("older still"),
      make({ role: "bot", kind: "compaction", compaction }),
      user("recent question"),
    ]);
    const texts = out.messages.map((m) => (m as { text: string }).text);
    expect(texts).toContain("Earlier: they chose Postgres over SQLite.");
    expect(texts).toContain("recent question");
    expect(texts).not.toContain("ancient history");
    expect(out.compacted).toBe(true);
  });

  it("never drops the summary itself to make room", () => {
    const compaction: CompactionRecord = {
      schemaVersion: 1,
      summary: "S".repeat(4_000),
      firstKeptId: "x",
      throughId: "y",
      sourceDigest: "d",
      estimatedTokensBefore: 1,
      targetContextWindow: 8_000,
      createdByInstanceId: "claude",
    };
    const out = project(
      [make({ role: "bot", kind: "compaction", compaction }), ...Array.from({ length: 50 }, (_, i) => user(`t${i}`))],
      budgetOf(8_000),
    );
    expect(out.messages.some((m) => m.kind === "summary")).toBe(true);
  });

  it("never splits an assistant action from the observation of what it did", () => {
    const out = project([user("read it"), tool("tool: Read"), bot("done")], budgetOf(200_000));
    expect(out.messages.map((m) => m.kind)).toEqual(["user-text", "tool-observation", "assistant-text"]);
  });

  it("counts what it sent and reports it", () => {
    const out = project([user("one"), bot("two")]);
    expect(out.sourceItems).toBe(2);
    expect(out.estimatedTokens).toBeGreaterThan(0);
  });

  it("survives a branch with nothing projectable on it", () => {
    const out = project([make({ role: "bot", kind: "screen", png: "AAAA" })]);
    expect(out).toMatchObject({ messages: [], sourceItems: 0, clipped: false, compacted: false });
  });
});
