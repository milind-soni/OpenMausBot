import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { widgetNumber, widgetString, type WidgetNode } from "../../../shared/widget";
import { ChatMarkdown } from "../ChatMarkdown";
import { WidgetChart } from "./WidgetChart";
import { WidgetBadge, WidgetImage, WidgetProgress } from "./WidgetContent";
import { useWidgetForm, widgetActionUrl, widgetCanPress, widgetFieldId, WidgetButton, WidgetGlyph, type WidgetForm } from "./WidgetControls";
import { WIDGET_CAPTION, WIDGET_FIELD_TYPES, WidgetFieldView } from "./WidgetFields";
import { WidgetTable } from "./WidgetTable";
import {
  ALIGN, BACKGROUND, boxStyle, CAPTION_SIZE, ICON_SIZE, INK, JUSTIFY, kids, TEXT_ALIGN, TEXT_SIZE, TITLE_SIZE, WEIGHT, widthStyle,
} from "./widget-style";
import { activeLocale } from "@/lib/i18n";


export interface WidgetWhere {
  axis: "row" | "col";
  gap: number;
  item?: boolean;
  lead?: boolean;
  card?: { top: number; left: number; right: number };
  room?: readonly [number, number];
  form?: boolean;
  cell?: boolean;
}

const RULE = "bg-ink/[0.12]";

export function WidgetChildren({ nodes, where }: { nodes: WidgetNode[]; where: WidgetWhere }) {
  return <>{nodes.map((child, index) => <WidgetNodeView key={child.id ?? index} node={child} where={where} />)}</>;
}

export function WidgetNodeView({ node, where }: { node: WidgetNode; where: WidgetWhere }): ReactNode {
  if (WIDGET_FIELD_TYPES.has(node.type)) return <WidgetFieldView node={node} where={where} />;
  switch (node.type) {
    case "Box": case "Row": case "Col": case "Form":
      return <Layout node={node} where={where} />;
    case "ListViewItem":
      return <WidgetListRow node={node} />;
    case "Spacer": {
      const min = widgetNumber(node, "minSize");
      return <div aria-hidden="true" className="min-h-0 min-w-0 flex-1" style={min === undefined ? undefined : where.axis === "row" ? { minWidth: min } : { minHeight: min }} />;
    }
    case "Divider":
      return <Divider node={node} where={where} />;
    case "Table":
      return <WidgetTable node={node} drawCell={drawCell} />;
    case "Text": case "Title": case "Caption":
      return <TextNode node={node} where={where} />;
    case "Label":
      return <LabelNode node={node} where={where} />;
    case "Markdown":
      return <div className="min-w-0 text-[14px] text-ink [&_.chat-md]:leading-[21px]!"><ChatMarkdown locale={activeLocale()} text={widgetString(node, "value") ?? ""} /></div>;
    case "Image":
      return <WidgetImage node={node} where={where} />;
    case "Icon": {
      const size = ICON_SIZE[widgetString(node, "size") ?? "md"] ?? ICON_SIZE.md;
      const ink = INK[widgetString(node, "color") ?? ""];
      if (!(where.item && where.lead)) return <WidgetGlyph name={node.name} size={size} className={ink} />;
      return (
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-inset group-hover/row:bg-composer group-aria-checked/row:bg-composer", ink ?? "text-ink-secondary")}>
          <WidgetGlyph name={node.name} size={size} />
        </span>
      );
    }
    case "Chart":
      return <WidgetChart node={node} />;
    case "Badge":
      return <WidgetBadge node={node} />;
    case "Progress":
      return <WidgetProgress node={node} />;
    case "Button":
      return (
        <WidgetButton
          actionRef={node.id}
          label={widgetString(node, "label")}
          look={widgetString(node, "style") ?? "secondary"}
          iconStart={node.iconStart}
          iconEnd={node.iconEnd}
          block={node.block === true}
          disabled={node.disabled === true}
        />
      );
    default:
      return <WidgetChildren nodes={kids(node)} where={where} />;
  }
}

function submitRef(node: WidgetNode, form: WidgetForm): string | undefined {
  for (const child of kids(node)) {
    const entry = child.type === "Button" && child.submit === true ? form.actions.get(child.id) : undefined;
    // Security: never a link, so a keystroke in a field cannot open an address the bot chose.
    if (entry?.tone === "submit" && !entry.client) return child.id;
    const inner = submitRef(child, form);
    if (inner) return inner;
  }
  return undefined;
}

