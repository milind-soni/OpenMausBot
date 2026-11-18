// The streaming scrub must agree with `scrub` on every body, however the bytes are split.
import { describe, expect, it } from "vitest";

import { createJsonScrubber } from "../src/json-scrub.ts";
import { scrub } from "../src/wire.ts";

/** Feeds `body` in pieces of `size` characters (0: one piece). */
const run = (body: string, size = 0): string => {
  const scrubber = createJsonScrubber();
  let out = "";
  if (!size) out += scrubber.write(body);
  else for (let i = 0; i < body.length; i += size) out += scrubber.write(body.slice(i, i + size));
  return out + scrubber.end();
};
const expected = (value: unknown): string => JSON.stringify(scrub(value));

/** Deterministic, so a failure reproduces. */
const random = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const KEYS = ["id", "resumeCursors", "name", "sshAlias", "messages", "vpsAlias", "text", "vpsAliases", "tool", ""];
const STRINGS = ["", "plain", 'quote " and \\ backslash', "line\nbreak\ttab", "é and 😀", "\u0001\u001f", '"resumeCursors":{}', "}]{[,:"];
function value(next: () => number, depth: number): unknown {
  const pick = next();
  if (depth > 5 || pick < 0.35) {
    const atoms = [null, true, false, 0, -1.5, 1e21, 42, STRINGS[Math.floor(next() * STRINGS.length)]];
    return atoms[Math.floor(next() * atoms.length)];
  }
  const count = Math.floor(next() * 5);
  if (pick < 0.6) return Array.from({ length: count }, () => value(next, depth + 1));
  return Object.fromEntries(Array.from({ length: count }, () => [KEYS[Math.floor(next() * KEYS.length)], value(next, depth + 1)]));
}

describe("streaming JSON scrub", () => {
  it("drops a withheld member wherever it sits, with the commas still right", () => {
    const body = {
      resumeCursors: { agent: "first" },
      bots: [
        { id: "b1", sshAlias: "box", tasks: [{ id: "t1", resumeCursors: { a: [1, { b: 2 }] } }] },
        { vpsAlias: "only" },
        { id: "b3", vpsAliases: ["x", "y"] },
      ],
      last: 1,
      vpsAlias: null,
    };
    const out = run(JSON.stringify(body));
    expect(out).toBe(expected(body));
    expect(JSON.parse(out)).toEqual({ bots: [{ id: "b1", tasks: [{ id: "t1" }] }, {}, { id: "b3" }], last: 1 });
  });

  it("withholds a key spelled with escapes, as JSON.parse on the device would read it", () => {
    const out = run('{"keep":1,"resume\\u0043ursors":{"agent":"cursor-value"},"ssh\\u0041lias":"box"}');
    expect(out).toBe('{"keep":1}');
  });

  it("keeps a message that merely mentions a withheld key", () => {
    const body = { text: '{"resumeCursors":{"agent":"x"}}', resumeCursors: 1 };
    expect(run(JSON.stringify(body))).toBe(JSON.stringify({ text: body.text }));
  });

  it("agrees with scrub on random bodies, pretty or compact, split anywhere", () => {
    const next = random(7);
    for (let n = 0; n < 400; n++) {
      const body = value(next, 0);
      const text = JSON.stringify(body, null, n % 3 === 0 ? 2 : undefined);
      for (const size of [0, 1, 2, 7]) expect(run(text, size)).toBe(expected(body));
    }
  });

  it("takes top-level atoms and surrounding whitespace", () => {
    expect(run(" 12 ")).toBe("12");
    expect(run("1", 1)).toBe("1");
    expect(run('"text"')).toBe('"text"');
    expect(run("null\n")).toBe("null");
  });

  it("refuses everything that is not strict JSON", () => {
    const refused = [
      "", "   ", "{", "[1,]", '{"a":1,}', "{,}", "[1 2]", '{"a" 1}', '{"a":1]', "[1}", "]", "01", "1.", "-", "tru", "nul",
      "undefined", "NaN", "'x'", '"\\x"', '"\\u12G4"', '"tab\there"', '"open', "{} {}", "1 2", '{"a":1}x', "﻿{}",
      '{a:1}', "[1,,2]",
    ];
    for (const body of refused) {
      expect(() => JSON.parse(body), body).toThrow();
      expect(() => run(body), body).toThrow(/not JSON/);
      expect(() => run(body, 1), body).toThrow(/not JSON/);
    }
  });

  it("bounds nesting with its own stack rather than the runtime's", () => {
    expect(run(`${"[".repeat(1_000)}${"]".repeat(1_000)}`)).toBe(`${"[".repeat(1_000)}${"]".repeat(1_000)}`);
    expect(() => run(`${"[".repeat(1_001)}${"]".repeat(1_001)}`)).toThrow(/too deep/);
  });
});
