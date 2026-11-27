import { useMemo, type ReactNode } from "react";
import { t } from "@/lib/i18n";
import { widgetNumber, widgetString, type WidgetNode } from "../../../shared/widget";
import { RichTable, type TableAlign, type TableCell, type TableColumn } from "../RichTable";
import { useWidgetForm } from "./WidgetControls";
import { COL_SIZE, kids } from "./widget-style";

const MAX_COLUMNS = 8;
const ALIGN: Record<string, TableAlign> = { start: "start", center: "center", end: "end" };
const V_ALIGN: Record<string, TableCell["vAlign"]> = { start: "top", center: "middle", end: "bottom" };
const COLUMN_PADDING = 24;
const CHAR = 7;
const SORT_BUTTON = 38;
const WRAP_AFTER = 12;
const COLUMN_MIN = 64;
const COLUMN_MAX = 320;

export function widgetCellText(node: WidgetNode): string {
  switch (node.type) {
    case "Text": case "Title": case "Caption": case "Label": case "Markdown":
      return widgetString(node, "value") ?? "";
    case "Badge": case "Button":
      return widgetString(node, "label") ?? "";
    case "Progress":
      return `${Math.round((widgetNumber(node, "value") ?? 0) * 100)}%`;
    default:
      return kids(node).map(widgetCellText).filter(Boolean).join(" ");
  }
}

function spread(row: WidgetNode): Array<WidgetNode | null> {
  return kids(row).flatMap((cell) => [cell, ...Array<null>(Math.max(0, (widgetNumber(cell, "colSpan") ?? 1) - 1)).fill(null)]).slice(0, MAX_COLUMNS);
}

function columnWidth(cell: WidgetNode | null | undefined): number | undefined {
  if (!cell) return undefined;
  const own = typeof cell.width === "number" ? cell.width : COL_SIZE[widgetString(cell, "colSize") ?? ""];
  return own === undefined ? undefined : own + COLUMN_PADDING;
}

export function WidgetTable({ node, drawCell }: { node: WidgetNode; drawCell: (cell: WidgetNode) => ReactNode }) {
  const form = useWidgetForm();
  const model = useMemo(() => {
    const rows = kids(node).filter((row) => row.type === "Table.Row");
    const head = rows.find((row) => row.header === true);
    const headCells = head ? spread(head) : [];
    const body = rows.filter((row) => row !== head).map(spread);
    const count = Math.max(1, headCells.length, ...body.map((cells) => cells.length));
    const columns: TableColumn[] = Array.from({ length: count }, (_, index) => {
      const cell = headCells[index];
      const given = body.map((cells) => cells[index]).filter((each): each is WidgetNode => Boolean(each)).map((each) => widgetString(each, "align"));
      const agreed = given.length > 0 && given.every((align) => align !== undefined && align === given[0]) ? ALIGN[given[0]!] : undefined;
      const text = cell ? widgetCellText(cell) : "";
      const longest = Math.max(0, ...body.slice(0, 100).map((cells) => Math.min(WRAP_AFTER, cells[index] ? widgetCellText(cells[index]!).length : 0)));
      const read = Math.max(text ? text.length * CHAR + COLUMN_PADDING + SORT_BUTTON : 0, longest * CHAR + COLUMN_PADDING + 8);
      const width = [cell, ...body.map((cells) => cells[index])].map(columnWidth).find((each) => each !== undefined)
        ?? Math.min(COLUMN_MAX, Math.max(COLUMN_MIN, read));
      return { text, align: (cell ? ALIGN[widgetString(cell, "align") ?? ""] : undefined) ?? agreed, width };
    });
    const cells: TableCell[][] = body.map((row) => Array.from({ length: count }, (_, index): TableCell => {
      const cell = row[index];
      if (!cell) return { text: "" };
      return {
        text: widgetCellText(cell),
        content: drawCell(cell),
        align: ALIGN[widgetString(cell, "align") ?? ""],
        vAlign: V_ALIGN[widgetString(cell, "vAlign") ?? ""],
      };
    }));
    return { columns, rows: cells, headless: !head };
  }, [node, drawCell]);
  return <RichTable {...model} name={form.name || t("table.title")} card={false} />;
}
