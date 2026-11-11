import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { addHeldSecretScrubber, partialFormAt, redactSecretsInText } from "../redact.ts";
import { heldTailStart } from "../../shared/stream-hold.ts";
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

  it("masks thinking text the same way, and leaves every other event as it was", () => {
    const safe = new SafeText();
    const thinking = (delta: string) => deltaText(safe.delta({ ...words(delta), streamKind: "reasoning_text" } as RuntimeEvent));
    const out = [thinking("hmm the key is sk-ant-api03-abcdefgh"), thinking("ijklmnopqrstuvwxyz ok ")].join("");
    expect(out).not.toContain("abcdefgh");
    expect(out).toMatch(/^hmm the key is «redacted \d+ chars» ok $/);
    expect(deltaText(safe.delta(words("Reply words ")))).toBe("Reply words ");
    const usage = { ...words(""), type: "thread.token-usage.updated", input: 1, output: 1 } as RuntimeEvent;
    expect(safe.delta(usage)).toBe(usage);
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

/** A held value registered the way the server registers its own: masked whole, and pending while begun. */
function holdSecret(value: string): void {
  unregister = addHeldSecretScrubber((text) => text.split(value).join("••••••"), (text) => partialFormAt(text, [value]));
}
const filler = (chars: number) => {
  const paragraph = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. ".repeat(4).trim() + "\n\n";
  return paragraph.repeat(Math.ceil(chars / paragraph.length)).slice(0, chars).replace(/\S*$/, "");
};

describe("a held value with whitespace in it", () => {
  const PASS = "correct horse battery staple";

  it("sends none of its words before it is whole, then masks it", () => {
    holdSecret(PASS);
    const out = stream(["Your passphrase is correct ", "horse battery ", "staple. Done "]);
    expect(out[0]).toBe("Your passphrase is ");
    expect(out[1]).toBe("");
    expect(out.join("")).toBe("Your passphrase is ••••••. Done ");
  });

  it("holds one written across a line break", () => {
    holdSecret("first line\nsecond line");
    const out = stream(["It is first ", "line\nsecond ", "line and that is all "]);
    expect(out.join("")).toBe("It is •••••• and that is all ");
    for (const piece of out) expect(piece).not.toMatch(/first|second/);
  });

  it("holds one longer than a settle step, written across a paragraph break", () => {
    const secret = `BEGINSECRET ${"alpha bravo ".repeat(60)}\n\n${"charlie delta ".repeat(50)}ENDSECRET`;
    holdSecret(secret);
    const safe = new SafeText();
    const text = `${filler(4600)}Here it is: ${secret} and done. `;
    let sent = "";
    for (let at = 0; at < text.length; at += 50) sent += deltaText(safe.delta(words(text.slice(at, at + 50))));
    expect(sent).not.toMatch(/BEGINSECRET|alpha bravo|charlie delta|ENDSECRET/);
    expect(sent.endsWith("Here it is: •••••• and done. ")).toBe(true);
  });

  it("holds it one character at a time", () => {
    holdSecret(PASS);
    const text = `Use ${PASS} to sign in. `;
    const out = stream([...text]);
    let sent = "";
    for (const piece of out) {
      sent += piece;
      expect(sent).not.toMatch(/correct|horse|battery/);
    }
    expect(sent).toBe("Use •••••• to sign in. ");
  });

  it("streams text that only starts like one, once it goes another way", () => {
    holdSecret(PASS);
    const out = stream(["The correct ", "horse ", "racing tip is here "]);
    expect(out.slice(0, 2).join("")).toBe("The ");
    expect(out.join("")).toBe("The correct horse racing tip is here ");
  });
});

describe("settling a long message", () => {
  it("never settles inside a closed harness note, so none of it is sent", () => {
    const note = `Hi<SYSTEM_MESSAGE>\n${"internal words here ".repeat(260).trim()}\n\nHIDDENTAIL ${"more internal text ".repeat(48).trim()}\n</SYSTEM_MESSAGE>\n\n`;
    const out = stream([note, "Visible ", "words "]);
    const all = out.join("");
    expect(all).not.toMatch(/HIDDENTAIL|internal/);
    expect(all).toBe("Hi\n\nVisible words ");
  });

  it("never settles inside a closed goal envelope", () => {
    const envelope = `Plan<openmaus-goal>{"note": "${"private plan words ".repeat(260).trim()}\n\nHIDDENTAIL ${"more private ".repeat(70).trim()}"}</openmaus-goal>\n\n`;
    const out = stream([envelope, "Visible ", "words "]);
    const all = out.join("");
    expect(all).not.toMatch(/HIDDENTAIL|private/);
    expect(all).toBe("Plan\n\nVisible words ");
  });

  it("never settles between a secret's name and a value that follows a long run of blank lines", () => {
    const safe = new SafeText();
    const sent = [`${filler(4600)}password:${"\n".repeat(700)}`, "hunter2hunter2 ", "and on. "].map((piece) => deltaText(safe.delta(words(piece)))).join("");
    expect(sent).not.toContain("hunter2");
    expect(sent.endsWith("«redacted 14 chars» and on. ")).toBe(true);
  });
});

describe("messages streaming side by side", () => {
  it("keeps each message's text its own, so going back to one with an open key sends none of the key", () => {
    const safe = new SafeText();
    const say = (delta: string, itemId: string) => deltaText(safe.delta(words(delta, itemId)));
    const sent = [
      say("Key:\n-----BEGIN PRIVATE KEY-----\nMIIEsecretbody ", "a"),
      say("Meanwhile ", "b"),
      say("morebody\nlines ", "a"),
      say("-----END PRIVATE KEY-----\nok ", "a"),
    ];
    expect(sent.join("")).not.toMatch(/MIIE|secretbody|morebody/);
    expect(sent[3]).toMatch(/^-----BEGIN PRIVATE KEY-----\n«redacted/);
  });
});

describe("text written without spaces", () => {
  it("streams a long Japanese paragraph as it is written, all but its last few characters", () => {
    const safe = new SafeText();
    const text = "これは日本語の文章です。今日はとても良い天気ですね。".repeat(240);
    let sent = "";
    for (let at = 0; at < text.length; at += 20) sent += deltaText(safe.delta(words(text.slice(at, at + 20))));
    expect(text.startsWith(sent)).toBe(true);
    expect(sent.length).toBeGreaterThanOrEqual(text.length - 24);
  });

  it("never cuts inside a run of ASCII, a surrogate pair, or a word with an address in it", () => {
    expect(heldTailStart("日本語".repeat(10))).toBe(30 - 24);
    expect(heldTailStart(`日本語sk-ant-api03-${"a".repeat(30)}`)).toBe(3);
    expect(heldTailStart(`${"😀".repeat(30)}`) % 2).toBe(0);
    expect(heldTailStart(`見てhttps://user:pässwörd${"日".repeat(30)}`)).toBe(0);
    expect(heldTailStart("ascii only words here and a longwordwithoutanyspaceatallxxxxxxxx")).toBe(28);
  });

  it("only ever sends a prefix of the saved message, wherever the text is split", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const parts = [
      "日本語の説明です。", "Here is the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 ", "password: hunter2hunter2 ",
      "ログインはhttps://user:pässwörd@example.comから。", "トークンghp_abcdefghijklmnopqrstuvwxyz0123です。", "plain words ", "\n\n",
      "Bearer abcdefghijklmnopqrstuvwxyz ", "ภาษาไทยไม่มีช่องว่างระหว่างคำ",
    ];
    for (let round = 0; round < 40; round++) {
      const text = Array.from({ length: 12 }, () => parts[Math.floor(random() * parts.length)]).join("");
      const saved = savedReplyText(text);
      const safe = new SafeText();
      let sent = "";
      for (let at = 0; at < text.length;) {
        const size = 1 + Math.floor(random() * 15);
        sent += deltaText(safe.delta(words(text.slice(at, at + size), `r${round}`)));
        at += size;
        expect(saved.startsWith(sent), `round ${round}: ${JSON.stringify(sent.slice(-40))}`).toBe(true);
      }
      expect(sent).not.toMatch(/abcdefghijklmnop|hunter2|pässwörd/);
    }
  });
});
