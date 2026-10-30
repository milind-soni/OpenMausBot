export const ELEVATED_CONTROL = "bg-composer ring-1 ring-inset ring-ink/[0.07]";
/** A card in the conversation, a question or an approval: the floating surface, resting on the page without a shadow. */
export const ELEVATED_CARD = "bg-composer ring-[0.5px] ring-ink/10";
export const ELEVATED_FLOAT = `${ELEVATED_CARD} shadow-(--shadow-float)`;
/** The hover tint alone, for a control whose aria-expanded is not a menu of its own. */
export const ELEVATED_TINT = "transition-colors duration-[120ms] hover:bg-[color-mix(in_srgb,var(--color-composer),var(--color-ink)_7%)]";
export const ELEVATED_HOVER = `${ELEVATED_TINT} aria-expanded:bg-[color-mix(in_srgb,var(--color-composer),var(--color-ink)_7%)]`;
/** The hover tint as a plain fill, for a trigger whose aria-expanded sits on a wrapping button. */
export const ELEVATED_OPEN = "bg-[color-mix(in_srgb,var(--color-composer),var(--color-ink)_7%)]";
