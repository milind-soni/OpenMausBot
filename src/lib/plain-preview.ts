/**
 * One line of plain text for a list preview (the sidebar's bot and room
 * rows): what a person would read in the message, without the Markdown that
 * draws it. `**bold**` reads as bold, `[name](url)` as name, a code fence as
 * its code, and a heading or list item as its words.
 *
 * This is a reading aid, not a Markdown parser. It never needs to be exact,
 * only to never show syntax a person did not type to be read.
 */
export function plainPreviewText(text: string): string {
  // backslash escapes read as the character: park them out of the way so
  // no rule below takes an escaped * or _ for markup
  const escaped: string[] = [];
  let out = text.replace(/\r\n?/g, "\n").replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_match, char: string) => {
    escaped.push(char);
    return `\uE000${escaped.length - 1}\uE001`;
  });
  // code reads as its code, untouched by the rules below: park each fenced
  // block's body (dropping the fence lines and language tag, closed or cut
  // off mid-stream) and each inline code span's text
  const code: string[] = [];
  const park = (body: string) => {
    // inside code a backslash is literal, so an escape reads as typed
    code.push(body.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => `\\${escaped[Number(index)] ?? ""}`));
    return `\uE002${code.length - 1}\uE003`;
  };
  // (a closing fence is the same character, at least as long as the opening)
  out = out.replace(/^[ \t]*((`|~)\2{2,})[^\n]*(?:\n([\s\S]*?))?(?:\n[ \t]*\1\2*[ \t]*(?=\n|$(?![\s\S]))|$(?![\s\S]))/gm, (_block, _fence: string, _char: string, body: string | undefined) => `\n${park(body ?? "")}\n`);
  out = out.replace(/(`+)([^`]*?)\1/g, (_span, _ticks: string, body: string) => park(body));
  // images read as their alt text, links as their label
  out = out.replace(/!\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1");
  out = out.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  out = out.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1");
  out = out.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  // a link reference definition is not something to read
  out = out.replace(/^[ \t]{0,3}\[[^\]]+\]:[ \t]+\S+.*$/gm, "");
  // <https://example.com> autolinks read as the address
  out = out.replace(/<((?:https?|mailto):[^>\s]+)>/gi, "$1");
  // html line breaks and simple inline tags
  out = out.replace(/<br\s*\/?>/gi, " ");
  out = out.replace(/<\/?(?:b|strong|i|em|u|s|del|ins|mark|code|kbd|sub|sup|small|span|p|div)\b[^>]*>/gi, "");
  // block markers at the start of a line: headings, quotes, list bullets,
  // task boxes, table rules and horizontal rules
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]*$/gm, "");
  out = out.replace(/^[ \t]*(?:>[ \t]?)+/gm, "");
  out = out.replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "");
  out = out.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, "");
  out = out.replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, "");
  out = out.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_row, cells: string) => cells.split("|").map((cell) => cell.trim()).filter(Boolean).join(" "));
  // emphasis: ***x***, **x**, __x__, *x*, _x_, ~~x~~. Underscores inside a
  // word (snake_case) are not emphasis, and a lone * (2 * 3) is not either.
  out = out.replace(/(\*{1,3}|_{1,3})(?=\S)([\s\S]*?\S)\1(?![\p{L}\p{N}])/gu, (match, marks: string, inner: string, offset: number, whole: string) => {
    if (marks[0] === "_" && offset > 0 && /[\p{L}\p{N}]/u.test(whole[offset - 1]!)) return match;
    return inner;
  });
  out = out.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");
  // a reply cut off mid-stream leaves an unclosed ** or ``` behind
  out = out.replace(/\*\*+|`{3,}|~~/g, "");
  out = out.replace(/\uE002(\d+)\uE003/g, (_match, index: string) => code[Number(index)] ?? "");
  out = out.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => escaped[Number(index)] ?? "");
  return out.replace(/\s+/g, " ").trim();
}
