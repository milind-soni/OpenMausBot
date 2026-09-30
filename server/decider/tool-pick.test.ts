import { describe, expect, it, vi } from "vitest";

import type { Decider } from "./index.ts";
import { TOOL_PICK } from "./jobs.ts";
import { RELAY_MAX_STATE_BYTES, relayAccepts } from "./relay.ts";
import { TOOL_PICK_KEEP_TOP, decideToolPick, toolPickRequest, type PickableTool } from "./tool-pick.ts";
import type { DeciderResult, YesNoAnswer } from "./types.ts";

type Ask = Decider["ask"];

const tools = (count: number, description = (i: number) => `Tool number ${i} for a connected app.`): PickableTool[] =>
  Array.from({ length: count }, (_, i) => ({ name: `app_tool_${i}`, description: description(i) }));

/** A decider that says yes with `p(i)` for the tool at index i. */
function answering(p: (index: number) => number) {
  const ask = vi.fn(async (_seam: string, state: { tools: string[] }) => ({
    ok: true,
    provider: "jev",
    latencyMs: 300,
    answers: Object.fromEntries(state.tools.map((_, i) => [`t${i}`, { type: "yesno", p: p(i) }])),
  })) as unknown as Ask & ReturnType<typeof vi.fn>;
  return { ask };
}

const failing = (result: DeciderResult<Record<string, YesNoAnswer>>) =>
  ({ ask: vi.fn(async () => result) as unknown as Ask & ReturnType<typeof vi.fn> });

describe("tool pick request", () => {
  it("one yes/no per tool, in order, with the contract's exact questions", () => {
    const { state, questions } = toolPickRequest("Send the invoice to Priya", tools(3));
    expect(state).toEqual({
      message: "Send the invoice to Priya",
      tools: ["app_tool_0: Tool number 0 for a connected app.", "app_tool_1: Tool number 1 for a connected app.", "app_tool_2: Tool number 2 for a connected app."],
    });
    expect(Object.keys(questions)).toEqual(["t0", "t1", "t2"]);
    expect(questions.t1).toEqual({ type: "yesno", instructions: TOOL_PICK.instructionsFor(1) });
    expect(relayAccepts("toolPick", state, questions)).toBe(true);
  });

  it("clips each entry and the message, and flattens whitespace", () => {
    const { state } = toolPickRequest(`  ${"m".repeat(3_000)}  `, [{ name: "x", description: `line one\nline two ${"d".repeat(400)}` }]);
    expect(state.message.length).toBe(1_500);
    expect(state.tools[0]!.length).toBe(200);
    expect(state.tools[0]!.startsWith("x: line one line two")).toBe(true);
  });

  it("asks about at most the contract's 120 tools", () => {
    const { state, questions } = toolPickRequest("hi", tools(128));
    expect(state.tools).toHaveLength(TOOL_PICK.maxItems);
    expect(Object.keys(questions)).toHaveLength(TOOL_PICK.maxItems);
  });

  it("a worst case (120 long non-ASCII descriptions, long message) still fits Cloud Pro's relay", () => {
    const long = tools(128, (i) => `${"Envoie un e-mail récapitulatif à l’équipe — 送信する ".repeat(20)} ${i}`);
    const { state, questions } = toolPickRequest("請把本週的銷售報告整理成表格並寄給團隊 ".repeat(200), long);
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThanOrEqual(RELAY_MAX_STATE_BYTES);
    expect(relayAccepts("toolPick", state, questions)).toBe(true);
  });
});

describe("decideToolPick", () => {
  it("does not ask with 20 tools or fewer", async () => {
    const decider = answering(() => 0);
    await expect(decideToolPick(decider, { message: "hi", tools: tools(20) })).resolves.toEqual({ kind: "fallback", reason: "too_few" });
    expect(decider.ask).not.toHaveBeenCalled();
  });

  it("keeps tools at p >= 0.2 and always the top five", async () => {
    // tool 3 is likely; everything else is unlikely, with 7..10 the next best
    const p = (i: number) => (i === 3 ? 0.9 : i === 21 ? 0.2 : i >= 7 && i <= 10 ? 0.1 : 0.01);
    const decider = answering(p);
    const pick = await decideToolPick(decider, { message: "Email Priya", tools: tools(25) });
    expect(pick.kind).toBe("keep");
    const names = pick.kind === "keep" ? [...pick.names].sort() : [];
    // top five: 3 and 21, then 7, 8 and 9 (ties keep list order, so not 10)
    expect(names).toEqual(["app_tool_21", "app_tool_3", "app_tool_7", "app_tool_8", "app_tool_9"].sort());
    expect(decider.ask).toHaveBeenCalledWith("toolPick", expect.any(Object), expect.any(Object), expect.objectContaining({ timeoutMs: TOOL_PICK.timeoutMs }));
  });

  it("a flat answer keeps the first five, never nothing", async () => {
    const pick = await decideToolPick(answering(() => 0), { message: "hi", tools: tools(30) });
    expect(pick.kind === "keep" && [...pick.names]).toEqual(tools(TOOL_PICK_KEEP_TOP).map((tool) => tool.name));
  });

  it("past 120, the first 120 are asked about and the rest are kept untouched", async () => {
    const decider = answering(() => 0);
    const pick = await decideToolPick(decider, { message: "hi", tools: tools(125) });
    expect(pick.kind === "keep" && pick.asked).toBe(120);
    const names = pick.kind === "keep" ? pick.names : new Set();
    for (const index of [120, 121, 122, 123, 124]) expect(names.has(`app_tool_${index}`)).toBe(true);
    expect(names.size).toBe(TOOL_PICK_KEEP_TOP + 5);
  });

  it("any failure keeps every tool", async () => {
    for (const reason of ["timeout", "overloaded", "disabled", "job_off", "misconfigured"] as const) {
      await expect(decideToolPick(failing({ ok: false, reason }), { message: "hi", tools: tools(30) })).resolves.toEqual({ kind: "fallback", reason });
    }
  });

  it("an answer missing an entry, or a decider that throws, keeps every tool", async () => {
    const partial = answering(() => 0.5);
    partial.ask.mockImplementationOnce(async () => ({ ok: true, provider: "jev", latencyMs: 1, answers: { t0: { type: "yesno", p: 0.5 } } }));
    await expect(decideToolPick(partial, { message: "hi", tools: tools(30) })).resolves.toEqual({ kind: "fallback", reason: "malformed" });
    const ask = vi.fn(async () => { throw new Error("boom"); }) as unknown as Ask;
    await expect(decideToolPick({ ask }, { message: "hi", tools: tools(30) })).resolves.toEqual({ kind: "fallback", reason: "malformed" });
  });

  it("passes the turn's Stop signal through", async () => {
    const decider = answering(() => 0.5);
    const controller = new AbortController();
    await decideToolPick(decider, { message: "hi", tools: tools(30) }, { signal: controller.signal });
    expect(decider.ask).toHaveBeenCalledWith("toolPick", expect.any(Object), expect.any(Object), expect.objectContaining({ signal: controller.signal }));
  });
});
