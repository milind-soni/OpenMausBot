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
    if (row.length !== headers.length) throw new Error("columns");
  }
  return { headers, rows };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
export function isTableNumber(text: string): boolean { return NUMBER.test(text.trim()); }

const AMOUNT = /^[+-]?[$€£¥₹]?\d{1,3}(?:,?\d{3})*(?:\.\d+)?%?$/;
/** A cell that reads as a quantity (a plain number, a price, a percentage), so its column lines up on the right. */
export function isTableAmount(text: string): boolean { return isTableNumber(text) || AMOUNT.test(text.trim()); }

function decimalParts(text: string): { sign: number; order: bigint; digits: string } {
  const negative = text.startsWith("-");
  const [mantissa = "", exponent = "0"] = text.replace(/^[+-]/, "").toLowerCase().split("e");
  const dot = mantissa.indexOf(".");
  const decimals = dot < 0 ? 0 : mantissa.length - dot - 1;
  const digits = mantissa.replace(".", "").replace(/^0+/, "");
  if (!digits) return { sign: 0, order: 0n, digits: "" };
  return { sign: negative ? -1 : 1, order: BigInt(exponent) + BigInt(digits.length - decimals), digits: digits.replace(/0+$/, "") };
}

/** Different floating-point values keep decimal order; equal rounded values need their original decimal digits. */
function compareTableNumbers(left: string, right: string): number {
  const l = Number(left), r = Number(right);
  if (l < r) return -1;
  if (l > r) return 1;
  const a = decimalParts(left.trim()), b = decimalParts(right.trim());
  if (a.sign !== b.sign) return a.sign - b.sign;
  if (!a.sign) return 0;
  const magnitude = a.order < b.order ? -1 : a.order > b.order ? 1
    : a.digits < b.digits ? -1 : a.digits > b.digits ? 1 : 0;
  return a.sign * magnitude;
}

export function tableRowOrder(rows: readonly (readonly string[])[], query: string, sort: TableSort): number[] {
  const needle = query.trim().toLocaleLowerCase();
  const order = rows.flatMap((row, index) => !needle || row.some((cell) => cell.toLocaleLowerCase().includes(needle)) ? [index] : []);
  if (sort) order.sort((a, b) => {
    const left = rows[a]![sort.column] ?? "", right = rows[b]![sort.column] ?? "";
    if (!left.trim() || !right.trim()) return Number(!left.trim()) - Number(!right.trim()) || a - b;
    const difference = isTableNumber(left) && isTableNumber(right) ? compareTableNumbers(left, right) : collator.compare(left, right);
    return difference * (sort.descending ? -1 : 1) || a - b;
  });
  return order;
}

/** A cell a spreadsheet would read as a formula; a plain number such as -12.50 is a number, not a formula. */
const FORMULA = /^(?![+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$)[=+\-@\t\r]/i;

export function tableCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return Papa.unparse([headers, ...rows], { newline: "\r\n", escapeFormulae: FORMULA });
}
