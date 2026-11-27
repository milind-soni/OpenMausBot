// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";

vi.mock("@/lib/call-record", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/call-record")>();
  return { ...original, callRecordLines: vi.fn(original.callRecordLines) };
});

const { callRecordLines } = await import("@/lib/call-record");
const { CallRecordRow } = await import("./CallRecordRow");

const at = 1_700_000_000_000;
const msg = (id: string, fields: Partial<Message>): Message => ({ id, role: "bot", kind: "text", at, ...fields }) as Message;
const record = msg("row", {
  kind: "call",
  text: "Call with Pepper · 1:42",
  call: { callId: "c1", botId: "bot", client: "ios", startedAt: at - 102_000, endedAt: at, seconds: 102, endReason: "hung-up" },
});
const withCall = (fields: Partial<NonNullable<Message["call"]>>): Message => ({ ...record, call: { ...record.call!, ...fields } });
const step = (id: string, tool: NonNullable<Message["tool"]>) =>
  msg(id, { kind: "activity", requestMessageId: "m1", tool: { ...tool, itemId: `item-${id}` } });
const transcript: Message[] = [
  msg("m1", { role: "user", text: "what's the weather", via: "call", callId: "c1" }),
  step("a1", { name: "WebSearch", spoken: "searching the web", ok: true }),
  record,
];

describe("CallRecordRow's lines", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const draw = (message: Message, list: readonly Message[], botName = "Pepper") =>
    flushSync(() => root.render(createElement(CallRecordRow, { message, transcript: list, botName, busy: false, hasMore: false })));
  beforeEach(() => {
    vi.mocked(callRecordLines).mockClear();
  });
  afterAll(() => root.unmount());

  it("are worked out once per transcript and call, not on every render", () => {
    draw(record, transcript);
    expect(callRecordLines).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Searching the web");

    draw(withCall({ title: "Pune weather check" }), transcript);
    expect(host.textContent).toContain("Pune weather check");
    draw(record, transcript, "Ada");
    expect(host.textContent).toContain("Call with Ada");
    expect(callRecordLines).toHaveBeenCalledTimes(1);

    const later = [...transcript, step("a2", { name: "Read", spoken: "reading a file", ok: true })];
    draw(record, later);
    expect(callRecordLines).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Reading a file");

    draw(withCall({ callId: "c2" }), later);
    expect(callRecordLines).toHaveBeenCalledTimes(3);
    expect(host.textContent).not.toContain("Searching the web");
  });
});
