import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { useStore } from "@/state/store";
import { track } from "@/lib/analytics";
import { t } from "@/lib/i18n";
import { BotPickerList } from "../BotPickerList";

/** Pick members and an optional Work/Personal/project context, then create. */
export function NewRoomPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [section, setSection] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const bots = state.bots.filter((b) => !b.hidden);
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const create = () => {
    if (!picked.size) return;
    dispatch({
      type: "createGroup",
      memberIds: [...picked],
      name: name.trim() || undefined,
      section: section.trim() || undefined,
    });
    track("room_created", { members: picked.size, context: Boolean(section.trim()) });
    onClose();
  };
  // A real dialog: Escape closes from whichever child holds focus, Tab cycles
  // inside, and focus lands back on the opener when the panel goes away.
  useEffect(() => {
    openerRef.current = document.activeElement;
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("sidebar.newChannel.title")}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="w-[340px] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl outline-none"
      >
        <div className="mb-3 text-[15px] font-semibold text-ink">{t("sidebar.newChannel.title")}</div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="text-[15px] font-semibold text-ink">{t("sidebar.newChannel.title")}</div>
          <button type="button" onClick={onClose} aria-label={t("common.close")} className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"><X size={16} /></button>
        </div>        <input
          autoFocus
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) create();
          }}
          placeholder={t("sidebar.newChannel.name")}
          className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <input
          value={section}
          maxLength={60}
          onChange={(e) => setSection(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) create();
          }}
          placeholder={t("sidebar.newChannel.context")}
          aria-label={t("sidebar.newChannel.contextAria")}
          className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <BotPickerList
          bots={bots}
          picked={picked}
          onToggle={toggle}
          emptyHint={t("sidebar.newChannel.emptyHint")}
        />
        <button
          onClick={create}
          disabled={!picked.size}
          className="mt-3 w-full rounded-lg bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          {picked.size === 0
            ? t("sidebar.newChannel.create")
            : picked.size === 1
              ? t("sidebar.newChannel.createOne")
              : t("sidebar.newChannel.createMany", { count: picked.size })}
        </button>
      </div>
    </div>
  );
}
