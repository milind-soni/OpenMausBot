const FILLERS = ["can you", "could you", "please", "quickly", "hey", "just", "now"];
const MOMENT_WORDS = new Set([
  "this", "that", "it", "here", "there", "these", "those", "them",
  "latest", "newest", "oldest", "last", "first", "top", "next", "previous", "recent", "today", "tonight", "tomorrow", "yesterday", "current", "unread",
]);

const wordPattern = (phrase: string, flags: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${phrase}(?![\\p{L}\\p{N}])`, flags);
const FILLER_PATTERNS = [...FILLERS]
  .sort((a, b) => b.length - a.length)
  .map((phrase) => wordPattern(phrase, "gu"));

const SENTENCE_MARKS = new RegExp([
  String.raw`["'\x60\p{Pi}\p{Pf}„‚!?¡¿…‒-―]`,
  String.raw`(?<![\p{L}\p{N}])[.,;:]`,
  String.raw`[.,;:](?![\p{L}\p{N}])`,
  String.raw`-(?![\p{L}\p{N}])`,
].join("|"), "gu");

/** Symbols, a leading or inner hyphen and a stop inside a word or number stay: "-5" is not "5", "C++" is not "C". */
export function requestKey(text: string): string {
  let key = text.normalize("NFKC").toLowerCase().replace(SENTENCE_MARKS, " ").replace(/\s+/g, " ");
  for (const pattern of FILLER_PATTERNS) key = key.replace(pattern, " ");
  return key.replace(/\s+/g, " ").trim();
}

export function exactRequest(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function hasMomentWords(text: string): boolean {
  return requestKey(text).split(/[^\p{L}\p{N}]+/u).some((token) => MOMENT_WORDS.has(token));
}

export function inRequest(fragment: string, request: string): boolean {
  const trimmed = fragment.trim();
  if (!trimmed) return false;
  return wordPattern(trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu").test(request);
}
