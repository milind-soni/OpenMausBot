// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", async (original) => {
  const store = await original<typeof import("@/state/store")>();
  return { ...store, api: fixture.api, useStore: () => ({ state: store.initialState, dispatch: fixture.dispatch }) };
});
const { setLocale } = await import("@/lib/i18n");
const { ReactAction, ReactionChips } = await import("./Reactions");

const ASKED: Message = { id: "m1", at: 1, role: "bot", kind: "text", text: "Shall I send it?" };

let host: HTMLDivElement;
let root: Root;

async function render(element: ReturnType<typeof createElement>) {
  await act(async () => root.render(element));
}
const button = () => host.querySelector<HTMLButtonElement>('button[aria-label="Add reaction"]')!;
const toolbar = () => host.querySelector<HTMLElement>('[role="toolbar"]');
const choices = () => [...(toolbar()?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
const key = (target: Element, name: string) => act(async () => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
});
const click = (target: HTMLElement) => act(async () => { target.click(); });
const patched = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "messagePatched");

beforeEach(() => {
  setLocale("en");
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ kind: "loopback" }))));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the react button on a bot's message", () => {
  it("opens six reactions that say what they mean, focuses the first, and walks them with the arrow keys", async () => {
    await render(createElement(ReactAction, { threadId: "t1", message: ASKED }));
    expect(button().getAttribute("aria-expanded")).toBe("false");
    await click(button());
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(toolbar()?.getAttribute("aria-label")).toBe("Reactions");
    expect(choices().map((choice) => [choice.textContent, choice.getAttribute("aria-label"), choice.getAttribute("aria-pressed")])).toEqual([
      ["👍", "Thumbs up: yes, go ahead", "false"],
      ["👎", "Thumbs down: no, not that", "false"],
      ["❤️", "Heart", "false"],
      ["😂", "Laughing", "false"],
      ["🎉", "Celebrate", "false"],
      ["👀", "Eyes", "false"],
    ]);
    expect(document.activeElement).toBe(choices()[0]);
    await key(choices()[0]!, "ArrowRight");
    expect(document.activeElement).toBe(choices()[1]);
    await key(choices()[1]!, "End");
    expect(document.activeElement).toBe(choices()[5]);
    await key(choices()[5]!, "ArrowRight");
    expect(document.activeElement).toBe(choices()[0]);
    await key(choices()[0]!, "ArrowLeft");
    expect(document.activeElement).toBe(choices()[5]);
    await key(choices()[5]!, "Home");
    expect(document.activeElement).toBe(choices()[0]);
  });

  it("closes on Escape and gives focus back to the button", async () => {
    await render(createElement(ReactAction, { threadId: "t1", message: ASKED }));
    await click(button());
    await key(choices()[2]!, "Escape");
    expect(toolbar()).toBeNull();
    expect(document.activeElement).toBe(button());
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("closes when focus moves on to something else", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    await render(createElement(ReactAction, { threadId: "t1", message: ASKED }));
    await click(button());
    await act(async () => { outside.focus(); });
    expect(toolbar()).toBeNull();
    outside.remove();
  });

  it("shows a 👍 at once, sends it, then shows the server's copy", async () => {
    const server: Message = { ...ASKED, reactions: [{ emoji: "👍", by: "user", at: 9 }] };
    fixture.api.mockResolvedValue({ message: server, delivery: "started" });
    await render(createElement(ReactAction, { threadId: "t1", message: ASKED }));
    await click(button());
    await click(choices()[0]!);
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/threads/t1/messages/m1/reactions", { method: "POST", body: JSON.stringify({ emoji: "👍", on: true }) });
    expect(patched()).toEqual([
      { type: "messagePatched", threadId: "t1", message: { ...ASKED, reactions: [{ emoji: "👍", by: "user", at: expect.any(Number) }] } },
      { type: "messagePatched", threadId: "t1", message: server },
    ]);
    expect(toolbar()).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it("marks the person's own reaction, starts on it, and clears it on a second tap", async () => {
    fixture.api.mockResolvedValue({ message: ASKED, delivery: "none" });
    await render(createElement(ReactAction, { threadId: "t1", message: { ...ASKED, reactions: [{ emoji: "👎", by: "user" }, { emoji: "👍", by: "p_bob" }] } }));
    await click(button());
    expect(choices().map((choice) => choice.getAttribute("aria-pressed"))).toEqual(["false", "true", "false", "false", "false", "false"]);
    expect(document.activeElement).toBe(choices()[1]);
    await click(choices()[1]!);
    expect(fixture.api.mock.calls[0]![1]).toEqual({ method: "POST", body: JSON.stringify({ emoji: "👎", on: false }) });
    expect(patched()[0]?.message.reactions).toEqual([{ emoji: "👍", by: "p_bob" }]);
  });

  it("puts the message back and says why when the server refuses the reaction", async () => {
    fixture.api.mockRejectedValue(new Error("this workspace has reached its monthly spend limit"));
    await render(createElement(ReactAction, { threadId: "t1", message: ASKED }));
    await click(button());
    await click(choices()[0]!);
    await act(async () => {});
    expect(patched().at(-1)).toEqual({ type: "messagePatched", threadId: "t1", message: ASKED });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "error", message: "this workspace has reached its monthly spend limit" });
  });

  it("takes back only its own tap when refused: a reaction that came in meanwhile stays, and a later tap of theirs too", async () => {
    let refuse!: (error: Error) => void;
    fixture.api.mockReturnValueOnce(new Promise((_resolve, reject) => { refuse = reject; }));
    await render(createElement(ReactAction, { threadId: "t1", message: ASKED }));
    await click(button());
    await click(choices()[0]!);
    const mine = patched()[0]!.message.reactions![0]!;
    const bob = { emoji: "❤️", by: "p_bob", name: "Bob", at: 5 };
    await render(createElement(ReactAction, { threadId: "t1", message: { ...ASKED, reactions: [mine, bob] } }));
    await act(async () => refuse(new Error("engine unavailable")));
    expect(patched().at(-1)?.message.reactions).toEqual([bob]);

    fixture.api.mockReturnValueOnce(new Promise((_resolve, reject) => { refuse = reject; }));
    await render(createElement(ReactAction, { threadId: "t1", message: ASKED }));
    await click(button());
    await click(choices()[0]!);
    const later = { emoji: "👎", by: "user", at: Date.now() + 1_000 };
    await render(createElement(ReactAction, { threadId: "t1", message: { ...ASKED, reactions: [later] } }));
    const before = patched().length;
    await act(async () => refuse(new Error("engine unavailable")));
    expect(patched()).toHaveLength(before);
  });

  it("keeps the newest tap when the server answers two taps out of order", async () => {
    const answers: Array<(body: { message: Message }) => void> = [];
    fixture.api.mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
    await render(createElement(ReactAction, { threadId: "t1", message: ASKED }));
    await click(button());
    await click(choices()[0]!);
    const yes = patched()[0]!.message;
    await render(createElement(ReactAction, { threadId: "t1", message: yes }));
    await click(button());
    await click(choices()[1]!);
    expect(fixture.api.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([{ emoji: "👍", on: true }, { emoji: "👎", on: true }]);
    const no: Message = { ...ASKED, reactions: [{ emoji: "👎", by: "user", at: 20 }] };
    await act(async () => answers[1]!({ message: no }));
    await act(async () => answers[0]!({ message: { ...ASKED, reactions: [{ emoji: "👍", by: "user", at: 10 }] } }));
    expect(patched().at(-1)?.message).toEqual(no);
  });
});

