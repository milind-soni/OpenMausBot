import type { WireBot, WireGroup } from "../../shared/wire.ts";
import {
  ATTACHMENTS_DIR, extensionForMime, FILE_MAX_BYTES, IMAGE_MAX_BYTES, parseAudioRange, readAttachment, saveFile, saveImageUpload,
  validateAttachmentUploadId, type SavedAttachment,
} from "../attachments.ts";
import { deliveredCopy } from "../bot-attachment.ts";
import { memberBot, memberGroup, type Viewer, type VisibleSet } from "../bot-visibility.ts";
import type { ComputerControl } from "../computer-control.ts";
import { speakerOf, type PersonName } from "../replies.ts";
import type { Coordinator } from "../coordinator.ts";
import type { WorkspaceAccess } from "../enterprise.ts";
import type { GroupUsageReader } from "../group-thread-usage.ts";
import { searchMessagesAsync } from "../message-db.ts";
import {
  listMessageFolder, messageAttachmentName, messageFileDisposition, messageFileDownloadName, messageFolderEntryName,
  messageImageTargetAt, messageReferencesFile, openMessageFile, openMessageFolderEntry, referencedFileName,
} from "../message-file.ts";
import { resolveRequestAuth, type RequestAuth, type ResolveOptions } from "../request-auth.ts";
import type { queuedSteerSnapshot } from "../steer-queue.ts";
import type { BotRecord, GroupRecord, Message, Store } from "../store.ts";
import { createJobRoutes } from "./jobs.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export type MessagePage = { messages: Array<Message | Record<string, unknown>>; hasMore?: boolean; activeLeafId: string | null };

export interface ThreadRouteDeps {
  store: Pick<Store,
    | "activeLeaf" | "activePath" | "bot" | "botByThread" | "bots" | "groupByThread" | "groupTaskByThread" | "groups" | "messagesFor"
    | "onChange" | "sections" | "taskByThread" | "tasks">;
  coordinator: Pick<Coordinator, "job">;
  groupThreadIsWorking(groupId: string, threadId: string): boolean;
  /** What people's lines are called in this conversation (replies.ts PersonName). */
  userName(threadId: string): PersonName;
  sessions: ResolveOptions["sessions"];
  groupUsageReader: Pick<GroupUsageReader, "refresh">;
  hostedWorkspace: boolean;
  sessionCookie: string;
  loopback: { trust: ResolveOptions["loopbackTrust"]; localBrowsers: boolean };
  lendingEnabled(): boolean;
  workspaceAccess(): WorkspaceAccess | null;
  desktopMutationToken(): string | undefined;
  companionMutationToken(): string | undefined;
  cliOwnerToken(): string | undefined;
  defaultPage: number;
  pageSize(raw: string | null): number | null | undefined;
  messagePage(threadId: string, limit: number | undefined, before?: string | null): MessagePage;
  messageWindow(threadId: string, messageId: string, limit: number): { messages: Array<Message | Record<string, unknown>>; hasMore: boolean } | null;
  publicBotQueuedMessages(): ReturnType<typeof queuedSteerSnapshot>;
  publicGroupState(record: GroupRecord): WireGroup;
  wireBot(bot: BotRecord): WireBot;
  botComputerControlSnapshot(botId: string): ReturnType<ComputerControl["snapshot"]>;
  messageFileRootsForThread(senderId: string, threadId: string): string[];
  viewerFor(auth: RequestAuth): Viewer;
  visibleTo(viewer: Viewer): VisibleSet;
  /** A Team Cloud: gives a member their own MausBot once, before their first list of bots. */
  memberDefaultBot?(email: string): unknown;
}

