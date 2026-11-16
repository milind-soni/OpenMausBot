// A connected-app tool that takes a file (GOOGLEDRIVE_UPLOAD_FILE's file_to_upload, a Gmail attachment) reads it from
// Composio's file storage by `s3key`: Composio runs the tool on its own servers and never sees this computer's disk. A
// bot that names a file in its working folder (C:\Users\…\report.pdf) gets the file uploaded here first, and the call
// carries the `{ name, mimetype, s3key }` Composio asks for. Without this, every such call failed at Composio with a
// storage error the bot could not act on.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { connectorCallsIn } from "../shared/outbound.ts";
import { FILE_MAX_BYTES, limitMegabytes } from "../shared/upload-limits.ts";
import { guestWorkspaceToHost } from "./bot-attachment.ts";
import type { BrokerAccess } from "./composio-broker-access.ts";
import { requestFileUpload } from "./composio-files.ts";
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
  /** The file at `path`, only from the bot's working folder or the conversation's attachments; throws with the reason. */
  open(path: string): Promise<OpenedLocalFile>;
  /** Composio's upload link and key for the file (server/composio.ts requestFileUpload). */
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
  replace(staged: StagedFile): void;
}

function localPath(value: unknown): value is string {
  return typeof value === "string" && LOCAL_PATH.test(value.trim());
}

function referenceIn(owner: Json | unknown[], key: string | number, field: string, tool: string, value: unknown, found: FileReference[]): boolean {
  const set = (staged: StagedFile) => { (owner as Record<string | number, unknown>)[key] = staged; };
  if (FILE_FIELDS.has(field.toLowerCase()) && localPath(value)) {
    found.push({ tool, field, path: value.trim(), replace: set });
    return true;
  }
  if (!isRecord(value)) return false;
  const pathKey = PATH_KEYS.find((candidate) => localPath(value[candidate]));
  // Only a file object: `{ s3key }` anywhere, or a path inside a field that takes a file.
  if (!pathKey || (pathKey !== "s3key" && !FILE_FIELDS.has(field.toLowerCase()))) return false;
  const name = typeof value.name === "string" && value.name.trim() ? basename(value.name.trim().replace(/\\/g, "/")) : undefined;
  const given = typeof value.mimetype === "string" ? value.mimetype : typeof value.mime_type === "string" ? value.mime_type : undefined;
  found.push({
    tool, field, path: (value[pathKey] as string).trim(), ...(name ? { name } : {}), ...(given && MIME.test(given.trim()) ? { mimetype: given.trim() } : {}),
    replace: set,
  });
  return true;
}

function collect(node: unknown, field: string, tool: string, found: FileReference[], depth: number): void {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      if (!referenceIn(node, index, field, tool, item, found)) collect(item, field, tool, found, depth + 1);
    });
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (!referenceIn(node, key, key, tool, value, found)) collect(value, key, tool, found, depth + 1);
  }
}

/** The local files a tools/call frame names where a connected-app tool takes a file, in a copy of the frame whose
 * references can be replaced. Search, schema and connection tools carry none. */
export function localFileReferences(frame: unknown): { frame: unknown; references: FileReference[] } {
  if (!isRecord(frame) || frame.method !== "tools/call" || !isRecord(frame.params) || typeof frame.params.name !== "string") return { frame, references: [] };
  const copy = structuredClone(frame) as Json & { params: { name: string; arguments?: unknown } };
  const references: FileReference[] = [];
  for (const call of connectorCallsIn(copy.params.name, copy.params.arguments)) {
    if (call.slug === "COMPOSIO_PROXY_EXECUTE" || call.arguments === undefined) continue;
    collect(call.arguments, "", call.slug, references, 0);
  }
  return { frame: copy, references };
}

/** A file a bot named, opened only inside `roots` (its working folder, the conversation's attachments) through the
 * message-file route's hardened resolver; a Local VM path is read from the VM's host folder. */
