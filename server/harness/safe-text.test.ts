import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { addHeldSecretScrubber, longestSplittableForm, redactSecretsInText } from "../redact.ts";
import { secretForms } from "../vault-store.ts";
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
    holdSecret(HELD);
    const out = stream(["Your password is Zq9v", "K2pLmw and nothing ", "else, and a few more words to carry it out. "]);
    for (const piece of out) {
      expect(piece).not.toContain("Zq9v");
      expect(piece).not.toContain("K2pL");
    }
    expect(out.join("")).toMatch(/^Your password is •••••• and nothing else/);
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
    expect(deltaText(safe.delta(words("Again ", "c")))).toBe("Again ");
    safe.observe({ ...words("", "c"), type: "turn.completed", ok: true } as RuntimeEvent);
    expect(deltaText(safe.delta(words("Next turn ", "b")))).toBe("Next turn ");
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

/** A held value registered the way the server registers its own: masked whole, with its length. */
function holdSecret(value: string): void {
  unregister = addHeldSecretScrubber((text) => text.split(value).join("••••••"), () => value.length);
}
const filler = (chars: number) => {
  const paragraph = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. ".repeat(4).trim() + "\n\n";
  return paragraph.repeat(Math.ceil(chars / paragraph.length)).slice(0, chars).replace(/\S*$/, "");
};
const MORE = "and a few more words to carry the held tail past it all. ";
/** Each piece in, what goes out, and everything sent. */
function pieces(text: string, size: number, safe = new SafeText(), itemId?: string): { frames: string[]; sent: string } {
  const frames: string[] = [];
  for (let at = 0; at < text.length; at += size) frames.push(deltaText(safe.delta(words(text.slice(at, at + size), itemId))));
  return { frames, sent: frames.join("") };
}

describe("a held value with whitespace in it", () => {
  const PASS = "correct horse battery staple";

  it("sends none of its words before it is whole, then masks it", () => {
    holdSecret(PASS);
    const out = stream(["Your passphrase is correct ", "horse battery ", "staple. Done ", MORE]);
    for (const piece of out) expect(piece).not.toMatch(/correct|horse|battery/);
    expect(out.join("")).toMatch(/^Your passphrase is ••••••\. Done and a few /);
  });

  it("holds one written across a line break", () => {
    holdSecret("first line\nsecond line");
    const out = stream(["It is first ", "line\nsecond ", "line and that is all ", MORE]);
    expect(out.join("")).toMatch(/^It is •••••• and that is all and/);
    for (const piece of out) expect(piece).not.toMatch(/first|second/);
  });

  it("holds one longer than a settle step, written across a paragraph break", () => {
    const secret = `BEGINSECRET ${"alpha bravo ".repeat(60)}\n\n${"charlie delta ".repeat(50)}ENDSECRET`;
    holdSecret(secret);
    const { sent } = pieces(`${filler(4600)}Here it is: ${secret} and done. ${MORE.repeat(30)}`, 50);
    expect(sent).not.toMatch(/BEGINSECRET|alpha bravo|charlie delta|ENDSECRET/);
    expect(sent).toContain("Here it is: •••••• and done. ");
  });

  it("holds it one character at a time", () => {
    holdSecret(PASS);
    const { frames, sent } = pieces(`Use ${PASS} to sign in. ${MORE}`, 1);
    let so = "";
    for (const piece of frames) {
      so += piece;
      expect(so).not.toMatch(/correct|horse|battery/);
    }
    expect(sent).toMatch(/^Use •••••• to sign in\. and/);
  });

  it("streams text that only starts like one in full once it is far enough back", () => {
    holdSecret(PASS);
    expect(stream(["The correct ", "horse ", "racing tip is here ", MORE]).join("")).toMatch(/^The correct horse racing tip is here and/);
  });
});

