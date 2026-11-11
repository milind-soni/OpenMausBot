import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { addHeldSecretScrubber, redactSecretsInText } from "../redact.ts";
import { publicReplyEvent, SafeText, safeEnd, savedReplyText } from "./safe-text.ts";

let seq = 0;
const words = (delta: string, itemId = "turn-1:m1", threadId = "t"): RuntimeEvent =>
  ({ eventId: `e${++seq}`, provider: "fake", threadId, createdAt: "", turnId: "turn-1", itemId, type: "content.delta", streamKind: "assistant_text", delta }) as RuntimeEvent;
const deltaText = (event: RuntimeEvent | null) => (event?.type === "content.delta" ? event.delta : "");

/** Each delta in, what goes out after it. */
function stream(deltas: readonly string[], safe = new SafeText()): string[] {
  return deltas.map((delta) => deltaText(safe.delta(words(delta))));
}

const HELD = "Zq9vK2pLmw";
let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
});

describe("streamed reply text", () => {
  it("streams ordinary words with at most the word still being written held back", () => {
    const deltas = ["Hello ", "wor", "ld, how ", "are you", " today?\n\nFine", " thanks."];
    const out = stream(deltas);
    let raw = "";
    let sent = "";
    deltas.forEach((delta, at) => {
      raw += delta;
      sent += out[at];
      expect(sent).toBe(raw.slice(0, Math.max(raw.lastIndexOf(" "), raw.lastIndexOf("\n")) + 1));
    });
  });

  it("never sends a held secret split across two deltas, and masks it whole once it is in", () => {
    unregister = addHeldSecretScrubber((text) => text.split(HELD).join("••••••"));
    const out = stream(["Your password is Zq9v", "K2pLmw and nothing ", "else."]);
    for (const piece of out) {
      expect(piece).not.toContain("Zq9v");
      expect(piece).not.toContain("K2pL");
    }
    expect(out.join("")).toBe("Your password is •••••• and nothing ");
  });

  it("holds a private key from its header until its END line, then sends it masked", () => {
    const deltas = [
      "Here is the key:\n-----BEGIN RSA ", "PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecret ", "bodyline\nmoresecret\n",
      "-----END RSA PRIVATE KEY-----\n", "Keep it safe. ",
    ];
    const out = stream(deltas);
    const beforeEnd = out.slice(0, 3).join("");
    expect(beforeEnd).toBe("Here is the key:\n");
    const all = out.join("");
    expect(all).not.toMatch(/MIIE|secret|bodyline/);
    expect(all).toContain("-----BEGIN RSA PRIVATE KEY-----\n«redacted");
    expect(all.endsWith("Keep it safe. ")).toBe(true);
  });

  it("leaves out a harness note in the middle of a reply, and streams what follows it", () => {
    const out = stream(["Sure thing. <SYSTEM_MESSAGE>Background ", "task done: internal ", "detail</SYSTEM_MESSAGE> Continuing ", "with the plan. "]);
    const all = out.join("");
    expect(all).not.toMatch(/SYSTEM_MESSAGE|Background|internal|detail/);
    expect(all).toBe("Sure thing.  Continuing with the plan. ");
  });

  it("leaves out a room goal envelope, closed or still being written", () => {
    const out = stream(["Next I will check. <openmaus-goal>{\"status\": ", "\"continue\", \"next\": ", "\"b2\"}</openmaus-goal> Then ", "report. "]);
    const all = out.join("");
    expect(all).not.toMatch(/openmaus-goal|status|continue/);
    expect(all).toBe("Next I will check.  Then report. ");
  });

  it("masks a credential the moment its last character is in, never part of it before", () => {
    const out = stream(["Use sk-ant-api03-abcdefgh", "ijklmnopqrstuvwxyz0123 ", "now. "]);
    expect(out[0]).toBe("Use ");
    expect(out.join("")).not.toContain("abcdefgh");
    expect(out.join("")).toContain("«redacted");
  });

  it("starts over for each message, and after a tool or a turn's end", () => {
    const safe = new SafeText();
    expect(deltaText(safe.delta(words("First message ", "a")))).toBe("First message ");
    expect(deltaText(safe.delta(words("Second ", "b")))).toBe("Second ");
    safe.observe({ ...words("", "b"), type: "item.started", itemType: "tool", title: "ls" } as RuntimeEvent);
    expect(deltaText(safe.delta(words("Again ", "b")))).toBe("Again ");
  });

  it("keeps threads apart", () => {
    const safe = new SafeText();
    expect(deltaText(safe.delta(words("Half a wo", "a", "t")))).toBe("Half a ");
    expect(deltaText(safe.delta(words("Other thread ", "a", "u")))).toBe("Other thread ");
    expect(deltaText(safe.delta(words("rd done ", "a", "t")))).toBe("word done ");
  });

  it("leaves reasoning and every other event as it was", () => {
    const safe = new SafeText();
    const thinking = { ...words("hmm sk-ant-api03-abcdefghijklmnopqrstuvwxyz"), streamKind: "reasoning_text" } as RuntimeEvent;
    expect(safe.delta(thinking)).toBe(thinking);
  });

  it("settles a long reply as it goes and still masks a secret near its end", () => {
    const safe = new SafeText();
    const paragraph = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(10) + "\n\n";
    let raw = "";
    let sent = "";
    for (let n = 0; n < 60; n++) {
      for (const piece of paragraph.match(/.{1,7}/gs)!) {
        raw += piece;
        sent += deltaText(safe.delta(words(piece)));
      }
    }
    expect(sent).toBe(raw);
    for (const piece of ["token: ", "abcdefgh12345678 ", "end. "]) {
      raw += piece;
      sent += deltaText(safe.delta(words(piece)));
    }
    expect(sent).not.toContain("abcdefgh12345678");
    expect(sent.endsWith("token: «redacted 16 chars» end. ")).toBe(true);
  });
});

