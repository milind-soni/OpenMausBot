// Chat-header chips fold to icon-only shapes when the header is narrow —
// the computer/inspector panel is open or the window is small — so the
// row stops wrapping and crushing the bot's name. The header is the
// `@container/chathead`; below 4xl (56rem) these variants kick in.
//
// Kept as plain literal strings so Tailwind's scanner sees every class.

/** Round bubble, icon only — Stop, + Task. */
export const COMPACT_BUBBLE =
  "@max-4xl/chathead:size-[30px] @max-4xl/chathead:justify-center @max-4xl/chathead:gap-0 @max-4xl/chathead:p-0";

/** Rounded square, icon only — working folder, model. */
export const COMPACT_SQUARE =
  "@max-4xl/chathead:size-[30px] @max-4xl/chathead:justify-center @max-4xl/chathead:gap-0 @max-4xl/chathead:rounded-md @max-4xl/chathead:p-0";
