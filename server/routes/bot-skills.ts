import { z } from "zod";

import { setImportedSkillEnabled } from "../imported-skills.ts";
import { botSkillTemplateSchema } from "../new-bot-defaults.ts";
import { fetchSkillFromSource } from "../skill-fetch.ts";
import { skillImportSummary } from "../skill-folder.ts";
import {
  installSkill, listBotSkillsWithOrigin, listStagedSkillWrites, parseSkillMd, removeSkill, setSkillEnabled,
  type SkillListing, type StagedSkillWrite,
} from "../skills.ts";
import type { BotRecord, Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotSkillsRouteDeps {
  store: Store;
  listBotSkills(bot: BotRecord, threadId?: string): SkillListing[];
  readBotSkillFile(bot: BotRecord, name: string): string | null;
  stagedSkillListing(staged: StagedSkillWrite): Omit<StagedSkillWrite, "files" | "baseSha256" | "baseAppliedStageId">;
}

export function createBotSkillsRoutes(deps: BotSkillsRouteDeps): RouteHandler {
  const { store, listBotSkills, readBotSkillFile, stagedSkillListing } = deps;
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
      const skills = listBotSkillsWithOrigin(bot.id, bot.assignedSkills);
      const names = new Set(skills.map((skill) => skill.name));
      return json(res, 200, {
        skills: [...skills, ...listBotSkills(bot, threadId).filter((skill) => !names.has(skill.name))],
        staged: listStagedSkillWrites(m[1]).map(stagedSkillListing),
      });
    }
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ source: z.string().min(1).max(2000) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "source must be a GitHub or skills.sh URL, or owner/repo" });
      const fetched = await fetchSkillFromSource(parsed.data.source);
      if ("error" in fetched) return json(res, 422, { error: fetched.error });
      const results = fetched.skills.map((skill) => ({ skill, result: installSkill(m![1]!, skill.source, skill.files, skill.github) }));
      const errors = results.flatMap(({ result }) => ("error" in result ? [result.error] : []));
      const done = results.flatMap(({ skill, result }) => ("error" in result ? [] : [{ skill, installed: result }]));
      if (!done.length) return json(res, 422, { error: errors.join("; ") || "nothing importable found" });
      const imported = done.map(({ skill, installed }) => skillImportSummary(installed.name, skill.files, skill.skipped));
      return json(res, 201, { installed: done.map(({ installed }) => installed), imported, errors });
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

    return PASS;
  };
}
