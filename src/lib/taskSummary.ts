// Plain-text card summary for a task description: drops a YAML frontmatter
// block (tasks imported from docs/dev/fixes carry one), a heading that just
// repeats the title, and Markdown punctuation.
export function taskSummary(description: string, title = ""): string {
  let text = description.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
  const lines = text.split(/\r?\n/);
  const firstContent = lines.findIndex((line) => line.trim());
  if (firstContent >= 0) {
    const heading = /^#{1,6}\s+(.*)$/.exec(lines[firstContent].trim());
    if (heading && heading[1].trim().toLowerCase() === title.trim().toLowerCase()) lines.splice(firstContent, 1);
  }
  text = lines.join(" ");
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(\*\*|__|\*|_|~~)(\S[^*_~]*?)\1/g, "$2")
    .replace(/(^|\s)(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/g, "$1")
    .replace(/(^|\s)>\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
