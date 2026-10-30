import { createContext, useContext, type Ref } from "react";
import { Calendar, Check, ChevronsUpDown, LoaderCircle, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  WIDGET_LIMITS, threadActionTarget, widgetNumber, widgetString, widgetTakesOther, type WidgetActionEntry, type WidgetField, type WidgetNode, type WidgetOther, type WidgetValues,
} from "../../../shared/widget";
import { isWidgetDot, widgetIcon, widgetIconFilled } from "./widget-icons";

export interface WidgetForm {
  uid: string;
  values: WidgetValues;
  setValue: (name: string, value: string | boolean) => void;
  /** A name is here while Other is the choice for that field, with the words typed so far. */
  other: WidgetOther;
  chooseOther: (name: string) => void;
  setOther: (name: string, text: string) => void;
  locked: boolean;
  invalid?: string;
  errorId: string;
  fields: ReadonlyMap<string, WidgetField>;
  actions: ReadonlyMap<string, WidgetActionEntry>;
  pendingRef?: string;
  sentRef?: string;
  press: (ref: string) => void;
  imagesAllowed: boolean;
  allowImages: () => void;
  labelled: ReadonlySet<string>;
  compact: boolean;
  name: string;
}

export const WIDGET_COMPACT_BELOW = 400;

const INERT: WidgetForm = {
  uid: "widget", values: {}, setValue: () => {}, other: {}, chooseOther: () => {}, setOther: () => {}, locked: true, errorId: "widget-error", fields: new Map(), actions: new Map(),
  press: () => {}, imagesAllowed: false, allowImages: () => {}, labelled: new Set(), compact: false, name: "",
};
const WidgetFormContext = createContext<WidgetForm>(INERT);
export const WidgetFormProvider = WidgetFormContext.Provider;
export const useWidgetForm = (): WidgetForm => useContext(WidgetFormContext);

export const widgetFieldId = (form: WidgetForm, name: string): string => `${form.uid}-field-${name}`;

export function widgetCanPress(form: WidgetForm, entry: WidgetActionEntry | undefined): entry is WidgetActionEntry {
  if (!entry) return false;
  return entry.client ? form.pendingRef === undefined : !form.locked;
}

export function WidgetGlyph({ name, size = 16, className }: { name: unknown; size?: number; className?: string }) {
  if (isWidgetDot(name)) {
    return (
      <span aria-hidden="true" className={cn("flex shrink-0 items-center justify-center", className)} style={{ width: size, height: size }}>
        <span className="size-[7px] rounded-full bg-current" />
      </span>
    );
  }
  const Icon = widgetIcon(name);
  return <Icon aria-hidden="true" size={size} strokeWidth={1.8} fill={widgetIconFilled(name) ? "currentColor" : "none"} className={cn("shrink-0", className)} />;
}


const BUTTON =
  "inline-flex h-9 max-w-full shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-4 text-[14px] font-medium leading-5 transition-[background-color,color,filter,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-45 aria-busy:opacity-100";

/** inset-ring, never ring-inset: this theme has a colour named `inset`, so ring-inset also paints the ring in it. */
const BUTTON_LOOK: Record<string, string> = {
  primary: "bg-accent text-accent-ink enabled:hover:brightness-110",
  secondary: "bg-ink/[0.07] text-ink enabled:hover:bg-ink/[0.12]",
  outline: "bg-composer text-ink inset-ring inset-ring-composer-ring enabled:hover:bg-raised-hover",
  quiet: "px-2.5 text-ink-secondary enabled:hover:bg-ink/[0.07] enabled:hover:text-ink",
  danger: "bg-danger text-danger-ink enabled:hover:brightness-110",
};

export function widgetActionUrl(entry: WidgetActionEntry | undefined): string | undefined {
  const payload = entry?.client ? entry.action.payload : undefined;
  const url = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.url : undefined;
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : undefined;
}

export function widgetThreadTarget(entry: WidgetActionEntry | undefined): { botId: string; threadId: string } | { groupId: string; threadId: string } | undefined {
  const target = entry?.client ? threadActionTarget(entry.action) : undefined;
  if (!target) return undefined;
  return target.groupId !== undefined ? { groupId: target.groupId, threadId: target.threadId } : { botId: target.botId!, threadId: target.threadId };
}

