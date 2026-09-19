// The message-feed HTTP routes (the bot list with paginated transcripts,
// scrollback, per-message image and file downloads, image-attachment and
// shared-file uploads, attachment serving, search, and transcript export),
// extracted verbatim from index.ts's dispatch chain. Path matching,
// methods, and status codes are unchanged; the handler returns false for
// anything it does not own so the chain falls through in the same order.
// The pagination helpers and the wire/bot views are index-local and cross
// via deps; store/cfg are live bindings from ../runtime.ts; everything
// else is imported from its source module. requirePinnedClientThread is
// defined once here and re-imported by index.ts: every caller is a
// bot-mutation route that stayed there, and it reads the per-request auth
// and companion header, so it crosses as a factory.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import { handleSearch } from "./search.ts";
import { cfg, store } from "../runtime.ts";
import {
  ATTACHMENTS_DIR,
  extensionForMime,
  FILE_MAX_BYTES,
  IMAGE_MAX_BYTES,
  readAttachment,
  saveFile,
  saveImageUpload,
  type SavedAttachment,
  validateAttachmentUploadId,
} from "../attachments.ts";
import {
  messageFileDisposition,
  messageFileDownloadName,
  messageAttachmentName,
  messageFileRoots,
  messageImageTargetAt,
  messageReferencesFile,
  openMessageFile,
} from "../message-file.ts";
import { workspaceDir } from "../workspace.ts";
import type { GroupRecord, Message } from "../store.ts";
import type { WireGroup } from "../../shared/wire.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { createBotViews } from "../bot-views.ts";
import type { createComputerLifecycle } from "../computer-lifecycle.ts";

type BotViews = ReturnType<typeof createBotViews>;
type ComputerLifecycle = ReturnType<typeof createComputerLifecycle>;

export function createRequirePinnedClientThread(auth: RequestAuth, req: IncomingMessage) {
  return (botId: string, threadId: unknown): void => {
    if (threadId === undefined &&
      (auth.kind === "session" || req.headers["x-openmausbot-companion"] === "1") &&
      store.tasks(botId).length > 1) {
      throw Object.assign(new Error("This bot has more than one thread. Update the OpenMausBot app on this device, then choose a thread and try again."), { status: 409 });
    }
  };
}