export async function openBotFile(path: string, roots: readonly string[], guest?: { root: string; host: string }): Promise<OpenedLocalFile> {
  const onHost = guest ? guestWorkspaceToHost(path, guest.root, guest.host) : null;
  let file: OpenedMessageFile;
  try {
    file = await openMessageFile(onHost ?? path, guest ? [guest.host, ...roots] : roots, FILE_MAX_BYTES);
  } catch (error) {
    const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
    if (code === "outside_workspace") throw new Error("it is outside your working folder and this conversation's attachments");
    if (code === "file_too_large") throw new Error(`it is larger than ${limitMegabytes(FILE_MAX_BYTES)} MB`);
    if (status === 404) throw new Error("there is no such file");
    throw error;
  }
  try {
    return { name: file.name, mime: file.mime, bytes: await file.handle.readFile() };
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

/** The relay's staging for one call: files from `roots` (and the turn's Local VM folder), uploaded through the same
 * connection the call goes out on. */
export function connectorFileDeps(options: {
  roots: readonly string[];
  vm?: { workspaceDir: string } | undefined;
  guestRoot: string;
  via: readonly [AppConfig, BrokerAccess?];
  serviceSlugs: readonly string[];
  appFor(tool: string): string | null;
}): FileStagingDeps {
  const toolkit = (tool: string) => serviceSlugForCandidates(tool, options.serviceSlugs) ?? serviceSlugFor(tool);
  return {
    open: (path) => openBotFile(path, options.roots, options.vm ? { root: options.guestRoot, host: options.vm.workspaceDir } : undefined),
    requestUpload: (request) => requestFileUpload(options.via[0], request, options.via[1]),
    toolkitFor: (tool) => toolkit(tool) ?? tool.toLowerCase(),
    appFor: (tool) => options.appFor(tool) ?? toolkit(tool) ?? "the app",
  };
}

function expandHome(path: string): string {
  return /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path;
}

async function putBytes(url: string, bytes: Uint8Array, mimetype: string): Promise<void> {
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  const response = await fetch(url, { method: "PUT", body, headers: { "content-type": mimetype }, signal: AbortSignal.timeout(5 * 60_000) });
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new Error(`the upload was refused (HTTP ${response.status})`);
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 240);

/** What the bot is told when a file it named could not be read here. */
export function unreadableFileText(reference: Pick<FileReference, "tool" | "field" | "path">, app: string, reason: string): string {
  return `OpenMausBot did not run ${reference.tool}: it could not read ${reference.path} to send it to ${app} (${reason}). `
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

/**
 * `frame` with each local file a connected-app tool takes uploaded to Composio and named by its key, or the refusal the
 * bot is told when one cannot be. A frame naming no local file is returned unchanged.
 */
export async function stageConnectorFiles(frame: unknown, deps: FileStagingDeps): Promise<{ frame: unknown } | { refusal: string }> {
  const found = localFileReferences(frame);
  if (!found.references.length) return { frame };
  if (found.references.length > MAX_FILES_PER_REQUEST) {
    return { refusal: `OpenMausBot did not run this call: it names ${found.references.length} files, and one call can upload at most ${MAX_FILES_PER_REQUEST}. Send them in smaller batches.` };
  }
  const put = deps.put ?? putBytes;
  for (const reference of found.references) {
    const app = deps.appFor(reference.tool);
    let file: OpenedLocalFile;
    try {
      file = await deps.open(expandHome(reference.path));
    } catch (error) {
      return { refusal: unreadableFileText(reference, app, reasonOf(error)) };
    }
    const name = reference.name ?? file.name;
    const mimetype = reference.mimetype ?? file.mime.split(";")[0]!.trim();
    try {
      const md5 = createHash("md5").update(file.bytes).digest("hex");
      const upload = await deps.requestUpload({ toolkit_slug: deps.toolkitFor(reference.tool), tool_slug: reference.tool, filename: name, mimetype, md5 });
      await put(upload.url, file.bytes, mimetype);
      reference.replace({ name, mimetype, s3key: upload.key });
    } catch (error) {
      return { refusal: uploadFailedText(reference, name, app, reasonOf(error)) };
    }
  }
  return { frame: found.frame };
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

