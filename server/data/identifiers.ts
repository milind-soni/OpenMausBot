/** A table reference, not a SQL expression. Quoted parts keep their exact spaces and doubled quotes. */
export function tableIdentifierParts(input: string): string[] | null {
  const text = input.trim();
  const parts: string[] = [];
  let at = 0;
  while (at < text.length && parts.length < 3) {
    while (/\s/.test(text[at] ?? "")) at++;
    let part = "";
    if (text[at] === '"') {
      at++;
      let closed = false;
      while (at < text.length) {
        const char = text[at++]!;
        if (char !== '"') part += char;
        else if (text[at] === '"') { part += '"'; at++; }
        else { closed = true; break; }
      }
      if (!closed || !part) return null;
    } else {
      const match = /^[\p{L}_][\p{L}\p{M}\p{N}_$]*/u.exec(text.slice(at));
      if (!match) return null;
      part = match[0];
      at += part.length;
    }
    parts.push(part);
    while (/\s/.test(text[at] ?? "")) at++;
    if (at === text.length) return parts;
    if (text[at++] !== "." || at === text.length) return null;
  }
  return null;
}
