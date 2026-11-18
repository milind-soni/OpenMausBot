// Reads an anchored request-path pattern (`/^\/api\/bots\/([\w-]+)$/`) as the OpenAPI path templates it matches, for
// scripts/route-list.ts. Literal alternatives and optional parts expand into one path each; variable parts become `{name}`
// slots named after the segment before them; a part that can span `/` makes the path a prefix. Anything it cannot read as
// a path (a lookaround, an anchor inside, no `^`) throws, and route-list.ts reports that pattern instead of dropping it.

/** The end of a group or class starting at `i` (the index of its opening bracket). */
function closing(src: string, i: number, open: string, close: string): number {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") { j++; continue; }
    if (open === "(" && c === "[") { j = closing(src, j, "[", "]"); continue; }
    if (c === open && (open !== "[" || j === i)) depth++;
    else if (c === close) { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/** Split on top-level `|`. */
function alternatives(src: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let j = 0; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") { j++; continue; }
    if (c === "[") { j = closing(src, j, "[", "]"); continue; }
    if (c === "(") { j = closing(src, j, "(", ")"); continue; }
    if (c === "|") { out.push(src.slice(start, j)); start = j + 1; }
  }
  out.push(src.slice(start));
  return out;
}

const PARAM = "\u0000";
/** A part that can span `/` (`.+`, `[^?]*`): the reading is a prefix, everything below the text before it. */
const TAIL = "\u0001";
/** One character that may be `/` (a bare `.`), before its quantifier is known. */
const SLASHY = "\u0002";

/**
 * The literal readings of a pattern body, with PARAM where a segment is variable. Throws on what it cannot read.
 * Variable parts (a class, `.`, `\w`, `\d`, a quantified atom) collapse into one PARAM; literal alternations and optional
 * literal groups expand into one reading each, so `(?:read|done)` gives two paths and `(?:\/count)?` gives two.
 */
function readings(src: string): string[] {
  let outs = [""];
  const add = (piece: string[]) => { outs = outs.flatMap((o) => piece.map((p) => o + p)); };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    let atom: string[];
    let variable = false;
    let next = i + 1;
    if (c === "\\") {
      const e = src[i + 1];
      next = i + 2;
      if ("wdsWDSb".includes(e)) { atom = [PARAM]; variable = true; }
      else atom = [e];
    } else if (c === "[") {
      next = closing(src, i, "[", "]") + 1;
      if (next === 0) throw new Error("unclosed class");
      const cls = src.slice(i, next);
      // A class that admits `/` (`[^?]`, `[\s\S]`) can cross segments; one that names its characters cannot.
      atom = [(cls.startsWith("[^") && !cls.includes("/")) || cls.includes("\\S") ? SLASHY : PARAM];
      variable = true;
    } else if (c === "(") {
      const end = closing(src, i, "(", ")");
      if (end < 0) throw new Error("unclosed group");
      let body = src.slice(i + 1, end);
      const capturing = !body.startsWith("?");
      if (body.startsWith("?:")) body = body.slice(2);
      else if (body.startsWith("?<") && !body.startsWith("?<=") && !body.startsWith("?<!")) body = body.slice(body.indexOf(">") + 1);
      else if (body.startsWith("?")) throw new Error("lookaround");
      // A group keeps its literal parts: `(?:\/([\w-]+))?` is "/{id}" or nothing, `(p_[\w-]{22})` is "p_{id}". One capture
      // whose value has several variable parts within one segment (a UUID's five) is one parameter, not five.
      atom = alternatives(body).flatMap(readings);
      variable = atom.some((r) => r.includes(PARAM) || r.includes(SLASHY) || r.includes(TAIL));
      const slots = (r: string) => (r.replace(new RegExp(`[${PARAM}${SLASHY}]+`, "g"), PARAM).match(new RegExp(PARAM, "g")) ?? []).length;
      if (capturing && variable && !atom.some((r) => r.includes("/") || r.includes(TAIL)) && atom.some((r) => slots(r) > 1)) atom = [PARAM];
      next = end + 1;
    } else if (c === ".") {
      atom = [SLASHY];
      variable = true;
    } else if ("^$".includes(c)) {
      throw new Error("anchor inside the pattern");
    } else {
      atom = [c];
    }
    // Quantifiers.
    const q = src[next];
    if (q === "?") {
      atom = [...atom, ""];
      next++;
    } else if (q === "*" || q === "+" || q === "{") {
      if (q === "{") next = src.indexOf("}", next) + 1;
      else next++;
      if (src[next] === "?") next++;
      // Repeated, a part that admits `/` spans segments.
      atom = atom.map((a) => (a.includes(SLASHY) ? TAIL : PARAM));
    }
    add(atom);
    i = next;
  }
  // Adjacent variable parts are one slot; a lone `.` is one character of a segment.
  return [...new Set(outs.map((o) => o.replace(new RegExp(SLASHY, "g"), PARAM).replace(new RegExp(`${PARAM}+`, "g"), PARAM)))];
}

/** Parameter names for a reading: from the segment before the slot (`bots` gives `botId`), unique within the path. */
export function nameParams(reading: string, given: string[] = []): string {
  const used = new Map<string, number>();
  let k = 0;
  const segments = reading.split("/");
  return segments.map((segment, index) => {
    if (!segment.includes(PARAM)) return segment;
    return segment.replace(new RegExp(PARAM, "g"), () => {
      let base = given[k++];
      if (!base) {
        const before = segments.slice(0, index).reverse().find((s) => s && !s.includes(PARAM) && !s.includes("{"));
        base = before ? `${before.replace(/[^A-Za-z0-9]+(.)/g, (_, ch: string) => ch.toUpperCase()).replace(/(ies)$/, "y").replace(/s$/, "")}Id` : "param";
      }
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      return `{${n === 1 ? base : `${base}${n}`}}`;
    });
  }).join("/");
}

/** Path templates an anchored request-path pattern matches. Throws when it is not one. */
export function templatesOf(pattern: string): { paths: string[]; prefixes: string[] } {
  if (!pattern.startsWith("^")) throw new Error("pattern is not anchored at the start");
  let body = pattern.slice(1);
  let open = true;
  if (body.endsWith("$") && !body.endsWith("\\$")) { body = body.slice(0, -1); open = false; }
  // `(?:\/|$)` at the end: this path and everything under it.
  else if (body.endsWith("(?:\\/|$)")) body = body.slice(0, -"(?:\\/|$)".length);
  const names = [...pattern.matchAll(/\(\?<([A-Za-z_]\w*)>/g)].map((m) => m[1]);
  const paths = new Set<string>();
  const prefixes = new Set<string>();
  for (const r of alternatives(body).flatMap(readings)) {
    const tail = r.indexOf(TAIL);
    if (tail >= 0 && tail !== r.length - 1) throw new Error("a part that spans segments is followed by more of the path");
    const path = nameParams(tail >= 0 ? r.slice(0, tail) : r, names);
    if (!path.startsWith("/")) throw new Error(`reads as ${JSON.stringify(path)}, not a path`);
    (open || tail >= 0 ? prefixes : paths).add(path);
  }
  return { paths: [...paths], prefixes: [...prefixes] };
}
