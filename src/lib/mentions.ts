import { MAUS_COLORS, type MausColor } from "./mascot";

export type MentionPeer = { name: string; hidden?: boolean; color?: MausColor };
export type MentionRange = { start: number; end: number; color?: string };

/** Display word-start, longest-name matches without coloring Unicode prefixes.
 * Keep offsets in the original string so casing and Unicode remain intact. */
export function mentionRanges(text: string, peers: readonly MentionPeer[], everyone = false): MentionRange[] {
  const candidates = peers.filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const ranges: MentionRange[] = [];
  let at = -1;
  while ((at = text.indexOf("@", at + 1)) !== -1) {
    if (at > 0 && !/\s/.test(text[at - 1])) continue;
    const rest = text.slice(at + 1);
    const peer = candidates.find(({ name }) => rest.slice(0, name.length).toLowerCase() === name.toLowerCase()
      && !/^[\p{L}\p{N}\p{M}_]/u.test(rest.slice(name.length)));
    const all = everyone && /^everyone(?![\p{L}\p{N}\p{M}_])/iu.test(rest);
    const length = all ? 8 : peer?.name.length;
    if (length === undefined) continue;
    // Only palette values enter CSS. @everyone has no individual bot identity.
    const color = !all && peer?.color && Object.hasOwn(MAUS_COLORS, peer.color) ? MAUS_COLORS[peer.color] : undefined;
    ranges.push({ start: at, end: at + length + 1, ...(color ? { color } : {}) });
    at += length;
  }
  return ranges;
}

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName: string; hProperties: { className: string; style?: string } };
};

/** Transform text nodes only: links, code and image metadata stay untouched. */
export function remarkMentions({ peers, everyone = false }: { peers: readonly MentionPeer[]; everyone?: boolean }) {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children || ["link", "linkReference", "code", "inlineCode"].includes(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) { visit(child); return [child]; }
        const text = child.value;
        const ranges = mentionRanges(text, peers, everyone);
        if (!ranges.length) return [child];
        const result: MarkdownNode[] = [];
        let end = 0;
        for (const range of ranges) {
          if (range.start > end) result.push({ type: "text", value: text.slice(end, range.start) });
          result.push({ type: "mention", data: { hName: "span", hProperties: {
            className: "mention-highlight",
            ...(range.color ? { style: `--mention-color:${range.color}` } : {}),
          } },
            children: [{ type: "text", value: text.slice(range.start, range.end) }] });
          end = range.end;
        }
        if (end < text.length) result.push({ type: "text", value: text.slice(end) });
        return result;
      });
    };
    visit(tree);
  };
}
