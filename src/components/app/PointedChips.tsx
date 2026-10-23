import { Crosshair, X } from "lucide-react";
import { t } from "@/lib/i18n";
import { removePointedChip, usePointedChips } from "@/lib/pointed-chips";
import { pointedLabel } from "../../../shared/app-frame/point";

/** The parts of a page the person pointed at, waiting to go with their next message. */
export function PointedChips({ threadId }: { threadId: string }) {
  const chips = usePointedChips(threadId);
  if (!chips.length) return null;
  return (
    <div data-pointed-chips className="mb-2 flex flex-wrap gap-1.5">
      {chips.map((chip) => {
        const label = pointedLabel(chip) ?? t("chat.preview.pointedPart");
        return (
          <span key={chip.id} data-pointed-chip={chip.selector} title={`${chip.title} · <${chip.tag}> ${chip.selector}`}
            className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 ps-2.5 pe-1 text-[13px] text-ink">
            <Crosshair size={13} aria-hidden="true" className="shrink-0 text-accent-text" />
            <bdi dir="auto" className="min-w-0 truncate">{label}</bdi>
            <span className="shrink-0 text-[11.5px] text-ink-tertiary">{`<${chip.tag}>`}</span>
            <button type="button" onClick={() => removePointedChip(threadId, chip.id)} aria-label={t("chat.preview.removePoint", { label })}
              className="flex size-5 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.08] hover:text-ink">
              <X size={12} />
            </button>
          </span>
        );
      })}
    </div>
  );
}
