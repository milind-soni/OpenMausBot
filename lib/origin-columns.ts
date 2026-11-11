/** Title of the draft column on new boards. Older boards keep their "Draft" column, shown as Backlog (columnLabel). */
export const DRAFT_COLUMN_TITLE = "Backlog";
export const DEFAULT_WORKFLOW_COLUMNS = [DRAFT_COLUMN_TITLE, "Todo", "In progress"] as const;

export const normalizedColumnTitle = (title: unknown): string => (typeof title === "string" ? title.trim().toLowerCase().replace(/[\s_-]+/g, "") : "");

/**
 * Issues in the draft column stay in Origin: they get no GitHub issue until they move to another column. A column
 * keeps `isDraft` once flagged, even when renamed; without the flag the title "Draft" decides.
 */
export function isDraftColumn(column: { title?: unknown; isDraft?: unknown }): boolean {
  return typeof column.isDraft === "boolean" ? column.isDraft : normalizedColumnTitle(column.title) === "draft";
}

/** The first column of boards created before drafts, which becomes the draft column. */
export const isLegacyIdeaColumn = (column: { title?: unknown; isDraft?: unknown }): boolean =>
  column.isDraft === undefined && normalizedColumnTitle(column.title) === "idea";

export function compareWorkflowColumns(a: { title?: unknown; isDraft?: unknown; order: number }, b: { title?: unknown; isDraft?: unknown; order: number }): number {
  return Number(isDraftColumn(b)) - Number(isDraftColumn(a)) || a.order - b.order;
}

/**
 * The name a column shows. The draft column was called "Draft"; it now reads "Backlog" wherever it still carries the
 * old default name. A draft column the team renamed to anything else keeps its own name, as do all other columns.
 * The stored title is never changed, so webhooks, MCP and existing links see the same data as before.
 */
export function columnLabel(column: { title: string; isDraft?: unknown }): string {
  return isDraftColumn(column) && normalizedColumnTitle(column.title) === "draft" ? "Backlog" : column.title;
}

/** Columns as shown: their display name, with the draft flag resolved first so the renamed title cannot lose it. */
export function presentColumns<T extends { title: string; isDraft?: boolean }>(columns: readonly T[]): T[] {
  return columns.map(column => {
    const draft = isDraftColumn(column);
    const title = columnLabel(column);
    return title === column.title && column.isDraft === draft ? column : { ...column, title, isDraft: draft };
  });
}
