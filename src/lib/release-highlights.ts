/**
 * Two to four plain lines from a release's notes, for the update card.
 *
 * The notes come from the update feed as published: the GitHub provider
 * gives the release body as HTML, a generic feed often gives Markdown. Each
 * release here opens its items with a bold lead ("**Faster start.** After the
 * first launch…"), so an item reads as its lead when it has one and as its
 * first sentence when not. Group labels ("**Chats:**"), headings and
 * references (#1234, by @someone in a link) are not highlights.
 */
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
    // a bold label that only names a group of sub-items
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
