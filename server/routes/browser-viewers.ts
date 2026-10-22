// People's views of a bot's browser. v1 (GET …/browser/live as server-sent events, POST …/browser/action) is what the
// phone apps speak, and its contract is frozen. v2 (GET …/browser/stream, a WebSocket) is the desktop panel's and the
// web UI's, on the new engine only: a page's file picker is answered by POST …/browser/upload and a finished download
// is fetched from GET …/browser/download/:id. Never mix login frames into the general events feed, which every device
// reads.
import { createReadStream, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";

import type { Audience } from "../audience.ts";
import { storeUploads } from "../browser-upload.ts";
import type { BrowserLive } from "../browser-live.ts";
import type { LiveRouter } from "../browser/engines.ts";
import { messageFileDisposition } from "../message-file.ts";
import { isSameOrigin, type RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";
import type { Upgrades } from "./upgrades.ts";

const LIVE = /^\/api\/bots\/([\w-]+)\/browser\/(live|action)$/;
const STREAM = /^\/api\/bots\/([\w-]+)\/browser\/stream$/;
const UPLOAD = /^\/api\/bots\/([\w-]+)\/browser\/upload$/;
const DOWNLOAD = /^\/api\/bots\/([\w-]+)\/browser\/download\/([\w-]{1,64})$/;
const CHOOSER = /^[\w-]{1,64}$/;
const UPLOAD_MAX_FILES = 20;
const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
const PICKER_CLOSED = "The page's file picker is no longer open.";

type Spec = Parameters<BrowserLive["open"]>[0]["spec"];
type Failure = { status: number; error: string };

export interface BrowserViewerRouteDeps {
  upgrades: Upgrades;
  viewers: Pick<LiveRouter, "open" | "action" | "stream" | "fileChooserOffered" | "answerFileChooser" | "download">;
  /** Whose browser of the bot this person's view shows (`threadId` names the conversation they look at); null when
   * they may not see that conversation. */
  audience(auth: RequestAuth, threadId: string | null): Audience | null;
  /** A bot with its browser on, and the session and spec that audience's browser runs as. */
  browser(botId: string, audience: Audience): Promise<{ botId: string; session: string; spec: Spec } | Failure>;
  /** Hosted workspaces check the member's sign-in again before a view opens. */
  authorize(req: IncomingMessage, auth: RequestAuth): Promise<Failure | null>;
  /** Whether a view opened for `session` still shows the bot's current browser to a live sign-in. */
  current(botId: string, session: string, auth: RequestAuth, audience: Audience): boolean;
  /** Why a person may not restart this browser now, or null. */
  restartRefusal(session: string): string | null;
  dataDir: string;
}

const ownerOf = (auth: RequestAuth) => (auth.kind === "session" ? auth.session.id : "local-owner");

class UploadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The multipart `file` parts of an upload, read whole: at most 20 files and 100 MiB in all. */
async function uploadedFiles(req: IncomingMessage): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  const type = String(req.headers["content-type"] ?? "");
  if (!/^multipart\/form-data;/i.test(type)) throw new UploadError(415, "Send the files as multipart form data.");
  if (Number(req.headers["content-length"]) > UPLOAD_MAX_BYTES) throw new UploadError(413, "Those files are larger than 100 MB in all.");
  let bytes = 0;
  const limited = req.pipe(new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done(bytes > UPLOAD_MAX_BYTES ? new UploadError(413, "Those files are larger than 100 MB in all.") : null, chunk);
    },
  }));
  req.once("error", (error) => limited.destroy(error));
  let form: FormData;
  try {
    form = await new Request("http://upload.invalid/", {
      method: "POST", headers: { "content-type": type }, body: Readable.toWeb(limited) as ReadableStream, duplex: "half",
    } as RequestInit).formData();
  } catch (error) {
    throw error instanceof UploadError ? error : bytes > UPLOAD_MAX_BYTES ? new UploadError(413, "Those files are larger than 100 MB in all.") : new UploadError(400, "The upload was not valid form data.");
  }
  const files = form.getAll("file").filter((entry): entry is File => typeof entry !== "string");
  if (files.length > UPLOAD_MAX_FILES) throw new UploadError(413, `A page takes at most ${UPLOAD_MAX_FILES} files at once.`);
  return Promise.all(files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
}

/** Gives an upload's files to the page's picker; null when it took them, else why not. Files it did not take are deleted. */
async function answerUpload(req: IncomingMessage, deps: BrowserViewerRouteDeps, browser: { session: string; spec: Spec }, owner: string, chooser: string): Promise<(Failure & { unread?: boolean }) | null> {
  let files: Array<{ name: string; bytes: Uint8Array }>;
  try { files = await uploadedFiles(req); }
  catch (error) {
    if (!(error instanceof UploadError)) throw error;
    return { status: error.status, error: error.message, unread: true };
  }
  const paths = storeUploads(files, join(deps.dataDir, "browser-uploads"));
  if (await deps.viewers.answerFileChooser(browser, owner, chooser, paths).catch(() => false)) return null;
  for (const file of paths) rmSync(dirname(file), { recursive: true, force: true });
  return { status: 409, error: PICKER_CLOSED };
}

