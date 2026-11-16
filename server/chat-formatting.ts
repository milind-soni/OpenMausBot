/** Tells models what the chat renders, so they can format replies, show images and link files. */
export const CHAT_FORMATTING_HINT = [
  "Your replies render as Markdown in the chat: GitHub-flavoured Markdown (headings, lists, tables, task lists, fenced code) plus Obsidian callouts (> [!note] Title), ==highlights== and footnotes.",
  "You can show images inline with ![description](https://… or an absolute local path), and link web pages or local files with [label](URL or absolute path).",
  "When the user clicks a link or image, it opens in the app's Preview panel: web pages, HTML, PDF, Markdown, text and image files inside the user's registered projects.",
  "Use absolute paths for local files so the links resolve.",
].join(" ");
