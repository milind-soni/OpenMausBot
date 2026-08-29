// Chat-header chips fold to icon-only shapes when the header is narrow —
// the computer/inspector panel is open or the window is small — so the
// row stops wrapping and crushing the bot's name. The header is the
// `@container/chathead`; below 5xl (64rem) these variants kick in. Folding
// before the text collides keeps the balanced three-zone header centered.
//
// Kept as plain literal strings so Tailwind's scanner sees every class.

/** Round bubble, icon only — Stop, + Task. */
export const COMPACT_BUBBLE =
  "@max-5xl/chathead:size-[30px] @max-5xl/chathead:justify-center @max-5xl/chathead:gap-0 @max-5xl/chathead:p-0";

/** Rounded square, icon only — working folder, model. */
export const COMPACT_SQUARE =
  "@max-5xl/chathead:size-[30px] @max-5xl/chathead:justify-center @max-5xl/chathead:gap-0 @max-5xl/chathead:rounded-md @max-5xl/chathead:p-0";