const WORDS = new Set(["Label", "Text", "Caption", "Title"]);
const FLOWS = new Set(["Button", "Badge", "Spacer", ...WIDGET_FIELD_TYPES]);

function pairsField(node: WidgetNode): boolean {
  const children = kids(node);
  return children.some((child) => WIDGET_FIELD_TYPES.has(child.type) && child.type !== "Checkbox") && children.some((child) => WORDS.has(child.type));
}

function flows(children: WidgetNode[]): boolean {
  return children.length > 1 && children.every((child) => FLOWS.has(child.type));
}

function Layout({ node, where }: { node: WidgetNode; where: WidgetWhere }) {
  const form = useWidgetForm();
  const stacked = form.compact && node.type === "Row" && pairsField(node);
  const axis = !stacked && (node.type === "Row" || (node.type !== "Col" && node.direction === "row")) ? "row" : "col";
  const gap = stacked ? 6 : widgetNumber(node, "gap") ?? (axis === "row" ? 8 : node.type === "Form" ? 12 : 0);
  const isForm = node.type === "Form";
  const shown = stacked ? kids(node).filter((child) => child.type !== "Spacer") : kids(node);
  const className = cn(
    "flex min-w-0",
    axis === "row" ? "flex-row" : "flex-col",
    stacked ? ALIGN.stretch : ALIGN[widgetString(node, "align") ?? (axis === "row" ? "center" : "stretch")],
    JUSTIFY[widgetString(node, "justify") ?? ""],
    axis === "row" && (node.wrap === true || flows(shown)) && "flex-wrap",
    BACKGROUND[widgetString(node, "background") ?? ""],
    widgetNumber(node, "border") ? "border-solid border-ink/[0.12]" : null,
    where.card && node.type === "Row" && (stacked ? "py-2.5" : "min-h-[44px]"),
  );
  const style: CSSProperties = { gap, ...boxStyle(node) };
  const children = <WidgetChildren nodes={shown} where={{ axis, gap, item: where.item, form: where.form || isForm, room: gap > 0 ? [0, 0] : [8, 8] }} />;
  if (!isForm || where.form) return <div className={className} style={style}>{children}</div>;
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    const target = event.target;
    if (event.key !== "Enter" || event.nativeEvent.isComposing || !(target instanceof HTMLInputElement) || target.type === "checkbox" || target.type === "radio") return;
    event.preventDefault();
    const ref = submitRef(node, form);
    if (ref) form.press(ref);
  };
  return <form noValidate onSubmit={(event) => event.preventDefault()} onKeyDown={onKeyDown} className={className} style={style}>{children}</form>;
}

export const WIDGET_ROW = "flex min-h-[60px] w-full min-w-0 rounded-2xl px-2 py-2.5 text-start";
export const WIDGET_ROW_CONTROLS = "button, a, input, select, textarea, label, [role='button']";

/**
 * A row holding a control of its own cannot be a button around it (no nested interactive content), so it takes the
 * button role and keys.
 */
