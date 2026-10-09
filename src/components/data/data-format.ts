// Pure helpers behind the Data tab: cell text, copy formats, page maths.
// No React here, so the grid's behaviour is testable without a DOM.
import { DATA_LIMITS, DATA_RESULTS_SCHEMA, type DataCard, type DataColumn, type DataPage, type DataSheet } from "../../../shared/data-surface";

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

/** Page indexes that cover rows first..last (inclusive), each page being
 * DATA_LIMITS.pageSize rows; the grid asks the server for exactly these. */
export function pagesCovering(first: number, last: number, pageSize: number = DATA_LIMITS.pageSize): number[] {
  if (last < first || first < 0) return [];
  const pages: number[] = [];
  for (let page = Math.floor(first / pageSize); page <= Math.floor(last / pageSize); page++) pages.push(page);
  return pages;
}

/** The request window for one page: never more than pageSize rows, and never
 * past the known end of the result. */
export function pageWindow(page: number, total: number, pageSize: number = DATA_LIMITS.pageSize): { offset: number; limit: number } {
  const offset = page * pageSize;
  return { offset, limit: Math.max(1, Math.min(pageSize, total - offset)) };
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

/** The table a card's result lives in, as SQL names it. */
export function cardResultTable(card: Pick<DataCard, "result">): string | null {
  return card.result ? `${DATA_RESULTS_SCHEMA}.${card.result}` : null;
}

/** The names the SQL editor completes: the loaded tables with their columns,
 * and the results schema with every ready card's result table. */
export function sqlNamespace(sheet: DataSheet | undefined): Record<string, string[] | Record<string, string[]>> {
  if (!sheet) return {};
  const namespace: Record<string, string[] | Record<string, string[]>> = {};
  for (const source of sheet.sources) namespace[source.name] = source.columns.map((column) => column.name);
  const results: Record<string, string[]> = {};
  for (const card of sheet.cards) {
    if (card.result && card.columns) results[card.result] = card.columns.map((column) => column.name);
  }
  if (Object.keys(results).length) namespace[DATA_RESULTS_SCHEMA] = results;
  return namespace;
}

/** Cards in the order the stream shows them: oldest first, newest at the
 * bottom, whatever order the server stored them in. */
export function cardsOldestFirst(cards: DataCard[]): DataCard[] {
  return [...cards].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** A count with thousands separators, in the person's locale. */
export function formatCount(value: number | undefined | null): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "";
}
