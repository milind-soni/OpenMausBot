import { cn } from "@/lib/cn";

/** The app's on/off switch (matches bot settings). Use instead of native checkboxes. */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
  size = "md",
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
  size?: "sm" | "md";
}) {
  const sm = size === "sm";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-40 motion-reduce:transition-none",
        sm ? "h-[20px] w-[34px]" : "h-[26px] w-[44px]",
        checked ? "bg-accent" : "bg-raised-hover",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-[3px] rounded-full bg-white shadow transition-transform motion-reduce:transition-none",
          sm ? "left-[3px] h-[14px] w-[14px]" : "left-[3px] h-[20px] w-[20px]",
          checked && (sm ? "translate-x-[14px]" : "translate-x-[18px]"),
        )}
      />
    </button>
  );
}
