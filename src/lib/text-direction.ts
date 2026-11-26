const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const ADDRESS = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF()]+/giu;
const TECHNICAL = /[\d._/\\@=]|^-|\p{Ll}\p{Lu}/u;

export function textDirection(value: string): "rtl" | "ltr" {
  const text = value.replace(ADDRESS, " ");
  let rtl = 0;
  let ltr = 0;
  let first: "rtl" | "ltr" | null = null;
  for (const raw of text.split(/\s+/)) {
    const word = raw.replace(/[.,;:!?]+$/u, "");
    const direction = [...word].some((char) => RTL_LETTER.test(char) && /\p{Letter}/u.test(char))
      ? "rtl"
      : /\p{Letter}/u.test(word) && !TECHNICAL.test(word)
        ? "ltr"
        : null;
    if (!direction) continue;
    first ??= direction;
    if (direction === "rtl") rtl += 1;
    else ltr += 1;
  }
  if (rtl !== ltr) return rtl > ltr ? "rtl" : "ltr";
  if (first) return first;
  const strong = /\p{Letter}/u.exec(text);
  return strong && RTL_LETTER.test(strong[0]) ? "rtl" : "ltr";
}
