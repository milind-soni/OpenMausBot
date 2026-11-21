// A Team Cloud's own templates: each a template folder at <dataDir>/team-files/templates/<slug>/, in the team's shared
// files, with who added it and when kept apart in share/team-library.json. Adding a template with a slug already there
// keeps the one it replaces as <slug>.previous/, and so does removing one.
// Security: a folder here is read back through the template folder reader and the package gate at every import, never
// trusted for having been written by this server; nothing outside templates/ is written or deleted.
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { TeamTemplate, TemplateScope } from "../shared/share-card.ts";
import type { ShareFolderFiles } from "../shared/share-folder.ts";
import { renameWithRetry, writeFileAtomic } from "./atomic.ts";
import { readFolderFromDisk, ShareError, writeFolder } from "./share.ts";
import { TEAM_FILES_DIR, TEAM_FILES_TEMPLATES } from "./host/team-files.ts";

/** The team's shared files (server/host/team-files.ts). Its templates are one folder of it. */
export const teamTemplatesFolder = (dataDir: string): string => join(dataDir, TEAM_FILES_DIR, TEAM_FILES_TEMPLATES);

export const TEAM_TEMPLATE_SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_TEMPLATES = 500;
const GONE = "This template is no longer in the team's library.";

const entrySchema = z.object({
  name: z.string().min(1).max(100),
  scope: z.enum(["bot", "department"]),
  tagline: z.string().max(200),
  addedBy: z.string().max(200).optional(),
  addedAt: z.number().int().nonnegative(),
});
const fileSchema = z.object({ v: z.literal(1), templates: z.record(z.string().regex(TEAM_TEMPLATE_SLUG), entrySchema) });

const isFolder = (path: string) => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

export function createTeamTemplates(dataDir: string, now: () => number = Date.now) {
  const root = teamTemplatesFolder(dataDir);
  const indexFile = join(dataDir, "share", "team-library.json");
  const read = (): Record<string, z.output<typeof entrySchema>> => {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(indexFile, "utf8")));
      return parsed.success ? parsed.data.templates : {};
    } catch {
      return {};
    }
  };
  const write = (templates: Record<string, z.output<typeof entrySchema>>) => {
    mkdirSync(join(dataDir, "share"), { recursive: true, mode: 0o700 });
    writeFileAtomic(indexFile, JSON.stringify({ v: 1, templates }), { mode: 0o600 });
  };
  const folderOf = (slug: string) => {
    if (!TEAM_TEMPLATE_SLUG.test(slug)) throw new ShareError(GONE, 404);
    return join(root, slug);
  };
  /** The folder at `slug` moves to <slug>.previous/, replacing an older one there. */
  const keepPrevious = (slug: string) => {
    const previous = join(root, `${slug}.previous`);
    rmSync(previous, { recursive: true, force: true });
    renameWithRetry(join(root, slug), previous);
  };

  return {
    list(): TeamTemplate[] {
      return Object.entries(read())
        .filter(([slug]) => isFolder(join(root, slug)))
        .map(([slug, entry]) => ({ slug, ...entry }))
        .sort((a, b) => b.addedAt - a.addedAt);
    },

    /** Adds a template folder's files as <slug>, replacing one already there. */
    add(slug: string, files: ShareFolderFiles, about: { name: string; scope: TemplateScope; tagline: string; addedBy?: string }): { template: TeamTemplate; replaced: boolean } {
      const target = folderOf(slug);
      const templates = read();
      if (!templates[slug] && Object.keys(templates).length >= MAX_TEMPLATES) throw new ShareError(`The team's library holds at most ${MAX_TEMPLATES} templates. Remove one first.`, 409);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const incoming = join(root, `.incoming-${randomBytes(6).toString("hex")}`);
      try {
        writeFolder(incoming, files);
        const replaced = isFolder(target);
        if (replaced) keepPrevious(slug);
        renameWithRetry(incoming, target);
        const entry = { name: about.name.slice(0, 100), scope: about.scope, tagline: about.tagline.slice(0, 200), ...(about.addedBy ? { addedBy: about.addedBy.slice(0, 200) } : {}), addedAt: now() };
        write({ ...templates, [slug]: entry });
        return { template: { slug, ...entry }, replaced };
      } finally {
        rmSync(incoming, { recursive: true, force: true });
      }
    },

    /** The template's files as they are on disk now, for the folder reader. */
    files(slug: string): ShareFolderFiles {
      const folder = folderOf(slug);
      if (!read()[slug] || !isFolder(folder)) throw new ShareError(GONE, 404);
      return readFolderFromDisk(folder);
    },

    has(slug: string): boolean {
      return TEAM_TEMPLATE_SLUG.test(slug) && Boolean(read()[slug]) && isFolder(join(root, slug));
    },

    /** Takes the template out of the library; its folder stays as <slug>.previous/. */
    remove(slug: string): void {
      folderOf(slug);
      const templates = read();
      if (!templates[slug]) throw new ShareError(GONE, 404);
      if (isFolder(join(root, slug))) keepPrevious(slug);
      delete templates[slug];
      write(templates);
    },
  };
}
export type TeamTemplates = ReturnType<typeof createTeamTemplates>;
