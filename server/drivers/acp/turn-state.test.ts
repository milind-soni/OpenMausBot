import { describe, expect, it } from "vitest";

import { endTurn, type AcpTurn } from "./turn-state.ts";

const ERROR_BODY = '403 {"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization."}}';

/** A turn whose buffered text is `text`, flushed as core.ts does: a non-blank text becomes a reply. */
function turnWith(text: string, state: { stopped?: boolean; replied?: string } = {}) {
  const replies: string[] = [];
  const current = {
    state: { text: state.replied ?? "", stopped: false, producedItem: false, repliedText: false },
    flushAssistantText() {
      const said = current.state.text;
      current.state.text = "";
      if (!said.trim()) return;
      current.state.producedItem = true;
      current.state.repliedText = true;
      replies.push(said);
    },
  };
  if (state.replied) current.flushAssistantText();
  current.state.text = text;
  current.state.stopped = state.stopped ?? false;
  return { current: current as unknown as AcpTurn, replies };
}

describe("endTurn on a reply that is a provider's error body", () => {
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
