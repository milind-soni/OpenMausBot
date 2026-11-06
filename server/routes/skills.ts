import { z } from "zod";

import type { SkillWire } from "../../shared/skill-catalog.ts";
import { WRITTEN_SKILL_SOURCE, writtenSkillMd, writtenSkillProblem } from "../../shared/written-skill.ts";
import {
  listSkillCatalog, readCatalogSkill, removeCatalogSkill, setBotSkill, setSkillAccess, type CatalogResult, type SkillCatalogDeps,
} from "../skill-catalog.ts";
import { fetchSkillFromSource } from "../skill-fetch.ts";
import { prepareSkillFolder, skillImportSummary } from "../skill-folder.ts";
import { installLibrarySkill } from "../skill-library.ts";
import { parseSkillMd, scanSkillText, type SkillListing } from "../skills.ts";
import type { GitHubSkillOrigin, SkillImportSummary } from "../../shared/skill-import.ts";
import type { BotRecord, Store } from "../store.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export interface SkillsRouteDeps {
  store: Store;
  catalog(): SkillCatalogDeps;
  listBotSkills(bot: BotRecord): SkillListing[];
}

const accessSchema = z.object({ who: z.enum(["all", "bots", "off"]), bots: z.array(z.string().min(1).max(128)).max(500).optional() }).strict();
const addSchema = z.union([
  z.object({ link: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ name: z.string().max(64), description: z.string().max(1024), instructions: z.string().max(20_000) }).strict(),
]);

/** A new skill is for every bot, unless the scan flagged it: then it waits, off, for a person to choose. */
function addToLibrary(text: string, source: string, warnings: string[], folder: {
  files?: ReadonlyArray<{ path: string; content: Buffer; executable: boolean }>; skipped?: string[]; github?: GitHubSkillOrigin;
} = {}): { name: string } | { error: string } {
  const parsed = parseSkillMd(text);
  if ("error" in parsed) return parsed;
  const installed = installLibrarySkill({
    name: parsed.name, instructions: text, source, license: parsed.license, compatibility: parsed.compatibility, tags: parsed.tags,
    warnings, reviewState: warnings.length ? "disabled" : "approved", everyBot: warnings.length === 0,
    ...(folder.files?.length ? { files: folder.files } : {}), ...(folder.skipped?.length ? { skippedFiles: folder.skipped } : {}),
    ...(folder.github ? { github: folder.github } : {}),
  });
  return "error" in installed ? installed : { name: installed.name };
}

/** The bot's skills its engine loads from its working folder: shown, never changed here. */
function folderRows(bot: BotRecord, listed: readonly SkillListing[], catalog: readonly SkillWire[]): SkillWire[] {
  const names = new Set(catalog.filter((row) => row.bots.includes(bot.id)).map((row) => row.name));
  return listed.filter((skill) => (skill as { origin?: string }).origin === "native" && !names.has(skill.name)).map((skill): SkillWire => ({
    id: `project:${skill.name}`, name: skill.name, description: skill.description, from: { kind: "project" }, who: "bots", bots: [bot.id], only: [bot.id], removable: false,
  }));
}

function answer({ json, res }: RouteContext, result: CatalogResult) {
  return "error" in result ? json(res, result.status, { error: result.error, ...(result.code ? { code: result.code } : {}) }) : json(res, 200, { ok: true });
}

export function createSkillsRoutes(deps: SkillsRouteDeps): RouteHandler {
  return async (ctx) => {
    const { req, res, url, path, method, json, readBody } = ctx;
    if (path === "/api/skills" && method === "GET") {
      const skills = listSkillCatalog(deps.catalog());
      const bot = deps.store.bot(url.searchParams.get("bot") ?? "");
      return json(res, 200, { skills: bot ? [...skills, ...folderRows(bot, deps.listBotSkills(bot), skills)] : skills });
    }
    if (path === "/api/skills" && method === "POST") {
      const parsed = addSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "paste a GitHub link, or write a name, a description and the instructions" });
      const body = parsed.data;
      if ("link" in body) {
        const fetched = await fetchSkillFromSource(body.link);
        if ("error" in fetched) return json(res, 422, { error: fetched.error });
        const results = fetched.skills.map((skill): { name: string; imported: SkillImportSummary } | { error: string } => {
          const folder = prepareSkillFolder(skill.files);
          if ("error" in folder) return folder;
          const skipped = [...skill.skipped, ...folder.skipped];
          const added = addToLibrary(folder.skillMd, skill.source, folder.warnings, { files: folder.files, skipped: skipped.map((file) => file.path), github: skill.github });
          return "error" in added ? added : { name: added.name, imported: skillImportSummary(added.name, [{ path: "SKILL.md" }, ...folder.files], skipped) };
        });
        const added = results.flatMap((result) => ("name" in result ? [result] : []));
        const errors = results.flatMap((result) => ("error" in result ? [result.error] : []));
        return added.length
          ? json(res, 201, { added: added.map((result) => result.name), imported: added.map((result) => result.imported), errors })
          : json(res, 422, { error: errors.join("; ") || "no skill found there" });
      }
      const taken = listSkillCatalog(deps.catalog()).map((row) => row.name);
      const problem = writtenSkillProblem(body, taken);
      if (problem) return json(res, 422, { error: problem, code: problem });
      const text = writtenSkillMd(body);
      const added = addToLibrary(text, WRITTEN_SKILL_SOURCE, scanSkillText(text));
      return "error" in added ? json(res, 422, { error: added.error }) : json(res, 201, { added: [added.name], errors: [] });
    }
    const m = path.match(/^\/api\/skills\/([^/]+)(?:\/(access)|\/bots\/([\w-]+))?$/);
    if (!m) return PASS;
    const id = decodeURIComponent(m[1]!);
    if (m[2] && method === "PUT") {
      const parsed = accessSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "who must be all, bots or off" });
      return answer(ctx, setSkillAccess(deps.catalog(), id, parsed.data.who, parsed.data.bots ?? []));
    }
    if (m[3] && method === "PUT") {
      if (!deps.store.bot(m[3])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ on: z.boolean() }).strict().safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "on must be true or false" });
      return answer(ctx, setBotSkill(deps.catalog(), m[3], id, parsed.data.on));
    }
    if (m[2] || m[3]) return PASS;
    if (method === "GET") {
      const detail = readCatalogSkill(deps.catalog(), id);
      return detail ? json(res, 200, detail) : json(res, 404, { error: "no such skill" });
    }
    if (method === "DELETE") return answer(ctx, removeCatalogSkill(deps.catalog(), id));
    return PASS;
  };
}
