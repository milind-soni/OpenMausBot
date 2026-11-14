import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { rolloutMark, unsupportedCallsIn, unsupportedCallsNotice, unsupportedCallsSince } from "./codex-unsupported-calls.ts";

const item = (payload: unknown) => `${JSON.stringify({ timestamp: "2026-10-26T02:17:00.000Z", type: "response_item", payload })}\n`;
// What a provider that drops `namespace` makes codex write: the bare-named call, then codex's own refusal.
const refused = (tool: string, callId = `call_${tool}`) =>
  item({ type: "function_call", name: tool, arguments: "{}", call_id: callId }) +
  item({ type: "function_call_output", call_id: callId, output: `unsupported call: ${tool}` });

describe("unsupportedCallsIn", () => {
  it("finds a namespace-less MCP call codex refused, once per tool", () => {
    const text = refused("retry_thread") + refused("retry_thread", "call_2") + refused("coordinate_bots");
    expect(unsupportedCallsIn(text)).toEqual(["retry_thread", "coordinate_bots"]);
  });

  it("reads codex's content-item output form too", () => {
    expect(unsupportedCallsIn(item({ type: "function_call_output", call_id: "c", output: [{ type: "input_text", text: "unsupported call: session_search" }] })))
      .toEqual(["session_search"]);
  });

  it("ignores a tool's own output, a message quoting the words, and a torn line", () => {
    const text = item({ type: "function_call_output", call_id: "c", output: "the API said: unsupported call: nope" }) +
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "unsupported call: retry_thread" }] }) +
      "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"output\":\"unsupported call: half";
    expect(unsupportedCallsIn(text)).toEqual([]);
  });
});

describe("unsupportedCallsSince", () => {
  const scratch = () => mkdtempSync(join(tmpdir(), "omb-rollout-"));

  it("reads only what the turn appended", () => {
    const path = join(scratch(), "rollout.jsonl");
    writeFileSync(path, refused("coordinate_bots"));
    const mark = rolloutMark(path);
    appendFileSync(path, refused("retry_thread"));
    expect(unsupportedCallsSince(mark)).toEqual(["retry_thread"]);
  });

  it("reads a rollout that was replaced from its top, and gives up quietly on a missing one", () => {
    const path = join(scratch(), "rollout.jsonl");
    writeFileSync(path, refused("coordinate_bots") + refused("browser_open"));
    const mark = rolloutMark(path);
    writeFileSync(path, refused("retry_thread"));
    expect(unsupportedCallsSince(mark)).toEqual(["retry_thread"]);
    expect(rolloutMark(join(scratch(), "missing.jsonl"))).toBeNull();
    expect(rolloutMark(null)).toBeNull();
    expect(unsupportedCallsSince({ path: join(scratch(), "missing.jsonl"), offset: 0 })).toEqual([]);
  });

  it("stops at its byte cap", () => {
    const path = join(scratch(), "rollout.jsonl");
    writeFileSync(path, "");
    const mark = rolloutMark(path);
    appendFileSync(path, refused("retry_thread") + refused("coordinate_bots"));
    expect(unsupportedCallsSince(mark, refused("retry_thread").length)).toEqual(["retry_thread"]);
  });
});

it("names the refused tools and what to do", () => {
  expect(unsupportedCallsNotice(["retry_thread"])).toMatch(/^Codex could not run the tool retry_thread \("unsupported call"\)/);
  expect(unsupportedCallsNotice(["a", "b", "c", "d", "e", "f", "g", "h"])).toContain("a, b, c, d, e, f and 2 more");
});
