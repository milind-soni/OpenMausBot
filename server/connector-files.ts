// A connected-app tool that takes a file (GOOGLEDRIVE_UPLOAD_FILE's file_to_upload, a Gmail attachment) reads it from
// Composio's file storage by `s3key`: Composio runs the tool on its own servers and never sees this computer's disk. A
// bot that names a file in its working folder (C:\Users\…\report.pdf) gets the file uploaded here first, and the call
// carries the `{ name, mimetype, s3key }` Composio asks for. Without this, every such call failed at Composio with a
// storage error the bot could not act on. Files are read before the call's checks and approval card (which lists them),
// and uploaded only after its last check, right before it goes out.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { connectorCallsIn } from "../shared/outbound.ts";
import { FILE_MAX_BYTES, limitMegabytes } from "../shared/upload-limits.ts";
import { guestWorkspaceToHost } from "./bot-attachment.ts";
import type { BrokerAccess } from "./composio-broker-access.ts";
import { requestFileUpload, UploadServiceOutdatedError } from "./composio-files.ts";
import type { AppConfig } from "./config.ts";
import { withFailedCallHint } from "./connector-scope-hint.ts";
import { serviceSlugFor, serviceSlugForCandidates } from "./connector-verdict.ts";
import { openMessageFile, type OpenedMessageFile } from "./message-file.ts";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Fields Composio's tools take a file in, besides any `{ s3key }` object. */
const FILE_FIELDS = new Set(["file_to_upload", "file", "files", "file_upload", "upload", "attachment", "attachments", "document", "image", "media"]);
/** Where a `{ … }` file object may carry a path instead of a staged key. */
const PATH_KEYS = ["s3key", "path", "file_path", "local_path", "filepath"] as const;
/** An absolute path on this computer, in any spelling a bot writes one: C:\…, C:/…, \\server\share, /…, ~/…, file://… */
const LOCAL_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]|\/(?!\/)|~[\\/]|file:\/\/)/;
const MIME = /^[A-Za-z0-9][\w.+-]*\/[\w.+-]+$/;
const MAX_FILES_PER_REQUEST = 10;
const MAX_DEPTH = 6;

export interface StagedFile {
  name: string;
  mimetype: string;
  s3key: string;
}

export interface OpenedLocalFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface FileStagingDeps {
  /** The file at `path` when the bot may send it; null when there is no such file there, or it is outside the bot's
   * folders: the value is then not one of its files and is left as it is. Throws why a file there may not be sent. */
  open(path: string): Promise<OpenedLocalFile | null>;
  /** Composio's upload link and key for the file (server/composio-files.ts). */
  requestUpload(request: { toolkit_slug: string; tool_slug: string; filename: string; mimetype: string; md5: string }): Promise<{ key: string; url: string }>;
  /** The toolkit a tool belongs to (GOOGLEDRIVE_UPLOAD_FILE → googledrive). */
  toolkitFor(tool: string): string;
  /** The app's name for people (Google Drive). */
  appFor(tool: string): string;
  put?(url: string, bytes: Uint8Array, mimetype: string): Promise<void>;
}

interface FileReference {
  tool: string;
  field: string;
  path: string;
  name?: string;
  mimetype?: string;
  /** The call's arguments in the frame as the bot sent it, to find the call on its approval card. */
  source: unknown;
  replace(staged: StagedFile): void;
}

/** A file one call will upload, as its approval card lists it. */
export interface CardFile {
  name: string;
  path: string;
  bytes: number;
}

function localPath(value: unknown): value is string {
  return typeof value === "string" && !/[\r\n]/.test(value) && LOCAL_PATH.test(value.trim());
}

function referenceIn(owner: Json | unknown[], key: string | number, field: string, call: { slug: string; source: unknown }, value: unknown, found: FileReference[]): boolean {
  const set = (staged: StagedFile) => { (owner as Record<string | number, unknown>)[key] = staged; };
  const base = { tool: call.slug, field, source: call.source, replace: set };
  if (FILE_FIELDS.has(field.toLowerCase()) && localPath(value)) {
    found.push({ ...base, path: value.trim() });
    return true;
  }
  if (!isRecord(value)) return false;
  const pathKey = PATH_KEYS.find((candidate) => localPath(value[candidate]));
  // Only a file object: `{ s3key }` anywhere, or a path inside a field that takes a file.
  if (!pathKey || (pathKey !== "s3key" && !FILE_FIELDS.has(field.toLowerCase()))) return false;
  const name = typeof value.name === "string" && value.name.trim() ? basename(value.name.trim().replace(/\\/g, "/")) : undefined;
  const given = typeof value.mimetype === "string" ? value.mimetype : typeof value.mime_type === "string" ? value.mime_type : undefined;
  found.push({ ...base, path: (value[pathKey] as string).trim(), ...(name ? { name } : {}), ...(given && MIME.test(given.trim()) ? { mimetype: given.trim() } : {}) });
  return true;
}

