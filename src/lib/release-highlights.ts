/** The GitHub update provider gives release notes as HTML; a generic feed often gives Markdown. */
export function releaseHighlights(notes: string | undefined, max = 4): string[] {
  if (!notes?.trim()) return [];
  const markdown = notes
    .replace(/\r\n?/g, "\n")
    .replace(/<\s*(strong|b)\s*>/gi, "**")
    .replace(/<\s*\/\s*(strong|b)\s*>/gi, "**")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\s*\/\s*(li|p|h[1-6]|ul|ol)\s*>|<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*h[1-6][^>]*>/gi, "\n# ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  const out: string[] = [];
  for (const raw of markdown.split("\n")) {
    const item = /^\s*[-*+]\s+(.*)$/.exec(raw)?.[1]?.trim();
    if (!item) continue;
    const lead = /^\*\*(.+?)\*\*/.exec(item)?.[1]?.trim();
    if (lead?.endsWith(":") && item.replace(/^\*\*.+?\*\*/, "").trim() === "") continue;
    let line = lead ?? (/^(.+?[.!?])(\s|$)/.exec(item)?.[1] ?? item);
    line = line
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\s+by @[\w-]+ in \S+$/i, "")
      .replace(/\s*\((?:#\d+(?:,\s*)?)+\)/g, "")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[*_`~]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line.length < 3) continue;
    if (line.length > 110) line = `${line.slice(0, 107).trimEnd()}…`;
    if (!out.includes(line)) out.push(line);
    if (out.length >= max) break;
  }
  return out;
}
