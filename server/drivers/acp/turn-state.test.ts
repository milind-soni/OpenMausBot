import { describe, expect, it } from "vitest";

import { endTurn, type AcpTurn } from "./turn-state.ts";

const ERROR_BODY = '403 {"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization."}}';

/** A turn whose buffered text is `text`, flushed as core.ts does: a non-blank text becomes a reply. */
function turnWith(
  text: string,
  state: { stopped?: boolean; replied?: string; toolsEnded?: boolean; toolRunning?: boolean; thoughtAfterTools?: boolean; replyAfterTools?: string } = {},
) {
  const replies: string[] = [];
  const current = {
    state: { text: state.replied ?? "", stopped: false, producedItem: false, repliedText: false, toolsSinceShown: false, thoughtSinceTool: false },
    runningTools: new Set<string>(),
    endedToolIds: new Set<string>(),
    flushAssistantText() {
      const said = current.state.text;
      current.state.text = "";
      if (!said.trim()) return;
      current.state.producedItem = true;
      current.state.repliedText = true;
      current.state.toolsSinceShown = false;
      current.state.thoughtSinceTool = false;
      replies.push(said);
    },
  };
  if (state.replied) current.flushAssistantText();
  if (state.toolsEnded) {
    current.state.producedItem = true;
    current.state.toolsSinceShown = true;
    current.state.thoughtSinceTool = false;
    current.endedToolIds.add("acp-tool-1");
  }
  if (state.toolRunning) current.runningTools.add("acp-tool-1");
  if (state.thoughtAfterTools) current.state.thoughtSinceTool = true;
  if (state.replyAfterTools) {
    current.state.text = state.replyAfterTools;
    current.flushAssistantText();
  }
  current.state.text = text;
  current.state.stopped = state.stopped ?? false;
  return { current: current as unknown as AcpTurn, replies };
}

describe("endTurn on a reply that is a provider's error body", () => {
  it("keeps an empty reply's existing notice key and provider", () => {
    const { current } = turnWith("");
    expect(endTurn(current, true, null, "Grok")).toEqual({
      ok: false, stopReason: "empty_turn", error: {
        message: "Grok finished without replying.",
        text: { key: "chat.notice.acpEmpty", params: { provider: "Grok" } },
      },
    });
  });

  it("keeps the semantic reset facts when a provider's error body ends the turn", () => {
    const { current, replies } = turnWith('429 {"error":{"message":"usage limit"}} retry-after-ms=300000');
    expect(endTurn(current, true, null, "Grok")).toMatchObject({
      ok: false, stopReason: "quota", error: {
        text: { key: "chat.notice.usageLimitResets", params: { provider: "Grok", resetsAt: expect.any(Number), timeZone: expect.any(String) } },
        limit: "engine", limitResetsAt: expect.any(Number),
      },
    });
    expect(replies).toEqual([]);
  });

  it("after the person's Stop, ends the turn as stopped and keeps what was said", () => {
    const { current, replies } = turnWith(ERROR_BODY, { stopped: true });
    expect(endTurn(current, true, null, "omp")).toEqual({ ok: true, stopReason: "cancelled" });
    expect(replies).toEqual([ERROR_BODY]);
  });

  it("keeps the body a reply when the turn already replied in words before it", () => {
    const { current, replies } = turnWith(ERROR_BODY, { replied: "Let me check the deploy." });
    expect(endTurn(current, true, null, "omp")).toEqual({ ok: true, stopReason: null });
    expect(replies).toEqual(["Let me check the deploy.", ERROR_BODY]);
  });
});

describe("endTurn on a turn that goes wordless after its tools", () => {
  it("reads as a lost reply when a talking turn reasons after a tool and never speaks again", () => {
    const { current } = turnWith("", { replied: "Working through the folder.", toolsEnded: true, thoughtAfterTools: true });
    expect(endTurn(current, true, null, "Grok")).toEqual({
      ok: false, stopReason: "ended_after_tools", error: {
        message: "Grok thought right past the last tool, then finished the turn without a last reply. Ask it to continue or summarize what it did.",
        text: { key: "chat.notice.acpEndedAfterTools", params: { provider: "Grok" } },
      },
    });
  });

  it("stays a success when a reply follows the reasoning after the tools", () => {
    const { current, replies } = turnWith("", { replied: "Working through the folder.", toolsEnded: true, thoughtAfterTools: true, replyAfterTools: "All six files are copied." });
    expect(endTurn(current, true, null, "Grok")).toEqual({ ok: true, stopReason: null });
    expect(replies).toEqual(["Working through the folder.", "All six files are copied."]);
  });

  it("stays a success when a turn that only runs tools ends without thinking or speaking again", () => {
    const { current } = turnWith("", { toolsEnded: true });
    expect(endTurn(current, true, null, "Grok")).toEqual({ ok: true, stopReason: null });
  });

  it("stays a success when a talking turn ends right on its tools without more words", () => {
    const { current } = turnWith("", { replied: "Working through the folder.", toolsEnded: true });
    expect(endTurn(current, true, null, "Grok")).toEqual({ ok: true, stopReason: null });
  });

  it("keeps buffered text after the tools as the turn's reply", () => {
    const { current, replies } = turnWith("Copied the last file.", { toolsEnded: true, thoughtAfterTools: true });
    expect(endTurn(current, true, null, "Grok")).toEqual({ ok: true, stopReason: null });
    expect(replies).toEqual(["Copied the last file."]);
  });

  it("after the person's Stop, stays a stop even mid-reasoning after a tool", () => {
    const { current } = turnWith("", { replied: "Working through the folder.", toolsEnded: true, thoughtAfterTools: true, stopped: true });
    expect(endTurn(current, true, null, "omp")).toEqual({ ok: true, stopReason: "cancelled" });
  });
});

