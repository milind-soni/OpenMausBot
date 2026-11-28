import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

import { decodeAttachmentAttribute } from "../src/lib/composer-attachments.ts";
import { ATTACHMENTS_DIR } from "./attachments.ts";
import { listZipSync, readZipMemberSync, type ZipMember } from "./zip-archive.ts";

/** Enough of the list to see an archive's shape; the rest is a count. */
const ZIP_LISTED_ENTRIES = 200;
/** 200 records with long paths fit; a directory larger than this is not read at all. */
const ZIP_DIRECTORY_MAX_BYTES = 1024 * 1024;
/** One archive member's text never crowds out its siblings. */
const ZIP_MEMBER_MAX_BYTES = 16 * 1024;
/** Everything inlined into one turn, so a model's context never fills with attachments. */
const TURN_INLINE_MAX_BYTES = 64 * 1024;
/** The JSON around each listed name, so a zip of many tiny files still spends the budget. */
const LISTED_ENTRY_BYTES = 32;

const TAG = /<attached-file[\t ]+path="([^"\r\n]*)"(?:[\t ]+name="[^"\r\n]*")?[\t ]*\/>/g;
const OWNED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/;
const NOTE = "The server read this attachment for you because you cannot open files here. Text is included only for small UTF-8 text files.";

type Contents = Record<string, unknown>;
type Reader = (path: string, budget: { left: number }) => Contents;

/** Valid UTF-8 with no NUL, or null. `partial` keeps a character cut at the end of a capped read out instead of failing. */
function utf8Text(bytes: Buffer, partial = false): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: partial });
  } catch {
    return null;
  }
}

function textFile(path: string, budget: { left: number }): Contents {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(budget.left + 1);
    const read = readSync(fd, bytes, 0, bytes.length, 0);
    const truncated = read > budget.left;
    const text = utf8Text(bytes.subarray(0, Math.min(read, budget.left)), truncated);
    if (text === null) return { error: "This file is not UTF-8 text." };
    budget.left -= Buffer.byteLength(text);
    return truncated ? { text, truncated } : { text };
  } finally {
    closeSync(fd);
  }
}

function memberText(path: string, member: ZipMember): string | null {
  try {
    return utf8Text(readZipMemberSync(path, member));
  } catch {
    return null;
  }
}

function zipFile(path: string, budget: { left: number }): Contents {
  let listing: ReturnType<typeof listZipSync>;
  try {
    listing = listZipSync(path, { maxEntries: ZIP_LISTED_ENTRIES, maxDirectoryBytes: ZIP_DIRECTORY_MAX_BYTES });
  } catch {
    return { error: "The archive's file list couldn't be read." };
  }
  const files: Contents[] = [];
  let seen = 0;
  for (const { name, uncompressedBytes, member } of listing.records) {
    if (!name.endsWith("/")) {
      const listed = Buffer.byteLength(name) + LISTED_ENTRY_BYTES;
      if (listed > budget.left) break;
      budget.left -= listed;
      const text = member && uncompressedBytes <= Math.min(ZIP_MEMBER_MAX_BYTES, budget.left) && member.compressedBytes <= ZIP_MEMBER_MAX_BYTES
        ? memberText(path, member) : null;
      if (text !== null) budget.left -= Buffer.byteLength(text);
      files.push({ path: name, bytes: uncompressedBytes, ...(text !== null ? { text } : {}) });
    }
    seen += 1;
  }
  const unlisted = listing.total - seen;
  return { files, ...(unlisted > 0 ? { unlisted } : {}) };
}

const READERS: Readonly<Record<string, Reader>> = {
  ".zip": zipFile,
  ".txt": textFile,
  ".md": textFile,
  ".csv": textFile,
  ".tsv": textFile,
  ".json": textFile,
};

function envelope(path: string, attachmentsDir: string, budget: { left: number }): string {
  const name = basename(path), reader = READERS[extname(name)];
  // A tag is untrusted message text: only an upload the store wrote, directly in its folder, is ever opened.
  if (!reader || !OWNED_NAME.test(name) || resolve(dirname(path)) !== resolve(attachmentsDir) || budget.left <= 0) return "";
  try {
    if (!lstatSync(path).isFile()) return "";
    const payload = JSON.stringify({ note: NOTE, ...reader(path, budget) }).replaceAll("<", "\\u003c");
    return `\n\n<attachment-contents>${payload}</attachment-contents>\n`;
  } catch {
    return "";
  }
}

/**
 * For a turn whose engine cannot open files (an API-only engine, or a confined guest turn), puts what the
 * server can read of each uploaded zip or text file right after its `<attached-file>` tag. The payload is JSON with
 * every `<` escaped, so nothing in a file can close the envelope or pass for an attachment tag. The newest tags are
 * read first, so an old attachment in the replayed conversation never spends the budget the latest message needs.
 */
export function withAttachmentContents(text: string, inline: boolean, attachmentsDir = ATTACHMENTS_DIR): string {
  if (!inline || !text.includes("<attached-file")) return text;
  const tags = [...text.matchAll(TAG)];
  const budget = { left: TURN_INLINE_MAX_BYTES };
  const added = tags.toReversed().map((tag) => envelope(decodeAttachmentAttribute(tag[1]!), attachmentsDir, budget)).toReversed();
  let out = "", from = 0;
  tags.forEach((tag, index) => {
    const end = tag.index + tag[0].length;
    out += text.slice(from, end) + added[index];
    from = end;
  });
  return out + text.slice(from);
}
