const TABLE_DIVIDER = /^ {0,3}\|? *:?-{3,}:? *\|/m;
const BLOCK_MARKDOWN = [
  /^ {0,3}(?:[-*+]|\d{1,3}[.)]) \S/m,
  /^ {0,3}#{1,6} \S/m,
  /^ {0,3}(?:```|~~~)/m,
  /^ {0,3}> ?\S/m,
  TABLE_DIVIDER,
];

/** A reply with block markdown (a list, heading, code, quote or table) reads as a document, not a chat line. */
export function isFormattedReply(text: string): boolean {
  return BLOCK_MARKDOWN.some((pattern) => pattern.test(text));
}

/** A formatted reply reads at prose width; one with a table takes the message's full width so every column shows,
 * and its prose stays at reading width (`.chat-wide` in styles.css). */
export function formattedReplyWidth(text: string): string {
  return TABLE_DIVIDER.test(text)
    ? "chat-wide w-full max-w-[var(--chat-card-pct)]"
    : "w-full max-w-[min(var(--chat-prose-max),var(--chat-card-pct))]";
}

export interface ReplyBlock {
  kind: "prose" | "table";
  text: string;
}

const PIPE_ROW = /^ {0,3}\|/;
const DELIMITER_ROW = /^ {0,3}\|?(?: *:?-+:? *\|)+(?: *:?-+:? *)?$/;
const FENCE = /^ {0,3}(```|~~~)/;

/** Splits a reply into prose and its tables, so Simple mode can draw each table as its own card. A table starts at a
 * top-level line opening with "|" that a delimiter row follows, and runs while its lines open with "|"; nothing inside a
 * code fence counts. A reply with no table comes back as one prose block. */
export function splitReplyBlocks(text: string): ReplyBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: ReplyBlock[] = [];
  const push = (kind: ReplyBlock["kind"], chunk: string[]) => {
    const body = chunk.join("\n").replace(/^\n+|\n+$/g, "");
    if (!body.trim()) return;
    const last = blocks.at(-1);
    if (kind === "prose" && last?.kind === "prose") last.text = `${last.text}\n\n${body}`;
    else blocks.push({ kind, text: body });
  };
  let prose: string[] = [];
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = FENCE.exec(line)?.[1];
    if (marker && (!fence || marker === fence)) fence = fence ? null : marker;
    if (fence || marker || !PIPE_ROW.test(line) || !DELIMITER_ROW.test(lines[index + 1] ?? "")) {
      prose.push(line);
      continue;
    }
    let end = index + 2;
    while (end < lines.length && PIPE_ROW.test(lines[end]!)) end++;
    push("prose", prose);
    prose = [];
    push("table", lines.slice(index, end));
    index = end - 1;
  }
  push("prose", prose);
  return blocks.length ? blocks : [{ kind: "prose", text }];
}
