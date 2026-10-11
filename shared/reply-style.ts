// How a bot shapes its replies. "default" is the unchanged behavior and is
// what an absent field means. "conversational" asks the model for short,
// plain replies split into small messages, and the chat shows each of those
// messages as its own bubble. The split is a view of one stored reply, so
// the transcript, copy, reply, speak and every engine see the same text.

export const REPLY_STYLES = ["default", "conversational"] as const;
export type ReplyStyle = (typeof REPLY_STYLES)[number];

export function isConversational(style: ReplyStyle | undefined): boolean {
  return style === "conversational";
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_OR_TABLE = /^ {0,3}([-*+]\s|\d{1,3}[.)]\s|\|)/;

/** Split a conversational reply on its blank-line message breaks. A code
 * fence is never cut, even when it holds blank lines, and the blocks of one
 * loose list or table stay together. An unclosed fence (a reply still
 * streaming) keeps everything after it in the last part, so the parts that
 * are already complete never change while the rest streams in. */
export function splitConversationalReply(text: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    // only trailing space goes: leading indentation can make a code block
    const block = current.join("\n").trimEnd();
    current = [];
    if (!block.trim()) return;
    const prev = parts.at(-1);
    if (prev !== undefined && LIST_OR_TABLE.test(block) && LIST_OR_TABLE.test(prev.split("\n").at(-1) ?? "")) {
      parts[parts.length - 1] = `${prev}\n\n${block}`;
    } else parts.push(block);
  };
  for (const line of text.split("\n")) {
    const open = FENCE.exec(line);
    if (fence) {
      current.push(line);
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && line.trim() === open[1]) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      current.push(line);
      continue;
    }
    if (!line.trim()) flush();
    else current.push(line);
  }
  flush();
  return parts;
}
