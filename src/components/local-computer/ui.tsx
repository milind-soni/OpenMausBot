import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Action } from "./inventory";

export function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]",
          done ? "bg-success/20 text-success" : "border border-hairline/50 text-ink-secondary",
        )}
      >
        {done ? <Check size={12} /> : n}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn("text-[14px]", done ? "text-ink-secondary line-through" : "text-ink")}>{title}</div>
        {!done && children && <div className="mt-2 flex flex-col items-start gap-2 [&>*]:max-w-full">{children}</div>}
      </div>
    </div>
  );
}

export function ActionButton({
  action,
  pending,
  children,
  onClick,
  danger = false,
}: {
  action: Action;
  pending: Action | null;
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={pending !== null}
      className={cn(
        "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-50",
        danger ? "bg-danger/15 text-danger hover:bg-danger/20" : "bg-accent text-white hover:brightness-110",
      )}
    >
      {pending === action && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

