import type { LucideIcon } from "lucide-react";

export function ComposerToolButton({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink"
    >
      <Icon size={16} strokeWidth={1.75} absoluteStrokeWidth />
    </button>
  );
}