describe("reaction chips under a message", () => {
  const reacted: Message = { ...ASKED, reactions: [
    { emoji: "❤️", by: "p_bob", name: "Bob" },
    { emoji: "👍", by: "user" },
    { emoji: "👍", by: "p_alice", name: "alice@example.test" },
  ] };
  const chips = () => [...host.querySelectorAll<HTMLElement>('[role="group"] > *')];

  it("shows each reaction once, in the offered order, with how many and who chose it", async () => {
    await render(createElement(ReactionChips, { threadId: "t1", message: reacted }));
    expect(host.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Reactions");
    expect(chips().map((chip) => [chip.tagName, chip.textContent, chip.getAttribute("aria-label"), chip.getAttribute("aria-pressed"), chip.getAttribute("title")])).toEqual([
      ["BUTTON", "👍2", "Thumbs up: yes, go ahead: You, alice@example.test", "true", "You, alice@example.test"],
      ["BUTTON", "❤️", "Heart: Bob", "false", "Bob"],
    ]);
  });

  it("sets or clears the viewer's own reaction from a chip", async () => {
    fixture.api.mockResolvedValue({ delivery: "noted" });
    await render(createElement(ReactionChips, { threadId: "t1", message: reacted }));
    await click(chips()[1]!);
    expect(fixture.api.mock.calls[0]![1]).toEqual({ method: "POST", body: JSON.stringify({ emoji: "❤️", on: true }) });
    expect(patched()[0]?.message.reactions).toEqual([
      { emoji: "❤️", by: "p_bob", name: "Bob" },
      { emoji: "👍", by: "p_alice", name: "alice@example.test" },
      { emoji: "❤️", by: "user", at: expect.any(Number) },
    ]);
  });

  it("shows a viewer who cannot write here the chips as labels, not buttons", async () => {
    await render(createElement(ReactionChips, { threadId: "t1", message: reacted, canReact: false }));
    expect(host.querySelectorAll("button")).toHaveLength(0);
    expect(chips().map((chip) => [chip.getAttribute("role"), chip.getAttribute("aria-label")])).toEqual([
      ["img", "Thumbs up: yes, go ahead: You, alice@example.test"],
      ["img", "Heart: Bob"],
    ]);
  });

  it("pops in only a reaction made just now, not every reaction a transcript loads", async () => {
    const message: Message = { ...ASKED, reactions: [{ emoji: "👍", by: "p_bob", at: Date.now() }, { emoji: "❤️", by: "p_ada", at: 1 }, { emoji: "🎉", by: "p_cy" }] };
    await render(createElement(ReactionChips, { threadId: "t1", message }));
    expect(chips().map((chip) => chip.classList.contains("animate-pop-in"))).toEqual([true, false, false]);
  });

  it("draws nothing for a message nobody reacted to", async () => {
    await render(createElement(ReactionChips, { threadId: "t1", message: ASKED }));
    expect(host.innerHTML).toBe("");
  });
});
