// Reference definitions and footnotes are resolved across the whole text.
const DOCUMENT_WIDE_SYNTAX = /^ {0,3}\[[^\]\n]+\]:|\[\^/m;
const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})/;
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const BLANK = /^[ \t]*$/;
// CommonMark 0.31 HTML blocks of kinds 1 to 5 run past blank lines until their own end marker.
const LONG_HTML = /^ {0,3}<(?:(script|pre|style|textarea)(?=[\s>]|$)|(!--)|(\?)|(!\[CDATA\[)|(![A-Za-z]))/i;
const LONG_HTML_ENDS = [/<\/(?:script|pre|style|textarea)>/i, /-->/, /\?>/, /\]\]>/, />/];
const SHORT_HTML = /^ {0,3}<[A-Za-z/]/;
const MATH_DELIMITER = /\$\$|\\[[\]()]/;
const MATH_UNSAFE = /\$\$|\\[[\]()]|`|~~~|\]\(/;
const ONE_LINE_MATH = /^(?:\$\$(?!\$)(.+)(?<!\$)\$\$|\\\[(.+)\\\])$/;

/** Whether math normalization could change `text`: without these it is returned as it came. */
export function mayHoldMath(text: string): boolean {
  return text.includes("$") || text.includes("\\(") || text.includes("\\[") || text.includes("\u0000");
}

/** A line whose only math delimiters are `\(…\)` pairs that open and close on it. */
function inlineMathOnly(line: string): boolean {
  return !/\$\$|\\[[\]]|`|\]\(/.test(line) && !/\\[()]/.test(line.replace(/\\\(.*?\\\)/g, ""));
}

/**
 * Cuts Markdown at blank lines that close every open block, so each piece renders exactly as it would inside the whole
 * text. Null when the text uses syntax that spans blocks. Display math is cut around only when it stands alone from
 * column one (`$$` or `\[` lines, or one line holding both ends); after any other display delimiter nothing is cut.
 */
export function splitMarkdownBlocks(text: string): string[] | null {
  if (text.includes("\r") || DOCUMENT_WIDE_SYNTAX.test(text)) return null;
  const blocks: string[] = [];
  let blockStart = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let fenceIndent = 0;
  let htmlEnd: RegExp | null = null;
  let mathEnd: string | null = null;
  let afterBlankLine = true;
  let listLike = false;
  let maybeHtml = false;
  let afterCode = false;
  for (const line of text.split("\n")) {
    const opener = FENCE_OPENER.exec(line)?.[1];
    if (fence !== null) {
      // A line left of an indented fence may end the list item holding it, which is not tracked.
      if (/\S/.test(line.slice(0, fenceIndent))) break;
      if (opener && opener[0] === fence[0] && opener.length >= fence.length && line.trim() === opener) fence = null;
    } else if (mathEnd !== null) {
      if (line === mathEnd) mathEnd = null;
      else if (MATH_UNSAFE.test(line)) break;
    } else if (htmlEnd !== null) {
      if (MATH_DELIMITER.test(line)) break;
      if (htmlEnd.test(line)) htmlEnd = null;
    } else if (BLANK.test(line)) {
      afterBlankLine = true;
      maybeHtml = false;
    } else {
      // Up to its blank line an HTML block holds fence lines as text, and whether a tag opens one is not tracked.
      // A tag line inside an HTML block is its text, not the start of one that runs past blank lines.
      if (maybeHtml && LONG_HTML.test(line)) break;
      maybeHtml ||= SHORT_HTML.test(line);
      if (maybeHtml && opener) break;
      const marker = LIST_MARKER.test(line);
      // micromark 4 reads the line after indented code as interrupting it, which changes what a quote, a tag or a
      // table row there opens.
      const continues = marker ? listLike : /^[ \t]/.test(line) || (afterCode && /^>|[<|]/.test(line));
      if (afterBlankLine && lineStart > blockStart && !continues) {
        blocks.push(text.slice(blockStart, lineStart));
        blockStart = lineStart;
        listLike = false;
      }
      if (MATH_DELIMITER.test(line)) {
        const opensBlock = afterBlankLine && lineStart === blockStart;
        if (opensBlock && (line === "$$" || line === "\\[")) mathEnd = line === "$$" ? "$$" : "\\]";
        else if (opensBlock && ONE_LINE_MATH.test(line)) {
          const inner = ONE_LINE_MATH.exec(line)!;
          if (MATH_UNSAFE.test(inner[1] ?? inner[2]!)) break;
        } else if (!inlineMathOnly(line)) break;
      }
      listLike ||= marker || /^[ \t]/.test(line);
      afterCode = /^(?: {4}|\t)/.test(line);
      afterBlankLine = false;
      fence = opener ?? null;
      if (opener) fenceIndent = line.indexOf(opener);
      const html = fence === null && mathEnd === null ? LONG_HTML.exec(line) : null;
      if (html) {
        const end = LONG_HTML_ENDS[html.slice(1).findIndex((kind) => kind !== undefined)]!;
        if (!end.test(line.slice(html[0].length))) htmlEnd = end;
      }
    }
    lineStart += line.length + 1;
  }
  blocks.push(text.slice(blockStart));
  return blocks;
}

