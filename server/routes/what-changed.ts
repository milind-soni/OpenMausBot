// The internal call behind the agents server's what_changed tool. Runs inside index.ts's /api/internal/ block, after the
// capability bearer is checked; the bot and conversation are the capability's. A file is read from the bot's own folders
// (by the extract tool's rules) or is a file this conversation's messages carry. The original side of a person's upload
// is the copy kept when it was sent; the edited side is always the file as it is now. The comparison runs in a worker
// thread. Nothing read is logged.
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { formatChangePage, TEXT_CHANGES_MAX_SENTENCES } from "../../shared/text-changes.ts";
import { decodeAttachmentAttribute } from "../../src/lib/composer-attachments.ts";
import { keptOriginal, keptOriginalsDir } from "../attachment-originals.ts";
import { boxUploadsDir } from "../bot-box/plan.ts";
import { botFileSource, canonicalRoots, containedBy, PageBundleError, readContained } from "../pages/bundle.ts";
import { compareInWorker, type WorkerComparison } from "../text-changes-worker.ts";
import type { HelperToolContext } from "./helper-tools.ts";
import { PASS } from "./table.ts";

export const WHAT_CHANGED_PATH = "/api/internal/what-changed";
export const WHAT_CHANGED_FILE_MAX_BYTES = 2 * 1024 * 1024;

type Line = { text?: string; attachments?: ReadonlyArray<{ kind: string; path: string }> };
export interface WhatChangedDeps {
  dataDir: string;
  attachmentsDir: string;
  messages: (threadId: string) => readonly Line[];
  compare?: (original: string, edited: string) => Promise<WorkerComparison>;
}

const TAG = /<attached-file[\t ]+path="([^"\r\n]*)"/g;
const NOT_TEXT = new Set([".docx", ".doc", ".odt", ".rtf", ".pdf", ".pages", ".xlsx", ".pptx"]);

export const WHAT_CHANGED_MESSAGES = {
  sides: "Give the original as original_file or original_text, and the edited version as edited_file or edited_text.",
  outside: "Only files in your working folder, or files attached in this conversation, can be read. Save it there first.",
  notText: "That is not a plain text file. Word, PDF and other document files aren't read here yet: compare their text instead (save it as .txt or .md, or pass original_text / edited_text).",
  tooLarge: "Each file may be up to 2 MB. Compare a part at a time.",
  tooManySentences: `Each side may have up to ${TEXT_CHANGES_MAX_SENTENCES.toLocaleString("en-US")} sentences (about 300 pages). Compare a part at a time.`,
  busy: "Another comparison is running. Try again in a moment.",
  failed: "The comparison could not finish. Try again, or compare a smaller part.",
  notKept: "Note: no copy of the original was kept when it was sent, so the original here is that file as it is now.",
} as const;

/** Every stored file this conversation's messages carry, by stored name: the person's attachments and the bots'. */
export function conversationFileNames(lines: readonly Line[]): Set<string> {
  const names = new Set<string>();
  for (const line of lines) {
    for (const match of (line.text ?? "").matchAll(TAG)) names.add(basename(decodeAttachmentAttribute(match[1]!)));
    for (const attachment of line.attachments ?? []) if (attachment.kind === "file") names.add(basename(attachment.path));
  }
  return names;
}

type Side = { text: string; notKept?: true } | { error: string; status: number };
type Context = HelperToolContext & { threadId: string };

const missing = (file: string): Side => ({ error: `Nothing was found at ${file.slice(0, 200)}.`, status: 404 });

/** The file `file` names and the folder that must hold it: a stored file this conversation carries (its kept copy for the
 * original side), else one in the bot's own folders. */
