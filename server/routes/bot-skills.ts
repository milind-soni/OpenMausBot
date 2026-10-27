import { z } from "zod";

import type { SkillsLibrarySkillWire } from "../../shared/wire.ts";
import type { AppConfig } from "../config.ts";
import { setImportedSkillEnabled } from "../imported-skills.ts";
import { botSkillTemplateSchema } from "../new-bot-defaults.ts";
import { fetchSkillFromSource } from "../skill-fetch.ts";
import { installLibrarySkill, listLibrarySkills, readLibrarySkillFile, readSkillLibraryIndex, setLibrarySkillEveryBot, setLibrarySkillReviewState, skillsLibraryEnabled } from "../skill-library.ts";
import {
  installSkill, listBotSkillsWithOrigin, listStagedSkillWrites, parseSkillMd, removeSkill, scanSkillText, setSkillEnabled,
  type SkillListing, type StagedSkillWrite,
} from "../skills.ts";
import type { BotRecord, Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotSkillsRouteDeps {
  store: Store;
  cfg: AppConfig;
  listBotSkills(bot: BotRecord, threadId?: string): SkillListing[];
  readBotSkillFile(bot: BotRecord, name: string): string | null;
  stagedSkillListing(staged: StagedSkillWrite): Omit<StagedSkillWrite, "files" | "baseSha256" | "baseAppliedStageId">;
}

export function createBotSkillsRoutes(deps: BotSkillsRouteDeps): RouteHandler {
  const { store, cfg, listBotSkills, readBotSkillFile, stagedSkillListing } = deps;
  return async ({ req, res, url, path, method, json, readBody }) => {
    let m: RegExpMatchArray | null = null;
    // Imports land DISABLED: a person enables one after reading SKILL.md and its scan warnings.
    m = path.match(/^\/api\/bots\/([\w-]+)\/skill-template$/);
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const checked = botSkillTemplateSchema.safeParse(await readBody(req));
      if (!checked.success) return json(res, 400, { error: checked.error.message });
      const input = checked.data;
      const parsed = parseSkillMd(input.text);
      if ("error" in parsed || parsed.name !== input.name) return json(res, 400, { error: "Skill name does not match its contents" });
      const installed = installSkill(m[1], input.source, [{ path: "SKILL.md", content: input.text }]);
      if ("error" in installed) return json(res, 422, { error: installed.error });
      if (input.enabled) {
        const enabled = setSkillEnabled(m[1], input.name, true);
        if ("error" in enabled) return json(res, 422, { error: enabled.error });
      }
      return json(res, 201, { installed });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/skills$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      // The thread names a folder on disk: only one of this bot's own threads may pick it.
      const asked = url.searchParams.get("threadId");
      const threadId = asked && store.taskByThread(bot.id, asked) ? asked : bot.threadId;
      if (skillsLibraryEnabled(cfg)) {
        const { skills, library } = listBotSkillsWithOrigin(m[1]!, store.bot(m[1])!.assignedSkills);
        const names = new Set(skills.map((skill) => skill.name));
        return json(res, 200, {
          skills: [...skills, ...listBotSkills(bot, threadId).filter((skill) => !names.has(skill.name))],
          library,
          assignedSkills: store.bot(m[1])!.assignedSkills,
          staged: listStagedSkillWrites(m[1]).map(stagedSkillListing),
        });
      }
      return json(res, 200, {
        skills: listBotSkills(bot, threadId),
        staged: listStagedSkillWrites(m[1]).map(stagedSkillListing),
      });
    }
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ source: z.string().min(1).max(2000) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "source must be a GitHub or skills.sh URL, or owner/repo" });
      const fetched = await fetchSkillFromSource(parsed.data.source);
      if ("error" in fetched) return json(res, 422, { error: fetched.error });
      const results = fetched.skills.map((skill) => installSkill(m![1]!, skill.source, skill.files));
      const installed = results.filter((entry): entry is Exclude<typeof entry, { error: string }> => !("error" in entry));
      const errors = results.flatMap((entry) => ("error" in entry ? [entry.error] : []));
      if (!installed.length) return json(res, 422, { error: errors.join("; ") || "nothing importable found" });
      return json(res, 201, { installed, errors });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/skills\/([a-z0-9-]+)$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      const text = bot ? readBotSkillFile(bot, m[2]!) : null;
      if (text === null) return json(res, 404, { error: "no such skill" });
      return json(res, 200, { text });
    }
    if (m && method === "PATCH") {
      const parsed = z.object({ enabled: z.boolean() }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "enabled must be true or false" });
      const bot = store.bot(m[1]);
      // A skill from this computer that none of the bot's own or library skills shadows: this bot's switch for it.
      if (bot && listBotSkills(bot).some((skill) => skill.name === m![2] && (skill as { origin?: string }).origin === "imported")) {
        const result = setImportedSkillEnabled(bot.id, m[2]!, parsed.data.enabled);
        if ("error" in result) return json(res, 409, { error: result.error });
        return json(res, 200, { skill: result });
      }
      const result = setSkillEnabled(m[1]!, m[2]!, parsed.data.enabled);
      if ("error" in result) return json(res, 404, { error: result.error });
      return json(res, 200, { skill: result });
    }
    if (m && method === "DELETE") {
      const result = removeSkill(m[1]!, m[2]!);
      if ("error" in result) return json(res, 404, { error: result.error });
      return json(res, 200, { ok: true });
    }

    m = path.match(/^\/api\/skills-library$/);
    if (m && method === "GET") {
      if (!skillsLibraryEnabled(cfg)) return json(res, 404, { error: "skills library is not enabled" });
      const index = readSkillLibraryIndex();
      const skills: SkillsLibrarySkillWire[] = listLibrarySkills()
        .map((listing): SkillsLibrarySkillWire => ({
          name: listing.name,
          description: listing.description,
          source: listing.source,
          enabled: listing.enabled,
          everyBot: index[listing.name]?.everyBot === true,
          tags: listing.tags ?? [],
          version: index[listing.name]?.package?.release ?? null,
          importedAt: listing.importedAt,
          ...(listing.license ? { license: listing.license } : {}),
          ...(listing.compatibility ? { compatibility: listing.compatibility } : {}),
          warnings: listing.warnings,
          assignedBots: store.bots
            .filter((bot) => index[listing.name]?.everyBot === true || bot.assignedSkills?.includes(listing.name))
            .map((bot) => ({ id: bot.id, name: bot.name })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, { skills });
    }
    if (m && method === "POST") {
      if (!skillsLibraryEnabled(cfg)) return json(res, 404, { error: "skills library is not enabled" });
      const parsed = z.object({ text: z.string().min(1) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "text must be the SKILL.md contents to import" });
      const skill = parseSkillMd(parsed.data.text);
      if ("error" in skill) return json(res, 400, { error: skill.error });
      const installed = installLibrarySkill({
        name: skill.name,
        instructions: parsed.data.text,
        source: "local-import",
        license: skill.license,
        compatibility: skill.compatibility,
        tags: skill.tags,
        warnings: scanSkillText(parsed.data.text),
        reviewState: "disabled",
      });
      if ("error" in installed) return json(res, 422, { error: installed.error });
      return json(res, 201, { skill: installed });
    }
    m = path.match(/^\/api\/skills-library\/([a-z0-9-]+)$/);
    if (m && method === "GET") {
      if (!skillsLibraryEnabled(cfg)) return json(res, 404, { error: "skills library is not enabled" });
      const text = readLibrarySkillFile(m[1]!);
      if (text === null) return json(res, 404, { error: "no such skill" });
      return json(res, 200, { text });
    }
    if (m && method === "PATCH") {
      if (!skillsLibraryEnabled(cfg)) return json(res, 404, { error: "skills library is not enabled" });
      const parsed = z.object({ enabled: z.boolean().optional(), everyBot: z.boolean().optional() })
        .refine((body) => (body.enabled !== undefined) !== (body.everyBot !== undefined)).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "enabled or everyBot must be true or false" });
      const result = parsed.data.enabled !== undefined
        ? setLibrarySkillReviewState(m[1]!, parsed.data.enabled ? "approved" : "disabled")
        : setLibrarySkillEveryBot(m[1]!, parsed.data.everyBot!);
      if ("error" in result) return json(res, 404, { error: result.error });
      return json(res, 200, { skill: result });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/skills-library$/);
    if (m && method === "PUT") {
      if (!skillsLibraryEnabled(cfg)) return json(res, 404, { error: "skills library is not enabled" });
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ skills: z.array(z.string().min(1).max(64)).max(200) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "skills must be a list of skill names" });
      const index = readSkillLibraryIndex();
      const names = [...new Set(parsed.data.skills)];
      const unknown = names.filter((name) => !index[name]);
      if (unknown.length) return json(res, 422, { error: "not in the library: " + unknown.join(", ") });
      store.patchBot(m[1]!, { assignedSkills: names });
      return json(res, 200, { assignedSkills: names });
    }
    return PASS;
  };
}
