// Obsidian-flavoured Markdown on top of react-markdown + GFM: frontmatter
// properties, callouts (> [!note] Title), ==highlights==, [[wikilinks]] and
// #tags. Everything becomes ordinary elements with class names; no raw HTML.

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};

export interface Frontmatter {
  properties: Array<[string, string]>;
  body: string;
  /** Lines taken by the frontmatter block, so source line numbers can be mapped back. */
  lineOffset: number;
}

export function splitFrontmatter(source: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) return { properties: [], body: source, lineOffset: 0 };
  const properties: Array<[string, string]> = [];
  let current: [string, string] | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([^\s:#][^:]*):\s*(.*)$/.exec(line);
    if (pair) {
      current = [pair[1].trim(), pair[2].trim().replace(/^["']|["']$/g, "")];
      properties.push(current);
    } else if (current && /^\s+-\s+/.test(line)) {
      const item = line.replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, "");
      current[1] = current[1] ? `${current[1]}, ${item}` : item;
    }
  }
  return { properties, body: source.slice(match[0].length), lineOffset: match[0].split("\n").length - 1 };
}

const element = (hName: string, className: string, children: MdNode[], extra: Record<string, unknown> = {}): MdNode => ({
  type: "obsidian",
  children,
  data: { hName, hProperties: { className: [className], ...extra } },
});

const CALLOUT = /^\[!([\w-]+)\]([+-]?)[ \t]*/;

function transformCallout(node: MdNode): void {
  const first = node.children?.[0];
  const text = first?.type === "paragraph" ? first.children?.[0] : undefined;
  if (!first || text?.type !== "text" || !text.value) return;
  const match = CALLOUT.exec(text.value);
  if (!match) return;
  const type = match[1].toLowerCase();
  const rest = text.value.slice(match[0].length);
  const newline = rest.indexOf("\n");
  // The title is the rest of the marker line, including any inline nodes before the first newline.
  const titleChildren: MdNode[] = [];
  if (newline === -1) {
    if (rest) titleChildren.push({ type: "text", value: rest });
    let i = 1;
    for (; i < first.children!.length; i++) {
      const child = first.children![i];
      if (child.type === "text" && child.value?.includes("\n")) {
        const at = child.value.indexOf("\n");
        if (at > 0) titleChildren.push({ type: "text", value: child.value.slice(0, at) });
        child.value = child.value.slice(at + 1);
        break;
      }
      titleChildren.push(child);
    }
    first.children = first.children!.slice(i);
  } else {
    if (newline > 0) titleChildren.push({ type: "text", value: rest.slice(0, newline) });
    text.value = rest.slice(newline + 1);
  }
  if (!titleChildren.length) titleChildren.push({ type: "text", value: type.charAt(0).toUpperCase() + type.slice(1) });
  const body = first.children!.length && !(first.children!.length === 1 && first.children![0].type === "text" && !first.children![0].value)
    ? node.children!
    : node.children!.slice(1);
  node.type = "obsidian";
  node.data = { hName: "div", hProperties: { className: ["callout"], "data-callout": type } };
  node.children = [
    element("div", "callout-title", titleChildren),
    ...(body.length ? [element("div", "callout-content", body)] : []),
  ];
}

const INLINE = /(==(?=\S)([^=\n]*?\S)==)|(\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\])|((?:^|(?<=[\s(]))#([A-Za-z_][\w/-]*))/g;

function splitInline(value: string): MdNode[] | null {
  INLINE.lastIndex = 0;
  if (!INLINE.test(value)) return null;
  INLINE.lastIndex = 0;
  const out: MdNode[] = [];
  let last = 0;
  for (const m of value.matchAll(INLINE)) {
    const start = m.index!;
    if (start > last) out.push({ type: "text", value: value.slice(last, start) });
    if (m[1]) out.push(element("mark", "md-highlight", [{ type: "text", value: m[2] }]));
    else if (m[3]) out.push(element("span", "internal-link", [{ type: "text", value: (m[5] ?? m[4]).trim() }], { title: m[4].trim() }));
    else out.push(element("span", "tag", [{ type: "text", value: `#${m[7]}` }]));
    last = start + m[0].length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function walk(node: MdNode): void {
  if (!node.children) return;
  if (node.type === "blockquote") transformCallout(node);
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value) {
      const parts = splitInline(child.value);
      if (parts) { next.push(...parts); continue; }
    }
    walk(child);
    next.push(child);
  }
  node.children = next;
}

/** remark plugin: callouts, highlights, wikilinks and tags. */
export function remarkObsidian() {
  return (tree: MdNode) => walk(tree);
}

/** Toggle the task checkbox on a 1-based source line ("- [ ]" <-> "- [x]"). */
export function toggleTaskLine(source: string, line: number): string {
  const lines = source.split("\n");
  const index = line - 1;
  if (index < 0 || index >= lines.length) return source;
  const next = lines[index].replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/, (_m, a, mark, b) => `${a}${mark === " " ? "x" : " "}${b}`);
  if (next === lines[index]) return source;
  lines[index] = next;
  return lines.join("\n");
}
