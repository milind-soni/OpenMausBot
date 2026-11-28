// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuggestionRow } from "../../shared/suggested-reply";

const fixture = vi.hoisted(() => ({
  on: true,
  calls: [] as Array<{ body: { botId: string; threadId: string; after: string }; signal?: AbortSignal }>,
  answer: "Send it to Priya too" as string | null,
  pending: [] as Array<() => void>,
}));
vi.mock("@/lib/use-feature", () => ({ useFeature: (name: string) => name === "suggestedReplies" && fixture.on }));
vi.mock("@/state/store", () => ({
  api: (_path: string, init: { body: string; signal?: AbortSignal }) => {
    fixture.calls.push({ body: JSON.parse(init.body), signal: init.signal });
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      fixture.pending.push(() => resolve({ text: fixture.answer }));
    });
  },
}));

import { forgetSuggestedReplies, SUGGESTION_DELAY_MS, useSuggestedReply, type SuggestedReply, type SuggestedReplyInput } from "./use-suggested-reply";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPLY = "I drafted the launch email and saved it in your drafts folder.";
const ask = (id: string, text = "Draft the launch email"): SuggestionRow => ({ id, role: "user", kind: "text", text });
const reply = (id: string, text = REPLY): SuggestionRow => ({ id, role: "bot", kind: "text", text });
const TURN = [ask("u1"), reply("b1")];

let root: Root;
let host: HTMLDivElement;
let latest: SuggestedReply;
const filled: string[] = [];
const inputRef = createRef<HTMLTextAreaElement>();
let props: Omit<SuggestedReplyInput, "inputRef" | "fill">;

function Harness(input: Omit<SuggestedReplyInput, "inputRef" | "fill">) {
  latest = useSuggestedReply({ ...input, inputRef, fill: (text) => filled.push(text) });
  return null;
}

function render(next: Partial<typeof props> = {}) {
  props = { ...props, ...next };
  act(() => root.render(createElement(Harness, props)));
}

async function settle() {
  await act(async () => { vi.advanceTimersByTime(SUGGESTION_DELAY_MS + 10); });
}

async function answer() {
  await act(async () => { fixture.pending.splice(0).forEach((resolve) => resolve()); });
}

/** A turn that runs and finishes while the composer is open. */
async function finishTurn(messages: SuggestionRow[] = TURN) {
  render({ working: true, messages: [messages[0]!] });
  render({ working: false, messages });
  await settle();
}

