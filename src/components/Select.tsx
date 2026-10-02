import type { ComponentProps } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

const VARIANTS = {
  field: "rounded-lg border border-hairline/40 bg-inset text-ink",
  pill: "h-8 rounded-full border border-hairline/40 bg-raised/60 font-medium text-ink hover:bg-raised",
} as const;

// The chevron's stroke sits as far from the right edge as the text does from
// the left. The 14px icon draws its stroke ~3.5px inside its box, so the box
// sits that much closer to the edge than the text's padding.
const SIZES = {
  // Matches bot-settings/field.ts `inputCls`, for the dialogs built on it.
  lg: { select: "py-2.5 pl-3 pr-9 text-[15px]", chevron: "right-2" },
  md: { select: "py-2 pl-3 pr-9 text-[13px]", chevron: "right-2" },
  sm: { select: "py-1.5 pl-2.5 pr-8 text-[12.5px]", chevron: "right-1.5" },
} as const;

/**
 * The app's dropdown: a native `<select>` drawn without the platform arrow,
 * with our own chevron inside the padding, so every one looks and aligns the
 * same on every OS. The look is owned here; `className` positions the field
 * (width, margin, flex) and nothing else — Select.guard.test.ts enforces it.
 */
export function Select({
  className,
  variant = "field",
  size = "md",
  ...props
}: Omit<ComponentProps<"select">, "size"> & { variant?: keyof typeof VARIANTS; size?: keyof typeof SIZES }) {
  return (
    <div className={cn("relative inline-flex min-w-0", className)}>
      <select
        {...props}
        className={cn(
          "peer w-full min-w-0 appearance-none truncate disabled:opacity-50",
          VARIANTS[variant],
          SIZES[size].select,
        )}
      />
      <ChevronDown
        size={14}
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-ink-secondary peer-disabled:opacity-50",
          SIZES[size].chevron,
        )}
      />
    </div>
  );
}
