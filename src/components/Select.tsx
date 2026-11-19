import { Check } from "lucide-react";
import { SidebarPopoverMenu } from "./SidebarPopoverMenu";
import { Children, isValidElement, useContext, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { SettingsLook } from "./SettingsPrimitives";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

const VARIANTS = {
  field: "rounded-lg border border-hairline/40 bg-inset text-ink",
  pill: "h-8 rounded-full border border-hairline/40 bg-raised/60 font-medium text-ink hover:bg-raised",
  ghost: "h-7 rounded-lg border-[0.5px] [border-color:var(--settings-edge,color-mix(in_srgb,var(--color-ink)_8%,transparent))] bg-transparent text-ink hover:bg-ink/[0.06] [field-sizing:content]",
  bare: "rounded-lg border border-transparent bg-transparent text-ink hover:bg-ink/[0.07]",
  quiet: "rounded-md bg-ink/[0.05] text-ink outline-none hover:bg-ink/[0.08] focus-visible:ring-[1.5px] focus-visible:ring-focus",
} as const;

const GHOST = { select: "pl-2.5 pr-[18px] text-[13px]", chevron: "right-1" };

// The 14px chevron draws its stroke ~3.5px inside its box, so the box sits that much nearer the edge than the text's padding.
const SIZES = {
  lg: { select: "py-2.5 pl-3 pr-9 text-[15px]", chevron: "right-2" },
  md: { select: "py-2 pl-3 pr-9 text-[13px]", chevron: "right-2" },
  sm: { select: "py-1.5 pl-2.5 pr-8 text-[13px]", chevron: "right-1.5" },
} as const;

function optionText(node: ReactNode): string {
  return Children.toArray(node).map((child) =>
    isValidElement<{ children?: ReactNode }>(child) ? optionText(child.props.children) : String(child),
  ).join("");
}

export function Select({
  className,
  variant = "field",
  size = "md",
  children,
  value,
  defaultValue,
  onChange,
  id,
  disabled,
  onFocus,
  onBlur,
  title,
  "aria-label": label,
  "aria-describedby": description,
  "aria-invalid": invalid,
  triggerContent,
  "data-widget-field": widgetField,
  ...props
}: Omit<ComponentProps<"select">, "size"> & {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  triggerContent?: ReactNode;
  "data-widget-field"?: string;
}) {
  const settings = useContext(SettingsLook);
  if (settings) variant = "ghost";
  const field = useRef<HTMLSelectElement>(null);
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const readOptions = (nodes: ReactNode, group?: ComponentProps<"optgroup">) => {
    let heading = group?.label;
    return Children.toArray(nodes).flatMap((child) => {
      if (!isValidElement<ComponentProps<"option">>(child) || child.type !== "option") return [];
      const { label, value, disabled, hidden, children } = child.props;
      const text = label ?? optionText(children);
      const option = { value: String(value ?? text), text, disabled: group?.disabled || disabled, hidden: group?.hidden || hidden, heading };
      if (!option.hidden) heading = undefined;
      return [option];
    });
  };
  const options = Children.toArray(children).flatMap((child) =>
    isValidElement<ComponentProps<"optgroup">>(child) && child.type === "optgroup"
      ? readOptions(child.props.children, child.props)
      : readOptions(child));
  const selected = value ?? uncontrolled ?? options.find((option) => !option.disabled)?.value;
  const sizing = variant === "ghost" ? GHOST : SIZES[size];

  return (
    <div data-settings-select={settings ? "" : undefined} className={cn("inline-flex min-w-0 [&>div]:min-w-0 [&>div]:flex-1", settings ? "min-w-[160px] max-w-[240px] [width:var(--settings-select-width,auto)]" : className)}>
      <SidebarPopoverMenu align="end"
        ariaLabel={label ?? options.find((option) => option.value === selected)?.text ?? ""}
        triggerLabel={label ?? null}
        triggerTitle={title}
        triggerProps={{ id, disabled, "data-widget-field": widgetField, "aria-describedby": description, "aria-invalid": invalid,
          onFocus: onFocus ? () => field.current?.dispatchEvent(new FocusEvent("focusin", { bubbles: true })) : undefined,
          onBlur: onBlur ? () => field.current?.dispatchEvent(new FocusEvent("focusout", { bubbles: true })) : undefined }}
        triggerClassName={triggerContent ? "grid place-items-center" : cn("relative flex w-full min-w-0 items-center text-start disabled:opacity-50", VARIANTS[variant], sizing.select)}
        items={options.filter((option) => !option.hidden).map((option, index) => ({
          key: String(index),
          label: option.text,
          heading: option.heading,
          checked: option.value === selected,
          disabled: option.disabled,
          trailing: option.value === selected ? <Check size={14} aria-hidden="true" /> : undefined,
          onSelect: () => {
            const select = field.current;
            if (!select || select.value === option.value) return;
            select.value = option.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
          },
        }))}
        renderTrigger={() => triggerContent ?? <>
          <span className="truncate">{options.find((option) => option.value === selected)?.text}</span>
          <ChevronDown size={variant === "ghost" ? 12 : 14} aria-hidden className={cn("absolute top-1/2 -translate-y-1/2 text-ink-secondary", sizing.chevron)} />
        </>}
      />
      {/* Keep form submission and React's change event on the actual form field. */}
      <select {...props} ref={field} hidden aria-hidden="true" aria-label={label} tabIndex={-1}
        onFocus={onFocus} onBlur={onBlur} disabled={disabled} value={value} defaultValue={defaultValue}
        onChange={(event) => { setUncontrolled(event.currentTarget.value); onChange?.(event); }}>
        {children}
      </select>
    </div>
  );
}
