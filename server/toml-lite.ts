// Enough TOML 1.0 to read a Codex config.toml without a dependency: tables, arrays of tables, dotted keys, every
// string form, numbers, booleans, arrays and inline tables. Dates and times stay text. Tables have no prototype, so a
// key named __proto__ is only a key. Anything else is a TomlError, and the caller treats the file as unreadable.

export class TomlError extends Error {}

type Table = Record<string, unknown>;

const table = (): Table => Object.create(null) as Table;
const isTable = (value: unknown): value is Table => typeof value === "object" && value !== null && !Array.isArray(value);
const BARE_KEY = /[A-Za-z0-9_-]/;
const VALUE_END = /[\s,\]}#]/;
const MAX_DEPTH = 64;
/** Dotted keys and table headers nest too: without a cap one header of many parts is a table too deep to walk. */
const MAX_KEY_PARTS = 16;

export function parseToml(source: string): Table {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  let i = 0;
  const root = table();
  let current = root;

  const fail = (message: string): never => {
    throw new TomlError(`line ${text.slice(0, i).split("\n").length}: ${message}`);
  };
  const spaces = () => {
    while (text[i] === " " || text[i] === "\t") i++;
  };
  const comment = () => {
    if (text[i] === "#") while (i < text.length && text[i] !== "\n") i++;
  };
  const newline = (): boolean => {
    if (text[i] === "\n") i += 1;
    else if (text[i] === "\r" && text[i + 1] === "\n") i += 2;
    else return false;
    return true;
  };
  /** Spaces, comments and line breaks: between statements, and inside arrays and inline tables. */
  const blank = () => {
    for (;;) {
      spaces();
      comment();
      if (!newline()) return;
    }
  };
  const endOfLine = () => {
    spaces();
    comment();
    if (i < text.length && !newline()) fail("expected the end of the line");
  };

  function escape(): string {
    const code = text[i + 1];
    i += 2;
    switch (code) {
      case "b": return "\b";
      case "t": return "\t";
      case "n": return "\n";
      case "f": return "\f";
      case "r": return "\r";
      case "e": return "\x1b";
      case '"': return '"';
      case "\\": return "\\";
      case "u":
      case "U": {
        const length = code === "u" ? 4 : 8;
        const hex = text.slice(i, i + length);
        if (hex.length !== length || !/^[0-9A-Fa-f]+$/.test(hex)) fail("invalid unicode escape");
        const point = parseInt(hex, 16);
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) fail("invalid unicode escape");
        i += length;
        return String.fromCodePoint(point);
      }
      default:
        return fail("invalid escape");
    }
  }

  function basicString(): string {
    if (text.startsWith('"""', i)) return multilineBasicString();
    i += 1;
    let out = "";
    for (;;) {
      const char = text[i];
      if (char === undefined || char === "\n" || char === "\r") fail("unterminated string");
      if (char === '"') {
        i += 1;
        return out;
      }
      if (char === "\\") out += escape();
      else {
        out += char;
        i += 1;
      }
    }
  }

  function multilineBasicString(): string {
    i += 3;
    newline();
    let out = "";
    for (;;) {
      if (i >= text.length) fail("unterminated string");
      if (text.startsWith('"""', i)) {
        let extra = 0;
        while (extra < 2 && text[i + 3 + extra] === '"') extra++;
        i += 3 + extra;
        return out + '"'.repeat(extra);
      }
      if (text[i] === "\\") {
        let next = i + 1;
        while (text[next] === " " || text[next] === "\t") next++;
        if (text[next] === "\n" || (text[next] === "\r" && text[next + 1] === "\n")) {
          i = next;
          while (i < text.length && /[ \t\r\n]/.test(text[i]!)) i++;
          continue;
        }
        out += escape();
        continue;
      }
      out += text[i];
      i += 1;
    }
  }

  function literalString(): string {
    if (text.startsWith("'''", i)) {
      i += 3;
      newline();
      const close = text.indexOf("'''", i);
      if (close < 0) fail("unterminated string");
      let extra = 0;
      while (extra < 2 && text[close + 3 + extra] === "'") extra++;
      const out = text.slice(i, close + extra);
      i = close + 3 + extra;
      return out;
    }
    i += 1;
    const close = text.indexOf("'", i);
    const lineEnd = text.indexOf("\n", i);
    if (close < 0 || (lineEnd >= 0 && lineEnd < close)) fail("unterminated string");
    const out = text.slice(i, close);
    i = close + 1;
    return out;
  }

  function simpleKey(): string {
    if (text[i] === '"') return basicString();
    if (text[i] === "'") return literalString();
    const start = i;
    while (i < text.length && BARE_KEY.test(text[i]!)) i++;
    if (i === start) fail("expected a key");
    return text.slice(start, i);
  }

  function key(): string[] {
    const parts: string[] = [];
    for (;;) {
      spaces();
      parts.push(simpleKey());
      spaces();
      if (text[i] !== ".") return parts;
      if (parts.length >= MAX_KEY_PARTS) fail("key has too many parts");
      i += 1;
    }
  }

  function assign(target: Table, path: readonly string[], value: unknown) {
    let at = target;
    for (const part of path.slice(0, -1)) {
      const existing = at[part];
      if (existing === undefined) {
        const next = table();
        at[part] = next;
        at = next;
      } else if (isTable(existing)) {
        at = existing;
      } else {
        fail(`${JSON.stringify(part)} is not a table`);
      }
    }
    const last = path[path.length - 1]!;
    if (Object.hasOwn(at, last)) fail(`${JSON.stringify(last)} is defined twice`);
    at[last] = value;
  }

  function scalar(): unknown {
    const start = i;
    while (i < text.length && !VALUE_END.test(text[i]!)) i++;
    // An offset date-time may put one space between its date and its time.
    if (/^\d{4}-\d{2}-\d{2}$/.test(text.slice(start, i)) && text[i] === " " && /\d/.test(text[i + 1] ?? "")) {
      i += 1;
      while (i < text.length && !VALUE_END.test(text[i]!)) i++;
    }
    const raw = text.slice(start, i);
    if (!raw) fail("expected a value");
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^[+-]?(?:inf|nan)$/.test(raw)) return raw.endsWith("nan") ? Number.NaN : raw.startsWith("-") ? -Infinity : Infinity;
    const digits = raw.replace(/_/g, "");
    if (/^0x[0-9A-Fa-f]+$/.test(digits)) return parseInt(digits.slice(2), 16);
    if (/^0o[0-7]+$/.test(digits)) return parseInt(digits.slice(2), 8);
    if (/^0b[01]+$/.test(digits)) return parseInt(digits.slice(2), 2);
    if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(digits)) return Number(digits);
    if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(raw)) return raw;
    return fail(`unknown value ${JSON.stringify(raw.slice(0, 24))}`);
  }

  function array(depth: number): unknown[] {
    i += 1;
    const out: unknown[] = [];
    for (;;) {
      blank();
      if (text[i] === "]") {
        i += 1;
        return out;
      }
      out.push(value(depth + 1));
      blank();
      if (text[i] === ",") i += 1;
      else if (text[i] !== "]") fail("expected , or ] in an array");
    }
  }

  function inlineTable(depth: number): Table {
    i += 1;
    const out = table();
    for (;;) {
      blank();
      if (text[i] === "}") {
        i += 1;
        return out;
      }
      const path = key();
      if (text[i] !== "=") fail("expected =");
      i += 1;
      spaces();
      assign(out, path, value(depth + 1));
      blank();
      if (text[i] === ",") i += 1;
      else if (text[i] !== "}") fail("expected , or } in an inline table");
    }
  }

  function value(depth: number): unknown {
    if (depth > MAX_DEPTH) fail("nested too deeply");
    if (text[i] === '"') return basicString();
    if (text[i] === "'") return literalString();
    if (text[i] === "[") return array(depth);
    if (text[i] === "{") return inlineTable(depth);
    return scalar();
  }

  function header() {
    const many = text.startsWith("[[", i);
    i += many ? 2 : 1;
    const path = key();
    if (many ? !text.startsWith("]]", i) : text[i] !== "]") fail("expected ]");
    i += many ? 2 : 1;
    endOfLine();
    let at = root;
    path.forEach((part, index) => {
      const existing = at[part];
      if (many && index === path.length - 1) {
        const list = existing === undefined ? [] : existing;
        if (!Array.isArray(list)) fail(`${JSON.stringify(part)} is not an array of tables`);
        const next = table();
        (list as unknown[]).push(next);
        at[part] = list;
        at = next;
      } else if (existing === undefined) {
        const next = table();
        at[part] = next;
        at = next;
      } else if (Array.isArray(existing) && isTable(existing[existing.length - 1])) {
        at = existing[existing.length - 1] as Table;
      } else if (isTable(existing)) {
        at = existing;
      } else {
        fail(`${JSON.stringify(part)} is not a table`);
      }
    });
    current = at;
  }

  for (;;) {
    blank();
    if (i >= text.length) return root;
    if (text[i] === "[") {
      header();
      continue;
    }
    const path = key();
    if (text[i] !== "=") fail("expected =");
    i += 1;
    spaces();
    assign(current, path, value(0));
    endOfLine();
  }
}
