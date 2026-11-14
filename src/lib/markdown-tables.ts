import { fromMarkdown } from "mdast-util-from-markdown";

const DELIMITER_CELL = /^:?-+:?$/;

const DELIMITER_RUN = /\|(?:\s*:?-+:?\s*\|)+/;

function cells(row: string): string[] {
  const parts = row.trim().split("|");
  if (parts[0]?.trim() === "") parts.shift();
  if (parts.at(-1)?.trim() === "") parts.pop();
  return parts.map((cell) => cell.trim());
}

const row = (values: string[]): string => `| ${values.join(" | ")} |`;

function isDelimiterRow(line: string): boolean {
  if (!line.includes("|")) return false;
  const parts = cells(line);
  return parts.length > 0 && parts.every((cell) => DELIMITER_CELL.test(cell));
}

const looksLikeRow = (line: string): boolean => cells(line).length >= 2 && line.includes("|");

function fitDelimiter(line: string, count: number): string {
  const supplied = cells(line);
  return row(Array.from({ length: count }, (_, i) => supplied[i] ?? "---"));
}

function splitInlineTable(line: string): string[] | null {
  if (!/^ {0,3}\|/.test(line)) return null;
  const match = DELIMITER_RUN.exec(line);
  if (!match) return null;
  const header = line.slice(0, match.index);
  const body = line.slice(match.index + match[0].length);
  const headers = cells(header);
  if (headers.length < 2 || !header.trimEnd().endsWith("|")) return null;
  if (body.trim() !== "" && !body.trimStart().startsWith("|")) return null;

  const lines = [row(headers), fitDelimiter(match[0], headers.length)];
  let chunk: string[] = [];
  let boundary = false;
  for (const value of cells(body)) {
    if (boundary) {
      boundary = false;
      if (value === "") continue;
    }
    chunk.push(value);
    if (chunk.length === headers.length) {
      lines.push(row(chunk));
      chunk = [];
      boundary = true;
    }
  }
  if (chunk.length > 0) {
    while (chunk.length < headers.length) chunk.push("");
    lines.push(row(chunk));
  }
  return lines;
}

function repairParagraph(text: string): string {
  const source = text.split("\n");
  const out: string[] = [];
  let inTable = false;

  for (const [index, line] of source.entries()) {
    if (inTable && line.includes("|")) {
      out.push(line);
      continue;
    }
    inTable = false;

    const inlineMatch = DELIMITER_RUN.exec(line);
    if (inlineMatch && !isDelimiterRow(line) && !isDelimiterRow(source[index + 1] ?? "")) {
      const split = splitInlineTable(line);
      if (split) {
        if (out.length > 0 && out.at(-1)?.trim() !== "" && !looksLikeRow(out.at(-1) ?? "")) out.push("");
        out.push(...split);
        continue;
      }
    }

    if (isDelimiterRow(line)) {
      const header = out.at(-1) ?? "";
      if (looksLikeRow(header)) {
        inTable = true;
        // GFM: a table cannot interrupt a paragraph, so the header needs a blank line above it.
        const before = out.at(-2);
        if (before !== undefined && before.trim() !== "" && !looksLikeRow(before)) {
          out.splice(out.length - 1, 0, "");
        }
        // GFM needs the delimiter's cell count to match the header's exactly.
        const width = cells(header).length;
        if (cells(line).length !== width) {
          out.push(fitDelimiter(line, width));
          continue;
        }
      }
    }

    out.push(line);
  }

  return out.join("\n");
}

export function repairMarkdownTables(text: string): string {
  if (!text.includes("|")) return text;
  const out: string[] = [];
  let cursor = 0;
  for (const node of fromMarkdown(text).children) {
    if (node.type !== "paragraph") continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const paragraph = text.slice(start, end);
    if (/[`\\]/.test(paragraph)) continue;
    out.push(text.slice(cursor, start), repairParagraph(paragraph));
    cursor = end;
  }
  out.push(text.slice(cursor));
  return out.join("");
}
