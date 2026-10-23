import { useEffect, useRef, useState } from "react";
import { Check, FolderMinus } from "lucide-react";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useHeldMenuMotion } from "./MenuMotion";

/** "Move to context": the sidebar sections in use, a field for a new one, and "remove from context". */
export function SectionPicker({
  current,
  anchor,
  onClose,
  onAssign,
}: {
  current: string | undefined;
  anchor: { x: number; y: number } | null;
  onClose: () => void;
  onAssign: (section: string) => void;
}) {
  const { state } = useStore();
  const [name, setName] = useState("");
  const motion = useHeldMenuMotion(anchor);
  const shown = motion.value;
  const heldCurrent = useRef(current);
  if (anchor) heldCurrent.current = current;
  const trimmed = name.trim();

  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-section-picker]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [anchor, onClose]);

  const sections = [
    ...new Set([
      ...(state.sections ?? []),
      ...state.bots.filter((b) => !b.hidden && b.section).map((b) => b.section!),
      ...state.groups.filter((g) => g.section).map((g) => g.section!),
    ]),
  ];

  const assign = (section: string) => {
    onAssign(section);
    onClose();
  };

  if (!motion.shown || !shown) return null;
  const sectionCurrent = heldCurrent.current;
  const top = Math.max(8, Math.min(shown.y, window.innerHeight - 300));
  const left = Math.min(shown.x, window.innerWidth - 260);

  return (
    <div
      data-section-picker
      style={{ top, left }}
      className={cn("fixed z-40 w-[236px] overflow-hidden rounded-xl border border-hairline/50 bg-menu py-2 shadow-2xl shadow-black/60", motion.className)} {...motion.exitProps}
    >
      <div className="px-3.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
        {t("sidebar.section.moveToContext")}
      </div>
      {sections.length > 0 && (
        <div className="flex flex-col gap-0.5 px-1.5 py-1">
          {sections.map((section) => (
            <button
              key={section}
              onClick={() => assign(section)}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
                section === sectionCurrent ? "bg-raised text-ink" : "text-ink hover:bg-raised/70",
              )}
            >
              <span className="truncate">{section}</span>
              {section === sectionCurrent && <Check size={14} className="shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-1.5 px-2.5 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || trimmed.length > 60) return;
          assign(trimmed);
        }}
      >
        <input
          autoFocus
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("sidebar.section.newContext")}
          aria-label={t("sidebar.section.newContextAria")}
          className="w-full rounded-lg bg-raised/70 px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <button
          type="submit"
          disabled={!trimmed || trimmed.length > 60}
          className={cn(
            "shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium",
            trimmed ? "bg-accent text-panel" : "bg-raised/70 text-ink-secondary",
          )}
        >
          {t("common.add")}
        </button>
      </form>
      {sectionCurrent && (
        <>
          <div className="mx-2 my-1 border-t border-hairline/40" />
          <button
            onClick={() => assign("")}
            className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[13px] text-danger hover:bg-raised/70"
          >
            <FolderMinus size={15} />
            {t("sidebar.section.removeFromContext")}
          </button>
        </>
      )}
    </div>
  );
}
