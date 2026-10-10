import { fromMarkdown } from "mdast-util-from-markdown";

// Repair top-level paragraphs only. The existing parser owns Markdown block
// boundaries, so code, headings, lists and quotes keep their original source.

/** A delimiter cell: optional alignment colons around a run of dashes. */
const DELIMITER_CELL = /^:?-+:?$/;

/** A run of delimiter cells embedded anywhere in a line, e.g. `|---|:--:|`. */
const DELIMITER_RUN = /\|(?:\s*:?-+:?\s*\|)+/;

/** Splits a table row into cells, dropping the empty edges around outer pipes. */
function cells(row: string): string[] {
  const parts = row.trim().split("|");
  if (parts[0]?.trim() === "") parts.shift();
  if (parts.at(-1)?.trim() === "") parts.pop();
  return parts.map((cell) => cell.trim());
}

/** Renders cells back as a pipe-delimited row. */
const row = (values: string[]): string => `| ${values.join(" | ")} |`;

/** True when every cell of a non-empty line is a delimiter cell. */
function isDelimiterRow(line: string): boolean {
  if (!line.includes("|")) return false;
  const parts = cells(line);
  return parts.length > 0 && parts.every((cell) => DELIMITER_CELL.test(cell));
}

/** True when a line carries enough pipes to be a table row rather than prose. */
const looksLikeRow = (line: string): boolean => cells(line).length >= 2 && line.includes("|");

/**
 * Rebuilds a delimiter row to `count` cells, keeping the alignment the model
 * asked for where it supplied one and padding the rest with plain dashes.
 */
function fitDelimiter(line: string, count: number): string {
  const supplied = cells(line);
  return row(Array.from({ length: count }, (_, i) => supplied[i] ?? "---"));
}

/**
 * Explodes a table that arrived on a single line into header, delimiter and
 * body rows. The header is whatever precedes the delimiter run; the body is
 * chunked into rows of the header's width, since that is the only cell count
 * the table can actually have.
 */
function splitInlineTable(line: string): string[] | null {
  if (!/^ {0,3}\|/.test(line)) return null;
  const match = DELIMITER_RUN.exec(line);
  if (!match) return null;
  const header = line.slice(0, match.index);
  const body = line.slice(match.index + match[0].length);
  const headers = cells(header);
  // Two columns is the smallest table worth rescuing; below that the pipes are
  // far more likely to be prose (a "yes | no" aside) than a mangled table.
  if (headers.length < 2 || !header.trimEnd().endsWith("|")) return null;
  // The delimiter run has to end the line or be followed by more table, never
  // by a sentence that happens to sit after a row of dashes.
  if (body.trim() !== "" && !body.trimStart().startsWith("|")) return null;

  const lines = [row(headers), fitDelimiter(match[0], headers.length)];
  let chunk: string[] = [];
  let boundary = false;
  for (const value of cells(body)) {
    // The `| |` that joins two rows on one line reads as an empty cell. Only
    // the one sitting exactly on a row boundary is that artifact; an empty
    // cell the model actually wrote survives, because the boundary consumed
    // its own separator first.
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
  // A trailing short row is padded so the table keeps its rectangle — the
  // common case is a message still streaming its last row in.
  if (chunk.length > 0) {
    while (chunk.length < headers.length) chunk.push("");
    lines.push(row(chunk));
  }
  return lines;
}

/** Repairs a paragraph without reinterpreting rows of an established table. */
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

    // A whole table mashed onto one line: split it before anything else, so the
    // delimiter and blank-line repairs below see ordinary rows.
    const inlineMatch = DELIMITER_RUN.exec(line);
    if (inlineMatch && !isDelimiterRow(line) && !isDelimiterRow(source[index + 1] ?? "")) {
      const split = splitInlineTable(line);
      if (split) {
        // The header may need separating from the paragraph above it too.
        if (out.length > 0 && out.at(-1)?.trim() !== "" && !looksLikeRow(out.at(-1) ?? "")) out.push("");
        out.push(...split);
        continue;
      }
    }

    if (isDelimiterRow(line)) {
      const header = out.at(-1) ?? "";
      if (looksLikeRow(header)) {
        inTable = true;
        // A table cannot interrupt a paragraph — without a blank line above it
        // the header is only a lazy continuation and the table never parses.
        // This applies whatever else the delimiter needs, so it comes first.
        const before = out.at(-2);
        if (before !== undefined && before.trim() !== "" && !looksLikeRow(before)) {
          out.splice(out.length - 1, 0, "");
        }
        // GFM demands an exact match; one cell out and the table is a paragraph.
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

/** Repair near-miss tables without changing other Markdown block types. */
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
    // ponytail: escaped pipes and inline-code boundaries are ambiguous here;
    // leave those paragraphs alone instead of maintaining a second tokenizer.
    if (/[`\\]/.test(paragraph)) continue;
    out.push(text.slice(cursor, start), repairParagraph(paragraph));
    cursor = end;
  }
  out.push(text.slice(cursor));
  return out.join("");
}