function collect(node: unknown, field: string, call: { slug: string; source: unknown }, found: FileReference[], depth: number): void {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      if (!referenceIn(node, index, field, call, item, found)) collect(item, field, call, found, depth + 1);
    });
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (!referenceIn(node, key, key, call, value, found)) collect(value, key, call, found, depth + 1);
  }
}

/** The values a tools/call frame gives where a connected-app tool takes a file and that read as a path on this
 * computer, in a copy of the frame whose values can be replaced. Search, schema and connection tools carry none. */
export function localFileReferences(frame: unknown): { frame: unknown; references: FileReference[] } {
  if (!isRecord(frame) || frame.method !== "tools/call" || !isRecord(frame.params) || typeof frame.params.name !== "string") return { frame, references: [] };
  const copy = structuredClone(frame) as Json & { params: { name: string; arguments?: unknown } };
  const sent = connectorCallsIn(frame.params.name, frame.params.arguments);
  const references: FileReference[] = [];
  connectorCallsIn(copy.params.name, copy.params.arguments).forEach((call, index) => {
    if (call.slug === "COMPOSIO_PROXY_EXECUTE" || call.arguments === undefined) return;
    collect(call.arguments, "", { slug: call.slug, source: sent[index]?.arguments }, references, 0);
  });
  return { frame: copy, references };
}

/** Where a bot's files may come from: its folders (never the attachment store as a whole), this conversation's own
 * attachments by path, never the app's own data or a hidden folder, its Local VM folder. */
export interface BotFileScope {
  roots: readonly string[];
  /** This conversation's attachments, each allowed by its exact path. */
  attachments: readonly string[];
  /** The app's own data folders: a file in one goes out only from a folder of the bot's inside it (its workspace). */
  refuse: readonly string[];
  guest?: { root: string; host: string } | undefined;
  /** The home folder, whose hidden folders (.ssh, .aws, .config…) never go out. */
  home?: string;
}

const SENSITIVE = "it is in a hidden folder or in the app's own data, which is never sent to an app";

const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};
const hiddenBelow = (root: string, path: string) => relative(root, path).split(/[\\/]/).some((part) => part.startsWith("."));
const real = (path: string) => realpath(path).catch(() => null);

/** The bot's file at `path`, read through the chat file-link resolver (realpath containment, no-follow, secret folders,
 * 100 MB), or null when nothing the bot may send is there. A Local VM path is read from the VM's host folder. */
