/** An absent style means "default". */
export const REPLY_STYLES = ["default", "conversational"] as const;
export type ReplyStyle = (typeof REPLY_STYLES)[number];

export function isConversational(style: ReplyStyle | undefined): boolean {
  return style === "conversational";
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_OR_TABLE = /^ {0,3}([-*+]\s|\d{1,3}[.)]\s|\|)/;

/** Splits on blank lines but never inside a code fence, and keeps one loose list or table together. An unclosed fence keeps the rest in the last part, so finished parts never change. */
export function splitConversationalReply(text: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    // Leading indentation can make a code block, so only trailing space goes.
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