export function WidgetButton({ actionRef, label, look, iconStart, iconEnd, block = false, disabled = false }: {
  actionRef: string;
  label?: string;
  look: string;
  iconStart?: unknown;
  iconEnd?: unknown;
  block?: boolean;
  disabled?: boolean;
}) {
  const form = useWidgetForm();
  const entry = form.actions.get(actionRef);
  const pending = form.pendingRef === actionRef;
  const sent = form.sentRef === actionRef;
  return (
    <button
      type="button"
      data-widget-ref={actionRef}
      disabled={disabled || !widgetCanPress(form, entry)}
      aria-busy={pending || undefined}
      aria-label={label ? undefined : entry?.label}
      title={[label, widgetActionUrl(entry)].filter(Boolean).join("\n") || undefined}
      onClick={(event) => {
        event.stopPropagation();
        form.press(actionRef);
      }}
      className={cn(BUTTON, BUTTON_LOOK[look] ?? BUTTON_LOOK.secondary, block && "flex w-full", !label && "w-9 px-0")}
    >
      {pending ? <LoaderCircle aria-hidden="true" size={14} className="shrink-0 animate-spin" />
        : sent ? <Check aria-hidden="true" size={14} className="shrink-0" />
          : iconStart ? <WidgetGlyph name={iconStart} size={14} /> : null}
      {label && <span dir="auto" className="min-w-0 truncate">{label}</span>}
      {iconEnd ? <WidgetGlyph name={iconEnd} size={14} /> : null}
    </button>
  );
}


export const WIDGET_FIELD =
  "block h-9 w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 text-[14px] leading-5 text-ink placeholder:text-ink-tertiary disabled:cursor-not-allowed disabled:opacity-60 user-invalid:border-danger aria-[invalid=true]:border-danger";
export const WIDGET_BARE =
  "h-9 min-w-0 max-w-full cursor-pointer rounded-lg border border-transparent bg-transparent text-[14px] font-medium leading-5 text-ink enabled:hover:bg-ink/[0.07] disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger";
export const WIDGET_FIELD_ACTION =
  "flex size-7 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/[0.07] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

export type WidgetFieldControl = ReturnType<typeof useWidgetField>;

export function useWidgetField(node: WidgetNode) {
  const form = useWidgetForm();
  const name = widgetString(node, "name") ?? "";
  const invalid = form.invalid === name;
  const disabled = form.locked || node.disabled === true;
  const required = node.required === true;
  return {
    form, name, disabled, invalid,
    set: (value: string | boolean) => form.setValue(name, value),
    text: typeof form.values[name] === "string" ? form.values[name] as string : "",
    takesOther: widgetTakesOther(node),
    other: Object.hasOwn(form.other, name) ? form.other[name] : undefined,
    chooseOther: () => form.chooseOther(name),
    control: {
      id: widgetFieldId(form, name),
      name,
      disabled,
      required,
      "data-widget-field": name,
      "aria-invalid": invalid || undefined,
      "aria-describedby": invalid ? form.errorId : undefined,
      "aria-label": spokenName(node, form.fields.get(name)?.label, name),
    },
  };
}

function spokenName(node: WidgetNode, recorded: string | undefined, name: string): string {
  return recorded && recorded !== name ? recorded : widgetString(node, "ariaLabel") ?? widgetString(node, "placeholder") ?? name;
}

function optionsOf(node: WidgetNode): Array<{ label: string; value: string }> {
  const list: unknown[] = Array.isArray(node.options) ? node.options : [];
  return list.flatMap((option) => {
    const record = option && typeof option === "object" ? option as { label?: unknown; value?: unknown } : {};
    return typeof record.value === "string" ? [{ value: record.value, label: typeof record.label === "string" ? record.label : record.value }] : [];
  });
}

/** Canonical option values are trimmed, so no bot's option can be this one. */
const OTHER_OPTION = " other";

