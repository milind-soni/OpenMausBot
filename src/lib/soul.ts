export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function firstSentence(text: string, max = 200): string {
  const line = text.trim().split("\n")[0] ?? "";
  const match = line.match(/^.*?(?:[。！？]|[.!?](?=\s|$))/u);
  const sentence = (match ? match[0] : line).trim();
  return sentence.slice(0, max).replace(/[\uD800-\uDBFF]$/u, "");
}

export function soulPatchFor(value: string, limit: number): { soul: string } | null {
  return utf8Bytes(value) > limit ? null : { soul: value };
}
