import { attachmentBasename, splitTranscriptAttachments, type TranscriptFileAttachment } from "./composer-attachments";

/** The person's attached file a bot's returned file is an edit of: the "What changed" view compares the two. */
export interface EditSource { messageId: string; path: string; name: string }

type Line = { id: string; role: string; text?: string; parentId?: string | null };

const TEXT_FILE = /\.(?:md|markdown|txt)$/i;
const MAX_STEPS = 200;
// Words people and bots add to an edited copy's name: "chapter-3 (edited).md", "chapter_3_v2.md", "Chapter 3 revised.md".
const EDIT_WORDS = /(?:[\s._-]*(?:\([^)]*\)|\[[^\]]*\])|[\s._-]+(?:edited|edit|revised|revision|rewrite|rewritten|updated|update|final|new|copy|clean|improved|changes|tracked|v\d+))+$/i;

export const isComparableTextName = (name: string) => TEXT_FILE.test(name);

export function editStem(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "").normalize("NFC").toLowerCase();
  return stem.replace(EDIT_WORDS, "").replace(/[\s._-]+/g, " ").trim() || stem;
}

const parsed = new WeakMap<object, TranscriptFileAttachment[]>();
const positionsOf = new WeakMap<readonly Line[], Map<string, number>>();
/** Where each message is, built once for each loaded conversation the store hands out. */
function positions(messages: readonly Line[]): Map<string, number> {
  let index = positionsOf.get(messages);
  if (!index) {
    index = new Map();
    messages.forEach((line, at) => index!.set(line.id, at));
    positionsOf.set(messages, index);
  }
  return index;
}
function attachedTextFiles(line: Line): TranscriptFileAttachment[] {
  let files = parsed.get(line);
  if (!files) {
    files = line.text?.includes("<attached-file") ? splitTranscriptAttachments(line.text, false).files.filter((file) => file.private && isComparableTextName(file.name || attachmentBasename(file.path))) : [];
    parsed.set(line, files);
  }
  return files;
}

/**
 * The rule for offering "What changed" on a file a bot returned, from the conversation's structure alone (no file is
 * read to decide): the returned file is a stored .md, .markdown or .txt on a bot's message; going back from that
 * message, the nearest message of the person's that attached text files is found within the loaded conversation; and
 * exactly one of those files has the same name once edit words are set aside ("chapter-3 (edited).md" is an edit of
 * "chapter-3.md"). Anything less certain offers nothing: two files of other names may be different documents.
 */
export function findEditSource(messages: readonly Line[], replyId: string, returned: readonly TranscriptFileAttachment[]): Map<string, EditSource> {
  const found = new Map<string, EditSource>();
  const texts = returned.filter((file) => file.private && isComparableTextName(file.name || attachmentBasename(file.path)));
  if (!texts.length) return found;
  const index = positions(messages);
  let at = index.get(replyId);
  if (at === undefined || messages[at]!.role !== "bot") return found;
  let source: { line: Line; files: TranscriptFileAttachment[] } | null = null;
  for (let steps = 0; at !== undefined && steps < MAX_STEPS; steps++) {
    const line: Line = messages[at]!;
    if (line.role === "user") {
      const files = attachedTextFiles(line);
      if (files.length) {
        source = { line, files };
        break;
      }
    }
    at = line.parentId ? index.get(line.parentId) : line.parentId === null ? undefined : at > 0 ? at - 1 : undefined;
  }
  if (!source) return found;
  const { line, files } = source;
  for (const file of texts) {
    const stem = editStem(file.name || attachmentBasename(file.path));
    const named = files.filter((candidate) => editStem(candidate.name || attachmentBasename(candidate.path)) === stem);
    const match = named.length === 1 ? named[0]! : null;
    if (match && match.path !== file.path) found.set(file.path, { messageId: line.id, path: match.path, name: match.name });
  }
  return found;
}
