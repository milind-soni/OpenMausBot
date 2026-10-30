/** The part of a person's name a bot greets them by: the first word of a Latin-script name of two or more words,
 * otherwise the whole name ("Ada Lovelace" → "Ada", "毛泽东" stays whole). Blank stays blank. */
export function greetingName(name: string | null | undefined): string {
  const full = (name ?? "").trim();
  const words = full.split(/\s+/);
  return words.length > 1 && /^[\p{Script=Latin}'’.-]+$/u.test(words.join("")) ? words[0]! : full;
}
