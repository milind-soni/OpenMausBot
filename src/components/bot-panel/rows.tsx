import type { ReactNode, Ref } from "react";
import { Check, ChevronLeft, ChevronRight, Trash2, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/cn";
import { useAdvancedMode } from "@/lib/interface-mode";
import { MAUS_COLORS, type MausColor } from "@/lib/mascot";
import { ELEVATED_CONTROL, ELEVATED_HOVER } from "../elevated";
import { Switch } from "../SettingsPrimitives";

export const rowCls = "flex min-h-[46px] items-center gap-2.5 px-3.5 py-[11px]";
export const roundButtonCls = `flex size-[34px] shrink-0 items-center justify-center rounded-full text-ink ${ELEVATED_CONTROL} ${ELEVATED_HOVER} [:root[data-skin=daylight]_&]:shadow-[0_1px_3px_rgb(28_28_28/0.12)]`;
const titleCls = "text-[14px] font-medium text-ink";
const hintCls = "mt-px text-[13px] leading-[1.35] text-ink-secondary";
export const buttonCls =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[9px] bg-control px-3.5 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50";
export const chipCls = (on: boolean) =>
  cn(
    "rounded-full px-2.5 py-1 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    on ? "bg-ink/[0.15] text-ink" : "bg-ink/[0.04] text-ink-secondary enabled:hover:text-ink",
  );

export function CardLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-1 mb-2 mt-5 flex min-h-5 items-center justify-between gap-3 text-[13px] text-ink-secondary">
      <span className="min-w-0 truncate">{children}</span>
      {action}
    </div>
  );
}

export function LabelAction({ children, onClick, ...rest }: { children: ReactNode; onClick: () => void; "aria-label"?: string; "data-panel-action"?: string }) {
  return (
    <button type="button" {...rest} onClick={onClick} className="shrink-0 rounded-[5px] px-1 py-px text-[13px] text-ink-secondary hover:bg-ink/[0.04] hover:text-ink">
      {children}
    </button>
  );
}

export function Card({ label, action, anchor, children }: { label?: ReactNode; action?: ReactNode; anchor?: string; children: ReactNode }) {
  const advanced = useAdvancedMode();
  return (
    <section data-panel-card={anchor}>
      {label ? <CardLabel action={action}>{label}</CardLabel> : <div className="h-3.5" />}
      <div
        data-panel-card-surface=""
        className={cn(
          "divide-y divide-ink/[0.05] overflow-hidden max-md:rounded-[20px] max-md:border-hairline max-md:bg-card",
          advanced ? "rounded-[14px] border border-ink/[0.04] bg-ink/[0.03]" : "rounded-[12px] bg-composer ring-1 ring-inset ring-ink/[0.06] max-md:border max-md:ring-0",
        )}
      >
        {children}
      </div>
    </section>
  );
}

export function RowText({ title, hint }: { title: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <div className={titleCls}>{title}</div>
      {hint && <div className={hintCls}>{hint}</div>}
    </div>
  );
}

export function RowIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-ink/[0.05] text-ink-secondary max-md:size-8 max-md:rounded-full" aria-hidden="true">
      <Icon size={15} />
    </span>
  );
}

export function BotSwitch({ color, checked, ...props }: Parameters<typeof Switch>[0] & { color: MausColor }) {
  return <Switch {...props} checked={checked} style={checked ? { backgroundColor: MAUS_COLORS[color] } : undefined} />;
}

export function SwitchRow({ title, hint, checked, onChange, disabled, color, label, tooltip, extra, ...rest }: {
  title: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  color: MausColor;
  label?: string;
  tooltip?: string;
  extra?: ReactNode;
  "data-panel-row"?: string;
}) {
  return (
    <div {...rest} className={rowCls}>
      <RowText title={title} hint={hint} />
      {extra}
      <BotSwitch
        color={color}
        checked={checked}
        disabled={disabled}
        title={tooltip}
        aria-label={label ?? (typeof title === "string" ? title : undefined)}
        onClick={onChange}
        className="disabled:cursor-not-allowed"
      />
    </div>
  );
}

export function NavRow({ title, hint, value, icon, onClick, drill = true, danger = false, disabled, tooltip, ...rest }: {
  title: ReactNode;
  hint?: ReactNode;
  value?: ReactNode;
  icon?: LucideIcon;
  onClick: () => void;
  drill?: boolean;
  danger?: boolean;
  disabled?: boolean;
  tooltip?: string;
  ref?: Ref<HTMLButtonElement>;
  "data-panel-row"?: string;
  "data-panel-page"?: string;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled}
      title={tooltip}
      onClick={onClick}
      className={cn(rowCls, "w-full text-left enabled:hover:bg-ink/[0.03] disabled:cursor-default disabled:opacity-45")}
    >
      {icon && <RowIcon icon={icon} />}
      <div className="min-w-0 flex-1">
        <div className={cn(titleCls, danger && "text-danger")}>{title}</div>
        {hint && <div className={hintCls}>{hint}</div>}
      </div>
      {value !== undefined && value !== null && value !== "" && (
        <span className="inline-flex max-w-[45%] shrink-0 items-center gap-1 truncate text-[13px] text-ink-secondary">{value}</span>
      )}
      {drill && <ChevronRight size={15} className="shrink-0 text-ink-tertiary" aria-hidden="true" />}
    </button>
  );
}