/** A streamed block that is one list or one table, cut so that only its last piece is still being written. */
export type StreamPieces =
  | { kind: "list"; lead: string; items: string[]; loose: boolean }
  | { kind: "table"; head: string; rows: string[] };

const TABLE_HEADER = /^\|[^`\\]*\| *$/;
const TABLE_DELIMITER = /^\|(?: *:?-+:? *\|)+ *$/;
const pipes = (line: string) => line.split("|").length - 1;

function tablePieces(lines: string[]): StreamPieces | null {
  const [header, delimiter] = lines;
  if (delimiter === undefined || !TABLE_HEADER.test(header!) || !TABLE_DELIMITER.test(delimiter)) return null;
  // One column is left whole: table repair rewrites some of its rows.
  if (pipes(header!) < 3 || pipes(header!) !== pipes(delimiter)) return null;
  const rows: string[] = [];
  for (let index = 2; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.startsWith("|")) rows.push(index < lines.length - 1 ? `${line}\n` : line);
    else if (BLANK.test(line) && lines.slice(index).every((rest) => BLANK.test(rest))) {
      const tail = lines.slice(index).join("\n");
      if (rows.length === 0) return null;
      rows[rows.length - 1] += tail;
      break;
    } else return null;
  }
  return { kind: "table", head: lines.length > 2 ? `${header}\n${delimiter}\n` : `${header}\n${delimiter}`, rows };
}

const ITEM = /^([-*+]|\d{1,9}([.)]))(?:( +)(.*))?$/;
const THEMATIC_BREAK = /^([-*_])(?: *\1){2,} *$/;
const ANY_FENCE = /^( *)(`{3,}|~{3,})/;
const LEAD_UNSAFE = /^[ <>|`~]|\|/;
const LEAD_ITEM = /^[\p{L}\p{N}*_`[("']/u;

function listPieces(text: string, lines: string[]): StreamPieces | null {
  const first = lines.findIndex((line) => ITEM.test(line));
  if (first < 0) return null;
  const opening = ITEM.exec(lines[first]!)!;
  const kind = opening[2] ?? opening[1]!;
  if (first > 0) {
    // Below a paragraph only a bullet with text, or "1" with text, starts a list, and what that text may open differs.
    if (lines.slice(0, first).some((line) => BLANK.test(line) || LEAD_UNSAFE.test(line))) return null;
    if (opening[2] !== undefined && opening[1] !== `1${opening[2]}`) return null;
    if ((opening[3] ?? "").length > 4 || !LEAD_ITEM.test(opening[4] ?? "") || ITEM.test(opening[4]!)) return null;
  }
  const starts: number[] = [];
  let offset = 0;
  let at = 0;
  let fence: { mark: string; indent: number } | null = null;
  let blank = false;
  let blankInside = false;
  let blankBetween = false;
  for (const [index, line] of lines.entries()) {
    const lineStart = at;
    at += line.length + 1;
    if (index < first) continue;
    if (fence) {
      if (/\S/.test(line.slice(0, fence.indent))) return null;
      const closer = ANY_FENCE.exec(line)?.[2];
      if (closer && closer[0] === fence.mark[0] && closer.length >= fence.mark.length && line.trim() === closer) fence = null;
      continue;
    }
    if (BLANK.test(line)) {
      blank = true;
      continue;
    }
    let body = line;
    if (line[0] !== " ") {
      const item = ITEM.exec(line);
      if (item && (item[2] ?? item[1]) === kind && !THEMATIC_BREAK.test(line)) {
        if (blank) blankBetween = true;
        starts.push(lineStart);
        const content = item[4] ?? "";
        const gap = item[3]?.length ?? 0;
        const code = content !== "" && gap > 4;
        offset = item[1]!.length + (content === "" || code ? 1 : gap);
        body = code ? "" : " ".repeat(offset) + content;
        // An item that opens with an empty line holds only what follows that line directly.
        if (content === "" && BLANK.test(lines[index + 1] ?? "x") && lines.slice(index + 2).find((rest) => !BLANK.test(rest))?.[0] === " ") return null;
      } else if (!(index === lines.length - 1 && !blank && opening[2] !== undefined && /^\d{1,9}$/.test(line))) {
        // Only digits that may yet become this list's next marker are let through as a last line.
        return null;
      }
    } else {
      if (line.length - line.trimStart().length < offset) return null;
      if (blank) blankInside = true;
    }
    blank = false;
    // An HTML block inside an item holds fence lines as text, which the fence tracking here would misread.
    if (body.trimStart().startsWith("<")) return null;
    const opener = ANY_FENCE.exec(body);
    if (opener) fence = { mark: opener[2]!, indent: opener[1]!.length };
  }
  if (blankInside && !blankBetween) return null;
  return { kind: "list", lead: text.slice(0, starts[0]), items: starts.map((start, index) => text.slice(start, starts[index + 1])), loose: blankBetween };
}

/**
 * Cuts a block that is one list into its top-level items, or one table into its header and rows, when each piece
 * parsed alone gives what it gives inside the block. Null for anything else, and for text that normalization or table
 * repair could rewrite.
 */
export function splitStreamPieces(block: string): StreamPieces | null {
  if (mayHoldMath(block) || /[\t\r]/.test(block)) return null;
  const lines = block.split("\n");
  return block.startsWith("|") ? tablePieces(lines) : listPieces(block, lines);
}

/** A block that is one code fence still being written, from its first column: its info string and code so far. */
export function openFence(block: string): { info: string; code: string } | null {
  const newline = block.indexOf("\n");
  const first = newline < 0 ? block : block.slice(0, newline);
  const opener = /^(`{3,}|~{3,})(.*)$/.exec(first);
  if (!opener || (opener[1]![0] === "`" && opener[2]!.includes("`"))) return null;
  const code = newline < 0 ? "" : block.slice(newline + 1);
  const closing = new RegExp(`^ {0,3}${opener[1]![0] === "`" ? "`" : "~"}{${opener[1]!.length},}[ \\t]*$`, "m");
  if (closing.test(code)) return null;
  return { info: opener[2]!.trim(), code: code.replace(/\n$/, "") };
}

/** Whether the fenced code at `start..end` of `source` has its closing fence. */
export function closedFence(source: string, start: number | undefined, end: number | undefined): boolean {
  if (start === undefined || end === undefined) return true;
  const value = source.slice(start, end);
  const opener = FENCE_OPENER.exec(value)?.[1];
  if (!opener) return true;
  if (!value.includes("\n")) return false;
  const lastLine = value.slice(value.lastIndexOf("\n") + 1);
  return new RegExp(`^ {0,3}${opener[0] === "`" ? "`" : "~"}{${opener.length},}[ \\t]*$`).test(lastLine);
}
