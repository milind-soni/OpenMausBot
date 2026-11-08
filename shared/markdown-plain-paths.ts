// A file path a bot writes in prose or in backticks becomes a link to that file. Markdown has already decoded a text
// node's escapes, so "\\server\share" reads as "\server\share" there: paths are found in each node's source instead,
// and a Windows or UNC path keeps its spelling. The server and the client both run this on the same source, so the
// file authorized is the file rendered.

type Node = {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const SKIP = new Set(["link", "linkReference", "definition", "code", "html", "math", "inlineMath", "image", "imageReference"]);
const EXT = String.raw`\.[A-Za-z0-9]{1,10}`;
const POSIX_PART = String.raw`(?:[\w.@+~-]|\\[_*~.-])`;
const WIN_PART = String.raw`[^\s\\/:*?"<>|\x60()\[\]]`;
// A path needs a folder and a file name with an extension, so "and/or" or a lone "/etc" stays prose.
const PROSE_PATH = new RegExp(
  [
    String.raw`(?<![\w.~/\\:@-])\/(?:${POSIX_PART}+\/)+${POSIX_PART}*[\w@+~-]${EXT}(?![\w/\\])`,
    String.raw`(?<![\w\\/])[A-Za-z]:\\(?:${WIN_PART}+\\)*${WIN_PART}*[^\s\\/:*?"<>|\x60()\[\].]${EXT}(?![\w\\])`,
    String.raw`(?<![\w\\])\\\\${WIN_PART}+(?:\\${WIN_PART}+)+${EXT}(?![\w\\])`,
  ].join("|"),
  "g",
);
// In backticks the whole span is the path, so spaces are allowed and no extension is needed.
const CODE_PATH = /^(?:\/(?:[^\s/][^/]*\/)+[^/]+|[A-Za-z]:\\(?:[^\\]+\\?)+|\\\\[^\\]+(?:\\[^\\]+)+)$/;

/** Removes Markdown's backslash escapes, the one decoding a plain path's text goes through. */
const unescape = (raw: string): string => raw.replace(/\\([!-/:-@[-`{-~])/g, "$1");
const isPosix = (raw: string): boolean => raw.startsWith("/");

function splitText(node: Node, source: string): Node[] {
  const start = node.position?.start.offset, end = node.position?.end.offset, value = node.value;
  if (start === undefined || end === undefined || typeof value !== "string") return [node];
  const raw = source.slice(start, end);
  const out: Node[] = [];
  let cursor = 0;
  for (const match of raw.matchAll(PROSE_PATH)) {
    const spelled = match[0];
    // POSIX backslashes are Markdown escapes; Windows and UNC backslashes are the path.
    const decoded = unescape(spelled);
    const at = value.indexOf(decoded, cursor);
    if (at < 0) continue;
    if (at > cursor) out.push({ type: "text", value: value.slice(cursor, at) });
    const url = isPosix(spelled) ? decoded : spelled;
    out.push({ type: "link", url, children: [{ type: "text", value: url }] });
    cursor = at + decoded.length;
  }
  if (!out.length) return [node];
  if (cursor < value.length) out.push({ type: "text", value: value.slice(cursor) });
  return out;
}

/** Turns plain file paths under `tree` into links; `source` is the Markdown `tree` was parsed from. */
export function linkPlainPaths(tree: object, source: string): void {
  const visit = (node: Node) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child): Node[] => {
      if (SKIP.has(child.type)) return [child];
      if (child.type === "inlineCode") {
        const path = child.value?.trim() ?? "";
        return CODE_PATH.test(path) ? [{ type: "link", url: path, children: [child] }] : [child];
      }
      if (child.type === "text") return splitText(child, source);
      visit(child);
      return [child];
    });
  };
  visit(tree as Node);
}
