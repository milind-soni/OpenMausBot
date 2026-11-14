import { widgetString, type WidgetNode } from "../../../shared/widget";
import {
  useWidgetForm, widgetFieldId, WidgetCheckbox, WidgetDatePicker, WidgetInput, WidgetRadioGroup, WidgetSelect, WidgetTextarea,
} from "./WidgetControls";
import { WidgetDayPicker } from "./WidgetDayPicker";
import { WidgetTimePicker } from "./WidgetTimePicker";
import type { WidgetWhere } from "./WidgetNodes";

export const WIDGET_FIELD_TYPES: ReadonlySet<string> = new Set(["Select", "DatePicker", "TimePicker", "DayPicker", "Checkbox", "RadioGroup", "Input", "Textarea"]);
const BARE = new Set(["Select", "DatePicker", "TimePicker", "DayPicker", "Input"]);
const FILLS = new Set(["Select", "DatePicker", "TimePicker", "Input", "Textarea"]);
export const WIDGET_FIELD_SHARE = "1 1 160px";

export const WIDGET_CAPTION = "ms-0.5 block text-[12px] leading-4 text-ink-secondary";

export function WidgetFieldView({ node, where }: { node: WidgetNode; where: WidgetWhere }) {
  const form = useWidgetForm();
  if (node.type === "Checkbox") return <WidgetCheckbox node={node} />;
  const name = widgetString(node, "name") ?? "";
  const label = widgetString(node, "label");
  const captioned = label !== undefined && !form.labelled.has(name);
  const inRow = where.axis === "row";
  const bare = inRow && !captioned && node.block !== true && BARE.has(node.type);
  const group = node.type === "RadioGroup" || node.type === "DayPicker";
  const captionId = `${widgetFieldId(form, name)}-label`;
  const labelledBy = captioned && group ? captionId : undefined;
  const control = node.type === "Select" ? <WidgetSelect node={node} bare={bare} />
    : node.type === "DatePicker" ? <WidgetDatePicker node={node} bare={bare} />
      : node.type === "TimePicker" ? <WidgetTimePicker node={node} bare={bare} />
        : node.type === "DayPicker" ? <WidgetDayPicker node={node} labelledBy={labelledBy} end={bare} />
          : node.type === "RadioGroup" ? <WidgetRadioGroup node={node} labelledBy={labelledBy} />
            : node.type === "Input" ? <WidgetInput node={node} bare={bare} />
              : <WidgetTextarea node={node} />;
  const shares = inRow && !bare && (captioned || FILLS.has(node.type));
  if (!captioned && !shares) return control;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" style={shares ? { flex: WIDGET_FIELD_SHARE } : undefined}>
      {captioned && (group
        ? <div id={captionId} dir="auto" className={WIDGET_CAPTION}>{label}</div>
        : <label id={captionId} htmlFor={widgetFieldId(form, name)} dir="auto" className={WIDGET_CAPTION}>{label}</label>)}
      {control}
    </div>
  );
}
