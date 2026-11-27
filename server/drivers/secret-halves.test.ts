import { describe, expect, it } from "vitest";

import { maskSecretHalves } from "./secret-halves.ts";

const safe = (text: string) => text;
const feed = (text: string, secrets: string[], flush = false) => maskSecretHalves(text, secrets, safe, flush);

describe("maskSecretHalves", () => {
  const secret = "abcdefgh12345678";

  it("holds a suffix that could start a credential, then masks it once the rest arrives", () => {
    const first = feed(`before ${secret.slice(0, 8)}`, [secret]);
    expect(first).toEqual({ visible: "before ", held: secret.slice(0, 8) });
    expect(feed(first.held + secret.slice(8) + " after", [secret], true)).toEqual({ visible: "[redacted] after", held: "" });
  });

  it("carries a credential split over three chunks", () => {
    const one = feed("abc", [secret]);
    const two = feed(one.held + "defgh12", [secret]);
    const three = feed(two.held + "345678 end", [secret], true);
    expect(one.visible).toBe("");
    expect(two.visible).toBe("");
    expect(three.visible).toBe("[redacted] end");
  });

  it("releases held text unmasked when the next chunk shows it was not a credential", () => {
    const held = feed("abcdefgh", [secret]).held;
    expect(held).toBe("abcdefgh");
    expect(feed(held + "x", [secret])).toEqual({ visible: "abcdefghx", held: "" });
  });

  it("masks any of several overlapping credentials", () => {
    const other = "abcdefgh99999999";
    expect(feed("say abcdefgh12", [secret, other])).toEqual({ visible: "say ", held: "abcdefgh12" });
    expect(feed("abcdefgh12345678 ok abcdefgh99999999", [secret, other], true))
      .toEqual({ visible: "[redacted] ok [redacted]", held: "" });
  });

  it("ignores an empty credential", () => {
    expect(feed("plain text", ["", secret])).toEqual({ visible: "plain text", held: "" });
    expect(feed("plain text", [""], true)).toEqual({ visible: "plain text", held: "" });
  });
});
