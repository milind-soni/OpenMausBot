import { createContext, useContext, useId, type ComponentProps, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronRight, Copy, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";

/** True inside the Settings window: every primitive draws the one Settings look (cards with edges, 44/64 px rows). */
export const SettingsLook = createContext(false);

export const SIMPLE_CARD = "settings-card rounded-[12px] border-[0.5px] border-(--settings-edge) bg-menu";

export function Switch({
  checked,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children" | "role" | "aria-checked"> & { checked: boolean }) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      data-switch=""
      className={cn(
        "relative cursor-pointer h-6 w-11 shrink-0 rounded-full transition-colors enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none",
        checked ? "bg-accent" : "bg-control",
        className,
      )}
    >
      <span
        className={cn(
          "absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-[left] motion-reduce:transition-none",
          checked ? "left-[21px]" : "left-[3px]",
        )}
      />
    </button>
  );
}

export function Card({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  if (useContext(SettingsLook)) {
    return (
      <section className="flex flex-col gap-2">
        {(title || subtitle) && (
          <div className="flex flex-col gap-0.5 px-4">
            {title && <h3 className="text-[13px] font-medium leading-[18px] text-ink">{title}</h3>}
            {subtitle && <p className="text-[13px] leading-[18px] text-ink-secondary">{subtitle}</p>}
          </div>
        )}
        {children && <div className={cn(SIMPLE_CARD, "p-4")}>{children}</div>}
      </section>
    );
  }
  return (
    <div className="rounded-xl bg-card p-4 max-md:rounded-2xl">
      {title && <div className="text-[16px] font-semibold text-ink">{title}</div>}
      {subtitle && <div className={cn(title && "mt-0.5", "text-[13px] leading-relaxed text-ink-secondary")}>{subtitle}</div>}
      {children && <div className={title || subtitle ? "mt-4" : undefined}>{children}</div>}
    </div>
  );
}

export function SettingRow({
  title,
  subtitle,
  children,
  message,
  className,
  tag,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  message?: React.ReactNode;
  className?: string;
  /** a short word after the title, such as Advanced or Early */
  tag?: string;
}) {
  const titleId = useId();
  if (useContext(SettingsLook)) {
    return (
      <div role="group" aria-labelledby={titleId} data-setting-row="" className={cn("flex min-h-11 flex-col justify-center px-4 py-3", className)}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex min-w-[min(100%,15rem)] flex-1 flex-col gap-0.5">
            <div id={titleId} className="flex items-center gap-1.5 text-[14px] leading-5 text-ink">{title}{tag && <SettingsTag>{tag}</SettingsTag>}</div>
            {subtitle && <div className="text-[13px] leading-[18px] text-pretty text-ink-secondary">{subtitle}</div>}
          </div>
          {children != null && children !== false && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
        </div>
        {message && <div className="mt-1 text-[12px] leading-4 text-ink-secondary">{message}</div>}
      </div>
    );
  }
  return (
    <div role="group" aria-labelledby={titleId} className={cn("px-4", className)}>
      <div className="grid min-w-0 grid-cols-1 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-6">
        <div className="min-w-0">
          <div id={titleId} className="text-[14px] font-medium text-ink">{title}</div>
          {subtitle && <div className="mt-1 text-[12px] leading-relaxed text-pretty text-ink-secondary">{subtitle}</div>}
        </div>
        <div className="min-w-0 sm:max-w-[240px]">{children}</div>
      </div>
      {message && <div className="mt-2 text-[12px]">{message}</div>}
    </div>
  );
}

export function SettingsTag({ children }: { children: ReactNode }) {
  return <span data-settings-tag="" className="inline-flex h-4 shrink-0 items-center rounded-full bg-ink/[0.06] px-1.5 text-[11px] font-medium leading-4 text-ink-secondary">{children}</span>;
}

export function SettingsGroup({ label, block, actions, footnote, description, children }: {
  label?: string;
  block?: string;
  actions?: ReactNode;
  footnote?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  const labelId = useId();
  return (
    <section
      data-settings-block={block}
      aria-labelledby={label ? labelId : undefined}
      className="flex scroll-mt-4 flex-col gap-2 has-[>[data-settings-rows]:empty]:hidden"
    >
      {(label || actions) && (
        <div className="flex min-h-7 items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            {label && <h3 id={labelId} className="text-[13px] font-medium leading-[18px] text-ink">{label}</h3>}
            {description && <p className="text-[13px] leading-[18px] text-ink-secondary">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
      {footnote && <p className="px-4 text-[12px] leading-4 text-ink-secondary empty:hidden">{footnote}</p>}
    </section>
  );
}

export function SettingsRows({ children, icons = false }: { children: ReactNode; icons?: boolean }) {
  return <div data-settings-rows="" data-settings-icons={icons ? "" : undefined} className={cn(SIMPLE_CARD, "flex flex-col overflow-hidden empty:hidden")}>{children}</div>;
}

/** A row that goes somewhere: the whole row is the button, with a value and a chevron (an arrow when it leaves Settings). */
export function SettingsLinkRow({ title, subtitle, value, badge, external = false, onClick, data }: {
  title: string;
  subtitle?: ReactNode;
  value?: ReactNode;
  badge?: ReactNode;
  external?: boolean;
  onClick: () => void;
  data?: Record<string, string>;
}) {
  return (
    <button type="button" onClick={onClick} {...data}
      className="group flex min-h-11 w-full cursor-pointer items-center gap-6 px-4 py-3 text-left transition-colors hover:bg-menu-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] leading-5 text-ink">{title}</span>
        {subtitle && <span className="text-[13px] leading-[18px] text-ink-secondary">{subtitle}</span>}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[13px] leading-5 text-ink-secondary">
        {badge}
        {value}
        {external ? <ArrowUpRight size={12} aria-hidden="true" className="text-ink-tertiary" />
          : <ChevronRight size={14} aria-hidden="true" className="text-ink-tertiary rtl:-scale-x-100" />}
      </span>
    </button>
  );
}

export function SettingsDisclosureRow({ id, title, subtitle, trailing, block, open, onToggle, children }: {
  id: string;
  title: string;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  block?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const regionId = useId();
  return (
    <section data-settings-disclosure={id} data-settings-block={block} className="flex scroll-mt-4 flex-col gap-3">
      <div className={SIMPLE_CARD}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={onToggle}
          className="group flex min-h-11 w-full cursor-pointer items-center gap-6 rounded-[12px] px-4 py-3 text-left transition-colors hover:bg-menu-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[14px] leading-5 text-ink">{title}</span>
            {subtitle && <span className="text-[13px] leading-[18px] text-ink-secondary">{subtitle}</span>}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[13px] leading-5 text-ink-secondary">
            {trailing}
            <ChevronRight size={14} aria-hidden="true" className={cn("text-ink-tertiary transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} />
          </span>
        </button>
      </div>
      <div id={regionId} hidden={!open} className="flex flex-col gap-6">{children}</div>
    </section>
  );
}

export function CommandLine({ command, copyLabel = "Copy command" }: { command: string; copyLabel?: string }) {
  const { state, copy } = useCopyFeedback(command);

  return (
    <div className="flex items-center gap-2 rounded-lg bg-inset px-3 py-2">
      <code className="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap font-mono text-[12px] text-ink">
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={state === "failed" ? t("common.copyFailed") : copyLabel}
        className="ui-icon-button shrink-0"
      >
        {state === "copied" ? <Check size={13} className="text-success" /> : state === "failed" ? <X size={13} className="text-danger" /> : <Copy size={13} />}
      </button>
    </div>
  );
}
