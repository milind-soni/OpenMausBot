import { cloneElement, createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";

import type { StreamPieces } from "./markdown-stream-blocks";

interface HastElement {
  type: "element";
  tagName: string;
  children: unknown[];
}

type Parsed = ReactElement<{ children?: ReactNode; node?: HastElement }>;

/** Parses one piece of Markdown; a cache key keeps the result, and `loose` draws its list as a loose one. */
export type ParsePiece = (source: string, cacheKey: string | null, loose?: boolean) => ReactElement;

/** Wraps the nodes of the list item at `index`; `source` is that item's Markdown while its list is still being written. */
export type ItemScope = (nodes: ReactNode[], index: number, source: string | null) => ReactNode;

const KEY = "\u0004";

const nodes = (children: ReactNode): ReactNode[] => (children === undefined || children === null ? [] : Array.isArray(children) ? children : [children]);
const elements = (children: ReactNode): Parsed[] => nodes(children).filter((child): child is Parsed => isValidElement(child));

/** The one top-level element a piece parsed to, when it is a `tags` element. */
function only(parsed: ReactElement, tags: readonly string[]): Parsed | null {
  const top = nodes((parsed as Parsed).props.children);
  const element = top.length === 1 && isValidElement(top[0]) ? (top[0] as Parsed) : null;
  return element?.props.node && tags.includes(element.props.node.tagName) ? element : null;
}

const merged = (tagName: string, children: unknown[]): HastElement => ({ type: "element", tagName, children });

function joinList(lead: ReactElement | null, items: ReactElement[], sources: string[] | null, scope: ItemScope): ReactNode | null {
  const lists = items.map((item) => only(item, ["ul", "ol"]));
  const first = lists[0];
  if (!first?.props.node) return null;
  const tagName = first.props.node.tagName;
  const children: ReactNode[] = [];
  for (const [index, list] of lists.entries()) {
    const inner = list?.props.node?.tagName === tagName ? nodes(list.props.children) : [];
    if (inner[0] !== "\n" || elements(inner).length !== 1) return null;
    children.push(scope(index === 0 ? inner : inner.slice(1), index, sources?.[index] ?? null));
  }
  const list = cloneElement(first, { node: merged(tagName, lists.map((each) => each!.props.node)) }, children);
  return lead ? createElement(Fragment, null, lead, "\n", list) : list;
}

function joinTable(head: ReactElement, rows: ReactElement[]): ReactNode | null {
  const table = only(head, ["table"]);
  if (!table?.props.node || elements(table.props.children).some((section) => section.type !== "thead")) return null;
  if (rows.length === 0) return head;
  const bodies: Parsed[] = [];
  const bodyNodes: unknown[] = [];
  for (const row of rows) {
    const node = only(row, ["table"])?.props.node;
    const body = elements(only(row, ["table"])?.props.children).find((section) => section.type === "tbody");
    const bodyNode = node?.children.find((child) => (child as HastElement).tagName === "tbody");
    if (!body || !bodyNode || elements(body.props.children).length !== 1) return null;
    bodies.push(body);
    bodyNodes.push(bodyNode);
  }
  const body = cloneElement(bodies[0]!, {}, bodies.map((each) => nodes(each.props.children)));
  return cloneElement(table, { node: merged("table", [table.props.node, ...bodyNodes]) }, [...nodes(table.props.children), body]);
}

/**
 * Draws a list or table from its pieces: every piece but the one still being written comes from the cache, and the
 * result is the element the whole block would parse to. Null when a piece did not parse to the shape its cut assumed.
 */
export function drawStreamPieces(pieces: StreamPieces, open: boolean, parse: ParsePiece, scope: ItemScope): ReactNode | null {
  if (pieces.kind === "table") {
    const last = open ? pieces.rows.length - 1 : -1;
    return joinTable(
      parse(pieces.head, open && last < 0 ? null : `${KEY}head${KEY}${pieces.head}`),
      pieces.rows.map((row, index) => parse(pieces.head + row, index === last ? null : `${KEY}row${KEY}${pieces.head}${row}`)),
    );
  }
  const last = open ? pieces.items.length - 1 : -1;
  const kind = pieces.loose ? "loose" : "tight";
  return joinList(
    pieces.lead ? parse(pieces.lead, `${KEY}lead${KEY}${pieces.lead}`) : null,
    pieces.items.map((item, index) => parse(item, index === last ? null : `${KEY}${kind}${KEY}${item}`, pieces.loose)),
    open ? pieces.items : null,
    scope,
  );
}
