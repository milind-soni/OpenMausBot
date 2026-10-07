import Papa from "papaparse";

export const TABLE_FILE_MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 100_000;
const MAX_COLUMNS = 200;
const MAX_CELLS = 500_000;

export interface TextTable { headers: string[]; rows: string[][] }
export type TableSort = { column: number; descending: boolean } | null;

export function tableDelimiter(name: string): "," | "\t" | null {
  return /\.csv$/i.test(name) ? "," : /\.tsv$/i.test(name) ? "\t" : null;
}

/** Strings stay strings: leading zeroes and long IDs must never be coerced. */
export function parseTableFile(text: string, delimiter: "," | "\t"): TextTable {
  if (text.includes("\0")) throw new Error("format");
  const parsed = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), {
    delimiter, skipEmptyLines: true, preview: MAX_ROWS + 2,
  });
  if (parsed.errors.length) throw new Error("format");
  const [headers = [], ...rows] = parsed.data;
  const columns = Math.max(headers.length, ...rows.slice(0, 1).map((row) => row.length));
  if (rows.length > MAX_ROWS || parsed.meta.truncated || columns > MAX_COLUMNS) throw new Error("size");
  let cells = headers.length;
  for (const row of rows) {
    cells += row.length;
    if (cells > MAX_CELLS || row.length > MAX_COLUMNS) throw new Error("size");
    // Do not silently discard extra fields or shift malformed data.
    if (row.length !== headers.length) throw new Error("columns");
  }
  return { headers, rows };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
export function isTableNumber(text: string): boolean { return NUMBER.test(text.trim()); }

export function tableRowOrder(rows: readonly (readonly string[])[], query: string, sort: TableSort): number[] {
  const needle = query.trim().toLocaleLowerCase();
  const order = rows.flatMap((row, index) => !needle || row.some((cell) => cell.toLocaleLowerCase().includes(needle)) ? [index] : []);
  if (sort) order.sort((a, b) => {
    const left = rows[a]![sort.column] ?? "", right = rows[b]![sort.column] ?? "";
    // Empty cells stay at the bottom in either direction.
    if (!left.trim() || !right.trim()) return Number(!left.trim()) - Number(!right.trim()) || a - b;
    const numeric = isTableNumber(left) && isTableNumber(right);
    let difference: number;
    if (numeric && /^[+-]?\d+$/.test(left.trim()) && /^[+-]?\d+$/.test(right.trim())) {
      const l = BigInt(left.trim()), r = BigInt(right.trim());
      difference = l < r ? -1 : l > r ? 1 : 0;
    } else difference = numeric ? Number(left) - Number(right) : collator.compare(left, right);
    // Equal numeric representations still sort stably; keep the original text.
    return (Number.isFinite(difference) ? difference : collator.compare(left, right)) * (sort.descending ? -1 : 1) || a - b;
  });
  return order;
}

/** Export the whole current result, not just the rows mounted by virtualization. */
export function tableCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return Papa.unparse([headers, ...rows], { newline: "\r\n", escapeFormulae: true });
}