export function createMessageRoutes(deps: {
  pageSize: (raw: string | null) => number | null | undefined;
  DEFAULT_PAGE: number;
  messagePage: (
    threadId: string,
    limit: number | undefined,
    before?: string | null,
  ) => {
    messages: (Message | Record<string, unknown>)[];
    hasMore?: boolean;
    activeLeafId?: string | null;
  };
  messageWindow: (threadId: string, messageId: string, limit: number) => {
    messages: (Message | Record<string, unknown>)[];
    hasMore: boolean;
  } | null;
  wireBot: BotViews["wireBot"];
  wireTask: BotViews["wireTask"];
  publicBotQueuedMessages: BotViews["publicBotQueuedMessages"];
  publicGroupState: (group: GroupRecord) => WireGroup;
  botComputerControlSnapshot: ComputerLifecycle["botComputerControlSnapshot"];
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, url } = rctx;
    let m: RegExpMatchArray | null = null;
    const {
      pageSize,
      DEFAULT_PAGE,
      messagePage,
      messageWindow,
      wireBot,
      wireTask,
      publicBotQueuedMessages,
      publicGroupState,
      botComputerControlSnapshot,
    } = deps;
    if (method === "GET" && path === "/api/bots") {
      const limit = pageSize(url.searchParams.get("messages"));
      if (limit === null) {
        json(res, 400, { error: "messages must be a non-negative whole number" });
        return true;
      }
      // wireBot(), not publicBot(): publicBot() pulls the whole transcript via
      // messagesFor() just to have it overwritten below by messagePage(),
      // which — for a bounded request — never needs the full transcript.
      // tasks stays explicit, because that is the one field publicBot() adds
      // that messagePage() does not: wireBot() omits the key entirely for a
      // bot record carrying no tasks, where publicBot() always sent [].
      json(res, 200, {
        bots: store.bots.map((bot) => ({
          ...wireBot(bot),
          tasks: store.tasks(bot.id).map(wireTask),
          ...messagePage(bot.threadId, limit),
        })),
        botQueuedMessages: publicBotQueuedMessages(),
        sections: store.sections,
        groups: store.groups.map((g) => ({ ...publicGroupState(g), ...messagePage(g.threadId, limit) })),
        computerControl: Object.fromEntries(
          store.bots.map((bot) => {
            const snapshot = botComputerControlSnapshot(bot.id);
            return [bot.id, { held: snapshot.held, helpReason: snapshot.helpReason }];
          }),
        ),
      });
      return true;
    }

    // scrollback: the page before a message the client already holds
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages$/);
    if (m && method === "GET") {
      const threadId = m[1];
      if (!store.botByThread(threadId) && !store.groupByThread(threadId)) {
        json(res, 404, { error: "no such conversation" });
        return true;
      }
      const limit = pageSize(url.searchParams.get("limit"));
      if (limit === null) {
        json(res, 400, { error: "limit must be a non-negative whole number" });
        return true;
      }
      const before = url.searchParams.get("before");
      const around = url.searchParams.get("around");
      if (before && around) {
        json(res, 400, { error: "before and around cannot be combined" });
        return true;
      }
      if (around) {
        const window = messageWindow(threadId, around, limit ?? DEFAULT_PAGE);
        if (!window) {
          json(res, 404, { error: "no such message" });
          return true;
        }
        json(res, 200, { ...window, activeLeafId: store.activeLeaf(threadId) });
        return true;
      }
      // An unknown cursor must not silently answer with the newest page —
      // the client would paginate in a circle and never reach the top.
      if (before && !store.messagesFor(threadId).some((msg) => msg.id === before)) {
        json(res, 404, { error: "no such message" });
        return true;
      }
      json(res, 200, { ...messagePage(threadId, limit ?? DEFAULT_PAGE, before), activeLeafId: store.activeLeaf(threadId) });
      return true;
    }

    // the pixels of one screen message, fetched only when something shows it
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/image$/);
    if (m && method === "GET") {
      // Same guard as the page route above, and for the same reason twice
      // over: an unknown id should 404 deliberately rather than by accident,
      // and `messagesFor` materialises and caches a ThreadState for whatever
      // it is handed. Without this, a client asking for images on ids that
      // do not exist grows the thread map for as long as it keeps asking.
      if (!store.botByThread(m[1]) && !store.groupByThread(m[1])) {
        json(res, 404, { error: "no such conversation" });
        return true;
      }
      const message = store.messagesFor(m[1]).find((msg) => msg.id === m![2]);
      if (!message?.png) {
        json(res, 404, { error: "no image on that message" });
        return true;
      }
      const bytes = Buffer.from(message.png, "base64");
      res.writeHead(200, {
        "content-type": message.mime ?? "image/png",
        "content-length": String(bytes.byteLength),
        // a settled message's image never changes
        "cache-control": "private, max-age=31536000, immutable",
      });
      res.end(bytes);
      return true;
    }

    // Download one local file only when this exact stored message grants it:
    // a bot must render a Markdown link or carry a generated-image attachment,
    // while a user message must carry the standalone composer tag. The bot
    // branch derives conversation/workspace roots; the user branch is limited
    // to OpenMausBot's private attachment directory. This is deliberately not
    // a general path reader.
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/file$/);
    const streamsMessageImage = Boolean(
      m && method === "GET" && url.searchParams.get("preview") === "1",
    );
    if (m && (method === "POST" || streamsMessageImage)) {
      if (method === "POST" && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        json(res, 415, { error: "content-type must be application/json" });
        return true;
      }
      const threadId = m[1]!;
      const directBot = store.botByThread(threadId);
      const group = directBot ? undefined : store.groupByThread(threadId);
      if (!directBot && !group) {
        json(res, 404, { error: "no such conversation" });
        return true;
      }

      const message = store.messagesFor(threadId).find((candidate) => candidate.id === m![2]);
      if (!message) {
        json(res, 404, { error: "no such message" });
        return true;
      }
      if (message.kind !== "text") {
        json(res, 403, { error: "that message does not share this file" });
        return true;
      }
      const body = method === "POST" ? await readBody(req) : null;
      const rawReference = streamsMessageImage ? url.searchParams.get("ref") : null;
      if (streamsMessageImage && (!rawReference || !/^\d+$/.test(rawReference))) {
        json(res, 400, { error: "ref must identify a rendered image" });
        return true;
      }
      const href = method === "POST"
        ? (typeof body.path === "string" ? body.path : "")
        : messageImageTargetAt(message.text ?? "", Number(rawReference));
      if (!href) {
        json(res, 400, { error: "path is required" });
        return true;
      }

      // Generated image paths are durable capabilities on this exact message.
      // They do not grant access to arbitrary workspace files or Markdown refs.
      const generatedImage = method === "POST" && message.role === "bot" &&
        message.attachments?.some((attachment) => attachment.kind === "image" && attachment.path === href) === true;
      let roots: string[];
      let downloadName: string | undefined;
      if (generatedImage) {
        roots = [ATTACHMENTS_DIR];
      } else if (message.role === "user") {
        downloadName = messageAttachmentName(message.text ?? "", href) ?? undefined;
        if (!downloadName) {
          json(res, 403, { error: "that message does not share this file" });
          return true;
        }
        roots = [ATTACHMENTS_DIR];
      } else {
        if (!messageReferencesFile(message.text ?? "", href)) {
          json(res, 403, { error: "that bot message does not link to this file" });
          return true;
        }
        const senderId = directBot?.id ?? message.from?.botId;
        // The persisted bot-role message is the author record. Membership is
        // intentionally not consulted: removing a bot must not break files it
        // already shared in channel history.
        if (!senderId) {
          json(res, 403, { error: "the file's bot author could not be verified" });
          return true;
        }
        let pinnedCwd: string | null | undefined;
        let configuredCwd: string | undefined;
        if (directBot) {
          pinnedCwd = store.taskByThread(directBot.id, threadId)?.cwd;
          configuredCwd = directBot.cwd;
        } else if (group) {
          const task = store.groupTaskByThread(group.id, threadId);
          pinnedCwd = task ? task.pinnedCwd : group.threadId === threadId ? group.pinnedCwd : undefined;
          configuredCwd = group.cwd;
        }

        roots = messageFileRoots({
          senderWorkspace: workspaceDir(senderId),
          attachments: ATTACHMENTS_DIR,
          pinnedCwd,
          configuredCwd,
        });
      }

      const file = await openMessageFile(href, roots);
      if ((streamsMessageImage || generatedImage) && !file.mime.startsWith("image/")) {
        await file.handle.close();
        json(res, 415, { error: "only images can be previewed here" });
        return true;
      }
      res.writeHead(200, {
        "content-type": file.mime,
        "content-length": String(file.bytes),
        ...(streamsMessageImage
          ? { "content-disposition": "inline" }
          : { "content-disposition": messageFileDisposition(messageFileDownloadName(downloadName, file.name)) }),
        "cache-control": streamsMessageImage ? "private, max-age=3600" : "private, no-store",
        "cdn-cache-control": "no-store",
        "cloudflare-cdn-cache-control": "no-store",
        pragma: "no-cache",
        vary: "Authorization",
        "x-content-type-options": "nosniff",
        ...(streamsMessageImage
          ? {
              "cross-origin-resource-policy": "same-origin",
              "referrer-policy": "no-referrer",
            }
          : {}),
      });
      if (file.bytes === 0) {
        await file.handle.close();
        res.end();
        return true;
      }
      const stream = file.handle.createReadStream({ start: 0, end: file.bytes - 1, autoClose: true });
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
      return true;
    }

    // ── image attachments ────────────────────────────────────────────────
    // Pasted/dropped images are stored as files and referenced by path in
    // the prompt (<attached-image path="…"/>); this pair of routes is the
    // save + serve. The POST takes raw bytes (base64 JSON would double the
    // payload), so it needs its own reader rather than readBody. A share
    // extension can add a UUID uploadId; retrying that UUID returns the same
    // committed path instead of creating an orphan duplicate.
    if (method === "POST" && path === "/api/attachments") {
      let uploadId: string | undefined;
      try {
        uploadId = validateAttachmentUploadId(url.searchParams.get("uploadId") ?? undefined);
      } catch (error) {
        req.resume();
        throw error;
      }
      const rawType = Array.isArray(req.headers["content-type"]) ? req.headers["content-type"][0] : req.headers["content-type"];
      const mime = rawType?.split(";")[0]?.trim().toLowerCase();
      if (!mime || !extensionForMime(mime)) {
        json(res, 400, { error: "content-type must be an image type" });
        return true;
      }
      const rawLength = Array.isArray(req.headers["content-length"])
        ? req.headers["content-length"][0]
        : req.headers["content-length"];
      const declaredLength = rawLength === undefined ? undefined : Number(rawLength);
      if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
        req.resume();
        json(res, 400, { error: "content-length must be a non-negative integer" });
        return true;
      }
      if (declaredLength !== undefined && declaredLength > IMAGE_MAX_BYTES) {
        req.resume();
        json(res, 413, { error: `image exceeds ${IMAGE_MAX_BYTES} bytes` });
        return true;
      }
      const saved = await new Promise<SavedAttachment>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let settled = false;
        const fail = (status: number, msg: string) => {
          if (settled) return;
          settled = true;
          reject(Object.assign(new Error(msg), { status }));
        };
        req.on("data", (chunk: Buffer) => {
          if (settled) return;
          received += chunk.byteLength;
          if (received > IMAGE_MAX_BYTES) return fail(413, `image exceeds ${IMAGE_MAX_BYTES} bytes`);
          chunks.push(chunk);
        });
        req.on("end", async () => {
          if (settled) return;
          settled = true;
          try {
            resolve(await saveImageUpload(Buffer.concat(chunks), mime, uploadId));
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
        req.on("error", (e) => fail(400, e instanceof Error ? e.message : String(e)));
      });
      json(res, 201, saved);
      return true;
    }

    // ── shared files ────────────────────────────────────────────────────
    // Companion apps and the desktop composer send documents as raw bytes
    // over the same authenticated connection as messages. saveFile writes each
    // incoming chunk directly to disk, atomically commits it, and removes
    // partial uploads on error. Its optional UUID uploadId is stable across
    // route retries, while the aggregate store quota rejects rather than
    // silently deleting files that old prompts may still reference.
    if (method === "POST" && path === "/api/files") {
      let uploadId: string | undefined;
      try {
        uploadId = validateAttachmentUploadId(url.searchParams.get("uploadId") ?? undefined);
      } catch (error) {
        req.resume();
        throw error;
      }
      const name = url.searchParams.get("name");
      if (!name) {
        req.resume();
        json(res, 400, { error: "name is required" });
        return true;
      }
      const rawType = Array.isArray(req.headers["content-type"])
        ? req.headers["content-type"][0]
        : req.headers["content-type"];
      const rawLength = Array.isArray(req.headers["content-length"])
        ? req.headers["content-length"][0]
        : req.headers["content-length"];
      const declaredLength = rawLength === undefined ? undefined : Number(rawLength);
      if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
        req.resume();
        json(res, 400, { error: "content-length must be a non-negative integer" });
        return true;
      }
      if (declaredLength !== undefined && declaredLength > FILE_MAX_BYTES) {
        req.resume();
        json(res, 413, { error: `file exceeds ${FILE_MAX_BYTES} bytes` });
        return true;
      }
      try {
        // Returning from this iterator must not destroy the request socket:
        // the caller still needs to receive the useful 4xx response when the
        // streamed byte count crosses the limit.
        const chunks = req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>;
        const saved = await saveFile(chunks, name, rawType ?? "", { uploadId, expectedBytes: declaredLength });
        json(res, 201, saved);
        return true;
      } catch (error) {
        req.resume();
        throw error;
      }
    }

    // serving is name-locked to the attachments dir — readAttachment
    // refuses anything that is not a bare generated filename
    m = path.match(/^\/api\/attachments\/([\w.-]+)$/);
    if (m && method === "GET") {
      const attachment = readAttachment(m[1]!);
      if (!attachment) {
        json(res, 404, { error: "no such attachment" });
        return true;
      }
      res.writeHead(200, {
        "content-type": attachment.mime,
        "content-length": String(attachment.bytes.byteLength),
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      });
      res.end(attachment.bytes);
      return true;
    }

    // ── search across every transcript ──────────────────────────────────
    // A LIKE scan over the SQLite message store: local transcripts are
    // megabytes at most, so a scan answers in milliseconds and needs no
    // index to maintain. Hits resolve to the bot/room that owns the thread;
    // rows belonging to deleted conversations resolve to nothing and drop.
    if (await handleSearch(req, res, rctx)) return true;

    // ── transcript export (the visible branch, human-readable) ──────────
    m = path.match(/^\/api\/threads\/([\w-]+)\/export$/);
    if (m && method === "GET") {
      const threadId = m[1];
      const bot = store.botByThread(threadId);
      const group = bot ? undefined : store.groupByThread(threadId);
      if (!bot && !group) {
        json(res, 404, { error: "no such conversation" });
        return true;
      }
      const format = url.searchParams.get("format") ?? "markdown";
      if (format !== "markdown" && format !== "json") {
        json(res, 400, { error: "format must be markdown or json" });
        return true;
      }
      const title = bot
        ? (store.taskByThread(bot.id, threadId)?.title || bot.name)
        : (store.groupTaskByThread(group!.id, threadId)?.title || group!.name);
      const filename = (title.replace(/[^\w\- ]+/g, "").trim() || "conversation").slice(0, 60);
      const messages = store.activePath(threadId);
      if (format === "json") {
        // pixels stripped — an export is for reading and archiving, and a
        // base64 desktop frame is neither
        const slim = messages.map(({ png: _png, mime: _mime, ...rest }) => rest);
        res.writeHead(200, {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="${filename}.json"`,
        });
        res.end(JSON.stringify({ name: title, threadId, messages: slim }, null, 2));
        return true;
      }
      const userName = cfg.profile?.name?.trim() || "User";
      const lines: string[] = [`# ${title}`, ""];
      for (const msg of messages) {
        const who = msg.role === "user"
          ? msg.via === "api" ? `${userName} (via the local API)` : userName
          : (msg.from?.name ?? bot?.name ?? "Bot");
        if (msg.kind === "text" && msg.text) lines.push(`**${who}:**`, "", msg.text, "");
        else if (msg.kind === "activity" && msg.tool) lines.push(`> ${msg.tool.name}`, "");
        else if (msg.kind === "screen") lines.push("> [screen capture]", "");
        else if (msg.kind === "options" && msg.card) {
          lines.push(`> ${msg.card.title}${msg.card.answered ? ` — answered: ${msg.card.answered}` : ""}`, "");
        }
      }
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}.md"`,
      });
      res.end(lines.join("\n"));
      return true;
    }
    return false;
  };
}
