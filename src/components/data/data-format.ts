// Pure helpers behind the Data tab: cell text, copy formats, page maths.
// No React here, so the grid's behaviour is testable without a DOM.
import type { DataCard, DataColumn, DataPage } from "../../../shared/data-surface";

export type Cell = DataPage["rows"][number][number];

/** DuckDB type names that hold numbers; the grid right-aligns these and the
 * chart turns their JSON strings (bigints, decimals) back into numbers. */
export function isNumericType(type: string): boolean {
  return /^(?:U?(?:TINY|SMALL|BIG|HUGE)?INT(?:EGER)?|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL)\b/i.test(type.trim());
}

/** Dates and times: the explorer draws these as a timeline, not a word list. */
export function isTemporalType(type: string): boolean {
  return /^(?:DATE|TIME|TIMESTAMP|INTERVAL)/i.test(type.trim());
}

/** What a cell shows. null is spelled out in the grid's own styling, so this
 * returns the empty string for it; copies keep the empty cell too. */
export function cellText(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** A number the chart can use: DuckDB sends bigints and decimals as strings. */
export function cellNumber(value: Cell): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Rows as objects, one per row, for Vega's dataset. Numeric columns become
 * numbers; everything else stays text (Vega-Lite parses ISO dates itself). */
export function rowObjects(columns: DataColumn[], rows: Cell[][]): Array<Record<string, Cell>> {
  const numeric = columns.map((column) => isNumericType(column.type));
  return rows.map((row) => {
    const object: Record<string, Cell> = {};
    columns.forEach((column, index) => {
      const value = row[index] ?? null;
      object[column.name] = numeric[index] ? cellNumber(value) : value;
    });
    return object;
  });
}

/** Tab-separated text with a header row; tabs and newlines inside a cell
 * become spaces so the paste keeps its shape. */
export function tsv(columns: string[], rows: Cell[][]): string {
  const clean = (text: string) => text.replace(/[\t\r\n]+/g, " ");
  return [columns.map(clean).join("\t"), ...rows.map((row) => row.map((cell) => clean(cellText(cell))).join("\t"))].join("\n");
}

/** A GitHub-flavoured Markdown table of the rows. Pipes are escaped. */
export function markdownTable(columns: string[], rows: Cell[][]): string {
  const clean = (text: string) => text.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  const line = (cells: string[]) => `| ${cells.map(clean).join(" | ")} |`;
  return [line(columns), `| ${columns.map(() => "---").join(" | ")} |`, ...rows.map((row) => line(row.map(cellText)))].join("\n");
}

/** A starting width for a column from its type and name: numbers narrow,
 * text wide, and never wider than the grid can show without a reason. */
export function defaultColumnWidth(column: DataColumn): number {
  const byName = Math.min(320, Math.max(90, column.name.length * 8 + 36));
  if (isNumericType(column.type)) return Math.max(byName, 110);
  if (/^BOOLEAN$/i.test(column.type)) return Math.max(byName, 90);
  if (isTemporalType(column.type)) return Math.max(byName, 170);
  return Math.max(byName, 180);
}

/** Latest includes a result updated in place. Reversing first makes ties
 * follow insertion order, without changing the stored cards. */
export function cardsLatestFirst(cards: DataCard[]): DataCard[] {
  return [...cards].reverse().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt));
}

/** A count with thousands separators, in the person's locale. */
export function formatCount(value: number | undefined | null): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "";
}
