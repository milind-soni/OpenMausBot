// Templates over HTTP (the department Share modal, the chat card, Import) and behind the bots' `share` tool.
import type { ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { PackageFormatError } from "../../shared/package-format.ts";
import type { TemplateCard } from "../../shared/share-card.ts";
import { readShareFolder, SHARE_FOLDER_MAX_BYTES, type ShareFolder, type ShareFolderFiles } from "../../shared/share-folder.ts";
import type { WireBot, WireGroup } from "../../shared/wire.ts";
import type { json as sendJson } from "../harness/http.ts";
import { PackageImportError, importPackageDocument, importTeamManifest, type PackageImportDeps, type PackageImportResult } from "../package-import.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Routine } from "../routines.ts";
import { fetchGithubTemplate, GithubTemplateError } from "../share-github.ts";
import { cardText, readFolderFromDisk, ShareError, type ShareHost } from "../share.ts";
import { zipFolder } from "../share-zip.ts";
import type { BotRecord, GroupRecord } from "../store.ts";
import { parseTeamManifest } from "../team-manifest.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ShareRouteDeps {
  host: ShareHost;
  /** The bots and routines this request's person may see. */
  bots(auth: RequestAuth): readonly BotRecord[];
  routines(auth: RequestAuth): readonly Routine[];
  /** True on a desktop's own server: folders on this computer may be read and written. */
  localFolders: boolean;
  importDeps(auth: RequestAuth | null): Promise<PackageImportDeps>;
  publicBot(bot: BotRecord): WireBot;
  publicGroup(group: GroupRecord): WireGroup;
  broadcast(payload: Record<string, unknown>): void;
  fetchTemplate?: typeof fetchGithubTemplate;
}

export type ImportSource = { url: string } | { path: string } | { files: ShareFolderFiles };

/** Words for an untrusted folder's refusal: the format's own sentence, else a plain one. */
function refusal(error: unknown): { status: number; error: string } | null {
  if (error instanceof ShareError || error instanceof GithubTemplateError) return { status: error.status, error: error.message };
  if (error instanceof PackageFormatError) return { status: error.code === "too_large" ? 413 : 400, error: error.message };
  if (error instanceof PackageImportError) return { status: error.status, error: error.message };
  return null;
}

/** `{url}`, `{path}` or `{files}`: exactly one, each checked for shape before anything is read. */
export function importSource(body: unknown): ImportSource | string {
  const value = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const given = ["url", "path", "files"].filter((key) => value[key] !== undefined);
  if (given.length !== 1) return "Paste a GitHub link or choose a folder.";
  if (typeof value.url === "string") return value.url.trim() ? { url: value.url.trim().slice(0, 2_000) } : "Paste a GitHub link or choose a folder.";
  if (typeof value.path === "string") return isAbsolute(value.path) ? { path: value.path } : "Choose a folder on this computer.";
  const files = value.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) return "Paste a GitHub link or choose a folder.";
  const out: ShareFolderFiles = {};
  let total = 0;
  for (const [path, text] of Object.entries(files as Record<string, unknown>)) {
    if (typeof text !== "string") return "This folder couldn't be read.";
    total += text.length;
    if (total > SHARE_FOLDER_MAX_BYTES * 1.4) return "This folder is larger than 4 MB.";
    out[path] = text;
  }
  return { files: out };
}

export async function readImport(source: ImportSource, localFolders: boolean, fetchTemplate = fetchGithubTemplate): Promise<ShareFolder> {
  if ("url" in source) return fetchTemplate(source.url);
  if ("path" in source) {
    if (!localFolders) throw new ShareError("Folders on this computer can only be imported in the desktop app.", 403);
    return readShareFolder(readFolderFromDisk(source.path));
  }
  return readShareFolder(source.files);
}

/** Adds a template's bots alongside everything here: a bot template joins no department, a department arrives as a
 * new one. The answer has the shape `/api/teams/import` has, plus how many apps wait to be connected. */