export function WidgetSelect({ node, bare }: { node: WidgetNode; bare: boolean }) {
  const field = useWidgetField(node);
  const open = node.clearable === true;
  const choosingOther = field.other !== undefined;
  const select = (
    <span className={cn("relative min-w-0 items-center", bare ? "inline-flex" : "flex w-full")}>
      <select
        {...field.control}
        value={choosingOther ? OTHER_OPTION : field.text}
        onChange={(event) => (event.target.value === OTHER_OPTION ? field.chooseOther() : field.set(event.target.value))}
        className={cn(bare ? WIDGET_BARE : WIDGET_FIELD, "appearance-none", bare ? "ps-2 pe-7 text-end [field-sizing:content]" : "pe-9", !field.text && !choosingOther && "text-ink-tertiary")}
      >
        <option value="" disabled={!open} hidden={!open}>{widgetString(node, "placeholder") ?? t("widget.choose")}</option>
        {optionsOf(node).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        {field.takesOther && <option value={OTHER_OPTION}>{t("question.other")}</option>}
      </select>
      <ChevronsUpDown aria-hidden="true" size={14} className={cn("pointer-events-none absolute text-ink-tertiary", bare ? "end-2" : "end-3")} />
    </span>
  );
  if (!field.takesOther) return select;
  return (
    <span className={cn("min-w-0 flex-col gap-2", bare ? "inline-flex items-end" : "flex w-full")}>
      {select}
      {choosingOther && <WidgetOtherInput name={field.name} disabled={field.disabled} focus />}
    </span>
  );
}

/** Where the person types their own answer once Other is their choice. */
export function WidgetOtherInput({ name, disabled, focus, ref }: { name: string; disabled: boolean; focus: boolean; ref?: Ref<HTMLInputElement> }) {
  const form = useWidgetForm();
  const invalid = form.invalid === name;
  return (
    <input
      ref={ref}
      type="text"
      dir="auto"
      data-widget-other={name}
      autoFocus={focus && !disabled}
      value={form.other[name] ?? ""}
      disabled={disabled}
      maxLength={WIDGET_LIMITS.fieldValue}
      placeholder={t("question.otherPlaceholder")}
      aria-label={t("question.otherPlaceholder")}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? form.errorId : undefined}
      onChange={(event) => form.setOther(name, event.target.value)}
      className={WIDGET_FIELD}
    />
  );
}

/** Chromium's own calendar indicator is stretched over the whole field and left invisible; the icon is ours. */
const DATE_INDICATOR =
  "[&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:size-full [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-0";

export function WidgetDatePicker({ node, bare }: { node: WidgetNode; bare: boolean }) {
  const field = useWidgetField(node);
  // An empty date input shows its own dd/mm/yyyy, so a placeholder stands in until the field is focused.
  const placeholder = !field.text ? widgetString(node, "placeholder") : undefined;
  return (
    <span className={cn("min-w-0 items-center gap-1", bare ? "inline-flex" : "flex w-full")}>
      <span className={cn("relative flex min-w-0 items-center", !bare && "flex-1")}>
        <Calendar aria-hidden="true" size={14} className={cn("pointer-events-none absolute z-[1] text-ink-secondary", bare ? "start-2" : "start-3")} />
        <input
          {...field.control}
          type="date"
          value={field.text}
          min={widgetString(node, "min")}
          max={widgetString(node, "max")}
          onChange={(event) => field.set(event.target.value)}
          className={cn(
            bare ? WIDGET_BARE : WIDGET_FIELD, "peer relative tabular-nums [color-scheme:var(--code-color-scheme)]", bare ? "ps-7 pe-2" : "ps-8", DATE_INDICATOR,
            placeholder && "text-transparent focus:text-ink",
          )}
        />
        {placeholder && (
          <span aria-hidden="true" className={cn("pointer-events-none absolute truncate text-[14px] leading-5 text-ink-tertiary peer-focus:hidden", bare ? "start-7 end-2" : "start-8 end-3")}>
            {placeholder}
          </span>
        )}
      </span>
      {node.clearable === true && field.text && !field.disabled && (
        <button type="button" aria-label={t("widget.clear", { label: field.control["aria-label"] })} onClick={() => field.set("")} className={WIDGET_FIELD_ACTION}>
          <X aria-hidden="true" size={14} />
        </button>
      )}
    </span>
  );
}

const MARK = "shrink-0 peer-focus-visible:ring-2 peer-focus-visible:ring-focus";
const MARK_IDLE = "shadow-[inset_0_0_0_1.5px_var(--color-ink-tertiary)]";

export function WidgetRadioMark({ on, invalid = false }: { on: boolean; invalid?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-[18px] rounded-full", MARK, on ? "shadow-[inset_0_0_0_5.5px_var(--color-accent)]" : invalid ? "shadow-[inset_0_0_0_1.5px_var(--color-danger)]" : MARK_IDLE)}
    />
  );
}

