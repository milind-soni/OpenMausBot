import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

import type { StreamPieces } from "@/lib/markdown-stream-blocks";

interface HastElement {
  type: string;
  tagName?: string;
  children?: HastElement[];
}

type Drawn = ReactElement<{ node?: HastElement; children?: ReactNode }>;

const nodes = (children: ReactNode): ReactNode[] => children === undefined ? [] : Array.isArray(children) ? children : [children];
const elements = (children: ReactNode) => nodes(children).filter(isValidElement) as Drawn[];

/** The one list or table a piece's Markdown drew, or null when it drew anything else. */
function onlyBlock(drawn: ReactElement, tags: readonly string[]): Drawn | null {
  const children = nodes((drawn as Drawn).props.children).filter((child) => child !== "\n");
  const block = children[0];
  if (children.length !== 1 || !isValidElement(block)) return null;
  const tag = (block as Drawn).props.node?.tagName;
  return tag && tags.includes(tag) ? block as Drawn : null;
}

const LIST_TAGS = ["ul", "ol"];
const TABLE_TAGS = ["table"];

/**
 * One list or table from the pieces' own drawings, the same as drawing their text whole; null when a piece did not draw
 * as one item or one row of the same block. `wrap` keys each piece's items and may give them context; a table reads its
 * rows as its body's direct children, so each row is only keyed.
 */
export function stitchPieces(kind: StreamPieces["kind"], drawn: readonly ReactElement[], wrap: (children: ReactNode[], index: number) => ReactNode): ReactElement | null {
  const blocks = drawn.map((piece) => onlyBlock(piece, kind === "list" ? LIST_TAGS : TABLE_TAGS));
  const first = blocks[0];
  if (!first || blocks.some((block) => !block || block.props.node?.tagName !== first.props.node?.tagName)) return null;
  return kind === "list" ? stitchList(blocks as Drawn[], wrap) : stitchTable(blocks as Drawn[]);
}

function stitchList(lists: Drawn[], wrap: (children: ReactNode[], index: number) => ReactNode): ReactElement | null {
  const parts: ReactNode[] = [];
  for (const [index, list] of lists.entries()) {
    const children = nodes(list.props.children);
    if (!elements(children).length || children.at(-1) !== "\n") return null;
    parts.push(wrap(children.slice(0, -1), index));
  }
  const first = lists[0]!;
  // The list's direction comes from its first letter, which may be in any item.
  const node = { ...first.props.node!, children: lists.flatMap((list) => list.props.node?.children ?? []) };
  return cloneElement(first, { node }, ...parts, "\n");
}

function stitchTable(tables: Drawn[]): ReactElement | null {
  const rows: ReactNode[] = [];
  const rowNodes: HastElement[] = [];
  for (const [index, table] of tables.entries()) {
    const body = elements(table.props.children).find((child) => child.type === "tbody");
    const bodyNode = table.props.node?.children?.find((child) => child.tagName === "tbody");
    const row = body && elements(body.props.children);
    if (!row || row.length !== 1 || !bodyNode) return null;
    rows.push(cloneElement(row[0]!, { key: `row-${index}` }));
    rowNodes.push(...(bodyNode.children ?? []));
  }
  const first = tables[0]!;
  const children = nodes(first.props.children).map((child) => isValidElement(child) && child.type === "tbody" ? cloneElement(child as Drawn, {}, ...rows) : child);
  const node = { ...first.props.node!, children: first.props.node!.children!.map((child) => child.tagName === "tbody" ? { ...child, children: rowNodes } : child) };
  return cloneElement(first, { node, children });
}
