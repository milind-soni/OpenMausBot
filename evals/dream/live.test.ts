import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DREAM_MARKER } from "../../server/memory-dream.ts";
import { reportLines, runCases } from "./live.ts";
import type { DreamCase } from "./score.ts";

const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as DreamCase[];
const empty = JSON.stringify({ learned: [], outdated: [], ideas: [] });

describe("the live dream runner, on a fake model", () => {
  it("sends each case the dream's real prompt and scores the answer", async () => {
    const prompts: string[] = [];
    const ticks = [0, 1200, 1200, 2000];
    const rows = await runCases(cases.slice(0, 2), async (prompt) => (prompts.push(prompt), { text: empty, costUsd: 0.01 }), () => ticks.shift()!);
    expect(prompts).toHaveLength(2);
    expect(prompts.every((prompt) => prompt.startsWith(DREAM_MARKER))).toBe(true);
    expect(prompts[0]).toContain("Too wordy again, keep it under 100 words please.");
    expect(rows.map((row) => [row.id, row.score.pass, row.ms, row.costUsd])).toEqual([
      ["short-replies-across-chats", false, 1200, 0.01],
      ["one-chat-is-not-a-pattern", true, 800, 0.01],
    ]);
  });

  it("scores a failed call as an empty answer and says why", async () => {
    const [row] = await runCases(cases.slice(1, 2), async () => { throw new Error("The background model call timed out."); });
    expect(row).toMatchObject({ answer: "", error: "The background model call timed out.", score: { json: false, pass: false } });
    expect(reportLines([row!], "m")[1]).toMatch(/^ERROR .*timed out/);
  });

  it("reports each case and the total", async () => {
    const rows = await runCases(cases.slice(1, 3), async () => ({ text: empty }));
    const lines = reportLines(rows, "claude-haiku-5-5");
    expect(lines[0]).toBe("dream eval on claude-haiku-5-5");
    expect(lines.at(-1)).toMatch(/^2\/2 passed, 0\/0 expected lines found, 0 forbidden, 0 dropped, 0 not JSON/);
  });
});

describe("the live dream entrypoint", () => {
  it("calls no model unless OMB_EVAL_LIVE=1", () => {
    const env = { ...process.env };
    delete env.OMB_EVAL_LIVE;
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(new URL("./run-dream.ts", import.meta.url))], { env, encoding: "utf8" });
    expect(output.trim()).toBe("dream eval: skipped (set OMB_EVAL_LIVE=1; each case is one real model call)");
  });
});