export function WidgetCheckbox({ node }: { node: WidgetNode }) {
  const field = useWidgetField(node);
  const checked = field.form.values[field.name] === true;
  const label = widgetString(node, "label");
  return (
    <label className={cn("relative flex min-h-[44px] min-w-0 items-center gap-3 text-[14px] leading-5 text-ink", field.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
      <input {...field.control} type="checkbox" checked={checked} onChange={(event) => field.set(event.target.checked)} className="peer sr-only" />
      <span
        aria-hidden="true"
        className={cn("flex size-[18px] items-center justify-center rounded-[6px]", MARK, checked ? "bg-accent text-accent-ink" : field.invalid ? "shadow-[inset_0_0_0_1.5px_var(--color-danger)]" : MARK_IDLE)}
      >
        {checked && <Check size={12} strokeWidth={2.6} />}
      </span>
      {label && <span dir="auto" className="min-w-0 flex-1">{label}</span>}
    </label>
  );
}

export function WidgetRadioGroup({ node, labelledBy }: { node: WidgetNode; labelledBy?: string }) {
  const field = useWidgetField(node);
  const { id, "aria-invalid": invalid, "aria-describedby": describedBy, "aria-label": ariaLabel } = field.control;
  const choosingOther = field.other !== undefined;
  const choice = (key: string, checked: boolean, onChange: () => void, label: string, first: boolean) => (
    <label key={key} className={cn("relative inline-flex min-w-0 items-center gap-2 text-[14px] leading-5 text-ink", field.disabled ? "cursor-not-allowed" : "cursor-pointer")}>
      <input
        type="radio"
        name={id}
        value={key}
        checked={checked}
        disabled={field.disabled}
        onChange={onChange}
        data-widget-field={first ? field.name : undefined}
        className="peer sr-only"
      />
      <WidgetRadioMark on={checked} invalid={field.invalid} />
      <span dir="auto" className="min-w-0">{label}</span>
    </label>
  );
  const group = (
    <div
      role="radiogroup"
      id={id}
      aria-label={labelledBy ? undefined : ariaLabel}
      aria-labelledby={labelledBy}
      aria-required={field.control.required || undefined}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      className={cn("flex min-w-0", node.direction === "col" ? "flex-col gap-2.5" : "flex-wrap gap-x-[18px] gap-y-2", field.disabled && "opacity-60")}
    >
      {optionsOf(node).map((option, index) => choice(option.value, field.text === option.value, () => field.set(option.value), option.label, index === 0))}
      {field.takesOther && choice(OTHER_OPTION, choosingOther, field.chooseOther, t("question.other"), false)}
    </div>
  );
  if (!field.takesOther) return group;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {group}
      {choosingOther && <WidgetOtherInput name={field.name} disabled={field.disabled} focus />}
    </div>
  );
}

export function WidgetInput({ node, bare }: { node: WidgetNode; bare: boolean }) {
  const field = useWidgetField(node);
  return (
    <input
      {...field.control}
      type={widgetString(node, "inputType") ?? "text"}
      dir="auto"
      value={field.text}
      maxLength={WIDGET_LIMITS.fieldValue}
      placeholder={widgetString(node, "placeholder")}
      pattern={widgetString(node, "pattern")}
      onChange={(event) => field.set(event.target.value)}
      className={cn(WIDGET_FIELD, bare && "w-44 max-w-[60%] text-end")}
    />
  );
}

export function WidgetTextarea({ node }: { node: WidgetNode }) {
  const field = useWidgetField(node);
  const grows = node.autoResize === true;
  const maxRows = widgetNumber(node, "maxRows");
  return (
    <textarea
      {...field.control}
      dir="auto"
      rows={widgetNumber(node, "rows") ?? 3}
      value={field.text}
      maxLength={WIDGET_LIMITS.fieldValue}
      placeholder={widgetString(node, "placeholder")}
      onChange={(event) => field.set(event.target.value)}
      className={cn(WIDGET_FIELD, "h-auto resize-none py-2", grows && "[field-sizing:content]")}
      style={grows && maxRows ? { maxHeight: maxRows * 20 + 18 } : undefined}
    />
  );
}
