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
    runningTools: new Set<string>(state.toolRunning ? ["call"] : []),
    endedToolIds: new Set<string>(state.toolsEnded ? ["call"] : []),
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
  }
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

describe("endTurn on a reply that ends on tool-call markup", () => {
  it.each([
    ["a closing parameter tag", 'Opening src/app.ts now.\n<parameter name="path">src/app.ts\n</parameter>'],
    ["a closing invoke tag", "Applying the edit.\n</invoke>"],
    ["a tool_call tag", "Reading the file.\n<tool_call>"],
    ["an unclosed parameter tag", 'Creating the file.\n<parameter name="path"'],
  ])("fails the turn on %s and still shows the text", (_name, text) => {
    const { current, replies } = turnWith(text);
    expect(endTurn(current, true, null, "Grok")).toMatchObject({
      ok: false,
      stopReason: "tool_call_fragment",
      error: { text: { key: "chat.notice.acpToolCallFragment", params: { provider: "Grok" } } },
    });
    expect(replies).toEqual([text]);
  });

  it("leaves prose that ends on plain JSON alone", () => {
    const { current, replies } = turnWith('The answer is:\n{"ok":true}');
    expect(endTurn(current, true, null, "Grok")).toEqual({ ok: true, stopReason: null });
    expect(replies).toEqual(['The answer is:\n{"ok":true}']);
  });

  it("leaves an ordinary announcement alone", () => {
    const { current } = turnWith("I'll keep that in mind.");
    expect(endTurn(current, true, null, "Grok")).toEqual({ ok: true, stopReason: null });
  });

  it("leaves a turn that ran a tool alone", () => {
    const running = turnWith("</parameter>", { toolRunning: true });
    expect(endTurn(running.current, true, null, "Grok")).toEqual({ ok: true, stopReason: null });
    const ended = turnWith("</parameter>", { toolsEnded: true });
    expect(endTurn(ended.current, true, null, "Grok")).toEqual({ ok: true, stopReason: null });
  });

  it("leaves a cut-off fenced example alone", () => {
    const { current } = turnWith('Here is the shape:\n```xml\n<tool_call>\n<parameter name="path">src/a.ts</parameter>');
    expect(endTurn(current, true, null, "Grok")).toEqual({ ok: true, stopReason: null });
  });
});
