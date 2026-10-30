import type { CloudSwatch } from "../../electron/cloud-list.mjs";
import { cn } from "@/lib/cn";
import { CLOUD_SWATCH_LABEL, CLOUD_SWATCH_ORDER, swatchFill } from "@/lib/cloud-extra";
import { t } from "@/lib/i18n";

const RING_OFFSET = { panel: "ring-offset-panel", card: "ring-offset-card", menu: "ring-offset-menu" } as const;

/** The six swatches a Cloud's colour is chosen from, as one radio group: arrow keys move the choice, Tab leaves it.
 * `value` null: none of them yet (the first one takes the focus). `offset`: the surface the ring sits on. `none`: the
 * plain swatch is offered as None, an empty circle, where it means no colour at all (a place's look), not Slate. */
export function SwatchRadios({ value, onChange, label, disabled = false, offset = "panel", none = false }: {
  value: CloudSwatch | null; onChange: (swatch: CloudSwatch) => void; label: string; disabled?: boolean; offset?: keyof typeof RING_OFFSET; none?: boolean;
}) {
  const focusable = value ?? CLOUD_SWATCH_ORDER[0];
  const plain = (option: CloudSwatch) => none && option === "slate";
  return <div role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className="flex flex-wrap gap-2.5">
    {CLOUD_SWATCH_ORDER.map((option) => <button key={option} type="button" role="radio" aria-checked={option === value}
      aria-label={t(plain(option) ? "placeLook.none" : CLOUD_SWATCH_LABEL[option])} title={t(plain(option) ? "placeLook.none" : CLOUD_SWATCH_LABEL[option])}
      data-swatch={option} disabled={disabled} onClick={() => onChange(option)}
      onKeyDown={(event) => {
        const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
        if (!delta) return;
        event.preventDefault();
        const next = CLOUD_SWATCH_ORDER[(CLOUD_SWATCH_ORDER.indexOf(option) + delta + CLOUD_SWATCH_ORDER.length) % CLOUD_SWATCH_ORDER.length]!;
        onChange(next);
        (event.currentTarget.parentElement?.querySelector(`[data-swatch="${next}"]`) as HTMLElement | null)?.focus();
      }}
      tabIndex={option === focusable ? 0 : -1}
      className={cn("grid size-8 place-items-center rounded-full border transition-[box-shadow] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default",
        plain(option) ? "border-ink/55 text-ink/55" : "border-ink/10",
        option === value && cn("ring-2 ring-ink/70 ring-offset-2", RING_OFFSET[offset]), disabled && option !== value && "opacity-50")}
      style={plain(option) ? undefined : { background: swatchFill(option) }}>
      {plain(option) && <span aria-hidden="true" className="h-[1.5px] w-[60%] -rotate-45 rounded-full bg-current" />}
    </button>)}
  </div>;
}
