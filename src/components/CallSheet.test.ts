// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { CallRecordRow } from "./CallRecordRow";

const at = 1_700_000_000_000;
const msg = (id: string, fields: Partial<Message>): Message => ({ id, role: "bot", kind: "text", at, ...fields }) as Message;
const record = msg("row", {
  kind: "call",
  text: "Call with Kiwi · 0:45",
  call: { callId: "c1", botId: "bot", client: "desktop", startedAt: at - 45_000, endedAt: at, seconds: 45, endReason: "hung-up" },
});
const transcript: Message[] = [
  msg("t0", { role: "user", text: "typed before the call" }),
  msg("tb", { text: "Typed answer.", requestMessageId: "t0" }),
  msg("m1", { role: "user", text: "Hey Kiwi, what are the two issues I should pick up", via: "call", callId: "c1" }),
  msg("a1", { kind: "activity", requestMessageId: "m1", tool: { name: "Bash", spoken: "running a command", ok: true, itemId: "item-a1", input: "node kiwi-fetch.mjs" } }),
  msg("b1", { text: "**MOCA-295** and **MOCA-341**.", requestMessageId: "m1" }),
  record,
];

describe("CallSheet", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const draw = (list: readonly Message[] = transcript) =>
    flushSync(() => root.render(createElement(CallRecordRow, { message: record, transcript: list, botName: "Kiwi", threadId: "t", busy: false, hasMore: false })));
  const sheet = () => document.querySelector<HTMLElement>('[data-testid="call-sheet"]');
  const openSheet = () => {
    const button = host.querySelector<HTMLButtonElement>('[data-testid="call-record"] button');
    expect(button).not.toBeNull();
    flushSync(() => button!.click());
  };
  afterEach(() => flushSync(() => root.render(null)));

  it("is closed until the row is clicked, and the row says it opens a dialog", () => {
    draw();
    expect(sheet()).toBeNull();
    const button = host.querySelector('[data-testid="call-record"] button');
    expect(button?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button?.getAttribute("aria-label")).toBe("Open the call: Call with Kiwi");
  });

  it("opens on a click anywhere on the row, not only its title", () => {
    draw();
    flushSync(() => host.querySelector<HTMLElement>('[data-testid="call-record"]')!.click());
    expect(sheet()).not.toBeNull();
  });

  it("shows what was asked, what the bot did and what it answered, in order, and nothing typed", () => {
    draw();
    openSheet();
    const text = sheet()!.textContent ?? "";
    expect(sheet()!.getAttribute("role")).toBe("dialog");
    expect(text).toContain("Call with Kiwi");
    expect(text).toContain("0:45");
    const asked = text.indexOf("Hey Kiwi, what are the two issues I should pick up");
    const did = text.indexOf("Running a command");
    const answered = text.indexOf("MOCA-295 and MOCA-341.");
    expect(asked).toBeGreaterThanOrEqual(0);
    expect(did).toBeGreaterThan(asked);
    expect(answered).toBeGreaterThan(did);
    // the answer is drawn as markdown, as in the chat
    expect(sheet()!.querySelector("strong")?.textContent).toBe("MOCA-295");
    // a step's name, never its arguments
    expect(text).not.toContain("kiwi-fetch");
    // what was typed is not the call's
    expect(text).not.toContain("typed before the call");
    expect(text).not.toContain("Typed answer.");
    expect(text).toContain("Nothing else said on the call is kept.");
  });

  it("says so when nothing was asked on the call", () => {
    draw([record]);
    openSheet();
    expect(sheet()!.textContent).toContain("Nothing was asked on this call.");
  });

  it("closes from its button and from Escape", () => {
    draw();
    openSheet();
    flushSync(() => sheet()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    expect(sheet()).toBeNull();

    openSheet();
    flushSync(() => sheet()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(sheet()).toBeNull();
  });
});
