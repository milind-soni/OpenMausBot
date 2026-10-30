import { describe, expect, it } from "vitest";

import { acpToolOutput, acpToolProgress, claudeToolDraft, codexCommandOutput, codexPatchProgress } from "./tool-progress.ts";

/** Claude Code's stream-json frames (2.1.306, --include-partial-messages) for one model message, as the CLI prints
 * them: `{type: "stream_event", event}` around the API's own streaming events. */
function claudeMessage(blocks: Array<{ id: string; name: string; json: string[] } | { text: string }>): unknown[] {
  const frames: unknown[] = [{ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 3, output_tokens: 1 } } }];
  blocks.forEach((block, index) => {
    if ("text" in block) {
      frames.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      frames.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else {
      frames.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      for (const partial_json of block.json) frames.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } });
    }
    frames.push({ type: "content_block_stop", index });
  });
  frames.push({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 900 } });
  frames.push({ type: "message_stop" });
  return frames;
}

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out;
}

describe("Claude: a tool call's input as it streams", () => {
  it("reports a long Write as a growing file, named once its path has streamed", () => {
    const content = "<div class=\"card\">sales</div>\n".repeat(500);
    const json = JSON.stringify({ file_path: "/Users/me/dash/index.html", content });
    const session = {};
    const reports = claudeMessage([
      { text: "I'll build the dashboard now." },
      { id: "toolu_write", name: "Write", json: chunks(json, 37) },
    ]).map((event) => claudeToolDraft(session, event)).filter((report) => report !== null);

    expect(reports[0]).toEqual({ type: "turn.progress", activity: "write", itemId: "toolu_write", bytes: 0 });
    expect(reports.every((report) => report.activity === "write" && report.itemId === "toolu_write")).toBe(true);
    const named = reports.findIndex((report) => report.file === "index.html");
    expect(named, "the file is named as soon as file_path has streamed").toBeGreaterThan(0);
    expect(named).toBeLessThan(4);
    expect(reports.slice(named).every((report) => report.file === "index.html")).toBe(true);
    const sizes = reports.map((report) => report.bytes ?? 0);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(reports.at(-1)!.bytes).toBe(Buffer.byteLength(json));
    // A path never travels whole: only its last part.
    expect(JSON.stringify(reports)).not.toContain("/Users/me");
  });

  it("reports a silent tool's call as soon as it opens, before the tool runs", () => {
    const session = {};
    const reports = claudeMessage([{ id: "toolu_bash", name: "Bash", json: ["{\"command\": \"sle", "ep 300\"}"] }])
      .map((event) => claudeToolDraft(session, event)).filter((report) => report !== null);
    expect(reports[0]).toEqual({ type: "turn.progress", activity: "command", itemId: "toolu_bash", bytes: 0 });
    expect(reports.every((report) => report.activity === "command" && !report.file)).toBe(true);
  });

  it("names any other tool by its own name and ignores text and thinking blocks", () => {
    const session = {};
    const [report] = claudeMessage([{ id: "toolu_pub", name: "mcp__agents__publish_page", json: ["{}"] }])
      .map((event) => claudeToolDraft(session, event)).filter((value) => value !== null);
    expect(report).toMatchObject({ activity: "tool", tool: "mcp__agents__publish_page" });
    expect(claudeToolDraft(session, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })).toBeNull();
    expect(claudeToolDraft(session, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } })).toBeNull();
  });

  it("starts over with each message, and keeps sessions apart", () => {
    const one = {}, two = {};
    claudeToolDraft(one, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "a", name: "Write" } });
    expect(claudeToolDraft(two, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } })).toBeNull();
    claudeToolDraft(one, { type: "message_start", message: {} });
    expect(claudeToolDraft(one, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } })).toBeNull();
  });
});

describe("Codex: an apply_patch as it streams (item/fileChange/patchUpdated, app-server 0.160)", () => {
  it("reports a new file as a write and a change as an edit, with the patch's size", () => {
    const add = codexPatchProgress({ threadId: "t", turnId: "u", itemId: "call_1", changes: [{ path: "/repo/web/index.html", kind: { type: "add" }, diff: "x".repeat(3000) }] });
    expect(add).toEqual({ type: "turn.progress", activity: "write", file: "index.html", bytes: 3000, itemId: "call_1" });
    const edit = codexPatchProgress({ itemId: "call_2", changes: [
      { path: "src/app.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@" },
      { path: "src/new.ts", kind: { type: "add" }, diff: "+x" },
    ] });
    expect(edit).toMatchObject({ activity: "edit", file: "app.ts", bytes: 13 });
    expect(codexPatchProgress({ itemId: "call_3", changes: [] })).toBeNull();
  });
});

describe("ACP: a tool call still running", () => {
  it("reads the call's kind, its file and its diff so far", () => {
    expect(acpToolProgress({
      sessionUpdate: "tool_call", toolCallId: "w1", title: "WriteFile", kind: "edit", status: "pending",
      locations: [{ path: "/work/index.html" }], content: [{ type: "diff", path: "/work/index.html", oldText: null, newText: "y".repeat(2048) }],
    })).toEqual({ type: "turn.progress", activity: "write", bytes: 2048, file: "index.html", itemId: "w1" });
    expect(acpToolProgress({ sessionUpdate: "tool_call", toolCallId: "c1", title: "npm test", kind: "execute", status: "in_progress" }))
      .toEqual({ type: "turn.progress", activity: "command", itemId: "c1" });
    expect(acpToolProgress({ sessionUpdate: "tool_call_update", toolCallId: "e1", status: "in_progress",
      content: [{ type: "diff", path: "a.ts", oldText: "old", newText: "new" }] })).toMatchObject({ activity: "edit", file: "a.ts", bytes: 3 });
  });

  it("says nothing for a finished call, a bare update or a thought", () => {
    expect(acpToolProgress({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", kind: "execute" })).toBeNull();
    expect(acpToolProgress({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" })).toBeNull();
    expect(acpToolProgress({ sessionUpdate: "tool_call", toolCallId: "t1", kind: "think" })).toBeNull();
    expect(acpToolProgress({ sessionUpdate: "agent_message_chunk", content: { text: "hi" } })).toBeNull();
  });
});

describe("a running command's output, as engines stream it", () => {
  it("Codex: item/commandExecution/outputDelta is the next chunk to append", () => {
    expect(codexCommandOutput({ threadId: "t", turnId: "u", itemId: "call_1", delta: "page 3 of 40\n" }))
      .toEqual({ type: "item.output", itemType: "tool", itemId: "call_1", text: "page 3 of 40\n" });
    expect(codexCommandOutput({ itemId: "call_1", delta: "" })).toBeNull();
    expect(codexCommandOutput({ delta: "orphan" })).toBeNull();
  });

  it("ACP: a running call's text content is all of its output so far, replaced on each update", () => {
    expect(acpToolOutput({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "Collecting 12 items" } }, { type: "diff", path: "a.ts", newText: "x" }] }))
      .toEqual({ type: "item.output", itemType: "tool", itemId: "c1", text: "Collecting 12 items", whole: true });
    expect(acpToolOutput({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "done" } }] })).toBeNull();
    expect(acpToolOutput({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress", content: [{ type: "terminal", terminalId: "t" }] })).toBeNull();
  });
});
