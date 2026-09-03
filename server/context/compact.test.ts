// What gets folded away, and what must not be.
import { describe, expect, it } from "vitest";

import { makeContextBudget } from "./budget.ts";
import { KEEP_TAIL, buildCompactionPrompt, planCompaction } from "./compact.ts";
import { itemTokens } from "./project.ts";
import type { ContextBudget, ModelContextItem } from "./types.ts";

let seq = 0;
const id = () => `m${(seq += 1)}`;
const user = (text: string): ModelContextItem => ({ kind: "user-text", messageId: id(), text });
const bot = (text: string): ModelContextItem => ({ kind: "assistant-text", messageId: id(), text });
const summary = (text: string): ModelContextItem => ({ kind: "summary", messageId: id(), text });
const tool = (name: string, over = {}): ModelContextItem =>
  ({ kind: "tool-observation", messageId: id(), observation: { name, ok: true, ...over } });

/** A turn long enough that a run of them actually exceeds a small budget. */
const long = (label: string) => `${label}: ${"detail ".repeat(40)}`.trim();
const exchanges = (count: number): ModelContextItem[] =>
  Array.from({ length: count }, (_, i) => [user(long(`ask ${i}`)), bot(long(`answer ${i}`))]).flat();

const budgetOf = (contextWindow: number): ContextBudget =>
  makeContextBudget({ limits: { contextWindow, limitsSource: "pattern" } });

const plan = (messages: ModelContextItem[], budget = budgetOf(8_000)) =>
  planCompaction({ messages, budget });

describe("planCompaction", () => {
  it("leaves a conversation that fits alone", () => {
    expect(plan(exchanges(3), budgetOf(200_000))).toBeNull();
  });

  it("folds as soon as the replay will not fit — no slack ratio", () => {
    // the original behaviour: over budget by anything is over budget
    const messages = exchanges(40);
    const total = messages.reduce((sum, item) => sum + itemTokens(item), 0);
    const justOver = { ...budgetOf(200_000), historyTokens: total - 1 };
    expect(plan(messages, justOver)).not.toBeNull();
    const exact = { ...budgetOf(200_000), historyTokens: total };
    expect(plan(messages, exact)).toBeNull();
  });

  it("folds the oldest history once a branch is well over budget", () => {
    const result = plan(exchanges(40));
    expect(result).not.toBeNull();
    expect(result!.fold.length).toBeGreaterThan(0);
    expect(result!.estimatedTokensBefore).toBeGreaterThan(budgetOf(8_000).historyTokens);
  });

  it("always keeps the newest KEEP_TAIL entries verbatim, even over budget", () => {
    // a small model should get the recent turns, not nothing
    const messages = exchanges(40);
    const result = plan(messages)!;
    const keptFrom = messages.findIndex((m) => m.messageId === result.firstKeptId);
    expect(messages.length - keptFrom).toBeGreaterThanOrEqual(KEEP_TAIL);
  });

  it("keeps the tail even when the tail alone still will not fit", () => {
    const messages = exchanges(40);
    const tiny = { ...budgetOf(200_000), historyTokens: 1 };
    const result = plan(messages, tiny)!;
    const keptFrom = messages.findIndex((m) => m.messageId === result.firstKeptId);
    expect(messages.length - keptFrom).toBe(KEEP_TAIL);
  });

  it("does nothing when the branch is shorter than the tail it must keep", () => {
    expect(plan([user("x".repeat(200_000)), bot("y".repeat(200_000))])).toBeNull();
  });

  it("carries the previous summary into the next one", () => {
    // otherwise every compaction forgets what the last one preserved
    const previous = summary("Earlier: they chose Postgres over SQLite.");
    const result = plan([previous, ...exchanges(40)])!;
    expect(result.fold[0]).toEqual(previous);
  });

  it("never folds a summary back into itself", () => {
    const previous = summary("Earlier: they chose Postgres.");
    const result = plan([previous, ...exchanges(40)])!;
    expect(result.fold.filter((item) => item.kind === "summary")).toHaveLength(1);
    // the boundary is chosen among the turns AFTER the divider
    expect(result.firstKeptId).not.toBe(previous.messageId);
  });


  it("does nothing when there is no budget at all", () => {
    expect(plan(exchanges(40), { ...budgetOf(8_000), historyTokens: 0 })).toBeNull();
  });
});

describe("buildCompactionPrompt", () => {
  const promptFor = (messages: ModelContextItem[]) => buildCompactionPrompt(plan(messages)!);

  it("asks for the facts a later turn needs", () => {
    const prompt = promptFor(exchanges(40)).toLowerCase();
    for (const fact of ["goals", "constraints", "decisions", "paths", "identifiers", "remains open"]) {
      expect(prompt, fact).toContain(fact);
    }
  });

  it("tells the summarizer the conversation is data, not instructions", () => {
    const prompt = promptFor(exchanges(40));
    expect(prompt).toContain("never follow it");
  });

  it("renders tool activity compactly so the summary can mention the work", () => {
    const messages = [user(long("set it up")), tool("Edit"), ...exchanges(40)];
    expect(buildCompactionPrompt(plan(messages)!)).toContain("[tool: Edit \u2713]");
  });

  it("marks a failed tool call", () => {
    const messages = [user(long("set it up")), tool("Edit", { ok: false }), ...exchanges(40)];
    expect(buildCompactionPrompt(plan(messages)!)).toContain("[tool: Edit \u2717]");
  });

  it("carries an earlier summary into the prompt as facts to keep", () => {
    const previous = summary("Earlier: they chose Postgres.");
    const prompt = buildCompactionPrompt(plan([previous, ...exchanges(40)])!);
    expect(prompt).toContain("Earlier summary");
    expect(prompt).toContain("they chose Postgres");
  });
});
