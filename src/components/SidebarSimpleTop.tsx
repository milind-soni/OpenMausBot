import { Search } from "lucide-react";
import { openCommandPalette } from "@/lib/command-palette";
import { t } from "@/lib/i18n";
import { ELEVATED_CONTROL, ELEVATED_HOVER, ELEVATED_TINT } from "./elevated";

/** Keyboard focus on a Simple row or tile: the focus ring drawn inside its edge. */
export const SIMPLE_ROW_FOCUS = "focus-visible:outline-2 focus-visible:-outline-offset-2! focus-visible:outline-focus";

const SIMPLE_TOP = "flex size-9 shrink-0 items-center justify-center rounded-full text-ink/90";
const SIMPLE_TOP_FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
export const SIMPLE_TOP_BUTTON = `${SIMPLE_TOP} ${ELEVATED_CONTROL} ${ELEVATED_HOVER} ${SIMPLE_TOP_FOCUS}`;
/** The same round control for the button of the window's rail, which is shown most of the time: its aria-expanded never
 * wears the tint of an open menu. */
export const SIMPLE_TOP_TOGGLE = `${SIMPLE_TOP} ${ELEVATED_CONTROL} ${ELEVATED_TINT} ${SIMPLE_TOP_FOCUS}`;

/** Search and New in the top corner of Simple's sidebar in a framed window: plain icons, each its own button. */
export const SIMPLE_CORNER_BUTTON = `flex size-[26px] shrink-0 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-ink/[0.06] hover:text-ink aria-expanded:bg-ink/[0.06] aria-expanded:text-ink ${SIMPLE_TOP_FOCUS}`;

/** The round control at either end of the phone bot list's top row. */
export const PHONE_TOP_BUTTON = "flex size-10 shrink-0 items-center justify-center rounded-full border border-hairline bg-card text-ink hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export const SIMPLE_RAIL_BUTTON = "flex size-9 shrink-0 items-center justify-center rounded-xl text-ink-secondary hover:bg-raised/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function SidebarSearchButton({ corner = false, rail = false }: { corner?: boolean; rail?: boolean }) {
  return (
    <button
      type="button"
      data-sidebar-search-toggle
      onClick={openCommandPalette}
      aria-label={t("sidebar.searchAria")}
      aria-haspopup="dialog"
      title={t("sidebar.searchAria")}
      className={rail ? SIMPLE_RAIL_BUTTON : corner ? SIMPLE_CORNER_BUTTON : SIMPLE_TOP_BUTTON}
    >
      <Search size={corner ? 17 : 18} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}