export function createBrowserViewerRoutes(deps: BrowserViewerRouteDeps): RouteHandler {
  deps.upgrades.route((path) => STREAM.test(path));
  const uploading = new Set<string>();
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    const live = LIVE.exec(path);
    const stream = live ? null : STREAM.exec(path);
    const upload = live || stream ? null : UPLOAD.exec(path);
    const download = live || stream || upload ? null : DOWNLOAD.exec(path);
    const botId = (live ?? stream ?? upload ?? download)?.[1];
    if (!botId) return PASS;
    res.setHeader("cache-control", "no-store");
    const pending = stream ? deps.upgrades.pending(req) : undefined;
    if (stream) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      if (!pending) return json(res, 426, { error: "WebSocket upgrade required" });
      if (!isSameOrigin(req)) return json(res, 403, { error: "forbidden: cross-origin request" });
    }
    const threadId = url.searchParams.get("threadId");
    const audience = deps.audience(auth, threadId);
    if (!audience) return json(res, 404, { error: "no such conversation" });
    const browser = await deps.browser(botId, audience);
    if ("error" in browser) return json(res, browser.status, { error: browser.error });
    // Discovery may have awaited while the portal closed this owner's streams: never open a late replacement on the earlier authorization.
    const failure = await deps.authorize(req, auth);
    if (failure) return json(res, failure.status, { error: failure.error });
    const owner = ownerOf(auth);
    const isCurrent = () => deps.audience(auth, threadId) === audience && deps.current(browser.botId, browser.session, auth, audience);

    if (live) {
      if (method === "GET" && live[2] === "live") {
        req.socket.setTimeout(0);
        return await deps.viewers.open({ botId: browser.botId, session: browser.session, spec: browser.spec, owner, isCurrent, res, resume: url.searchParams.get("resume") });
      }
      if (method === "POST" && live[2] === "action") {
        const body = await readBody(req, 32_768);
        if (!isCurrent()) return json(res, 409, { error: "This browser session changed. Reopen the browser panel." });
        if (typeof body?.viewerId !== "string") return json(res, 400, { error: "A live browser connection is required." });
        const refused = body.type === "restart" && deps.restartRefusal(browser.session);
        if (refused) return json(res, 409, { error: refused });
        return json(res, 200, await deps.viewers.action({ viewerId: body.viewerId, botId: browser.botId, owner, body }));
      }
      return json(res, 405, { error: "method not allowed" });
    }

    if (stream && pending) {
      if (pending.socket.destroyed) return;
      if (!isCurrent()) return json(res, 409, { error: "This browser session changed. Reopen the browser panel." });
      pending.release();
      const opened = deps.viewers.stream({
        session: browser.session, spec: browser.spec, botId: browser.botId, owner,
        canOperate: url.searchParams.get("interactive") !== "false",
        params: url.searchParams, req, socket: pending.socket, head: pending.head,
        isCurrent, restartRefusal: () => deps.restartRefusal(browser.session),
      });
      if (!opened) return json(res, 409, { error: "This browser shows in the live view only." });
      res.detachSocket(pending.socket);
      return;
    }

    if (upload) {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const chooser = url.searchParams.get("chooser") ?? "";
      if (!CHOOSER.test(chooser)) return json(res, 400, { error: "Name the page's file picker." });
      // Security: a body is read into memory only for the picker this person was offered, one upload of theirs at a time.
      const refused = !deps.viewers.fileChooserOffered(browser, owner, chooser) ? { status: 409, error: PICKER_CLOSED }
        : uploading.has(owner) ? { status: 429, error: "Your previous upload is still on its way. Wait for it, then try again." } : null;
      if (refused) {
        res.setHeader("connection", "close");
        return json(res, refused.status, { error: refused.error });
      }
      uploading.add(owner);
      const unanswered = await answerUpload(req, deps, browser, owner, chooser).finally(() => uploading.delete(owner));
      if (!unanswered) {
        res.writeHead(204).end();
        return;
      }
      // The rest of a refused body is never read.
      if (unanswered.unread) res.setHeader("connection", "close");
      return json(res, unanswered.status, { error: unanswered.error });
    }

    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    const file = deps.viewers.download(browser, download![2]!);
    if (!file?.path) return json(res, 404, { error: "That download is not available." });
    const saved = file.path;
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(file.receivedBytes),
      "content-disposition": messageFileDisposition(file.fileName),
      "x-content-type-options": "nosniff",
    });
    await new Promise<void>((resolve) => {
      const reading = createReadStream(saved);
      reading.once("error", () => { res.destroy(); resolve(); });
      res.once("close", () => { reading.destroy(); resolve(); });
      reading.pipe(res);
    });
  };
}
