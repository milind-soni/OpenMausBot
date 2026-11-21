// The internal call behind the agents server's what_changed tool. Runs inside index.ts's /api/internal/ block, after the
// capability bearer is checked; the bot and conversation are the capability's. A file is read from the bot's own folders
// (by the extract tool's rules) or is a file this conversation's messages carry; for the person's upload that is the copy
// kept before any turn could change it. The comparison runs in a worker thread. Nothing read is logged.
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { decodeAttachmentAttribute } from "../../src/lib/composer-attachments.ts";
import { keptOriginal, keptOriginalsDir } from "../attachment-originals.ts";
import { boxUploadsDir } from "../bot-box/plan.ts";
import { botFileSource, PageBundleError } from "../pages/bundle.ts";
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
  compare?: (original: string, edited: string, start?: number) => Promise<WorkerComparison>;
}

const TAG = /<attached-file[\t ]+path="([^"\r\n]*)"/g;
const NOT_TEXT = new Set([".docx", ".doc", ".odt", ".rtf", ".pdf", ".pages", ".xlsx", ".pptx"]);

export const WHAT_CHANGED_MESSAGES = {
  sides: "Give the original as original_file or original_text, and the edited version as edited_file or edited_text.",
  outside: "Only files in your working folder, or files attached in this conversation, can be read. Save it there first.",
  notText: "That is not a plain text file. Word, PDF and other document files aren't read here yet: compare their text instead (save it as .txt or .md, or pass original_text / edited_text).",
  tooLarge: "Each side may be up to 2 MB of text. Compare a part at a time.",
  busy: "Two comparisons are already running. Try again in a moment.",
  failed: "The comparison could not finish. Try again, or compare a smaller part.",
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

type Side = { text: string } | { error: string; status: number };

async function readSide(ctx: HelperToolContext & { threadId: string }, deps: WhatChangedDeps, file: string): Promise<Side> {
  const name = basename(file.replaceAll("\\", "/"));
  const folder = resolve(dirname(file));
  const stored = folder === resolve(deps.attachmentsDir) || folder === resolve(boxUploadsDir(deps.dataDir, ctx.botId, ctx.threadId));
  let target: string;
  if (stored && conversationFileNames(deps.messages(ctx.threadId)).has(name)) {
    const inStore = join(deps.attachmentsDir, name);
    target = keptOriginal(inStore, deps.attachmentsDir, keptOriginalsDir(deps.dataDir)) ?? inStore;
  } else {
    try {
      target = await botFileSource(file, ctx.folders);
    } catch (error) {
      if (!(error instanceof PageBundleError)) throw error;
      return error.status === 403 ? { error: WHAT_CHANGED_MESSAGES.outside, status: 403 } : { error: `Nothing was found at ${file.slice(0, 200)}.`, status: 404 };
    }
  }
  if (NOT_TEXT.has(extname(target).toLowerCase())) return { error: WHAT_CHANGED_MESSAGES.notText, status: 415 };
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) return { error: `Nothing was found at ${file.slice(0, 200)}.`, status: 404 };
  if (info.size > WHAT_CHANGED_FILE_MAX_BYTES) return { error: WHAT_CHANGED_MESSAGES.tooLarge, status: 413 };
  const bytes = await readFile(target);
  if (bytes.includes(0)) return { error: WHAT_CHANGED_MESSAGES.notText, status: 415 };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    // Notes saved by Windows apps are often Windows-1252, not UTF-8.
    return { text: new TextDecoder("windows-1252").decode(bytes) };
  }
}

async function side(ctx: HelperToolContext & { threadId: string }, deps: WhatChangedDeps, file: unknown, text: unknown): Promise<Side | null> {
  if (typeof text === "string" && (typeof file !== "string" || !file.trim())) {
    return text.length > WHAT_CHANGED_FILE_MAX_BYTES ? { error: WHAT_CHANGED_MESSAGES.tooLarge, status: 413 } : { text };
  }
  if (typeof file === "string" && file.trim() && text === undefined) return readSide(ctx, deps, file.trim());
  return null;
}

export function createWhatChangedRoutes(deps: WhatChangedDeps) {
  const compare = deps.compare ?? compareInWorker;
  return async (ctx: HelperToolContext & { threadId: string }): Promise<typeof PASS | void> => {
    if (ctx.method !== "POST" || ctx.path !== WHAT_CHANGED_PATH) return PASS;
    const body = await ctx.readBody();
    if (!body || typeof body !== "object" || Array.isArray(body)) return void ctx.json(ctx.res, 400, { error: "Send a JSON object." });
    const args = body as Record<string, unknown>;
    const original = await side(ctx, deps, args.original_file, args.original_text);
    const edited = await side(ctx, deps, args.edited_file, args.edited_text);
    if (!original || !edited) return void ctx.json(ctx.res, 400, { error: WHAT_CHANGED_MESSAGES.sides });
    for (const one of [original, edited]) if ("error" in one) return void ctx.json(ctx.res, one.status, { error: one.error });
    const start = typeof args.start === "number" && Number.isSafeInteger(args.start) && args.start > 1 ? args.start : undefined;
    const answer = await compare((original as { text: string }).text, (edited as { text: string }).text, start);
    if ("text" in answer) return void ctx.json(ctx.res, 200, { text: answer.text });
    const status = answer.reason === "too_large" ? 413 : answer.reason === "busy" ? 429 : 500;
    return void ctx.json(ctx.res, status, { error: answer.reason === "too_large" ? WHAT_CHANGED_MESSAGES.tooLarge : answer.reason === "busy" ? WHAT_CHANGED_MESSAGES.busy : WHAT_CHANGED_MESSAGES.failed });
  };
}
