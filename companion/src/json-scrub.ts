// `scrub` for a JSON body that arrives in pieces: the same withheld members are dropped, and memory is one chunk
// rather than the whole body. Strict JSON only. Anything else throws, because a structure this reader got wrong
// could hide a withheld key from it while the device's JSON.parse still found that key.
import { isWithheldKey } from "./wire.ts";

/** Real payloads nest a few dozen deep; the stack here is an array, so this only bounds a hostile body's memory. */
const MAX_DEPTH = 1_000;
/** Field names, never content: a key this long is not one of ours. */
const MAX_KEY_CHARS = 64 * 1024;
const MAX_ATOM_CHARS = 512;
const ATOM = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/;
const ATOM_START = /^[-0-9tfn]$/;
const ATOM_CHAR = /^[-+.0-9a-zA-Z]$/;
/** `"` `\` `/` b f n r t */
const ESCAPABLE = new Set([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74]);

// Where the reader is: what the next significant character may be.
const VALUE = 0;
const FIRST_VALUE = 1; // just after `[`
const FIRST_KEY = 2; // just after `{`
const KEY = 3; // after `,` in an object
const KEY_STRING = 4;
const COLON = 5;
const STRING = 6;
const ATOM_TEXT = 7;
const AFTER = 8; // a value just ended

const isHex = (c: number): boolean => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const isSpace = (char: string): boolean => char === " " || char === "\t" || char === "\n" || char === "\r";

export interface JsonScrubber {
  /** The scrubbed text this piece completes; it may be empty. Throws when the body is not JSON. */
  write(chunk: string): string;
  /** The rest; throws when the body stopped part-way through a value. */
  end(): string;
}

/** Re-emits the body compactly (no insignificant whitespace), commas placed by this reader so that dropping a
 * member never leaves a stray one. */
export function createJsonScrubber(): JsonScrubber {
  const stack: { object: boolean; members: number }[] = [];
  let state = VALUE;
  /** The depth whose current member is withheld; -1 while nothing is. */
  let dropDepth = -1;
  let key = "";
  let atom = "";
  let escape = false;
  let hex = 0;
  let out: string[] = [];

  const fail = (why: string): never => {
    throw new Error(`not JSON: ${why}`);
  };
  const emit = (text: string): void => {
    if (dropDepth < 0) out.push(text);
  };
  const valueDone = (): void => {
    state = AFTER;
    if (dropDepth === stack.length) dropDepth = -1;
  };
  const close = (char: string): void => {
    const top = stack.at(-1);
    if (!top || top.object !== (char === "}")) fail(`unbalanced ${char}`);
    emit(char);
    stack.pop();
    valueDone();
  };
  const startValue = (char: string): void => {
    const top = stack.at(-1);
    if (top && !top.object && top.members++ > 0) emit(",");
    if (char === "{" || char === "[") {
      if (stack.length >= MAX_DEPTH) fail("nested too deep");
      emit(char);
      stack.push({ object: char === "{", members: 0 });
      state = char === "{" ? FIRST_KEY : FIRST_VALUE;
    } else if (char === '"') {
      emit(char);
      state = STRING;
    } else if (ATOM_START.test(char)) {
      atom = char;
      state = ATOM_TEXT;
    } else {
      fail(`unexpected ${JSON.stringify(char)}`);
    }
  };
  const finishAtom = (): void => {
    if (!ATOM.test(atom)) fail(`bad value ${JSON.stringify(atom.slice(0, 32))}`);
    emit(atom);
    atom = "";
    valueDone();
  };
  /** The key is whole and checked by its decoded name, so an escaped spelling is withheld too. */
  const member = (): void => {
    const top = stack.at(-1)!;
    const name = JSON.parse(key) as string;
    if (dropDepth < 0 && isWithheldKey(name)) {
      dropDepth = stack.length;
    } else {
      emit(`${top.members > 0 ? "," : ""}${key}:`);
      top.members++;
    }
    key = "";
    state = VALUE;
  };

  /** Consumes a string's characters up to and including its closing quote, or to the chunk's end. */
  const scanString = (chunk: string, from: number): { next: number; closed: boolean } => {
    let i = from;
    while (i < chunk.length) {
      const c = chunk.charCodeAt(i++);
      if (hex > 0) {
        if (!isHex(c)) fail("bad \\u escape");
        hex--;
      } else if (escape) {
        escape = false;
        if (c === 0x75) hex = 4;
        else if (!ESCAPABLE.has(c)) fail("bad escape");
      } else if (c === 0x5c) {
        escape = true;
      } else if (c === 0x22) {
        return { next: i, closed: true };
      } else if (c < 0x20) {
        fail("control character in a string");
      }
    }
    return { next: i, closed: false };
  };

  const write = (chunk: string): string => {
    out = [];
    let i = 0;
    while (i < chunk.length) {
      if (state === STRING || state === KEY_STRING) {
        const { next, closed } = scanString(chunk, i);
        const run = chunk.slice(i, next);
        i = next;
        if (state === STRING) {
          emit(run);
          if (closed) valueDone();
        } else {
          key += run;
          if (key.length > MAX_KEY_CHARS) fail("key too long");
          if (closed) state = COLON;
        }
        continue;
      }
      const char = chunk[i];
      if (state === ATOM_TEXT) {
        if (ATOM_CHAR.test(char)) {
          atom += char;
          if (atom.length > MAX_ATOM_CHARS) fail("value too long");
          i++;
        } else {
          finishAtom(); // the character is read again as what follows the value
        }
        continue;
      }
      i++;
      if (isSpace(char)) continue;
      if (state === VALUE) startValue(char);
      else if (state === FIRST_VALUE && char === "]") close(char);
      else if (state === FIRST_VALUE) startValue(char);
      else if (state === FIRST_KEY && char === "}") close(char);
      else if (state === FIRST_KEY || state === KEY) {
        if (char !== '"') fail("expected a key");
        key = char;
        state = KEY_STRING;
      } else if (state === COLON) {
        if (char !== ":") fail("expected :");
        member();
      } else if (char === "}" || char === "]") {
        close(char);
      } else if (char === "," && stack.length) {
        state = stack.at(-1)!.object ? KEY : VALUE;
      } else {
        fail(stack.length ? `unexpected ${JSON.stringify(char)}` : "data after the value");
      }
    }
    return out.join("");
  };

  return {
    write,
    end(): string {
      out = [];
      if (state === ATOM_TEXT && stack.length === 0) finishAtom();
      if (state !== AFTER || stack.length) fail("the body ended part-way through a value");
      return out.join("");
    },
  };
}
