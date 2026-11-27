// A native <select> keeps the platform arrow, whose inset padding cannot move (about 6px on Linux Chrome, wider on macOS).
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");

const tags = readdirSync(src, { recursive: true, encoding: "utf8" })
  .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
  .flatMap((name) => {
    const source = readFileSync(join(src, name), "utf8");
    let line = 1;
    let counted = 0;
    return [...source.matchAll(/<([sS]elect)\b/g)].map((match) => {
      for (; counted < match.index; counted++) if (source[counted] === "\n") line++;
      let depth = 0;
      let end = match.index;
      for (; end < source.length; end++) {
        if (source[end] === "{") depth++;
        else if (source[end] === "}") depth--;
        else if (source[end] === ">" && depth === 0) break;
      }
      return { at: `${name}:${line}`, native: match[1] === "select", file: name, text: source.slice(match.index, end) };
    });
  });

function attribute(tag: string, name: string): string {
  const start = tag.search(new RegExp(`\\b${name}=`));
  if (start === -1) return "";
  const open = start + name.length + 1;
  if (tag[open] === '"') return tag.slice(open, tag.indexOf('"', open + 1) + 1);
  let depth = 0;
  let end = open;
  for (; end < tag.length; end++) {
    if (tag[end] === "{") depth++;
    else if (tag[end] === "}" && --depth === 0) break;
  }
  return tag.slice(open, end + 1);
}

const LAYOUT = /^(?:sm:)?(?:w-\S+|flex-1|shrink-0|hidden|font-mono|max-w-\S+|min-w-\S+|m[trblxy]?-\S+)$/;

describe("dropdowns", () => {
  it("use <Select> rather than a native <select>", () => {
    const raw = tags.filter(({ native, file, text }) => native && file !== join("components", "Select.tsx")
      // An invisible <select> laid over a custom button shows no arrow to align.
      && !/\bopacity-0\b/.test(text)
      // Bot-built widgets draw their own fields and chevron in the widget kit's style.
      && !file.startsWith(join("components", "widget") + sep));
    expect(raw.map(({ at }) => at)).toEqual([]);
  });

  it("are positioned by their call site, never restyled", () => {
    const restyled = tags.filter(({ native, text }) => {
      if (native) return false;
      const value = attribute(text, "className");
      const classes = [...value.matchAll(/"([^"]*)"/g)].flatMap((literal) => literal[1]!.split(/\s+/)).filter(Boolean);
      return classes.some((name) => !LAYOUT.test(name));
    });
    expect(restyled.map(({ at }) => at)).toEqual([]);
  });
});
