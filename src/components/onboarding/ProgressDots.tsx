import { cn } from "@/lib/cn";

const SLOT = 16;
const GAP = 6;

export function ProgressDots({
  items,
  index,
  onSelect,
  label,
}: {
  items: Array<{ id: string; label?: string }>;
  index: number;
  onSelect?: (index: number) => void;
  label?: string;
}) {
  const interactive = Boolean(onSelect);
  return (
    <div
      className="relative flex items-center"
      style={{ gap: GAP, height: 14 }}
      role={interactive ? "tablist" : undefined}
      aria-label={interactive ? label : undefined}
      aria-hidden={interactive ? undefined : true}
    >
      <span
        className="pointer-events-none absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{ width: SLOT, transform: `translate(${index * (SLOT + GAP)}px, -50%)` }}
        aria-hidden="true"
      />
      {items.map((item, i) => {
        const dot = (
          <span
            className={cn(
              "size-1.5 rounded-full transition-[background-color,opacity] duration-300",
              i === index ? "opacity-0" : i < index ? "bg-ink-secondary" : "bg-hairline",
            )}
          />
        );
        return interactive ? (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={i === index}
            aria-label={item.label ?? item.id}
            onClick={() => onSelect?.(i)}
            className="flex h-3.5 items-center justify-center rounded-full"
            style={{ width: SLOT }}
          >
            {dot}
          </button>
        ) : (
          <span key={item.id} data-step-dot={item.id} data-current={i === index} className="flex h-3.5 items-center justify-center" style={{ width: SLOT }}>
            {dot}
          </span>
        );
      })}
    </div>
  );
}