const key = (name: string, extra: Partial<KeyboardEvent> = {}) => ({ key: name, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, preventDefault: vi.fn(), ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  forgetSuggestedReplies();
  fixture.on = true;
  fixture.calls.length = 0;
  fixture.pending.length = 0;
  fixture.answer = "Send it to Priya too";
  filled.length = 0;
  props = { botId: "bot", threadId: "t1", messages: [], working: false, held: false, draft: "", attached: false };
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("useSuggestedReply", () => {
  it("asks once after a reply finishes, then shows the suggestion", async () => {
    render();
    await finishTurn();
    expect(fixture.calls.map((call) => call.body)).toEqual([{ botId: "bot", threadId: "t1", after: "b1" }]);
    expect(latest.text).toBeNull();
    await answer();
    expect(latest.text).toBe("Send it to Priya too");
    render({});
    await settle();
    expect(fixture.calls).toHaveLength(1);
  });

  it("asks after a quick reply to a message sent here, even if the bot was never seen working", async () => {
    render({ messages: TURN });
    render({ messages: [...TURN, ask("u2", "Make it friendlier"), reply("b2")] });
    await settle();
    expect(fixture.calls.map((call) => call.body.after)).toEqual(["b2"]);
  });

  it("asks nothing when an older page or an aside arrives after opening", async () => {
    render({ messages: [ask("u2"), reply("b2")] });
    render({ messages: [ask("u1"), reply("b1"), ask("u2"), reply("b2")] });
    render({ messages: [ask("u1"), reply("b1"), ask("u2"), reply("b2"), { id: "a1", role: "user", kind: "text", text: "peer note", aside: true }] });
    await settle();
    expect(fixture.calls).toHaveLength(0);
  });

  it("asks nothing for a conversation that was already finished when it opened", async () => {
    render({ messages: TURN });
    await settle();
    render({ threadId: "t2", messages: [] });
    render({ threadId: "t2", messages: [ask("x1"), reply("y1")] });
    await settle();
    expect(fixture.calls).toHaveLength(0);
  });

  it("clears at the first keystroke and stays gone after the field is emptied", async () => {
    render();
    await finishTurn();
    await answer();
    render({ draft: "S" });
    expect(latest.text).toBeNull();
    render({ draft: "" });
    expect(latest.text).toBeNull();
  });

  it("cancels the request when the person starts typing", async () => {
    render();
    await finishTurn();
    render({ draft: "n" });
    expect(fixture.calls[0]!.signal?.aborted).toBe(true);
    render({ draft: "" });
    await answer();
    expect(latest.text).toBeNull();
  });

  it("fills the field on Tab, and leaves Tab alone when there is nothing to take", async () => {
    render();
    expect(latest.onKeyDown(key("Tab"))).toBe(false);
    await finishTurn();
    await answer();
    expect(latest.onKeyDown(key("Tab", { shiftKey: true }))).toBe(false);
    expect(latest.onKeyDown(key("Tab", { ctrlKey: true }))).toBe(false);
    const tab = key("Tab");
    act(() => { expect(latest.onKeyDown(tab)).toBe(true); });
    expect(tab.preventDefault).toHaveBeenCalled();
    expect(filled).toEqual(["Send it to Priya too"]);
    expect(latest.text).toBeNull();
  });

  it("turns the suggestion down on Escape", async () => {
    render();
    await finishTurn();
    await answer();
    act(() => { expect(latest.onKeyDown(key("Escape"))).toBe(true); });
    expect(latest.text).toBeNull();
    expect(filled).toEqual([]);
    expect(latest.onKeyDown(key("Escape"))).toBe(false);
  });

  it("drops a pending request and the suggestion when a new turn starts", async () => {
    render();
    await finishTurn();
    render({ working: true, messages: [...TURN, ask("u2", "one more thing")] });
    expect(fixture.calls[0]!.signal?.aborted).toBe(true);
    await answer();
    expect(latest.text).toBeNull();
  });

  it("hides while the bot works or something else holds the field", async () => {
    render();
    await finishTurn();
    await answer();
    render({ held: true });
    expect(latest.text).toBeNull();
    render({ held: false, attached: true });
    expect(latest.text).toBeNull();
    render({ attached: false });
    expect(latest.text).toBe("Send it to Priya too");
  });

  it("asks nothing after a reply that ends in a card or choice, or a trivial one", async () => {
    render();
    await finishTurn([ask("u1"), reply("b1"), { id: "o1", role: "bot", kind: "options" }]);
    await finishTurn([ask("u2"), reply("b2", "Done.")]);
    expect(fixture.calls).toHaveLength(0);
  });

  it("asks nothing with the setting off or in a room", async () => {
    fixture.on = false;
    render();
    await finishTurn();
    fixture.on = true;
    render({ botId: undefined, threadId: "room" });
    await finishTurn();
    expect(fixture.calls).toHaveLength(0);
  });

  it("shows each thread's own suggestion when switching threads", async () => {
    render();
    await finishTurn();
    await answer();
    render({ threadId: "t2", messages: [ask("x1"), reply("y1")] });
    expect(latest.text).toBeNull();
    await settle();
    expect(fixture.calls).toHaveLength(1);
    render({ threadId: "t1", messages: TURN });
    expect(latest.text).toBe("Send it to Priya too");
  });

  it("stays quiet when the answer is empty", async () => {
    fixture.answer = null;
    render();
    await finishTurn();
    await answer();
    expect(latest.text).toBeNull();
  });
});
