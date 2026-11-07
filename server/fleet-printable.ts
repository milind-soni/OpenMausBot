const isControl = (char: string) => { const code = char.charCodeAt(0); return code < 32 || (code >= 127 && code <= 159); };
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿؜]/g;

/** A tenant-chosen label as plain terminal text: each control character becomes a space, so it cannot move the cursor, and
 * bidi and zero-width characters are dropped, so it cannot reorder or hide what is printed. */
export const printable = (text: string): string => [...text.replace(INVISIBLE, "")].map((char) => (isControl(char) ? " " : char)).join("");