export function createThreadRoutes(deps: ThreadRouteDeps): RouteHandler {
  const {
    store, userName: userNameFor, sessions, groupUsageReader, lendingEnabled,
    hostedWorkspace: HOSTED_WORKSPACE, sessionCookie: SESSION_COOKIE, loopback: LOOPBACK, defaultPage: DEFAULT_PAGE,
    pageSize, messagePage, messageWindow, publicBotQueuedMessages, publicGroupState, wireBot,
    botComputerControlSnapshot, messageFileRootsForThread, viewerFor, visibleTo,
  } = deps;
  const jobs = createJobRoutes({ store, coordinator: deps.coordinator, groupThreadIsWorking: deps.groupThreadIsWorking, viewerFor, visibleTo, sessions });
  const handle = async ({ req, res, url, path, method, auth, json, readBody }: RouteContext): Promise<unknown> => {
    let m: RegExpMatchArray | null = null;
    const member = auth.kind === "session" && auth.session.membershipAuthority === "team" ? auth.session.email : undefined;
    if (member && method === "GET" && path === "/api/bots") deps.memberDefaultBot?.(member);
    const visible = visibleTo(viewerFor(auth));
    const workspaceAccess = deps.workspaceAccess();
    const desktopMutationToken = deps.desktopMutationToken();
    const companionMutationToken = deps.companionMutationToken();
    const cliOwnerToken = deps.cliOwnerToken();
    if (method === "GET" && path === "/api/bots") {
      try { groupUsageReader.refresh(); } catch { }
      const limit = pageSize(url.searchParams.get("messages"));
      if (limit === null) return json(res, 400, { error: "messages must be a non-negative whole number" });
      // tasks stays explicit: clients expect [] where wireBot() would omit the key.
      const shownBots = store.bots.filter((bot) => visible.bot(bot.id));
      const queued = publicBotQueuedMessages();
      return json(res, 200, {
        bots: shownBots.map((bot) => {
          const wired = wireBot(bot);
          // Narrowed first: on a Team Cloud the selected conversation may be someone else's, and its words never go out.
          const shown = memberBot({ ...wired, tasks: wired.tasks ?? [] }, visible);
          return { ...shown, ...(typeof shown.threadId === "string" ? messagePage(shown.threadId, limit) : { messages: [], hasMore: false, activeLeafId: null }) };
        }),
        botQueuedMessages: visible.everything ? queued : Object.fromEntries(Object.entries(queued).filter(([threadId]) => visible.thread(threadId))),
        sections: visible.sections(store.sections),
        groups: store.groups.filter((g) => visible.group(g.id)).map((g) => {
          const room = { ...publicGroupState(g), ...messagePage(g.threadId, limit) };
          return visible.everything || !visible.member ? room : memberGroup(room);
        }),
        computerControl: Object.fromEntries(
          shownBots.map((bot) => {
            const snapshot = botComputerControlSnapshot(bot.id);
            // A plea from someone else's private chat (a Team Cloud) names its site and reason: held is all that is shared.
            if (snapshot.help && visible.hides(snapshot.help.threadId)) return [bot.id, { held: snapshot.held, helpReason: null }];
            return [bot.id, { held: snapshot.held, helpReason: snapshot.helpReason, ...(snapshot.help ? { help: snapshot.help } : {}) }];
          }),
        ),
      });
    }

    m = path.match(/^\/api\/threads\/([\w-]+)\/messages$/);
    if (m && method === "GET") {
      const threadId = m[1];
      if (!store.botByThread(threadId) && !store.groupByThread(threadId)) {
        return json(res, 404, { error: "no such conversation" });
      }
      const limit = pageSize(url.searchParams.get("limit"));
      if (limit === null) return json(res, 400, { error: "limit must be a non-negative whole number" });
      const before = url.searchParams.get("before");
      const around = url.searchParams.get("around");
      if (before && around) return json(res, 400, { error: "before and around cannot be combined" });
      if (around) {
        const window = messageWindow(threadId, around, limit ?? DEFAULT_PAGE);
        if (!window) return json(res, 404, { error: "no such message" });
        return json(res, 200, { ...window, activeLeafId: store.activeLeaf(threadId) });
      }
      // An unknown cursor must not answer with the newest page: the client would paginate in a circle.
      if (before && !store.messagesFor(threadId).some((msg) => msg.id === before)) {
        return json(res, 404, { error: "no such message" });
      }
      return json(res, 200, { ...messagePage(threadId, limit ?? DEFAULT_PAGE, before), activeLeafId: store.activeLeaf(threadId) });
    }

    m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/image$/);
    if (m && method === "GET") {
      // messagesFor caches a ThreadState for any id it is handed, so unknown ids 404 first.
      if (!store.botByThread(m[1]) && !store.groupByThread(m[1])) {
        return json(res, 404, { error: "no such conversation" });
      }
      const message = store.messagesFor(m[1]).find((msg) => msg.id === m![2]);
      if (!message?.png) return json(res, 404, { error: "no image on that message" });
      const bytes = Buffer.from(message.png, "base64");
      res.writeHead(200, {
        "content-type": message.mime ?? "image/png",
        "content-length": String(bytes.byteLength),
        "cache-control": "private, no-store",
      });
      return res.end(bytes);
    }

    // Only a file this exact stored message grants; deliberately not a general path reader.
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/file$/);
    const streamsMessageImage = Boolean(
      m && method === "GET" && url.searchParams.get("preview") === "1",
    );
    if (m && (method === "POST" || streamsMessageImage)) {
      if (method === "POST" && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const threadId = m[1]!;
      const directBot = store.botByThread(threadId);
      const group = directBot ? undefined : store.groupByThread(threadId);
      if (!directBot && !group) return json(res, 404, { error: "no such conversation" });

      const message = store.messagesFor(threadId).find((candidate) => candidate.id === m![2]);
      if (!message) return json(res, 404, { error: "no such message" });
      if (message.kind !== "text" || (!message.text && !message.attachments?.length)) {
        return json(res, 403, { error: "that message does not share this file" });
      }
      const messageText = message.text ?? "";
      const body = method === "POST" ? await readBody(req) : null;
      const rawReference = streamsMessageImage ? url.searchParams.get("ref") : null;
      if (streamsMessageImage && (!rawReference || !/^\d+$/.test(rawReference))) {
        return json(res, 400, { error: "ref must identify a rendered image" });
      }
      const href = method === "POST"
        ? (typeof body.path === "string" ? body.path : "")
        : messageImageTargetAt(messageText, Number(rawReference));
      if (!href) return json(res, 400, { error: "path is required" });

      let roots: string[];
      let downloadName: string | undefined;
      const botAttachment = message.role === "bot"
        ? message.attachments?.find((attachment) => attachment.path === href)
        : undefined;
      if (message.role === "user") {
        downloadName = messageAttachmentName(messageText, href) ?? undefined;
        if (!downloadName) {
          return json(res, 403, { error: "that message does not share this file" });
        }
        roots = [ATTACHMENTS_DIR];
      } else if (botAttachment) {
        downloadName = botAttachment.kind === "file" ? botAttachment.name : undefined;
        roots = [ATTACHMENTS_DIR];
      } else {
        if (!messageReferencesFile(messageText, href)) {
          return json(res, 403, { error: "that bot message does not link to this file" });
        }
        const senderId = directBot?.id ?? message.from?.botId;
        // Membership is not consulted: removing a bot must not break files it already shared.
        if (!senderId) {
          return json(res, 403, { error: "the file's bot author could not be verified" });
        }
        const runThread = message.automation?.executionThreadId;
        const fromRun = runThread && store.botByThread(runThread)?.id === senderId ? messageFileRootsForThread(senderId, runThread) : [];
        roots = [...new Set([...messageFileRootsForThread(senderId, threadId), ...fromRun])];
      }

      const folderEntry = method === "POST" && body.entry !== undefined
        ? messageFolderEntryName(body.entry)
        : undefined;
      if (folderEntry === null) return json(res, 400, { error: "entry must be one file name" });
      let file: Awaited<ReturnType<typeof openMessageFile>>;
      try {
        file = folderEntry
          ? await openMessageFolderEntry(href, folderEntry, roots)
          : await openMessageFile(href, roots);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        const status = (error as { status?: unknown } | null)?.status;
        const name = message.role === "bot" && !botAttachment && !folderEntry && (code === "outside_workspace" || status === 404)
          ? referencedFileName(href)
          : null;
        const copy = name ? deliveredCopy(store.messagesFor(threadId), message, name) : null;
        if (copy) {
          file = await openMessageFile(copy.path, [ATTACHMENTS_DIR]);
          downloadName = copy.name;
        } else {
          // Only a client that asks for listings gets one; older clients keep the 400.
          if (body?.listFolder !== true || folderEntry || code !== "directory") throw error;
          const listing = await listMessageFolder(href, roots);
          res.setHeader("x-openmausbot-folder", "1");
          res.setHeader("cache-control", "private, no-store");
          return json(res, 200, listing);
        }
      }
      if ((streamsMessageImage || botAttachment?.kind === "image") && !file.mime.startsWith("image/")) {
        await file.handle.close();
        return json(res, 415, { error: "only images can be previewed here" });
      }
      res.writeHead(200, {
        "content-type": file.mime,
        "content-length": String(file.bytes),
        ...(streamsMessageImage
          ? { "content-disposition": "inline" }
          : { "content-disposition": messageFileDisposition(messageFileDownloadName(downloadName, file.name)) }),
        "cache-control": "private, no-store",
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
        return res.end();
      }
      const stream = file.handle.createReadStream({ start: 0, end: file.bytes - 1, autoClose: true });
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
      return;
    }

    // Raw bytes, not base64 JSON; retrying a UUID uploadId returns the same committed path.
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
        return json(res, 400, { error: "content-type must be an image type" });
      }
      const rawLength = Array.isArray(req.headers["content-length"])
        ? req.headers["content-length"][0]
        : req.headers["content-length"];
      const declaredLength = rawLength === undefined ? undefined : Number(rawLength);
      if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
        req.resume();
        return json(res, 400, { error: "content-length must be a non-negative integer" });
      }
      if (declaredLength !== undefined && declaredLength > IMAGE_MAX_BYTES) {
        req.resume();
        return json(res, 413, { error: `image exceeds ${IMAGE_MAX_BYTES} bytes` });
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
      return json(res, 201, saved);
    }

    // Raw bytes; a UUID uploadId is stable across retries, and the quota rejects rather than delete files old prompts reference.
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
        return json(res, 400, { error: "name is required" });
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
        return json(res, 400, { error: "content-length must be a non-negative integer" });
      }
      if (declaredLength !== undefined && declaredLength > FILE_MAX_BYTES) {
        req.resume();
        return json(res, 413, { error: `file exceeds ${FILE_MAX_BYTES} bytes` });
      }
      try {
        // Returning must not destroy the socket: the caller still sends the 4xx when the byte count crosses the limit.
        const chunks = req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>;
        const saved = await saveFile(chunks, name, rawType ?? "", { uploadId, expectedBytes: declaredLength });
        return json(res, 201, saved);
      } catch (error) {
        req.resume();
        throw error;
      }
    }

    // Name-locked to the attachments dir: readAttachment refuses anything but a bare generated filename.
    m = path.match(/^\/api\/attachments\/([\w.-]+)$/);
    if (m && method === "GET") {
      const attachment = readAttachment(m[1]!);
      if (!attachment) return json(res, 404, { error: "no such attachment" });
      const size = attachment.bytes.byteLength;
      // Visibility is decided per request, so the browser must never reuse one member's copy for another identity.
      const headers = {
        "content-type": attachment.mime,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      };
      if (attachment.mime.startsWith("audio/")) {
        const rawRange = Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range;
        const range = parseAudioRange(rawRange, size);
        if (range.kind === "unsatisfiable") {
          res.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
          return res.end();
        }
        if (range.kind === "range") {
          res.writeHead(206, {
            ...headers,
            "content-length": String(range.end - range.start + 1),
            "content-range": `bytes ${range.start}-${range.end}/${size}`,
          });
          return res.end(attachment.bytes.subarray(range.start, range.end + 1));
        }
      }
      res.writeHead(200, { ...headers, "content-length": String(size) });
      return res.end(attachment.bytes);
    }

    if (method === "GET" && path === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit ? Math.min(Math.max(Number(rawLimit) || 0, 1), 100) : 40;
      const threadId = url.searchParams.get("threadId")?.trim() || undefined;
      if (threadId && ((!store.botByThread(threadId) && !store.groupByThread(threadId)) || !visible.thread(threadId))) {
        return json(res, 404, { error: "no such conversation" });
      }
      const activePaths = new Map<string, Set<string>>();
      const onActivePath = (threadId: string, messageId: string) => {
        let ids = activePaths.get(threadId);
        if (!ids) activePaths.set(threadId, (ids = new Set(store.activePath(threadId).map((m) => m.id))));
        return ids.has(messageId);
      };
      const found = await searchMessagesAsync(q, visible.everything ? limit : Math.min(limit * 10, 1_000), threadId);
      // A scan may outlive a revocation or audience edit: authorize again after the await.
      if (HOSTED_WORKSPACE && auth.kind === "session") {
        const failure = workspaceAccess ? await workspaceAccess.authorize(req, auth)
          : { status: 503, error: "Workspace sign-in is unavailable." };
        if (failure) return json(res, failure.status, { error: failure.error });
      }
      const current = resolveRequestAuth(req, {
        sessions, cookieName: SESSION_COOKIE, streamPath: "/api/events", url,
        loopbackMutationToken: desktopMutationToken, companionMutationToken,
        features: { sharedComputers: lendingEnabled() }, loopbackTrust: LOOPBACK.trust, cliOwnerToken, trustLocalBrowser: LOOPBACK.localBrowsers,
      });
      if (!current.auth) return json(res, current.status, { error: current.error });
      const currentVisible = visibleTo(viewerFor(current.auth));
      if (threadId && !currentVisible.thread(threadId)) return json(res, 404, { error: "no such conversation" });
      const hits = found
        .filter((hit) => currentVisible.thread(hit.threadId))
        .slice(0, limit)
        .map((hit) => {
          const bot = store.botByThread(hit.threadId);
          const group = bot ? undefined : store.groupByThread(hit.threadId);
          if (!bot && !group) return null;
          const active = onActivePath(hit.threadId, hit.messageId);
          if (bot) {
            const task = store.taskByThread(bot.id, hit.threadId);
            return { ...hit, botId: bot.id, name: bot.name, task: task?.title, onActivePath: active };
          }
          if (group) {
            const task = store.groupTaskByThread(group.id, hit.threadId);
            return { ...hit, groupId: group.id, name: group.name, task: task?.title, onActivePath: active };
          }
          return null;
        })
        .filter((hit): hit is NonNullable<typeof hit> => hit !== null);
      return json(res, 200, { hits });
    }

    m = path.match(/^\/api\/threads\/([\w-]+)\/export$/);
    if (m && method === "GET") {
      const threadId = m[1];
      const bot = store.botByThread(threadId);
      const group = bot ? undefined : store.groupByThread(threadId);
      if (!bot && !group) return json(res, 404, { error: "no such conversation" });
      const format = url.searchParams.get("format") ?? "markdown";
      if (format !== "markdown" && format !== "json") {
        return json(res, 400, { error: "format must be markdown or json" });
      }
      const title = bot
        ? (store.taskByThread(bot.id, threadId)?.title || bot.name)
        : (store.groupTaskByThread(group!.id, threadId)?.title || group!.name);
      const filename = (title.replace(/[^\w\- ]+/g, "").trim() || "conversation").slice(0, 60);
      const messages = store.activePath(threadId);
      if (format === "json") {
        const slim = messages.map(({ png: _png, mime: _mime, ...rest }) => rest);
        res.writeHead(200, {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="${filename}.json"`,
        });
        return res.end(JSON.stringify({ name: title, threadId, messages: slim }, null, 2));
      }
      const userName = userNameFor(threadId);
      const lines: string[] = [`# ${title}`, ""];
      for (const msg of messages) {
        const sentBy = speakerOf(userName, msg);
        const who = msg.role === "user"
          ? msg.via === "api" ? `${sentBy} (via the local API)` : sentBy
          : (msg.from?.name ?? bot?.name ?? "Bot");
        if ((msg.kind === "text" || msg.kind === "widget" || msg.kind === "app") && msg.text) lines.push(`**${who}:**`, "", msg.text, "");
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
      return res.end(lines.join("\n"));
    }
    return PASS;
  };
  return async (ctx) => (await jobs(ctx) !== PASS || await handle(ctx) !== PASS ? undefined : PASS);
}