async function locate(ctx: Context, deps: WhatChangedDeps, file: string, original: boolean): Promise<{ target: string; root: string; notKept?: true } | Side> {
  const name = basename(file.replaceAll("\\", "/"));
  const folder = resolve(dirname(file));
  const stored = folder === resolve(deps.attachmentsDir) || folder === resolve(boxUploadsDir(deps.dataDir, ctx.botId, ctx.threadId));
  if (stored && conversationFileNames(deps.messages(ctx.threadId)).has(name)) {
    const inStore = join(deps.attachmentsDir, name);
    const kept = original ? keptOriginal(inStore, deps.attachmentsDir, keptOriginalsDir(deps.dataDir)) : null;
    const target = kept ?? inStore;
    const sentByPerson = deps.messages(ctx.threadId).some((line) => [...(line.text ?? "").matchAll(TAG)].some((match) => basename(decodeAttachmentAttribute(match[1]!)) === name));
    const [real, root] = await Promise.all([realpath(target).catch(() => null), realpath(dirname(target)).catch(() => null)]);
    if (!real || !root) return missing(file);
    return { target: real, root, ...(original && !kept && sentByPerson ? { notKept: true as const } : {}) };
  }
  try {
    const target = await botFileSource(file, ctx.folders);
    const { roots, vmWorkspace } = await ctx.folders();
    const root = (await canonicalRoots(vmWorkspace ? [vmWorkspace, ...roots] : roots)).find((each) => containedBy(each, target));
    return root ? { target, root } : { error: WHAT_CHANGED_MESSAGES.outside, status: 403 };
  } catch (error) {
    if (!(error instanceof PageBundleError)) throw error;
    return error.status === 403 ? { error: WHAT_CHANGED_MESSAGES.outside, status: 403 } : missing(file);
  }
}

async function readSide(ctx: Context, deps: WhatChangedDeps, file: string, original: boolean): Promise<Side> {
  const found = await locate(ctx, deps, file, original);
  if (!("target" in found)) return found;
  if (NOT_TEXT.has(extname(found.target).toLowerCase())) return { error: WHAT_CHANGED_MESSAGES.notText, status: 415 };
  const info = await stat(found.target).catch(() => null);
  if (!info?.isFile()) return missing(file);
  if (info.size > WHAT_CHANGED_FILE_MAX_BYTES) return { error: WHAT_CHANGED_MESSAGES.tooLarge, status: 413 };
  const bytes = await readContained(found.target, found.root).catch(() => null);
  if (!bytes) return missing(file);
  if (bytes.includes(0)) return { error: WHAT_CHANGED_MESSAGES.notText, status: 415 };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Notes saved by Windows apps are often Windows-1252, not UTF-8.
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  return { text, ...(found.notKept ? { notKept: true as const } : {}) };
}

async function side(ctx: Context, deps: WhatChangedDeps, file: unknown, text: unknown, original: boolean): Promise<Side | null> {
  if (typeof text === "string" && (typeof file !== "string" || !file.trim())) return { text };
  if (typeof file === "string" && file.trim() && text === undefined) return readSide(ctx, deps, file.trim(), original);
  return null;
}

export function createWhatChangedRoutes(deps: WhatChangedDeps) {
  const compare = deps.compare ?? compareInWorker;
  return async (ctx: Context): Promise<typeof PASS | void> => {
    if (ctx.method !== "POST" || ctx.path !== WHAT_CHANGED_PATH) return PASS;
    const body = await ctx.readBody();
    if (!body || typeof body !== "object" || Array.isArray(body)) return void ctx.json(ctx.res, 400, { error: "Send a JSON object." });
    const args = body as Record<string, unknown>;
    const original = await side(ctx, deps, args.original_file, args.original_text, true);
    const edited = await side(ctx, deps, args.edited_file, args.edited_text, false);
    if (!original || !edited) return void ctx.json(ctx.res, 400, { error: WHAT_CHANGED_MESSAGES.sides });
    for (const one of [original, edited]) if ("error" in one) return void ctx.json(ctx.res, one.status, { error: one.error });
    const start = typeof args.start === "number" && Number.isSafeInteger(args.start) && args.start > 1 ? args.start : undefined;
    const before = original as { text: string; notKept?: true };
    const answer = await compare(before.text, (edited as { text: string }).text);
    if ("list" in answer) {
      const page = formatChangePage(answer.list, start ? { start } : {});
      return void ctx.json(ctx.res, 200, { text: before.notKept ? `${page}\n${WHAT_CHANGED_MESSAGES.notKept}` : page });
    }
    const [status, error] = answer.reason === "too_large" ? [413, WHAT_CHANGED_MESSAGES.tooLarge]
      : answer.reason === "too_many_sentences" ? [413, WHAT_CHANGED_MESSAGES.tooManySentences]
        : answer.reason === "busy" ? [429, WHAT_CHANGED_MESSAGES.busy] : [500, WHAT_CHANGED_MESSAGES.failed];
    return void ctx.json(ctx.res, status, { error });
  };
}
