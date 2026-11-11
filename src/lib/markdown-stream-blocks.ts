// Definitions, footnotes, raw HTML, container directives and display math can tie blocks together.
const DOCUMENT_WIDE_SYNTAX = /^ {0,3}(?:\[[^\]\n]+\]:|<[A-Za-z!?/]|:::|\$\$|\\\[)|\[\^/m;
const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})/;
// After a blank line these still continue the previous block: a list item or indented content.
const CONTINUATION = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;

/**
 * Cuts Markdown at blank lines that close every open block, so each piece renders exactly as it would inside the whole
 * text. Null when the text uses syntax that spans blocks.
 */
export function splitMarkdownBlocks(text: string): string[] | null {
  if (text.includes("\r") || DOCUMENT_WIDE_SYNTAX.test(text)) return null;
  const blocks: string[] = [];
  let blockStart = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let fenceIndent = 0;
  let afterBlankLine = false;
  for (const line of text.split("\n")) {
    const opener = FENCE_OPENER.exec(line)?.[1];
    if (fence !== null) {
      // A line left of an indented fence may end the list item holding it, which is not tracked.
      if (/\S/.test(line.slice(0, fenceIndent))) break;
      if (opener && opener[0] === fence[0] && opener.length >= fence.length && line.trim() === opener) fence = null;
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
    }
    lineStart += line.length + 1;
  }
  blocks.push(text.slice(blockStart));
  return blocks;
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
