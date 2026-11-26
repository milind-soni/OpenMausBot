import { fromMarkdown } from "mdast-util-from-markdown";

export function closeUnfinishedCodeFence(text: string): string {
  if (!/^ {0,3}(?:`{3,}|~{3,})/m.test(text)) return text;
  const last = fromMarkdown(text).children.at(-1);
  if (last?.type !== "code" || !last.position) return text;
  const lines = text.slice(last.position.start.offset, last.position.end.offset).split(/\r\n?|\n/);
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0]!)?.[1];
  if (!fence) return text;
  const closing = /^ {0,3}(`+|~+)[\t ]*$/.exec(lines.at(-1)!)?.[1];
  if (lines.length > 1 && closing?.startsWith(fence)) return text;
  return `${text}${/[\r\n]$/.test(text) ? "" : "\n"}${fence}`;
}
