// Where text still being written may be cut for showing: the word in progress waits, so a credential (a run of
// printable ASCII) is shown whole and masked, or not at all. Text with no spaces (Chinese, Japanese, Thai) would then
// never show until it ended, so in a word that long all but its last few characters may go, never splitting a run of
// printable ASCII, a surrogate pair, or anything after a URL's "://" in that word.

/** Characters of a long word that always wait. */
const WORD_TAIL = 24;

const isAsciiToken = (code: number) => code > 0x20 && code < 0x7f;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The end of what `text` may show while more of it is on the way. */
export function heldTailStart(text: string): number {
  let space = text.length;
  while (space > 0 && !/\s/.test(text[space - 1]!)) space--;
  let cut = text.length;
  for (let left = WORD_TAIL; left > 0; left--) {
    if (cut <= space) return space;
    cut--;
    if (isLowSurrogate(text.charCodeAt(cut)) && cut > space) cut--;
  }
  while (cut > space && (isLowSurrogate(text.charCodeAt(cut)) || (isAsciiToken(text.charCodeAt(cut - 1)) && isAsciiToken(text.charCodeAt(cut))))) cut--;
  return cut > space && !text.slice(space, cut).includes("://") ? cut : space;
}