export function ItemRow({ title, hint, icon, children, ...rest }: {
  title: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  children?: ReactNode;
  "data-panel-row"?: string;
}) {
  return (
    <div {...rest} className={rowCls}>
      {icon && <RowIcon icon={icon} />}
      <RowText title={title} hint={hint} />
      {children}
    </div>
  );
}

export function ColRow({ children, ...rest }: { children: ReactNode; "data-panel-row"?: string }) {
  return <div {...rest} className={cn(rowCls, "flex-col items-stretch gap-[9px]")}>{children}</div>;
}

export function NoteRow({ children, tone }: { children: ReactNode; tone?: "warn" }) {
  return (
    <div className={rowCls}>
      <div className={cn("text-[13px] leading-[1.35]", tone === "warn" ? "text-warning" : "text-ink-secondary")}>{children}</div>
    </div>
  );
}

export function LinkRow({ children, onClick, icon: Icon = ChevronRight, ...rest }: {
  children: ReactNode;
  onClick: () => void;
  icon?: LucideIcon;
  "data-panel-link"?: string;
}) {
  return (
    <button type="button" {...rest} onClick={onClick} className="flex w-full items-center gap-2 px-3.5 py-[11px] text-left text-[13px] text-ink-secondary hover:text-ink">
      <span className="min-w-0 flex-1">{children}</span>
      <Icon size={14} className="shrink-0" aria-hidden="true" />
    </button>
  );
}

export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  tooltip?: string;
}

export function Segmented<V extends string>({ options, value, onChange, label, attr }: {
  options: readonly SegmentOption<V>[];
  value: string | null | undefined;
  onChange: (value: V) => void;
  label: string;
  attr: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex w-full rounded-full bg-ink/[0.05] p-[3px]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          {...{ [attr]: option.value }}
          aria-pressed={value === option.value}
          disabled={option.disabled}
          title={option.tooltip}
          onClick={() => onChange(option.value)}
          className={cn(
            "min-w-0 flex-auto truncate whitespace-nowrap rounded-full px-1.5 py-1.5 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            value === option.value ? "bg-ink/[0.14] text-ink" : "text-ink-secondary enabled:hover:text-ink",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SegmentedRow<V extends string>({ title, hint, footer, ...segmented }: Parameters<typeof Segmented<V>>[0] & {
  title?: ReactNode;
  hint?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <ColRow data-panel-row={segmented.attr}>
      {(title || hint) && <RowText title={title} hint={hint} />}
      <Segmented {...segmented} />
      {footer}
    </ColRow>
  );
}

export function TrashButton({ label, onClick, disabled, ...rest }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  "data-panel-action"?: string;
}) {
  return (
    <button
      type="button"
      {...rest}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-tertiary hover:bg-ink/[0.05] hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Trash2 size={14} aria-hidden="true" />
    </button>
  );
}

export function RadioRow({ title, hint, checked, onClick, disabled, ...rest }: {
  title: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onClick: () => void;
  disabled?: boolean;
  "data-panel-choice"?: string;
}) {
  return (
    <button
      type="button"
      {...rest}
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      className={cn(rowCls, "w-full text-left enabled:hover:bg-ink/[0.03] disabled:cursor-not-allowed disabled:opacity-50")}
    >
      <RowText title={title} hint={hint} />
      <span className="flex w-4 shrink-0 text-ink">{checked && <Check size={16} aria-hidden="true" />}</span>
    </button>
  );
}

export function TextRow({ value, placeholder, label, action, disabled, onChange, onSubmit, ...rest }: {
  value: string;
  placeholder: string;
  label: string;
  action: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  "data-panel-form"?: string;
}) {
  return (
    <form
      {...rest}
      className={rowCls}
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim() && !disabled) onSubmit();
      }}
    >
      <input
        value={value}
        placeholder={placeholder}
        aria-label={label}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 min-w-0 flex-1 rounded-lg border border-hairline bg-inset px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent-border disabled:opacity-50"
      />
      <button type="submit" disabled={disabled || !value.trim()} className={buttonCls}>{action}</button>
    </form>
  );
}

export function PageHeader({ back, title, intro, onBack }: { back: string; title: string; intro?: ReactNode; onBack: () => void }) {
  return (
    <div>
      <button
        type="button"
        data-panel-back
        onClick={onBack}
        className="mt-0.5 inline-flex items-center gap-0.5 rounded-[7px] py-1 pl-0.5 pr-2 text-[13px] text-ink-secondary hover:bg-ink/[0.04] hover:text-ink"
      >
        <ChevronLeft size={15} aria-hidden="true" />
        <span>{back}</span>
      </button>
      <h3 className="mx-1 mt-1.5 text-[18px] font-semibold text-ink">{title}</h3>
      {intro && <p className="mx-1 mt-1.5 text-[13px] leading-normal text-ink-secondary">{intro}</p>}
    </div>
  );
}