export function addTemplate(folder: ShareFolder, deps: PackageImportDeps, view: Pick<ShareRouteDeps, "publicBot" | "publicGroup" | "broadcast">) {
  let imported: PackageImportResult;
  let apps = 0;
  if (folder.kind === "package") {
    const result = importPackageDocument(folder.document, { trust: "file", mode: "add", ...(folder.scope === "bot" ? { noDepartment: true } : {}) }, deps);
    if (result.alreadyAdded) throw new ShareError("This template is already added.", 409);
    imported = result;
    apps = folder.document.package.requirements.apps.length + (folder.document.package.connections?.length ?? 0);
  } else {
    let manifest;
    try {
      manifest = parseTeamManifest(folder.manifest as Parameters<typeof parseTeamManifest>[0]);
    } catch (error) {
      throw new ShareError(error instanceof Error ? error.message : "This folder has no bot.md or team.md.");
    }
    imported = importTeamManifest(manifest, { mode: "add" }, deps);
  }
  const bots = imported.bots.map((bot) => view.publicBot(deps.store.bot(bot.id) ?? bot));
  const groups = imported.groups.map((group) => ({ ...view.publicGroup(deps.store.group(group.id) ?? group), messages: [] }));
  for (const bot of bots) view.broadcast({ kind: "bot", bot });
  for (const group of groups) view.broadcast({ kind: "group", group });
  return {
    name: imported.name, section: imported.section, bots, groups, routines: imported.routines, offeredSkills: imported.offeredSkills,
    connections: imported.connections, skipped: imported.skipped, brief: imported.brief, appsToConnect: apps,
  };
}

const TEMPLATE_PATH = /^\/api\/share\/([a-f0-9]{16})(\/publish|\/save|\/download)?$/;

export function createShareRoutes(deps: ShareRouteDeps): RouteHandler {
  const { host } = deps;
  const answer = (res: ServerResponse, json: typeof sendJson, error: unknown) => {
    const known = refusal(error);
    if (!known) throw error;
    return json(res, known.status, { error: known.error });
  };
  const mayOpen = (auth: RequestAuth, id: string) => {
    const record = host.record(id);
    return Boolean(record) && (record!.botId === undefined || deps.bots(auth).some((bot) => bot.id === record!.botId));
  };
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (method === "POST" && path === "/api/share/export") {
      const body = await readBody(req) as Record<string, unknown>;
      const bots = deps.bots(auth);
      try {
        if (typeof body?.botId === "string") {
          const bot = bots.find((each) => each.id === body.botId && !each.hidden);
          if (!bot) return json(res, 404, { error: "That bot no longer exists." });
          return json(res, 201, host.export({ scope: "bot", bot }, deps.routines(auth)).card);
        }
        if (typeof body?.department !== "string" || !body.department.trim()) return json(res, 400, { error: "Choose a department to share." });
        const section = body.department.trim();
        return json(res, 201, host.export({ scope: "department", section, bots }, deps.routines(auth)).card);
      } catch (error) {
        return answer(res, json, error);
      }
    }
    if (method === "POST" && path === "/api/share/import") {
      const source = importSource(await readBody(req, SHARE_FOLDER_MAX_BYTES * 2));
      if (typeof source === "string") return json(res, 400, { error: source });
      try {
        const folder = await readImport(source, deps.localFolders, deps.fetchTemplate);
        if (url.searchParams.get("preview") === "1") return json(res, 200, { details: host.preview(folder) });
        return json(res, 201, addTemplate(folder, await deps.importDeps(auth), deps));
      } catch (error) {
        return answer(res, json, error);
      }
    }
    const m = path.match(TEMPLATE_PATH);
    if (!m) return PASS;
    const id = m[1]!;
    if (!mayOpen(auth, id)) return json(res, 404, { error: "This template was deleted." });
    try {
      if (method === "GET" && !m[2]) return json(res, 200, host.get(id));
      if (method === "DELETE" && !m[2]) {
        host.delete(id);
        return json(res, 200, { ok: true });
      }
      if (method === "POST" && m[2] === "/publish") return json(res, 200, await host.publish(id));
      if (method === "POST" && m[2] === "/save") {
        if (!deps.localFolders) return json(res, 403, { error: "Saving to a folder works in the desktop app. Download the template instead." });
        const body = await readBody(req) as Record<string, unknown>;
        if (typeof body?.path !== "string") return json(res, 400, { error: "Choose a folder to save the template in." });
        return json(res, 200, { path: host.saveTo(id, body.path) });
      }
      if (method === "GET" && m[2] === "/download") {
        const { slug, files } = host.files(id);
        const zip = zipFolder(slug, files);
        res.writeHead(200, { "content-type": "application/zip", "content-length": zip.length, "content-disposition": `attachment; filename="${slug}.zip"`, "cache-control": "no-store" });
        res.end(zip);
        return;
      }
    } catch (error) {
      return answer(res, json, error);
    }
    return PASS;
  };
}

export interface ShareToolContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  readBody: () => Promise<unknown>;
  bot: BotRecord;
  threadId: string;
  /** The person's own message that started this turn; null when a person didn't start it. */
  personMessage: string | null;
  /** Folders the bot may read; a folder path it imports from must be inside one, unless this is a desktop. */
  roots: readonly string[];
  /** Puts a card in this conversation; its message id, or null when the conversation is gone. */
  post(text: string, card: TemplateCard): string | null;
}