describe("the safe end of text still being written", () => {
  it("stops at the last whitespace, and before an unclosed key, note or envelope", () => {
    expect(safeEnd("one two thr")).toBe(8);
    expect(safeEnd("nospace")).toBe(0);
    expect(safeEnd("a -----BEGIN PRIVATE KEY-----\nabc def ")).toBe(2);
    expect(safeEnd("a -----BEGIN EC PRIV")).toBe(2);
    expect(safeEnd("a -----BEGIN CERTIFICATE-----\nabc ")).toBe(34);
    expect(safeEnd("a <SYSTEM_NOTIFICATION>x y ")).toBe(2);
    expect(safeEnd("a <openmaus-goal>{} ")).toBe(2);
    expect(safeEnd("a <openmaus-goal>{}</openmaus-goal> b ")).toBe(38);
  });
});

describe("a finished reply as it goes out", () => {
  it("carries the text its saved message holds, and the bus's own copy is untouched", () => {
    const text = "Done. <openmaus-goal>{\"status\":\"done\"}</openmaus-goal> Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
    const completed = { ...words(""), type: "item.completed", itemType: "assistant_text", text } as RuntimeEvent;
    const sent = publicReplyEvent(completed);
    expect(sent.type === "item.completed" && sent.itemType === "assistant_text" && sent.text).toBe(redactSecretsInText("Done.  Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz"));
    expect(savedReplyText("plain words")).toBe("plain words");
    expect(completed.type === "item.completed" && completed.itemType === "assistant_text" && completed.text).toBe(text);
  });

  it("names a room reply's speaker on its words, and nothing on a direct chat's", () => {
    const said = words("Hi ");
    expect(publicReplyEvent(said, "b2")).toMatchObject({ botId: "b2", delta: "Hi " });
    expect(publicReplyEvent(said)).toBe(said);
    const thinking = { ...said, streamKind: "reasoning_text" } as RuntimeEvent;
    expect(publicReplyEvent(thinking, "b2")).toBe(thinking);
  });
});
