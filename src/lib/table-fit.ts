/** Bounds for a column's narrowest width, in characters of the table's 14px text, and the width of one. */
export const COLUMN_MIN_CHARS = 4;
export const COLUMN_MAX_CHARS = 12;
export const CHAR_PX = 7.5;
const SAMPLE_ROWS = 100;

/** How narrow each column may get before its words break: its longest word, kept within bounds, in px. The browser
 * gives every column at least this and shares the rest of the row by how much each column has to say. */
export function columnMinimums(header: readonly string[], rows: readonly (readonly string[])[]): number[] {
  return header.map((title, index) => {
    let longest = 0;
    for (const text of [title, ...rows.slice(0, SAMPLE_ROWS).map((row) => row[index] ?? "")]) {
      for (const word of text.split(/\s+/)) longest = Math.max(longest, [...word].length);
    }
    return Math.round(Math.min(COLUMN_MAX_CHARS, Math.max(COLUMN_MIN_CHARS, longest)) * CHAR_PX);
  });
}

/** A cell's left and right padding (px-3). */
export const CELL_PADDING_PX = 24;

/** A table that wraps and is short enough to draw whole fits its columns to the message when their narrowest widths
 * fit the room it has (`available`, unknown before the first measure). Otherwise it keeps roomy fixed columns and
 * scrolls sideways, which on a phone beats rows squeezed tall; a very long one keeps fixed columns so rows keep their
 * widths as they scroll in and out. */
export function fitsColumns({ wrap, virtual, minimums = [], available = null }: {
  wrap: boolean; virtual: boolean; minimums?: readonly number[]; available?: number | null;
}): boolean {
  if (!wrap || virtual) return false;
  return available === null || minimums.reduce((sum, width) => sum + width + CELL_PADDING_PX, 0) <= available;
}