describe("endTurn on a reply that ends on a raw tool-call fragment", () => {
  it.each([
    ["a stray closing parameter tag", 'Opening src/app.ts now.\n<parameter name="path">src/app.ts\n</parameter>'],
    ["a stray closing invoke tag", "Applying the edit.\n</invoke>"],
    ["an opened tool_call block", "Starting the deploy.\n<tool_call>"],
    ["an unclosed parameter tag", 'Creating the file.\n<parameter name="path"'],
    ["a complete trailing JSON call", 'Checking the port now\n{"command": "lsof -i :3000"}'],
    ["a truncated trailing JSON call", '{"command": "lsof -i :30'],
    ["a JSON string holding braces, cut off", '{"command": "echo \\"}\\"'],
  ])("fails a turn whose reply ends on %s with no tool run", (_name, text) => {
    const { current, replies } = turnWith(text);
    expect(endTurn(current, true, null, "Grok")).toEqual({
      ok: false, stopReason: "tool_call_fragment", error: {
        message: "Grok's reply ended on a tool call it never ran, so the turn was not completed.",
        text: { key: "chat.notice.acpToolCallFragment", params: { provider: "Grok" } },
      },
    });
    expect(replies).toEqual([]);
  });

  it("fails when the fragment follows a reply the turn already sent", () => {
    const { current } = turnWith("</parameter>", { replied: "Opening the file now." });
    expect(endTurn(current, true, null, "Grok")).toMatchObject({ ok: false, stopReason: "tool_call_fragment" });
  });

  it.each([
    ["prose cut off inside a fenced example block", 'Here is the call format I would use:\n```json\n{"command": "ls -la"}\n'],
    ["a complete fenced example", 'Here is the shape:\n```xml\n<tool_call>\n<parameter name="path">src/a.ts</parameter>\n```\n'],
    ["a JSON example in inline code", 'Use {"command": "ls"} as the payload.'],
    ["plain prose", "The build is green and every check passed."],
  ])("stays ok when the reply ends on %s", (_name, text) => {
    const { current, replies } = turnWith(text);
    expect(endTurn(current, true, null, "Grok")).toEqual({ ok: true, stopReason: null });
    expect(replies).toEqual([text]);
  });

  it("stays ok when a tool ran even though the reply ends on a fragment", () => {
    const { current } = turnWith('{"command": "pnpm lint"}', { toolsEnded: true });
    expect(endTurn(current, true, null, "Grok")).toEqual({ ok: true, stopReason: null });
  });

  it("stays ok when a tool is still running even though the reply ends on a fragment", () => {
    const { current } = turnWith("</parameter>", { toolRunning: true });
    expect(endTurn(current, true, null, "Grok")).toEqual({ ok: true, stopReason: null });
  });
});

describe("endTurn on a reply that announces an action no tool ran", () => {
  it.each([
    ["I'll run", "I'll run the test suite now."],
    ["Now I'll run", "Now I'll write the file to disk."],
    ["Running", "Running the migration next"],
    ["Assigning", "Assigning the research to the teammate."],
    ["the last sentence", "Everything else is done.\nI'll start the deploy now."],
  ])("fails a turn whose last sentence announces %s with no tool run", (_name, text) => {
    const { current, replies } = turnWith(text);
    expect(endTurn(current, true, null, "Grok")).toEqual({
      ok: false, stopReason: "announced_action", error: {
        message: "Grok's reply announced an action no tool performed, so the turn was not completed.",
        text: { key: "chat.notice.acpAnnouncedAction", params: { provider: "Grok" } },
      },
    });
    expect(replies).toEqual([]);
  });

  it("stays ok when a tool ran before the announcement", () => {
    const { current } = turnWith("I'll summarize the results.", { toolsEnded: true });
    expect(endTurn(current, true, null, "Grok")).toEqual({ ok: true, stopReason: null });
  });

  it("stays ok when a tool is still running", () => {
    const { current } = turnWith("Running the checks now", { toolRunning: true });
    expect(endTurn(current, true, null, "Grok")).toEqual({ ok: true, stopReason: null });
  });

  it("stays ok on prose that reports rather than announces, including quoted speech", () => {
    const { current, replies } = turnWith('She said: "I\'ll run it tomorrow." and left.');
    expect(endTurn(current, true, null, "Grok")).toEqual({ ok: true, stopReason: null });
    expect(replies).toEqual(['She said: "I\'ll run it tomorrow." and left.']);
  });

  it("stays ok when the reply reports a quoted provider error and says it will retry", () => {
    const quoted = 'The deploy failed with this response:\n\n403 {"type":"error","error":{"type":"permission_error","message":"not allowed"}}\n\nI\'ll retry with the API key.';
    const { current, replies } = turnWith(quoted);
    expect(endTurn(current, true, null, "Grok")).toEqual({ ok: true, stopReason: null });
    expect(replies).toEqual([quoted]);
  });
});