describe("overlapping held values", () => {
  const hold = (...values: string[]) => {
    const removes = values.map((value) => addHeldSecretScrubber((text) => text.split(value).join("••••••"), () => value.length));
    unregister = () => removes.forEach((remove) => remove());
  };
  const check = (values: string[], text: string) => {
    for (const order of [values, [...values].reverse()]) {
      hold(...order);
      const saved = savedReplyText(text);
      for (let length = 40; length <= 60; length++) {
        const sent = deltaText(new SafeText().delta(words(text.slice(0, length))));
        expect(saved.startsWith(sent), `${order.join(" | ")} at ${length}: ${JSON.stringify(sent)}`).toBe(true);
        if (order === values) expect(sent, `at ${length}`).not.toMatch(/Aa/);
      }
      unregister!();
      unregister = null;
    }
  };

  it("never sends the start of one whose end another overlaps", () => {
    check(["Aaaaaaaaabbbbbbb", "bbbbbbb c"], `x Aaaaaaaaabbbbbbb c ${"zz ".repeat(30)}`);
  });

  it("never sends the start of a chain of three", () => {
    check(["Aaaaaaaaabbbbbbb", "bbbbbbb cccc", "cccc dddd"], `x Aaaaaaaaabbbbbbb cccc dddd ${"zz ".repeat(30)}`);
  });
});

describe("held values a stream cannot cut partway", () => {
  /** Held the way the server holds its own: its length counts only if a stream could cut it partway. */
  const holdLikeServer = (...values: string[]) => {
    unregister = addHeldSecretScrubber(
      (text) => values.reduce((out, value) => out.split(value).join("••••••"), text),
      () => longestSplittableForm(values.flatMap(secretForms)),
    );
  };
  const TOKEN = `ops_${"eyJhbGciOiJFUzI1NiIsImtpZCI6".repeat(30)}`;

  it("adds no lag for a long plain-ASCII token, and still never sends any of it before it is whole", () => {
    holdLikeServer(TOKEN);
    expect(safeEnd("Plenty of ordinary words here, and more of them. ")).toBe(49);
    const { frames, sent } = pieces(`Your token: ${TOKEN} and that is all. ${MORE}`, 1);
    let so = "";
    for (const frame of frames) {
      so += frame;
      expect(so).not.toContain("ops_eyJ");
    }
    expect(sent).toMatch(/^Your token: •••••• and that is all\. and a few/);
  });

  it("keeps a plain-ASCII value whole even when something still open cuts the text right after it", () => {
    holdLikeServer("Tr0ub4dor&3");
    expect(deltaText(new SafeText().delta(words("Use Tr0ub4dor&<SYSTEM_MESSAGE>x y z ")))).toBe("Use ");
  });

  it("holds back for a held value with a space in it, from the moment it is held", () => {
    holdLikeServer(TOKEN);
    expect(safeEnd("日".repeat(100))).toBe(100 - 24);
    unregister!();
    holdLikeServer(TOKEN, "abcd efgh ijkl");
    expect(safeEnd("日".repeat(100))).toBe(100 - 31);
  });

  it("is the same for a right first guess and a wrong one at a plain-ASCII value, with no lag", () => {
    const run = (guess: string) => {
      holdLikeServer("Tr0ub4dor&3");
      try {
        const safe = new SafeText();
        const frames = [...`Repeat: —${guess}${"—".repeat(30)} done `].map((char) => deltaText(safe.delta(words(char))));
        return { sizes: frames.map((frame) => frame.length), text: frames.join("").replaceAll(guess, "<guess>") };
      } finally {
        unregister!();
        unregister = null;
      }
    };
    const right = run("Tr0u");
    expect(right).toEqual(run("Tr0v"));
    expect(right.text).toContain("<guess>");
  });
});

