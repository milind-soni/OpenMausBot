import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { SidebarPopoverMenu } from "./SidebarPopoverMenu";

export interface DecisionOption { value: string; label: string; disabled?: boolean; group?: string }

export function DecisionSelect({ value, options, onChange, disabled, "aria-label": ariaLabel, "data-testid": testId }: {
  value: string;
  options: DecisionOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  "aria-label": string;
  "data-testid": string;
}) {
  return (
    <div data-testid={testId} data-settings-select="" className="w-40 min-w-0 max-w-full">
      <SidebarPopoverMenu
        ariaLabel={ariaLabel}
        align="end"
        width={200}
        disabled={disabled}
        triggerTitle={options.find((option) => option.value === value)?.label}
        triggerClassName="flex w-full items-center gap-2 rounded-lg border border-hairline/40 bg-inset py-2 pl-3 pr-2 text-start text-[13px] text-ink focus-visible:border-focus focus-visible:outline-none disabled:cursor-default disabled:opacity-50"
        items={options.map((option, index) => ({
          key: option.value,
          label: option.label,
          title: option.label,
          checked: option.value === value,
          disabled: disabled || option.disabled,
          heading: option.group !== options[index - 1]?.group ? option.group : undefined,
          trailing: option.value === value ? <Check size={14} aria-hidden className="shrink-0 text-accent" /> : undefined,
          onSelect: () => onChange(option.value),
        }))}
        renderTrigger={({ open }) => <>
          <span className="min-w-0 flex-1 truncate">{options.find((option) => option.value === value)?.label ?? value}</span>
          <ChevronDown size={14} aria-hidden className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
        </>}
      />
    </div>
  );
}
