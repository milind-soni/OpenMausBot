// Templates: a bot or a department written as a folder (shared/share-folder.ts) that can be saved, published to the
// community repository or imported. Security: an export carries no chats, memory, keys, connection addresses, model,
// approval level, folders or access lists, and every text passes redactPackageSecrets. An imported folder is untrusted:
// it is read through parsePackageDocument (trust "file") and added by the package importer, additively, with routines
// paused and connections left for the person to set up.
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import {
  PackageFormatError,
  packageSecretFindings,
  parsePackageDocument,
  redactPackageSecrets,
  type PackageDocument,
} from "../shared/package-format.ts";
import type { TemplateAvatar, TemplateCard, TemplateDetails, TemplateScope } from "../shared/share-card.ts";
import { manifestDetails, packageDetails } from "../shared/share-details.ts";
import {
  isShareFolderPath,
  isSkillFilePath,
  namedFolderFiles,
  MANIFEST_NAMES,
  readShareFolder,
  SHARE_FOLDER_MAX_BYTES,
  SHARE_FOLDER_MAX_FILES,
  writeShareFolder,
  type ShareFolder,
  type ShareFolderFiles,
} from "../shared/share-folder.ts";
import { admitSkillFiles, skillFileRefusalWords } from "../shared/skill-files.ts";
import { writeFileAtomic } from "./atomic.ts";
import { createTeamPackageExport, TeamExportError, type ExportablePackageSkill, type TeamExportSkip } from "./package-export.ts";
import type { Routine } from "./routines.ts";
import { COMMUNITY_MAX_BYTES, COMMUNITY_MAX_FILES, type CommunityPublisher } from "./share-publish.ts";
import type { BotRecord, GroupRecord } from "./store.ts";
import { parseTeamManifest } from "./team-manifest.ts";

export class ShareError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface ShareHostDeps {
  dataDir: string;
  bots(): readonly BotRecord[];
  groups(): readonly GroupRecord[];
  routines(): readonly Routine[];
  brief(section: string): string | undefined;
  collectTeamSkills(bots: readonly BotRecord[], selection: "all"):
    | { ok: true; skillsByBot: Map<string, ExportablePackageSkill[]>; skipped: TeamExportSkip[] }
    | { ok: false; error: string };
  /** The files beside one of the bot's skills, before what may travel is picked from them; null when they changed since
   * they came in. */
  skillFiles?(bot: BotRecord, name: string): Array<{ path: string; content: string | Uint8Array }> | null;
  /** The bot's picture as a data: URL, when it shows one instead of its mascot. */
  picture(bot: BotRecord): string | undefined;
  /** The bot's own folder, where a template it makes is written for it to read and edit. */
  botFolder(botId: string): string;
  publisher: CommunityPublisher;
  /** Re-draws a template card already in a conversation. */
  patch(threadId: string, messageId: string, text: string, card: TemplateCard): void;
}

const recordSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{16}$/),
  scope: z.enum(["bot", "department"]),
  botId: z.string().optional(),
  section: z.string().optional(),
  dir: z.string(),
  slug: z.string(),
  status: z.enum(["draft", "publishing", "published", "failed", "gone"]),
  link: z.string().optional(),
  prUrl: z.string().optional(),
  error: z.string().optional(),
  redacted: z.number().int().min(0),
  skipped: z.array(z.string()),
  avatars: z.array(z.object({ key: z.string(), name: z.string(), color: z.string(), picture: z.string().optional(), mascotExpression: z.string().optional(), mascotBody: z.string().optional() })),
  cards: z.array(z.object({ threadId: z.string(), messageId: z.string() })),
  updatedAt: z.number(),
});
type TemplateRecord = z.output<typeof recordSchema>;

const SKIP_WORDS: Record<string, string> = {
  picture_too_large: "a picture over 64 KB", picture_invalid: "a picture that couldn't be read", files_not_shared: "files attached to a routine",
  lead_not_in_group_chat: "a group chat goal whose lead isn't in the chat", skill_changed: "a skill that changed while it was being shared",
  skill_conflict: "a skill two bots have in different versions", bot_skill_limit: "skills past a bot's limit", team_skill_limit: "skills past the department's limit",
};
const skipWords = (skip: TeamExportSkip) => `${SKIP_WORDS[skip.reason] ?? "an item that can't be shared"} (${skip.part})`;

