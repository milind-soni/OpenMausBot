/** Markdown a person typed, as the one plain line a sidebar or an OS notification can show. */
export function plainPreviewText(text: string): string {
  const escaped: string[] = [];
  let out = text.replace(/\r\n?/g, "\n").replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_match, char: string) => {
    escaped.push(char);
    return `\uE000${escaped.length - 1}\uE001`;
  });
  const code: string[] = [];
  const park = (body: string) => {
    code.push(body.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => `\\${escaped[Number(index)] ?? ""}`));
    return `\uE002${code.length - 1}\uE003`;
  };
  // (a closing fence is the same character, at least as long as the opening)
  out = out.replace(/^[ \t]*((`|~)\2{2,})[^\n]*(?:\n([\s\S]*?))?(?:\n[ \t]*\1\2*[ \t]*(?=\n|$(?![\s\S]))|$(?![\s\S]))/gm, (_block, _fence: string, _char: string, body: string | undefined) => `\n${park(body ?? "")}\n`);
  out = out.replace(/(`+)([^`]*?)\1/g, (_span, _ticks: string, body: string) => park(body));
  out = out.replace(/!\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1");
  out = out.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  out = out.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1");
  out = out.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  out = out.replace(/^[ \t]{0,3}\[[^\]]+\]:[ \t]+\S+.*$/gm, "");
  out = out.replace(/<((?:https?|mailto):[^>\s]+)>/gi, "$1");
  out = out.replace(/<br\s*\/?>/gi, " ");
  out = out.replace(/<\/?(?:b|strong|i|em|u|s|del|ins|mark|code|kbd|sub|sup|small|span|p|div)\b[^>]*>/gi, "");
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]*$/gm, "");
  out = out.replace(/^[ \t]*(?:>[ \t]?)+/gm, "");
  out = out.replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "");
  out = out.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, "");
  out = out.replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, "");
  out = out.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_row, cells: string) => cells.split("|").map((cell) => cell.trim()).filter(Boolean).join(" "));
  // Underscores inside a word (snake_case) and a lone * (2 * 3) are not emphasis.
  out = out.replace(/(\*{1,3}|_{1,3})(?=\S)([\s\S]*?\S)\1(?![\p{L}\p{N}])/gu, (match, marks: string, inner: string, offset: number, whole: string) => {
    if (marks[0] === "_" && offset > 0 && /[\p{L}\p{N}]/u.test(whole[offset - 1]!)) return match;
    return inner;
  });
  out = out.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");
  out = out.replace(/\*\*+|`{3,}|~~/g, "");
  out = out.replace(/\uE002(\d+)\uE003/g, (_match, index: string) => code[Number(index)] ?? "");
  out = out.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => escaped[Number(index)] ?? "");
  return out.replace(/\s+/g, " ").trim();
}