describe("what a stream shows about a held value", () => {
  const HELD_VALUE = "Tr0ub4dor&3";
  /** What goes out for a bot repeating `guess`, with the guess blanked: reply frames, thinking frames, and the bus's
   * log and flush at the end. */
  const watch = (guess: string, streamKind: "assistant_text" | "reasoning_text", tail = 24) => {
    holdSecret(HELD_VALUE);
    try {
      const safe = new SafeText();
      const text = `Repeat: —${guess}${"—".repeat(tail)}`;
      const frames: string[] = [];
      for (const char of text) {
        const out = safe.delta({ ...words(char), streamKind } as RuntimeEvent);
        frames.push(deltaText(out));
      }
      const end = safe.observe({ ...words(""), type: "turn.completed", ok: true } as RuntimeEvent);
      frames.push(...end.map(deltaText));
      return { sizes: frames.map((frame) => frame.length), text: frames.join("").replaceAll(guess, "<guess>") };
    } finally {
      unregister?.();
      unregister = null;
    }
  };

  it.each(["assistant_text", "reasoning_text"] as const)("is the same for a right first guess and a wrong one (%s)", (kind) => {
    for (const tail of [24, 48]) {
      const right = watch("Tr0u", kind, tail);
      expect(right).toEqual(watch("Tr0v", kind, tail));
      if (tail === 48 || kind === "reasoning_text") expect(right.text, "the guess streams like any other text").toContain("<guess>");
    }
  });

  it("holds the same number of characters back whatever they are, blurred to a bucket", () => {
    for (const length of [1, 11, 32]) {
      unregister = addHeldSecretScrubber((text) => text, () => length);
      expect(safeEnd(`${"日".repeat(100)}`)).toBe(100 - 31);
      unregister();
    }
    unregister = addHeldSecretScrubber((text) => text, () => 33);
    expect(safeEnd(`${"日".repeat(100)}`)).toBe(100 - 63);
  });

  it("holds everything back for a scrubber that cannot say how long its values are", () => {
    unregister = addHeldSecretScrubber((text) => text, undefined as unknown as () => number);
    expect(safeEnd("plenty of words here to send ")).toBe(0);
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

  it("never settles where blank space separates a secret's name from a value still to come", () => {
    for (const gap of [`password:${"\n".repeat(700)}`, `password${"\n".repeat(700)}:${"\n".repeat(300)}`, `password${" ".repeat(400)}:${" ".repeat(400)}`, `Authorization${"\n".repeat(300)}:${"\n".repeat(300)}Basic${"\n".repeat(300)}`]) {
      const safe = new SafeText();
      const sent = [`${filler(4600)}${gap}`, "aHVudGVyMmh1bnRlcjI= ", "and on. "].map((piece) => deltaText(safe.delta(words(piece)))).join("");
      expect(sent, JSON.stringify(gap.slice(0, 20))).not.toContain("aHVudGVy");
    }
  });

  it("settles at sentence ends in a long paragraph with no line breaks", () => {
    const { sent } = pieces("This is a sentence that goes on for a while. ".repeat(1400), 40);
    expect("This is a sentence that goes on for a while. ".repeat(1400).startsWith(sent)).toBe(true);
    expect(sent.length).toBeGreaterThan(1400 * 45 - 40);
  });

  it("never settles between a secret's name and a value that follows a long run of blank lines", () => {
    const safe = new SafeText();
    const sent = [`${filler(4600)}password:${"\n".repeat(700)}`, "hunter2hunter2 ", "and on. "].map((piece) => deltaText(safe.delta(words(piece)))).join("");
    expect(sent).not.toContain("hunter2");
    expect(sent.endsWith("«redacted 14 chars» and on. ")).toBe(true);
  });
});

describe("a message closed and then continued", () => {
  const event = (fields: Partial<RuntimeEvent>) => ({ ...words(""), ...fields }) as RuntimeEvent;

  it("sends nothing more of a message whose open key a thinking item interrupted", () => {
    const safe = new SafeText();
    const sent = [deltaText(safe.delta(words("Key:\n-----BEGIN PRIVATE KEY-----\nMIIEsecretbody ", "m1")))];
    safe.observe(event({ type: "item.started", itemType: "reasoning", itemId: "r1" }));
    sent.push(deltaText(safe.delta(words("morebody\nlines\n-----END PRIVATE KEY-----\nok ", "m1"))));
    expect(sent.join("")).not.toMatch(/MIIE|secretbody|morebody/);
  });

  it("sends nothing more of a message a tool split in the middle of a held passphrase", () => {
    holdSecret("correct horse battery staple");
    const safe = new SafeText();
    const sent = [deltaText(safe.delta(words(`Phrase: ${"word ".repeat(10)}correct horse `, "m1")))];
    safe.observe(event({ type: "item.started", itemType: "tool", itemId: "c1", title: "ls" } as Partial<RuntimeEvent>));
    sent.push(deltaText(safe.delta(words(`battery staple then ${MORE}`, "m1"))));
    expect(sent.join("")).not.toMatch(/correct|horse|battery/);
  });

  it("sends nothing more of a message let go for others streaming meanwhile", () => {
    const safe = new SafeText();
    const sent = [deltaText(safe.delta(words("Key:\n-----BEGIN PRIVATE KEY-----\nMIIEsecretbody ", "a")))];
    for (let n = 0; n < 8; n++) sent.push(deltaText(safe.delta(words("Other words ", `b${n}`))));
    sent.push(deltaText(safe.delta(words("morebody\n-----END PRIVATE KEY-----\nok ", "a"))));
    expect(sent.join("")).not.toMatch(/MIIE|secretbody|morebody/);
  });
});

describe("the end of a thinking stream", () => {
  const thinking = (safe: SafeText, delta: string) => deltaText(safe.delta({ ...words(delta, "r1"), streamKind: "reasoning_text" } as RuntimeEvent));

  it("sends its held-back tail, cleaned, when the turn ends, and goes on through a tool", () => {
    const safe = new SafeText();
    let sent = thinking(safe, "Let me look at sk-ant-api03-abcdefghijklmnopqrstuvwxyz then ");
    expect(safe.observe({ ...words(""), type: "item.started", itemType: "tool", itemId: "c1", title: "ls" } as RuntimeEvent)).toEqual([]);
    sent += thinking(safe, "decide");
    const rest = safe.observe({ ...words(""), type: "turn.completed", ok: true } as RuntimeEvent);
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ streamKind: "reasoning_text", itemId: "r1" });
    expect(sent + deltaText(rest[0]!)).toMatch(/^Let me look at «redacted \d+ chars» then decide$/);
  });

  it.each([undefined, "r1"])("never sends a held passphrase or a key's body split across a tool start (item %s)", (itemId) => {
    holdSecret("correct horse battery staple");
    for (const [first, second, hidden] of [
      [`Thinking about ${"it ".repeat(12)}correct horse `, `battery staple and then ${MORE}`, /correct|horse|battery/],
      ["Key:\n-----BEGIN PRIVATE KEY-----\nMIIEsecretbody ", `morebody\n-----END PRIVATE KEY-----\nok ${MORE}`, /MIIE|secretbody|morebody/],
    ] as const) {
      const safe = new SafeText();
      const think = (delta: string) => deltaText(safe.delta({ ...words(delta, itemId), streamKind: "reasoning_text" } as RuntimeEvent));
      const frames = [think(first)];
      frames.push(...safe.observe({ ...words(""), type: "item.started", itemType: "tool", itemId: "c1", title: "ls" } as RuntimeEvent).map(deltaText));
      frames.push(think(second));
      frames.push(...safe.observe({ ...words(""), type: "turn.completed", ok: true } as RuntimeEvent).map(deltaText));
      for (const frame of frames) expect(frame).not.toMatch(hidden);
      expect(frames.join("")).toMatch(/••••••|«redacted/);
    }
  });

  it("drops a tail it cannot show safely", () => {
    const safe = new SafeText();
    const sent = thinking(safe, "Key:\n-----BEGIN PRIVATE KEY-----\nMIIEsecretbody ");
    const rest = safe.observe({ ...words(""), type: "turn.completed", ok: true } as RuntimeEvent);
    expect(sent + rest.map(deltaText).join("")).toBe("Key:\n");
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
    holdSecret("Tr0ub4dor&3");
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