export async function openBotFile(path: string, scope: BotFileScope): Promise<OpenedLocalFile | null> {
  const target = (scope.guest ? guestWorkspaceToHost(path, scope.guest.root, scope.guest.host) : null) ?? path;
  const canonical = await real(target);
  const attachments = (await Promise.all(scope.attachments.map(real))).filter((one): one is string => one !== null);
  const attached = canonical !== null && attachments.includes(canonical);
  const roots = attached ? [dirname(canonical)] : scope.guest ? [scope.guest.host, ...scope.roots] : scope.roots;
  let file: OpenedMessageFile;
  try {
    file = await openMessageFile(target, roots, FILE_MAX_BYTES);
  } catch (error) {
    const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
    if (code === "outside_workspace" || code === "directory" || status === 404) return null;
    if (code === "file_too_large") throw new Error(`it is larger than ${limitMegabytes(FILE_MAX_BYTES)} MB`);
    throw error;
  }
  try {
    const realRoots = (await Promise.all(roots.map(real))).filter((one): one is string => one !== null);
    const root = realRoots.filter((one) => within(one, file.path)).sort((a, b) => b.length - a.length)[0] ?? dirname(file.path);
    const appData = (await Promise.all(scope.refuse.map(real))).filter((one): one is string => one !== null);
    // A bot's own workspace sits inside the app's data folder: only a folder strictly inside it may send from there.
    const ownAppFolder = appData.some((data) => within(data, root));
    const home = await real(scope.home ?? homedir());
    if (hiddenBelow(root, file.path)
      || (!ownAppFolder && appData.some((data) => data === file.path || within(data, file.path)))
      || (!ownAppFolder && home !== null && within(home, file.path) && hiddenBelow(home, file.path))) {
      throw new Error(SENSITIVE);
    }
    return { name: file.name, mime: file.mime, bytes: await file.handle.readFile() };
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

/** The scope of one turn: the bot's folders without the attachment store (which holds every conversation's and every
 * team member's files), this conversation's own attachments by path, and the app's own data folders. */
export function connectorFileScope(input: {
  roots: readonly string[];
  attachmentStore: string;
  messages: ReadonlyArray<{ attachments?: ReadonlyArray<{ path: string }> | undefined }>;
  appData: ReadonlyArray<string | undefined>;
  vm?: { workspaceDir: string } | undefined;
  guestRoot: string;
}): BotFileScope {
  return {
    roots: input.roots.filter((root) => root !== input.attachmentStore),
    attachments: input.messages.flatMap((message) => (message.attachments ?? []).map((file) => file.path)),
    refuse: input.appData.filter((dir): dir is string => Boolean(dir)),
    ...(input.vm ? { guest: { root: input.guestRoot, host: input.vm.workspaceDir } } : {}),
  };
}

/** The relay's staging for one call: the bot's files, uploaded through the same connection the call goes out on. */
export function connectorFileDeps(options: {
  scope: BotFileScope;
  via: readonly [AppConfig, BrokerAccess?];
  serviceSlugs: readonly string[];
  appFor(tool: string): string | null;
}): FileStagingDeps {
  const toolkit = (tool: string) => serviceSlugForCandidates(tool, options.serviceSlugs) ?? serviceSlugFor(tool);
  return {
    open: (path) => openBotFile(path, options.scope),
    requestUpload: (request) => requestFileUpload(options.via[0], request, options.via[1]),
    toolkitFor: (tool) => toolkit(tool) ?? tool.toLowerCase(),
    appFor: (tool) => options.appFor(tool) ?? toolkit(tool) ?? "the app",
  };
}

/** A path as the file system reads it: ~/ is the home folder, file:// a file URL. */
function onDisk(path: string): string {
  if (/^~[\\/]/.test(path)) return join(homedir(), path.slice(2));
  if (/^file:\/\//i.test(path)) {
    try { return fileURLToPath(path); } catch { return path; }
  }
  return path;
}

async function putBytes(url: string, bytes: Uint8Array, mimetype: string): Promise<void> {
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  // The link is Composio's own storage: a redirect elsewhere is refused, never followed with the file.
  const response = await fetch(url, { method: "PUT", body, redirect: "error", headers: { "content-type": mimetype }, signal: AbortSignal.timeout(5 * 60_000) });
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new Error(`the upload was refused (HTTP ${response.status})`);
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 240);

/** What the bot is told when a file it named may not be sent. */
export function unreadableFileText(reference: Pick<FileReference, "tool" | "field" | "path">, app: string, reason: string): string {
  return `OpenMausBot did not run ${reference.tool}: it could not send ${reference.path} to ${app} (${reason}). `
    + `Nothing was written to ${app}. Give ${reference.field || "the file field"} the full path of a file in your working folder or one `
    + "attached to this conversation, and OpenMausBot uploads it for the call. For plain text, a tool that takes the text itself, "
    + "such as GOOGLEDRIVE_CREATE_FILE_FROM_TEXT, needs no file.";
}

/** What the bot is told when the file was read but Composio did not take it. */
export function uploadFailedText(reference: Pick<FileReference, "tool">, name: string, app: string, reason: string): string {
  return `OpenMausBot did not run ${reference.tool}: uploading ${name} for ${app} failed (${reason}). Nothing was written to ${app}. `
    + "This is usually brief: try the call once more. If it fails again, tell the person the upload to "
    + `${app} failed and why, and do not keep retrying.`;
}

/** What the bot is told when the connected-apps service is too old to take the file. */
function uploadServiceOutdatedText(reference: Pick<FileReference, "tool">, name: string, app: string): string {
  return `OpenMausBot did not run ${reference.tool}: uploading ${name} for ${app} failed: the connected-apps service is out of date `
    + `and does not take file uploads yet. Nothing was written to ${app}. Trying again will not help: tell the person that sending `
    + `files to ${app} works once the OpenMausBot team updates that service. A ${app} tool that takes text instead of a file still works.`;
}

export interface PreparedFiles {
  /** The files the call will upload, for its approval card. */
  files: Array<CardFile & { tool: string; source: unknown }>;
  /** Uploads them and answers the frame that names each by its key; rejects with the text the bot is told. Absent when
   * the call names none: the frame goes out as sent. Run only once the call has passed every check. */
  upload?: () => Promise<unknown>;
  /** `calls` (connectorCallsIn of the frame as sent) with the files each will upload. */
  cardCalls<T extends { arguments?: unknown }>(calls: T[]): Array<T & { files?: CardFile[] }>;
}

/**
 * Reads, here and before anything goes out, each file of the bot's that `frame` names where a connected-app tool takes a
 * file. A value that is not one of the bot's files is left as it is (a Drive folder path such as /Apps/report.pdf, text
 * that starts with /). Answers the refusal the bot is told when a file it named may not be sent.
 */
export async function prepareConnectorFiles(frame: unknown, deps: FileStagingDeps): Promise<PreparedFiles | { refusal: string }> {
  const found = localFileReferences(frame);
  const ready: Array<{ reference: FileReference; file: OpenedLocalFile; name: string; mimetype: string }> = [];
  for (const reference of found.references) {
    let file: OpenedLocalFile | null;
    try {
      file = await deps.open(onDisk(reference.path));
    } catch (error) {
      return { refusal: unreadableFileText(reference, deps.appFor(reference.tool), reasonOf(error)) };
    }
    if (!file) continue;
    if (ready.length === MAX_FILES_PER_REQUEST) {
      return { refusal: `OpenMausBot did not run this call: it names more than ${MAX_FILES_PER_REQUEST} files, and one call can upload at most ${MAX_FILES_PER_REQUEST}. Send them in smaller batches.` };
    }
    ready.push({ reference, file, name: reference.name ?? file.name, mimetype: reference.mimetype ?? file.mime.split(";")[0]!.trim() });
  }
  const files = ready.map(({ reference, file, name }) => ({ tool: reference.tool, source: reference.source, name, path: reference.path, bytes: file.bytes.byteLength }));
  const cardCalls = <T extends { arguments?: unknown }>(calls: T[]) => calls.map((call) => {
    const mine = files.filter((one) => one.source !== undefined && one.source === call.arguments).map(({ name, path, bytes }) => ({ name, path, bytes }));
    return mine.length ? { ...call, files: mine } : call;
  });
  if (!ready.length) return { files, cardCalls };
  const put = deps.put ?? putBytes;
  const upload = async () => {
    for (const { reference, file, name, mimetype } of ready) {
      const app = deps.appFor(reference.tool);
      try {
        const md5 = createHash("md5").update(file.bytes).digest("hex");
        const link = await deps.requestUpload({ toolkit_slug: deps.toolkitFor(reference.tool), tool_slug: reference.tool, filename: name, mimetype, md5 });
        await put(link.url, file.bytes, mimetype);
        reference.replace({ name, mimetype, s3key: link.key });
      } catch (error) {
        throw new Error(error instanceof UploadServiceOutdatedError
          ? uploadServiceOutdatedText(reference, name, app)
          : uploadFailedText(reference, name, app, reasonOf(error)));
      }
    }
    return found.frame;
  };
  return { files, upload, cardCalls };
}

/** prepareConnectorFiles and its upload at once: the frame to send, or the refusal. */
export async function stageConnectorFiles(frame: unknown, deps: FileStagingDeps): Promise<{ frame: unknown } | { refusal: string }> {
  const prepared = await prepareConnectorFiles(frame, deps);
  if ("refusal" in prepared) return prepared;
  if (!prepared.upload) return { frame };
  try {
    return { frame: await prepared.upload() };
  } catch (error) {
    return { refusal: error instanceof Error ? error.message : String(error) };
  }
}

/** Composio could not find the file a call named: a made-up key, a stale one, or a path it cannot reach. */
const MISSING_STAGED_FILE = /Failed to download file|storage returned HTTP 404|invalid s3key|s3key (?:was )?not found/i;

export function missingFileHint(): string {
  return "OpenMausBot note: Composio could not get the file this call named. Composio runs the tool on its own servers, so it "
    + "never reads this computer's disk and an s3key cannot be made up. Give the file field the full path of a file in your "
    + 'working folder or attached to this conversation, for example {"file_to_upload": "C:\\\\Users\\\\you\\\\report.pdf"} '
    + "or a path starting with /, and OpenMausBot uploads it for the call. For plain text, use a tool that takes the text itself, "
    + "such as GOOGLEDRIVE_CREATE_FILE_FROM_TEXT.";
}

/** Adds missingFileHint to a failed result whose error is Composio not finding the call's file. */
export function withMissingFileHint(bytes: Uint8Array, contentType: string, slugs: readonly string[]): Uint8Array {
  return withFailedCallHint(bytes, contentType, MISSING_STAGED_FILE, missingFileHint, slugs);
}