const slugOf = (name: string) => name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "template";
const firstLine = (text: string | undefined, max: number) => {
  const line = (text ?? "").split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** Inside `root` (both already resolved): the path itself or below it. */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Reads a template folder from disk. Security: the chosen folder is resolved once, only paths the reader opens are
 * looked at, nothing that is a link is followed, every file must resolve inside the folder, and the file count and
 * bytes are capped before anything is read. */
export function readFolderFromDisk(chosen: string): ShareFolderFiles {
  let root: string;
  try {
    root = realpathSync(resolve(chosen));
  } catch {
    throw new ShareError("That folder can't be opened.", 404);
  }
  if (!lstatSync(root).isDirectory()) throw new ShareError("Choose a folder, not a file.");
  const files: ShareFolderFiles = {};
  let total = 0, count = 0;
  const take = (rel: string) => {
    const full = join(root, rel);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    if (!inside(root, realpathSync(full))) return;
    if (++count > SHARE_FOLDER_MAX_FILES) throw new ShareError("This folder has too many files to be a template.");
    total += stat.size;
    if (total > SHARE_FOLDER_MAX_BYTES) throw new ShareError("This folder is larger than 4 MB.", 413);
    const bytes = readFileSync(full);
    files[rel.split(sep).join("/")] = /\.(md|json)$/.test(rel) ? bytes.toString("utf8") : new Uint8Array(bytes);
  };
  const directories = (rel: string) => {
    try {
      return readdirSync(join(root, rel), { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
    } catch {
      return [];
    }
  };
  const list = (rel: string) => {
    try {
      return readdirSync(join(root, rel), { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch {
      return [];
    }
  };
  const collect = (prefix: string) => {
    for (const name of list(prefix)) if (isShareFolderPath(name)) take(join(prefix, name));
    if (directories(prefix).includes("skills")) {
      for (const skill of directories(join(prefix, "skills")).slice(0, SHARE_FOLDER_MAX_FILES)) {
        if (isShareFolderPath(`skills/${skill}/SKILL.md`)) take(join(prefix, "skills", skill, "SKILL.md"));
      }
    }
    if (directories(prefix).includes("avatars")) {
      for (const name of list(join(prefix, "avatars")).slice(0, SHARE_FOLDER_MAX_FILES)) {
        if (isShareFolderPath(`avatars/${name}`)) take(join(prefix, "avatars", name));
      }
    }
    const manifest = [MANIFEST_NAMES.bot, MANIFEST_NAMES.department].map((name) => files[prefix ? `${prefix}/${name}` : name]).find((value) => typeof value === "string");
    let named: string[] = [];
    try {
      named = typeof manifest === "string" ? namedFolderFiles(manifest) : [];
    } catch {
      // The folder reader refuses a manifest it can't read, in its own words.
    }
    for (const path of named) if (isSkillFilePath(path)) take(join(prefix, ...path.split("/")));
  };
  collect("");
  if (!Object.keys(files).some((path) => !path.includes("/"))) {
    const below = directories("").filter((name) => name !== "skills" && name !== "avatars");
    if (below.length === 1) collect(below[0]!);
  }
  return files;
}

export function writeFolder(dir: string, files: Record<string, string | Uint8Array>): void {
  mkdirSync(dir, { recursive: true });
  for (const [path, value] of Object.entries(files)) {
    const target = join(dir, ...path.split("/"));
    if (!inside(dir, target)) continue;
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, value);
  }
}

/** The package a folder holds, re-checked: refused when an edit put a key- or password-shaped value back in. */
function folderPackage(dir: string, scope: TemplateScope): PackageDocument {
  let folder: ShareFolder;
  try {
    folder = readShareFolder(readFolderFromDisk(dir));
  } catch (error) {
    if (error instanceof ShareError) throw new ShareError("This template's folder is gone. Make the template again.", 410);
    throw new ShareError(error instanceof Error ? error.message : "This template's folder can't be read.");
  }
  if (folder.kind !== "package" || folder.scope !== scope) throw new ShareError(`This template's folder no longer holds its ${scope === "bot" ? "bot.md" : "team.md"}.`);
  const secrets = packageSecretFindings(folder.document);
  if (secrets.length) throw new ShareError(`Something in ${secrets[0]} looks like a key or password. Remove it from the template, then try again.`);
  return folder.document;
}

/** Where connection addresses and the rest that never travels are taken out: connections become apps by name. */
function templateDocument(document: PackageDocument, bots: readonly BotRecord[], botKeys: Readonly<Record<string, string>>): { document: PackageDocument; redacted: number } {
  const pkg = structuredClone(document.package);
  const apps = [...pkg.requirements.apps];
  const slugs = new Set(apps.map((app) => app.slug));
  const uses = (bot: BotRecord) => [...(bot.mcpServers ?? []), ...Object.keys(bot.connectorTools ?? {})];
  for (const bot of bots) {
    for (const name of uses(bot)) {
      const slug = slugOf(name).slice(0, 64);
      if (slugs.has(slug) || apps.length >= 30) continue;
      slugs.add(slug);
      const users = bots.filter((each) => uses(each).includes(name)).map((each) => each.name);
      apps.push({ slug, label: (name.charAt(0).toUpperCase() + name.slice(1)).slice(0, 100), reason: `Used by ${users.join(", ")}`.slice(0, 240), optional: true });
    }
  }
  pkg.requirements = { ...pkg.requirements, apps };
  delete pkg.connections;
  const keyed = new Map(Object.entries(botKeys).map(([id, key]) => [key, bots.find((bot) => bot.id === id)]));
  pkg.agents = pkg.agents.map((agent) => {
    const { connections: _connections, seed: _seed, approval: _approval, ...kept } = agent;
    const off = keyed.get(agent.key)?.toolsOff ?? [];
    return off.length ? { ...kept, tools: { off: [...off] } } : kept;
  });
  if (pkg.routines) pkg.routines = pkg.routines.map((routine) => ({ ...routine, enabledAfterInstall: false }));
  const { document: redactedDocument, redacted } = redactPackageSecrets({ ...document, package: pkg });
  return { document: parsePackageDocument(redactedDocument, { trust: "file" }), redacted: redacted.length };
}

/** The community repository's check takes SKILL.md alone in a skill's folder, so a template goes there without its
 * skills' other files; a download, a team library and a person's own repository keep them. */
export function withoutSkillFiles(document: PackageDocument): PackageDocument {
  const skills = document.package.skills;
  if (!skills?.entries.some((skill) => skill.files?.length)) return document;
  return { ...document, package: { ...document.package, skills: { ...skills, entries: skills.entries.map(({ files: _files, ...skill }) => skill) } } };
}

export function cardText(card: TemplateCard): string {
  if (card.status === "gone") return `Deleted the template of ${card.name}.`;
  if (card.status === "published" && card.link) return `Published the template of ${card.name}: ${card.link}`;
  if (card.status === "failed") return `Couldn't publish the template of ${card.name}. ${card.error ?? ""}`.trim();
  return `Made a shareable template of ${card.name}. It holds no chats, memory or keys.`;
}

export function createShareHost(deps: ShareHostDeps) {
  const file = join(deps.dataDir, "share", "templates.json");
  const records = new Map<string, TemplateRecord>();
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { templates?: unknown[] };
    for (const value of saved.templates ?? []) {
      const parsed = recordSchema.safeParse(value);
      if (parsed.success) records.set(parsed.data.id, parsed.data);
    }
  } catch {
  }
  const save = () => {
    mkdirSync(join(deps.dataDir, "share"), { recursive: true, mode: 0o700 });
    writeFileAtomic(file, JSON.stringify({ version: 1, templates: [...records.values()] }), { mode: 0o600 });
  };
  /** The folders this host writes and may delete: a bot's templates folder, or its own under the data folder. */
  const ownFolder = (record: Pick<TemplateRecord, "dir" | "botId">) =>
    inside(join(deps.dataDir, "share"), record.dir) || (record.botId !== undefined && inside(join(deps.botFolder(record.botId), "templates"), record.dir));

  const cardOf = (record: TemplateRecord, document?: PackageDocument): TemplateCard => {
    const pkg = document?.package;
    const fallback = record.status === "draft" || record.status === "failed" ? deps.publisher.availability() : null;
    return {
      id: record.id,
      scope: record.scope,
      name: pkg?.name ?? record.slug,
      tagline: pkg?.tagline ?? "",
      avatars: record.avatars,
      counts: {
        bots: pkg?.agents.length ?? record.avatars.length,
        skills: pkg?.skills?.entries.length ?? 0,
        routines: pkg?.routines?.length ?? 0,
        apps: pkg?.requirements.apps.length ?? 0,
      },
      redacted: record.redacted,
      skipped: record.skipped,
      status: record.status,
      ...(record.link ? { link: record.link } : {}),
      ...(record.prUrl ? { prUrl: record.prUrl } : {}),
      ...(record.error ? { error: record.error } : {}),
      ...(fallback ? { fallback } : {}),
    };
  };

  const lastCards = new Map<string, TemplateCard>();
  const update = (record: TemplateRecord, patch: Partial<TemplateRecord>, document?: PackageDocument): TemplateCard => {
    Object.assign(record, patch, { updatedAt: Date.now() });
    save();
    const previous = lastCards.get(record.id);
    const card = document ? cardOf(record, document) : previous ? { ...cardOf(record), name: previous.name, tagline: previous.tagline, counts: previous.counts } : cardOf(record);
    lastCards.set(record.id, card);
    for (const shown of record.cards) {
      try {
        deps.patch(shown.threadId, shown.messageId, cardText(card), card);
      } catch {
        // A conversation deleted since has no card to re-draw.
      }
    }
    return card;
  };

  function build(target: { scope: "bot"; bot: BotRecord } | { scope: "department"; section: string; bots: readonly BotRecord[] }, routines: readonly Routine[]) {
    const bots = target.scope === "bot"
      ? [{ ...target.bot, section: undefined, chiefOfStaff: false }]
      : target.bots.filter((bot) => !bot.hidden && (bot.section?.trim() ?? "") === target.section);
    if (!bots.length) throw new ShareError("This department has no bots to share.");
    const skills = deps.collectTeamSkills(bots, "all");
    if (!skills.ok) throw new ShareError(skills.error);
    const fileSkips = new Set<string>();
    for (const bot of bots) {
      for (const skill of skills.skillsByBot.get(bot.id) ?? []) {
        const stored = deps.skillFiles ? deps.skillFiles(bot, skill.name) : [];
        if (stored === null) {
          fileSkips.add(`the files beside skill ${skill.name}, which changed since they came in`);
          continue;
        }
        const admitted = admitSkillFiles(stored);
        if (admitted.files.length) skill.files = admitted.files;
        for (const refused of admitted.refused) fileSkips.add(`${skill.name}/${refused.path}, which ${skillFileRefusalWords(refused.reason)}`);
      }
    }
    const avatars: Record<string, string> = {};
    for (const bot of bots) {
      const picture = deps.picture(bot);
      if (picture) avatars[bot.id] = picture;
    }
    const brief = target.scope === "department" ? deps.brief(target.section)?.trim() : undefined;
    const lead = target.scope === "bot" ? target.bot : undefined;
    let exported;
    try {
      exported = createTeamPackageExport({
        team: target.scope === "bot" ? "" : target.section,
        name: lead ? lead.name : target.scope === "department" ? target.section : undefined,
        tagline: lead ? firstLine(lead.title || lead.description, 160) || undefined : firstLine(brief, 160) || undefined,
        summary: lead ? (lead.description?.trim().slice(0, 2_000) || undefined) : brief?.slice(0, 2_000) || undefined,
        authorName: "MausBot user",
        bots,
        groups: target.scope === "bot" ? [] : deps.groups(),
        routines: target.scope === "bot" ? routines.filter((routine) => routine.botId === target.bot.id && routine.target !== "room-goal") : routines,
        ...(brief ? { brief } : {}),
        published: null,
        skillsByBot: skills.skillsByBot,
        skillSelection: "all",
        avatars,
        mcpServers: {},
        skipped: skills.skipped,
      });
    } catch (error) {
      if (error instanceof TeamExportError) throw new ShareError(error.message);
      throw error;
    }
    const { document, redacted } = templateDocument(exported.document, bots, exported.published.keys.bots);
    const keyOf = new Map(Object.entries(exported.published.keys.bots).map(([id, key]) => [key, id]));
    const avatarsShown: TemplateAvatar[] = document.package.agents.slice(0, 12).map((agent) => {
      const bot = bots.find((each) => each.id === keyOf.get(agent.key));
      const picture = bot?.avatarUrl && bot.avatarCrop !== "mascot" ? bot.avatarUrl : undefined;
      return {
        key: agent.key, name: agent.name, color: agent.appearance.color,
        ...(picture ? { picture } : {}),
        ...(agent.appearance.mascotExpression ? { mascotExpression: agent.appearance.mascotExpression } : {}),
        ...(agent.appearance.mascotBody ? { mascotBody: agent.appearance.mascotBody } : {}),
      };
    });
    return { document, redacted: redacted + exported.redacted.length, skipped: [...exported.skipped.map(skipWords), ...fileSkips], avatars: avatarsShown };
  }

  return {
    /** Makes (or makes again, in the same folder) the template of a bot or a department. `writer` is the bot whose own
     * folder receives it: the bot itself, or the Chief that shares its department; none for the department's Share. */
    export(target: { scope: "bot"; bot: BotRecord } | { scope: "department"; section: string; bots: readonly BotRecord[] }, routines: readonly Routine[], writer?: BotRecord): { card: TemplateCard; dir: string; document: PackageDocument } {
      const built = build(target, routines);
      const botId = target.scope === "bot" ? target.bot.id : writer?.id;
      const section = target.scope === "department" ? target.section : undefined;
      const existing = [...records.values()].find((record) => record.status !== "gone" && record.scope === target.scope &&
        (target.scope === "bot" ? record.botId === botId : record.section === section && record.botId === botId));
      const id = existing?.id ?? randomBytes(8).toString("hex");
      const slug = built.document.package.id;
      const dir = botId ? join(deps.botFolder(botId), "templates", slug) : join(deps.dataDir, "share", id, slug);
      if (existing && existing.dir !== dir && ownFolder(existing)) rmSync(existing.dir, { recursive: true, force: true });
      if (botId) {
        const templates = join(deps.botFolder(botId), "templates");
        if (existsSync(templates) && lstatSync(templates).isSymbolicLink()) rmSync(templates, { force: true });
      }
      rmSync(dir, { recursive: true, force: true });
      writeFolder(dir, writeShareFolder(built.document, target.scope));
      const record: TemplateRecord = existing ?? {
        id, scope: target.scope, ...(botId ? { botId } : {}), ...(section !== undefined ? { section } : {}), dir, slug, status: "draft",
        redacted: 0, skipped: [], avatars: [], cards: [], updatedAt: Date.now(),
      };
      records.set(id, record);
      const card = update(record, {
        dir, slug, redacted: built.redacted, skipped: built.skipped, avatars: built.avatars,
        status: "draft", error: undefined,
      }, built.document);
      return { card, dir, document: built.document };
    },

    /** Records that `messageId` in `threadId` shows this template, so later changes re-draw it. */
    shown(id: string, threadId: string, messageId: string): void {
      const record = records.get(id);
      if (!record || record.cards.some((card) => card.messageId === messageId)) return;
      record.cards = [...record.cards.slice(-9), { threadId, messageId }];
      save();
    },

    record(id: string): Readonly<TemplateRecord> | undefined {
      return records.get(id);
    },

    /** The template this bot made last, of itself or (for a Chief) of its department. */
    latest(botId: string, scope: TemplateScope): Readonly<TemplateRecord> | undefined {
      return [...records.values()].filter((record) => record.botId === botId && record.scope === scope && record.status !== "gone")
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    },

    get(id: string): { card: TemplateCard; details: TemplateDetails } {
      const record = records.get(id);
      if (!record || record.status === "gone") throw new ShareError("This template was deleted.", 404);
      const document = folderPackage(record.dir, record.scope);
      const card = cardOf(record, document);
      lastCards.set(id, card);
      return { card, details: packageDetails(document, record.scope) };
    },

    /** The folder's files as they would be published: re-read, re-checked and written out again from what passed. */
    files(id: string): { slug: string; files: Record<string, string | Uint8Array> } {
      const record = records.get(id);
      if (!record || record.status === "gone") throw new ShareError("This template was deleted.", 404);
      return { slug: record.slug, files: writeShareFolder(folderPackage(record.dir, record.scope), record.scope) };
    },

    async publish(id: string): Promise<TemplateCard> {
      const record = records.get(id);
      if (!record || record.status === "gone") throw new ShareError("This template was deleted.", 404);
      if (record.status === "publishing") return lastCards.get(id) ?? cardOf(record);
      let document: PackageDocument;
      try {
        document = folderPackage(record.dir, record.scope);
      } catch (error) {
        if (error instanceof ShareError) return update(record, { status: "failed", error: error.message });
        throw error;
      }
      const files = writeShareFolder(withoutSkillFiles(document), record.scope);
      const bytes = Object.values(files).reduce((sum, value) => sum + (typeof value === "string" ? Buffer.byteLength(value) : value.byteLength), 0);
      if (Object.keys(files).length > COMMUNITY_MAX_FILES) return update(record, { status: "failed", error: `A template can have at most ${COMMUNITY_MAX_FILES} files.` }, document);
      if (bytes > COMMUNITY_MAX_BYTES) return update(record, { status: "failed", error: "This template is bigger than 4 MB. Leave out large pictures or skills, then publish again." }, document);
      update(record, { status: "publishing", error: undefined }, document);
      const result = await deps.publisher.submit({
        slug: record.slug,
        files: Object.fromEntries(Object.entries(files).map(([path, value]) => [path, typeof value === "string" ? value : { base64: Buffer.from(value).toString("base64") }])),
      });
      if (result.ok) return update(record, { status: "published", link: result.link, prUrl: result.prUrl, error: undefined }, document);
      if (result.reason === "failed") return update(record, { status: "failed", error: result.message }, document);
      return update(record, { status: "draft", error: undefined }, document);
    },

    /** Writes the folder into `target`/<slug> on this computer. */
    saveTo(id: string, target: string): string {
      if (!isAbsolute(target)) throw new ShareError("Choose a folder to save the template in.");
      let parent: string;
      try {
        parent = realpathSync(target);
      } catch {
        throw new ShareError("That folder can't be opened.", 404);
      }
      if (!lstatSync(parent).isDirectory()) throw new ShareError("Choose a folder, not a file.");
      const { slug, files } = this.files(id);
      const dir = join(parent, slug);
      if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new ShareError("A link with the template's name is already in that folder.");
      writeFolder(dir, files);
      return dir;
    },

    delete(id: string): TemplateCard {
      const record = records.get(id);
      if (!record) throw new ShareError("This template was deleted.", 404);
      if (ownFolder(record)) rmSync(record.dir, { recursive: true, force: true });
      return update(record, { status: "gone" });
    },

    /** Reads a template from a link, a folder on this computer or uploaded files; nothing is added. */
    preview(folder: ShareFolder): TemplateDetails {
      if (folder.kind === "package") return packageDetails(folder.document, folder.scope);
      const details = manifestDetails(parseTeamManifest(folder.manifest as Parameters<typeof parseTeamManifest>[0]));
      if (!details) throw new PackageFormatError("not_a_package", "This folder has no bot.md or team.md.");
      return details;
    },
  };
}
export type ShareHost = ReturnType<typeof createShareHost>;
