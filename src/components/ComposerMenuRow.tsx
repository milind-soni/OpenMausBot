import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

/** One picker row: icon, name, optional one-line description, kind tag at the end. */
export function ComposerMenuRow({
  icon,
  name,
  description,
  kind,
  selected = false,
  className,
  type = "button",
  ...rest
}: {
  icon: ReactNode;
  name: string;
  description?: string;
  kind: string;
  selected?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      {...rest}
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-2 text-start",
        selected && "bg-raised-hover",
        className,
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-ink">{name}</span>
        {description ? (
          <span dir="auto" className="block truncate text-xs text-ink-secondary">
            {description}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-end text-xs text-ink-secondary">{kind}</span>
    </button>
  );
}