export function WidgetListRow({ node }: { node: WidgetNode }) {
  const form = useWidgetForm();
  const entry = form.actions.get(node.id);
  const live = widgetCanPress(form, entry);
  const style: CSSProperties = { gap: widgetNumber(node, "gap") ?? 12 };
  const shape = cn(WIDGET_ROW, ALIGN[widgetString(node, "align") ?? "center"]);
  const content = kids(node).map((child, index) => (
    <WidgetNodeView key={child.id ?? index} node={child} where={{ axis: "row", gap: style.gap as number, item: true, lead: index === 0 }} />
  ));
  if (!entry) return <div className={shape} style={style}>{content}</div>;
  const pressed = form.pendingRef === node.id
    ? <LoaderCircle aria-hidden="true" size={14} className="shrink-0 animate-spin text-ink-tertiary" />
    : form.sentRef === node.id ? <Check aria-hidden="true" size={14} className="shrink-0 text-success" /> : null;
  const className = cn(shape, "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus", live ? "group/row cursor-pointer hover:bg-inset active:bg-inset" : "cursor-default");
  const shared = { "data-widget-ref": node.id, "aria-busy": form.pendingRef === node.id || undefined, title: widgetActionUrl(entry), className, style };
  if (!holdsControl(node)) {
    return <button type="button" {...shared} disabled={!live} onClick={() => form.press(node.id)}>{content}{pressed}</button>;
  }
  return (
    <div
      role="button"
      tabIndex={live ? 0 : -1}
      aria-disabled={!live || undefined}
      {...shared}
      onClick={(event) => {
        const inner = (event.target as Element).closest(WIDGET_ROW_CONTROLS);
        if (live && (!inner || inner === event.currentTarget)) form.press(node.id);
      }}
      onKeyDown={(event) => {
        if (!live || event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        form.press(node.id);
      }}
    >
      {content}{pressed}
    </div>
  );
}

const CLICKABLE = new Set(["Button", "Image", "ListViewItem", "Markdown"]);
function holdsControl(node: WidgetNode): boolean {
  return kids(node).some((child) => CLICKABLE.has(child.type) || WIDGET_FIELD_TYPES.has(child.type) || holdsControl(child));
}

function Divider({ node, where }: { node: WidgetNode; where: WidgetWhere }) {
  const spacing = widgetNumber(node, "spacing");
  const [before, after] = spacing === undefined ? where.room ?? [0, 0] : [spacing, spacing];
  if (where.axis === "row") {
    return <div role="separator" aria-orientation="vertical" className={cn("w-px shrink-0 self-stretch", RULE)} style={{ marginInlineStart: before, marginInlineEnd: after }} />;
  }
  const edge = node.flush === true ? where.card : undefined;
  return <div role="separator" className={cn("h-px shrink-0", RULE)} style={{ marginTop: before, marginBottom: after, ...(edge ? { marginLeft: -edge.left, marginRight: -edge.right } : {}) }} />;
}

const CELL: WidgetWhere = { axis: "col", gap: 0, cell: true };
const drawCell = (cell: WidgetNode): ReactNode => <WidgetChildren nodes={kids(cell)} where={CELL} />;

const TYPE: Record<string, { sizes: Record<string, readonly [string, number]>; weight?: string; ink: string }> = {
  Text: { sizes: TEXT_SIZE, ink: "text-ink" },
  Title: { sizes: TITLE_SIZE, weight: "font-semibold", ink: "text-ink" },
  Caption: { sizes: CAPTION_SIZE, ink: "text-ink-secondary" },
};

function TextNode({ node, where }: { node: WidgetNode; where: WidgetWhere }) {
  const face = TYPE[node.type] ?? TYPE.Text!;
  const [size, line] = face.sizes[widgetString(node, "size") ?? "md"] ?? face.sizes.md!;
  const inCell = where.cell === true && widgetString(node, "size") === undefined;
  const maxLines = widgetNumber(node, "maxLines");
  const minLines = widgetNumber(node, "minLines");
  const oneLine = node.truncate === true || (where.item === true && maxLines === undefined);
  const value = widgetString(node, "value") ?? "";
  const style: CSSProperties = {
    ...(maxLines && !oneLine ? { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: maxLines, overflow: "hidden" } : {}),
    ...(minLines ? { minHeight: minLines * line } : {}),
    ...widthStyle(node),
  };
  return (
    <div
      dir="auto"
      title={oneLine ? value : undefined}
      className={cn(
        "min-w-0", !inCell && size, WEIGHT[widgetString(node, "weight") ?? ""] ?? face.weight, INK[widgetString(node, "color") ?? ""] ?? face.ink,
        TEXT_ALIGN[widgetString(node, "textAlign") ?? ""], node.italic === true && "italic", node.lineThrough === true && "line-through",
        oneLine ? "truncate" : inCell ? "[.truncate>&]:truncate" : "whitespace-pre-line break-words",
      )}
      style={style}
    >
      {value}
    </div>
  );
}

function LabelNode({ node, where }: { node: WidgetNode; where: WidgetWhere }) {
  const form = useWidgetForm();
  const field = form.fields.get(widgetString(node, "fieldName") ?? "");
  const above = where.axis === "col";
  return (
    <label
      // A group goes by its own name: its label's click would pick the first option or day.
      htmlFor={field && field.type !== "RadioGroup" && field.type !== "DayPicker" ? widgetFieldId(form, field.name) : undefined}
      dir="auto"
      className={cn(
        "min-w-0", above ? WIDGET_CAPTION : "shrink-0 text-[14px] leading-5 text-ink-secondary",
        TEXT_SIZE[widgetString(node, "size") ?? ""]?.[0], WEIGHT[widgetString(node, "weight") ?? ""], INK[widgetString(node, "color") ?? ""],
        TEXT_ALIGN[widgetString(node, "textAlign") ?? ""],
      )}
      style={{ ...widthStyle(node), ...(above ? { marginBottom: 6 - where.gap } : {}) }}
    >
      {widgetString(node, "value") ?? ""}
    </label>
  );
}
