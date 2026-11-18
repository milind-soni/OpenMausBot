// Definitions, container directives, bracketed display math and raw HTML that runs past blank lines (comments,
// declarations, <script>, <pre>, <style>, <textarea>) can tie blocks together; so can "$$$", whose pairing is unclear.
const DOCUMENT_WIDE_SYNTAX = /^ {0,3}(?:\[(?!\^)[^\]\n]+\]:|:::|\\\[)|<[!?]|<(?:script|pre|style|textarea)\b|\$\$\$/im;
const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})/;
const MATH_FENCE = /^\$\$[ \t]*$/;
// After a blank line these still continue the previous block: a list item or indented content.
const CONTINUATION = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;

/**
 * Cuts Markdown at blank lines that close every open block, so each piece renders exactly as it would inside the whole
 * text. Footnotes number and collect across the text, so the first block that uses one runs to the end. Null when the
 * text uses syntax that spans blocks.
 */
export function splitMarkdownBlocks(text: string): string[] | null {
  if (text.includes("\r") || DOCUMENT_WIDE_SYNTAX.test(text)) return null;
  const blocks: string[] = [];
  let blockStart = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let fenceIndent = 0;
  let math = false;
  let afterBlankLine = false;
  for (const line of text.split("\n")) {
    const opener = FENCE_OPENER.exec(line)?.[1];
    if (fence !== null) {
      // A line left of an indented fence may end the list item holding it, which is not tracked.
      if (/\S/.test(line.slice(0, fenceIndent))) break;
      if (opener && opener[0] === fence[0] && opener.length >= fence.length && line.trim() === opener) fence = null;
    } else if (math) {
      if (MATH_FENCE.test(line)) math = false;
      else if (line.includes("$$")) return null;
    } else if (line.trim() === "") {
      afterBlankLine = true;
    } else {
      if (afterBlankLine && lineStart > blockStart && !CONTINUATION.test(line)) {
        blocks.push(text.slice(blockStart, lineStart));
        blockStart = lineStart;
      }
      afterBlankLine = false;
      fence = opener ?? null;
      if (opener) fenceIndent = line.indexOf(opener);
      // "$$" pairs in the order they come, so a line either opens display math alone or closes every pair it opens.
      else if (MATH_FENCE.test(line)) math = true;
      else if (line.split("$$").length % 2 === 0) return null;
    }
    lineStart += line.length + 1;
  }
  blocks.push(text.slice(blockStart));
  const footnoted = blocks.findIndex((block) => block.includes("[^"));
  if (footnoted >= 0) blocks.splice(footnoted, blocks.length, blocks.slice(footnoted).join(""));
  return blocks;
}

// Pieces are drawn from their own text: math, images and line ends that normalising rewrites across lines, and
// footnotes, which number across the text, stay whole.
const PIECE_UNSAFE = /[$\r]|\\[([]|!\[|\[\^/;
const TABLE_DELIMITER = /^\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*$/;
const LIST_ITEM = /^(?:([-*+])|\d{1,9}([.)])) +\S/;
const BARE_ITEM = /^(?:([-*+])|\d{1,9}([.)])) *$/;
const THEMATIC_BREAK = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** The last block of a streaming reply as a list's items or a table's rows, the last one still being written. */
export interface StreamPieces {
  kind: "list" | "table";
  /** Finished text above the list, drawn on its own. */
  head: string;
  /** Parsed before each piece: a table's header and delimiter rows. */
  lead: string;
  pieces: string[];
}

/**
 * Cuts a growing list between its items, or a growing table between its rows, so the finished ones parse once. Only a
 * tight list is cut (one blank line would make every item loose), only at column-0 items with the first one's marker,
 * and a table only at rows that start with "|". Null for any other shape.
 */
export function splitStreamingBlock(block: string): StreamPieces | null {
  if (PIECE_UNSAFE.test(block)) return null;
  const lines = block.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.some((line) => line.trim() === "" && line !== "")) return null;
  return tableRows(lines) ?? listItems(lines);
}

function tableRows(lines: string[]): StreamPieces | null {
  const [header, delimiter, ...rows] = lines;
  if (!header?.startsWith("|") || !delimiter || !TABLE_DELIMITER.test(delimiter) || !rows.length) return null;
  if (rows.some((row) => !row.startsWith("|"))) return null;
  return { kind: "table", head: "", lead: `${header}\n${delimiter}\n`, pieces: rows };
}

const sameMarker = (a: RegExpExecArray, b: RegExpExecArray) => a[1] === b[1] && a[2] === b[2];

function listItems(lines: string[]): StreamPieces | null {
  const start = lines.findIndex((line) => LIST_ITEM.test(line));
  if (start < 0) return null;
  const head = lines.slice(0, start);
  const first = LIST_ITEM.exec(lines[start]!)!;
  // Above the list: blocks a blank line closes, or a paragraph the first item may interrupt.
  if (head.some((line) => line !== "" && (CONTINUATION.test(line) || FENCE_OPENER.test(line)))) return null;
  const last = head.at(-1);
  if (last !== undefined && last !== "" && (last.startsWith("|") || (first[2] && !/^1[.)]/.test(lines[start]!)))) return null;
  const pieces: string[] = [];
  let piece = lines[start]!;
  for (const [index, line] of lines.entries()) {
    if (index <= start) continue;
    if (line.startsWith(" ")) {
      piece += `\n${line}`;
      continue;
    }
    if (THEMATIC_BREAK.test(line)) return null;
    const item = LIST_ITEM.exec(line);
    if (item && sameMarker(item, first)) {
      pieces.push(piece);
      piece = line;
      continue;
    }
    const bare = BARE_ITEM.exec(line);
    // A marker just typed, with its words still to come.
    if (bare && sameMarker(bare, first) && index === lines.length - 1) {
      piece += `\n${line}`;
      continue;
    }
    return null;
  }
  pieces.push(piece);
  if (pieces.length < 2 && !head.length) return null;
  return { kind: "list", head: head.length ? `${head.join("\n")}\n` : "", lead: "", pieces };
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
