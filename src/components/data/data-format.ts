import type { DataCard, DataColumn, DataPage } from "../../../shared/data-surface";
import { intlLocale } from "@/lib/i18n";

export type Cell = DataPage["rows"][number][number];

export function isNumericType(type: string): boolean {
  return /^(?:U?(?:TINY|SMALL|BIG|HUGE)?INT(?:EGER)?|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL)\b/i.test(type.trim());
}

export function isTemporalType(type: string): boolean {
  return /^(?:DATE|TIME|TIMESTAMP|INTERVAL)/i.test(type.trim());
}

export function cellText(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** DuckDB sends bigints and decimals as strings. */
export function cellNumber(value: Cell): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Vega-Lite parses ISO dates itself. */
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

export function tsv(columns: string[], rows: Cell[][]): string {
  const clean = (text: string) => text.replace(/[\t\r\n]+/g, " ");
  return [columns.map(clean).join("\t"), ...rows.map((row) => row.map((cell) => clean(cellText(cell))).join("\t"))].join("\n");
}

export function markdownTable(columns: string[], rows: Cell[][]): string {
  const clean = (text: string) => text.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  const line = (cells: string[]) => `| ${cells.map(clean).join(" | ")} |`;
  return [line(columns), `| ${columns.map(() => "---").join(" | ")} |`, ...rows.map((row) => line(row.map(cellText)))].join("\n");
}

export function defaultColumnWidth(column: DataColumn): number {
  const byName = Math.min(320, Math.max(90, column.name.length * 8 + 36));
  if (isNumericType(column.type)) return Math.max(byName, 110);
  if (/^BOOLEAN$/i.test(column.type)) return Math.max(byName, 90);
  if (isTemporalType(column.type)) return Math.max(byName, 170);
  return Math.max(byName, 180);
}

export function cardsLatestFirst(cards: DataCard[]): DataCard[] {
  return [...cards].reverse().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt));
}

export function formatCount(value: number | undefined | null): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString(intlLocale()) : "";
}
