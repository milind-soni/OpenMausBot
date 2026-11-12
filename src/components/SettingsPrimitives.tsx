import { createContext, useContext, useId, useState, type ComponentProps, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronRight, Copy, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";

/** True inside the Settings window: every primitive draws the one Settings look (cards with edges, 44/64 px rows). */
export const SettingsLook = createContext(false);

const InCard = createContext(false);

/** A card: radius 12 on the card fill, with its 0.5 px edge drawn as an inset hairline above the rows (a border this thin
 * is rounded up to a whole pixel on some screens, which made cards read heavier than their 0.5 px dividers). */
export const SIMPLE_CARD = "settings-card relative rounded-[12px] bg-menu after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_0.5px_var(--settings-edge)] after:content-['']";

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
  const nested = useContext(InCard);
  if (useContext(SettingsLook) && nested) {
    // Never a card in a card: a Card inside another is a titled part of it, set off by a divider.
    return (
      <section className="flex flex-col gap-2 border-t-[0.5px] border-(--settings-edge) pt-4 first-of-type:border-t-0 first-of-type:pt-0" data-settings-subcard="">
        {title && <h4 className="text-[13px] font-medium leading-[18px] text-ink">{title}</h4>}
        {subtitle && <p className="text-[13px] leading-[18px] text-ink-secondary">{subtitle}</p>}
        {children}
      </section>
    );
  }
  if (useContext(SettingsLook)) {
    return (
      <section className="flex flex-col gap-2">
        {(title || subtitle) && (
          <div className="flex flex-col gap-0.5 px-4">
            {title && <h3 className="text-[13px] font-medium leading-[18px] text-ink">{title}</h3>}
            {subtitle && <p className="text-[13px] leading-[18px] text-ink-secondary">{subtitle}</p>}
          </div>
        )}
        {children && <div className={cn(SIMPLE_CARD, "flex flex-col gap-4 p-4")}><InCard.Provider value={true}>{children}</InCard.Provider></div>}
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

/** The 32 px leading slot. It gives back 6 px above and below, so it sits inside the 12 + 20 + 12 text block: a title-only
 * row with a slot (or an empty one) is 44 like every other title-only row, and the text still starts at x + 60. */
export const SLOT = "-my-1.5 flex size-8 shrink-0 items-center justify-center self-center @max-[480px]/rows:self-start";

/** A control is at most 28 tall and gives back 4 px above and below, so the text block sets the row's height, never the
 * control: a select, a button and a switch row are all 44 (§6.5). Dropped under the text at narrow widths, the row's
 * 12 px gap less those 4 leaves the 8 the spec asks for. */
const CONTROL_FIT = "-my-1";

export function SettingRow({
  title,
  subtitle,
  children,
  message,
  className,
  tag,
  leading,
  inert,
  inertText,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  message?: React.ReactNode;
  className?: string;
  /** a short word after the title, such as Advanced or Early */
  tag?: string;
  /** the 32 px leading slot of an icon card: a device, a provider, a step */
  leading?: ReactNode;
  /** the row applies here but can't be changed from this page: control at 40%, quiet text and the reason under it */
  inert?: ReactNode;
  /** the reason as plain words, for the row's tooltip */
  inertText?: string;
}) {
  const titleId = useId();
  if (useContext(SettingsLook)) {
    const quiet = inert != null && inert !== false;
    return (
      <div role="group" aria-labelledby={titleId} aria-disabled={quiet || undefined} data-setting-row="" data-settings-inert={quiet ? "" : undefined}
        title={quiet && typeof inertText === "string" ? inertText : undefined}
        className={cn("flex min-h-11 items-center gap-3 px-4 py-3", className)}>
        {leading !== undefined && <span data-settings-slot="" className={SLOT}>{leading}</span>}
        {/* The text column holds the title, its description, and the status or reason line; the control sits centred
            on the whole block, so an inert row's 40% control lines up with the row, not its first line. */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex min-w-[min(100%,7rem)] flex-1 flex-col">
            <div id={titleId} className={cn("flex min-w-0 items-center gap-1.5 text-[14px] leading-5", quiet ? "text-ink-secondary" : "text-ink")}>{title}{tag && <SettingsTag>{tag}</SettingsTag>}</div>
            {subtitle && <div className="mt-0.5 text-[13px] leading-[18px] text-ink-secondary">{subtitle}</div>}
            {message && <div className="mt-1 text-[12px] leading-4 text-ink-secondary">{message}</div>}
            {quiet && <div data-settings-reason="" className="mt-1 text-[12px] leading-4 text-ink-secondary">{inert}</div>}
          </div>
          {children != null && children !== false && (
            <div data-settings-control="" className={cn("ml-auto flex shrink-0 items-center gap-2 self-center", CONTROL_FIT, quiet && "pointer-events-none opacity-40")} {...(quiet ? { inert: true } : {})}>{children}</div>
          )}
        </div>
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
      {(message || inert) && <div className="mt-2 text-[12px]">{message}{inert}</div>}
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
        <div className="flex flex-col gap-1 px-4">
          {/* The title and its one action share a 28 px line; the description runs 4 under them, the full width, and the
              card follows 8 below (§6.4's section description: the one place a section says more than its title). */}
          <div className="flex min-h-7 items-center justify-between gap-3">
            {label && <h3 id={labelId} className="min-w-0 text-[13px] font-medium leading-[18px] text-ink">{label}</h3>}
            {actions && <div data-settings-actions="" className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
          </div>
          {description && <p className="text-[13px] leading-[18px] text-ink-secondary">{description}</p>}
        </div>
      )}
      {children}
      {footnote && <p className="px-4 text-[12px] leading-4 text-ink-secondary empty:hidden">{footnote}</p>}
    </section>
  );
}

/** One card of rows. `selectWidth` gives every select in the card one width, so their left edges line up. */
export function SettingsRows({ children, icons = false, selectWidth }: { children: ReactNode; icons?: boolean; selectWidth?: number }) {
  // A Card drawn inside these rows is a titled part of this card (never a card in a card).
  return <div data-settings-rows="" data-settings-icons={icons ? "" : undefined} className={cn(SIMPLE_CARD, "@container/rows flex flex-col overflow-hidden empty:hidden")}
    style={selectWidth ? { ["--settings-select-width" as string]: `${selectWidth}px` } : undefined}><InCard.Provider value={true}>{children}</InCard.Provider></div>;
}

/** The last line of a card holding a small form (a backup model, a key): its status on the left, Save on the right. */
export function SettingsFormFoot({ status, children }: { status?: ReactNode; children: ReactNode }) {
  return (
    <div data-settings-form-foot="" className="flex min-h-11 items-center justify-end gap-3 px-4 py-2">
      {status && <div className="mr-auto min-w-0 text-[12px] leading-4 text-ink-secondary">{status}</div>}
      {children}
    </div>
  );
}

/** A row that goes somewhere: the whole row is the button, with a value and a chevron (an arrow when it leaves Settings). */
export function SettingsLinkRow({ title, subtitle, value, badge, leading, external = false, onClick, data }: {
  title: string;
  subtitle?: ReactNode;
  value?: ReactNode;
  badge?: ReactNode;
  /** the 32 px leading slot, in an icon card */
  leading?: ReactNode;
  external?: boolean;
  onClick: () => void;
  data?: Record<string, string>;
}) {
  return (
    <button type="button" onClick={onClick} {...data}
      className="group flex min-h-11 w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-menu-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none">
      {leading !== undefined && <span data-settings-slot="" className={SLOT}>{leading}</span>}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] leading-5 text-ink">{title}</span>
        {subtitle && <span className="text-[13px] leading-[18px] text-pretty text-ink-secondary">{subtitle}</span>}
      </span>
      <span className="ml-3 flex shrink-0 items-center gap-1.5 text-[13px] leading-5 text-ink-secondary">
        {badge}
        {value}
        {external ? <ArrowUpRight size={12} aria-hidden="true" className="text-ink-tertiary" />
          : <ChevronRight size={14} aria-hidden="true" className="-mr-1 text-ink-tertiary rtl:-scale-x-100" />}
      </span>
    </button>
  );
}

/** A row that opens more rows in its own card: the chevron turns, and what it reveals joins the card under a divider.
 * Use it inside SettingsRows; it replaces every native details triangle. */
export function SettingsFoldRow({ id, title, subtitle, value, leading, open, onToggle, children }: {
  id: string;
  title: string;
  subtitle?: ReactNode;
  value?: ReactNode;
  leading?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return <>
    <div data-settings-disclosure={id} data-settings-fold="">
      <button type="button" aria-expanded={open} onClick={onToggle}
        className="group flex min-h-11 w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-menu-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none">
        {leading !== undefined && <span data-settings-slot="" className={SLOT}>{leading}</span>}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] leading-5 text-ink">{title}</span>
          {subtitle && <span className="text-[13px] leading-[18px] text-pretty text-ink-secondary">{subtitle}</span>}
        </span>
        <span className="ml-3 flex shrink-0 items-center gap-1.5 text-[13px] leading-5 text-ink-secondary">
          {value}
          <ChevronRight size={14} aria-hidden="true" className={cn("-mr-1 text-ink-tertiary transition-transform duration-150 motion-reduce:transition-none rtl:-scale-x-100", open && "rotate-90")} />
        </span>
      </button>
    </div>
    {/* The revealed rows are the card's own rows (each gets the card's divider), so they are not wrapped. */}
    {open && children}
  </>;
}

/** A fold row alone in its own card (no section title): what it opens joins that same card. */
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
  return (
    <section data-settings-block={block} className="flex scroll-mt-4 flex-col">
      <SettingsRows>
        <SettingsFoldRow id={id} title={title} subtitle={subtitle} value={trailing} open={open} onToggle={onToggle}>{children}</SettingsFoldRow>
      </SettingsRows>
    </section>
  );
}

/** The 32 px leading slot's circle: an 18 px mark on ink 5%. */
export function SettingsMark({ children }: { children: ReactNode }) {
  return <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-ink/[0.05] text-ink-secondary [&_svg]:size-[18px] [&_img]:size-[18px]">{children}</span>;
}

/** "● Ready": a 6 px dot before a short status word. */
export function StatusDot({ tone }: { tone: "success" | "warning" | null }) {
  if (!tone) return null;
  return <span aria-hidden="true" className={cn("mr-1.5 inline-block size-1.5 shrink-0 rounded-full align-middle", tone === "success" ? "bg-success" : "bg-warning")} />;
}

/** One line of plain rows' text when a list has nothing in it yet. */
export function SettingsEmptyRow({ children }: { children: ReactNode }) {
  return <div data-settings-empty="" className="flex min-h-11 items-center px-4 py-3 text-[13px] leading-[18px] text-ink-secondary">{children}</div>;
}

/** A stacked field: a 13/18 500 label 6 above a 32 px field (the label holds the field, so it names it). */
export function SettingsField({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5" data-settings-field="">
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium leading-[18px] text-ink">{label}</span>
        {children}
      </label>
      {hint && <div className="text-[12px] leading-4 text-ink-secondary">{hint}</div>}
    </div>
  );
}
/** A field's 0.5 px edge is an inset hairline, like a card's: a 0.5 px border is rounded up to a whole pixel on some
 * screens, which drew fields heavier than the cards and dividers around them. Keyboard focus is the 2 px ring. */
export const FIELD_EDGE = "border-0 shadow-[inset_0_0_0_0.5px_var(--settings-edge,var(--color-hairline))]";
export const SETTINGS_INPUT = `h-8 w-full rounded-lg ${FIELD_EDGE} bg-app px-2 text-[13px] leading-5 text-ink outline-none placeholder:text-ink-tertiary focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus disabled:opacity-40`;
export const SETTINGS_INLINE_INPUT = `h-7 w-20 rounded-lg ${FIELD_EDGE} bg-app px-2 text-right text-[13px] leading-5 tabular-nums text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus disabled:opacity-40`;

/** The one segmented control: a 28 px pill track; the chosen part is a card-coloured pill with an edge. */
export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} data-settings-segmented="" className="inline-flex h-7 items-center rounded-full bg-ink/[0.05] p-0.5">
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} onClick={() => onChange(option.value)}
          className={cn("h-6 cursor-pointer rounded-full px-3 text-[13px] leading-5 transition-colors focus-visible:outline-2 focus-visible:outline-focus",
            value === option.value ? "bg-menu font-medium text-ink shadow-[inset_0_0_0_0.5px_var(--settings-edge)]" : "text-ink-secondary hover:text-ink")}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A description kept to its short form (≤ 140 characters), with Learn more opening the full text in its place. */
