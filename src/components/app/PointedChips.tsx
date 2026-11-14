import { useRef, useState } from "react";
import { Crosshair, StickyNote, X } from "lucide-react";
import { t } from "@/lib/i18n";
import { removePointedChip, setPointedNote, usePointedChips } from "@/lib/pointed-chips";
import { pointedLabel } from "../../../shared/app-frame/point";

/** The parts of a page the person pointed at, waiting to go with their next message. Each is numbered as its outline
 * in the page is, and a click on it opens a note that goes to the bot with that part. */
export function PointedChips({ threadId }: { threadId: string }) {
  const chips = usePointedChips(threadId);
  const [editing, setEditing] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  if (!chips.length) return null;
  const open = chips.find((chip) => chip.id === editing);
  const openLabel = open ? pointedLabel(open) ?? t("chat.preview.pointedPart") : "";
  return (
    <div data-pointed-chips className="mb-2">
      <div ref={list} className="flex flex-wrap gap-1.5">
        {chips.map((chip, index) => {
          const label = pointedLabel(chip) ?? t("chat.preview.pointedPart");
          return (
            <span key={chip.id} data-pointed-chip={chip.selector} title={`${chip.title} · <${chip.tag}> ${chip.selector}${chip.note ? `\n${chip.note}` : ""}`}
              className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 ps-2.5 pe-1 text-[13px] text-ink">
              <Crosshair size={13} aria-hidden="true" className="shrink-0 text-accent-text" />
              <button type="button" data-pointed-note-for={chip.id} onClick={() => setEditing(editing === chip.id ? null : chip.id)} aria-expanded={editing === chip.id}
                aria-label={t("chat.preview.notePoint", { label })} className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 text-[12px] font-semibold text-accent-text">{index + 1}</span>
                <bdi dir="auto" className="min-w-0 truncate">{label}</bdi>
                <span className="shrink-0 text-[12px] text-ink-tertiary">{`<${chip.tag}>`}</span>
                {chip.note ? <StickyNote size={12} aria-hidden="true" className="shrink-0 text-accent-text" /> : null}
              </button>
              <button type="button" onClick={() => removePointedChip(threadId, chip.id)} aria-label={t("chat.preview.removePoint", { label })}
                className="flex size-5 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.08] hover:text-ink">
                <X size={12} />
              </button>
            </span>
          );
        })}
      </div>
      {open ? (
        <input data-pointed-note autoFocus value={open.note ?? ""}
          onChange={(event) => setPointedNote(threadId, open.id, event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setEditing(null);
            list.current?.querySelector<HTMLButtonElement>(`[data-pointed-note-for="${CSS.escape(open.id)}"]`)?.focus();
          }}
          placeholder={t("chat.preview.pointNote", { label: openLabel })} aria-label={t("chat.preview.pointNote", { label: openLabel })}
          className="mt-1.5 h-8 w-full rounded-lg border border-ink/[0.12] bg-transparent px-2.5 text-[13px] text-ink outline-none focus:border-accent/60" />
      ) : null}
    </div>
  );
}