function within(root: string, path: string): boolean {
  try {
    const rel = relative(realpathSync(root), realpathSync(resolve(path)));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return false;
  }
}

const PRIVATE_DETAILS = "Before anyone publishes it, read the files and take out anything personal: people's names, emails, phone numbers, client names, private links or facts only this person should know. Keep the instructions general. Edit the files in that folder directly; Publish re-reads them.";

/** The `share` tool. Import needs the link or path in the person's own message this turn, so text the bot read
 * elsewhere (a web page, an email) can't make it add bots. */
export function createShareToolRoute(deps: Omit<ShareRouteDeps, "bots"> & { bots(): readonly BotRecord[]; routines(): readonly Routine[]; importDeps(auth: null): Promise<PackageImportDeps> }) {
  const { host } = deps;
  const shown = (ctx: ShareToolContext, card: TemplateCard) => {
    const messageId = ctx.post(cardText(card), card);
    if (messageId) host.shown(card.id, ctx.threadId, messageId);
  };
  return async (ctx: ShareToolContext): Promise<typeof PASS | void> => {
    if (ctx.method !== "POST" || ctx.path !== "/api/internal/share") return PASS;
    const body = (await ctx.readBody() ?? {}) as Record<string, unknown>;
    const reply = (status: number, text: string) => ctx.json(ctx.res, status, status < 300 ? { text } : { error: text });
    const department = body.department === true;
    const section = ctx.bot.section?.trim() ?? "";
    if (department && (!ctx.bot.chiefOfStaff || !section)) return reply(403, "Only a department's Chief of Staff can share the department. Share yourself instead, or ask the person to use the department's Share.");
    try {
      if (body.action === "export") {
        const target = department ? { scope: "department" as const, section, bots: deps.bots() } : { scope: "bot" as const, bot: ctx.bot };
        const made = host.export(target, deps.routines(), ctx.bot);
        shown(ctx, made.card);
        const counts = made.card.counts;
        return reply(200, [
          `Made the template folder at ${made.dir} (${counts.skills} skills, ${counts.routines} routines that will arrive paused, ${counts.apps} apps by name only). It has no chats, memory, keys or connection addresses.`,
          PRIVATE_DETAILS,
          "If something you learned would help anyone using this template, add it to a skill in the folder. A card with Publish and Details is in the chat; call share with action publish only when the person asks to publish.",
        ].join("\n"));
      }
      if (body.action === "publish") {
        const record = host.latest(ctx.bot.id, department ? "department" : "bot");
        if (!record) return reply(404, "There is no template to publish yet. Call share with action export first.");
        const card = await host.publish(record.id);
        if (!record.cards.some((each) => each.threadId === ctx.threadId)) shown(ctx, card);
        if (card.status === "published") return reply(200, `Published. The link anyone can import from is ${card.link} and the pull request for review is ${card.prUrl}.`);
        if (card.fallback) return reply(409, `Publishing isn't available here (${card.fallback === "sign_in" ? "this app isn't signed in to MausBot" : "the community service isn't offered here"}). The card offers Save folder… and the community repository's upload page instead; tell the person.`);
        return reply(502, card.error ?? "Publishing failed. Try again shortly.");
      }
      if (body.action === "import") {
        const link = typeof body.url === "string" ? body.url.trim() : "";
        const path = typeof body.path === "string" ? body.path.trim() : "";
        const given = link || path;
        if (!given || (link && path)) return reply(400, "Pass the url or the path the person gave you.");
        if (!ctx.personMessage || !ctx.personMessage.includes(given)) {
          return reply(403, "Import only what the person linked in their own message just now. Ask them to paste the link or folder path in the chat.");
        }
        if (path && !deps.localFolders && !ctx.roots.some((root) => within(root, path))) return reply(403, "That folder isn't one you can read here.");
        const folder = await readImport(link ? { url: link } : { path }, true, deps.fetchTemplate);
        const added = addTemplate(folder, await deps.importDeps(null), deps);
        const names = added.bots.map((bot) => bot.name).join(", ");
        return reply(201, `Added ${names}${added.section ? ` in a new department, ${added.section}` : ""}. Routines arrived paused${added.appsToConnect ? `, and ${added.appsToConnect} apps need the person's own accounts` : ""}.`);
      }
      return reply(400, "action must be export, publish or import.");
    } catch (error) {
      const known = refusal(error);
      if (!known) throw error;
      return reply(known.status, known.error);
    }
  };
}