export function MoreText({ short, long }: { short: ReactNode; long: ReactNode }) {
  const [open, setOpen] = useState(false);
  return open ? <>{long}</> : <>{short}{" "}<LearnMore onClick={() => setOpen(true)} /></>;
}

/** Learn more, as a link at the end of a description. */
export function LearnMore({ onClick, href, label }: { onClick?: () => void; href?: string; label?: string }) {
  const text = label ?? t("settings.learnMore");
  if (href) return <a href={href} target="_blank" rel="noreferrer" className="text-accent-text hover:underline focus-visible:underline">{text}</a>;
  return <button type="button" onClick={onClick} className="cursor-pointer text-accent-text hover:underline focus-visible:underline">{text}</button>;
}

export function CommandLine({ command, copyLabel = "Copy command" }: { command: string; copyLabel?: string }) {
  const { state, copy } = useCopyFeedback(command);
  // In Settings the command is a mono 12/16 line on the text edge (no box of its own, no extra inset), with its copy button.
  const settings = useContext(SettingsLook);

  return (
    <div className={settings ? "flex items-center gap-2" : "flex items-center gap-2 rounded-lg bg-inset px-3 py-2"}>
      <code className={cn("min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap font-mono text-[12px] text-ink", settings && "leading-4")}>
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
