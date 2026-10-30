import { t } from "./i18n";
import { MAUS_COLORS, type MausColor } from "./mascot";
import { isMentionBoundary, isMentionNameContinuation } from "../../shared/mention-boundary";
import { personTagAt, personTagNames } from "../../shared/person-mention";
import { devsTagAt } from "../../shared/devs-mention";

/** A name the @ list offers: a bot's, or (`person`) a teammate's on a Team Cloud. */
export type MentionPeer = { name: string; hidden?: boolean; color?: MausColor; person?: true };
export type MentionRange = { start: number; end: number; color?: string; you?: true; person?: true };
export type MentionPerson = { profileName?: string | null };

export function sameMentionPerson(a?: MentionPerson, b?: MentionPerson): boolean {
  return Boolean(a) === Boolean(b) && (a?.profileName ?? "") === (b?.profileName ?? "");
}

export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null;
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("@") || query.includes("\n")) return null;
  return { start: at, query };
}

export function mentionChoicesForQuery<T extends { name: string }>(pool: readonly T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (query.endsWith(" ") && pool.some((choice) => choice.name.toLowerCase() === normalized)) return [];
  return pool.filter((choice) => !normalized || choice.name.toLowerCase().includes(normalized));
}

export type MentionRowDetail =
  | { kind: "bot"; title: string }
  | { kind: "everyone"; count: number }
  | { kind: "team"; count: number }
  | { kind: "all"; count: number };

export function mentionRowDescription(detail: MentionRowDetail): string {
  switch (detail.kind) {
    case "bot":
      return detail.title.trim();
    case "everyone":
      return detail.count === 1
        ? t("composer.mention.everyoneOne")
        : t("composer.mention.everyoneMany", { count: detail.count });
    case "team":
      return detail.count === 1 ? t("composer.mention.teamOne") : t("composer.mention.teamMany", { count: detail.count });
    case "all":
      return detail.count === 1 ? t("composer.mention.allOne") : t("composer.mention.allMany", { count: detail.count });
    default: {
      const unreachable: never = detail;
      return unreachable;
    }
  }
}

export function mentionRanges(text: string, peers: readonly MentionPeer[], everyone = false, person?: MentionPerson): MentionRange[] {
  const candidates = peers.filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const personNames = person ? personTagNames(person.profileName) : [];
  const botNames = candidates.filter((peer) => !peer.person).map(({ name }) => name);
  const ranges: MentionRange[] = [];
  let at = -1;
  while ((at = text.indexOf("@", at + 1)) !== -1) {
    if (!isMentionBoundary(text, at)) continue;
    const rest = text.slice(at + 1);
    const peer = candidates.find(({ name }) => rest.slice(0, name.length).toLowerCase() === name.toLowerCase()
      && !isMentionNameContinuation(rest.slice(name.length)));
    const all = everyone && rest.slice(0, 8).toLowerCase() === "everyone"
      && !isMentionNameContinuation(rest.slice(8));
    const you = !all && personNames.length ? personTagAt(rest, personNames, botNames) : undefined;
    if (you !== undefined) {
      ranges.push({ start: at, end: at + you + 1, you: true });
      at += you;
      continue;
    }
    const length = all ? 8 : peer?.name.length ?? devsTagAt(rest, botNames);
    if (length === undefined) continue;
    // Only palette values enter CSS.
    const color = !all && peer?.color && Object.hasOwn(MAUS_COLORS, peer.color) ? MAUS_COLORS[peer.color] : undefined;
    ranges.push({ start: at, end: at + length + 1, ...(color ? { color } : {}), ...(!all && peer?.person ? { person: true as const } : {}) });
    at += length;
  }
  return ranges;
}

export function mentionClassName(range: Pick<MentionRange, "you" | "person">): string {
  return range.you ? "mention-highlight mention-you" : range.person ? "mention-highlight mention-person" : "mention-highlight";
}

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName: string; hProperties: { className: string; style?: string } };
};

export function remarkMentions({ peers, everyone = false, person }: { peers: readonly MentionPeer[]; everyone?: boolean; person?: MentionPerson }) {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children || ["link", "linkReference", "code", "inlineCode"].includes(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) { visit(child); return [child]; }
        const text = child.value;
        const ranges = mentionRanges(text, peers, everyone, person);
        if (!ranges.length) return [child];
        const result: MarkdownNode[] = [];
        let end = 0;
        for (const range of ranges) {
          if (range.start > end) result.push({ type: "text", value: text.slice(end, range.start) });
          result.push({ type: "mention", data: { hName: "span", hProperties: {
            className: mentionClassName(range),
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
