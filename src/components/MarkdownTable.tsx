import { Children, isValidElement, useMemo, type ReactElement, type ReactNode } from "react";
import { RichTable, type TableCell, type TableColumn } from "./RichTable";

type Element = ReactElement<{ children?: ReactNode; align?: string; alt?: string }>;
const elements = (children: ReactNode): Element[] => Children.toArray(children).filter(isValidElement) as Element[];
function plain(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(plain).join("");
  if (!isValidElement(node)) return "";
  const element = node as Element;
  if (element.type === "br") return "\n";
  return plain(element.props.children) || element.props.alt || "";
}

/** Retain react-markdown's already-sanitized cell children, including links,
 * code, math and scoped attachments. Never render model-authored raw HTML. */
export function MarkdownTable({ children, direction }: { children?: ReactNode; direction?: "rtl" | "ltr" }) {
  const data = useMemo(() => {
    const sections = elements(children);
    const head = sections.find((section) => section.type === "thead");
    const body = sections.find((section) => section.type === "tbody");
    const cell = (element: Element): TableCell => ({ text: plain(element.props.children), content: element.props.children });
    const columns: TableColumn[] = elements(elements(head?.props.children)[0]?.props.children).map((element) => ({
      ...cell(element), align: element.props.align === "left" || element.props.align === "right" || element.props.align === "center" ? element.props.align : undefined,
    }));
    const rows = elements(body?.props.children).map((row) => elements(row.props.children).map(cell));
    return { columns, rows };
  }, [children]);
  return <RichTable {...data} direction={direction} />;
}
