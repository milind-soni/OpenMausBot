/** Profile input limits shared by every web and server write surface.
 * name, title, description, and voice are character counts. soul is a
 * UTF-8 byte budget: it rides the system prompt on every turn, and what
 * that costs is bytes, not glyphs. */
export const BOT_PROFILE_LIMITS = {
  name: 100,
  title: 200,
  description: 4000,
  voice: 200,
  soul: 24_000,
} as const;

/** A name or title is quoted inside prompts and cards as one line — a
 * roster entry, a "Name: …" speaker line, the bracketed provenance note.
 * Text that can break out of that line (a newline, a control byte, the
 * Unicode separators) is refused at the door rather than flattened later,
 * so what the person sees in the sidebar is what every prompt sees too.
 * Written as a scan because a control-character class is the kind of
 * literal the linter (rightly) refuses. */
export function fitsOnOneLine(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return false;
  }
  return true;
}
