import { describe, expect, it } from "vitest";

import { signInCardWaits } from "./sign-in-request.ts";

describe("a sign-in card that still waits for the person", () => {
  it.each([
    { row: "an open card", card: { site: "a.example" }, waits: true },
    { row: "a stopped card", card: { site: "a.example", stopped: true }, waits: false },
    { row: "a card the person finished", card: { site: "a.example", done: true }, waits: false },
    { row: "a card the person cancelled", card: { site: "a.example", cancelled: true }, waits: false },
    { row: "a card a newer one replaced", card: { site: "a.example", superseded: true }, waits: false },
    { row: "a card answered in the chat", card: { site: "a.example", answeredInChat: true }, waits: false },
    { row: "no card, as when its conversation or branch is gone", card: undefined, waits: false },
  ])("$row", ({ card, waits }) => {
    expect(signInCardWaits(card)).toBe(waits);
  });
});
