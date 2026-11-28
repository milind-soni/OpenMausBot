import { z } from "zod";

import type { SkillsLibrarySkillWire } from "../../shared/wire.ts";
import type { AppConfig } from "../config.ts";
import { purgeImportedSkill, readImportedSkills, removeImportedSkillForBot, setImportedSkillEnabled } from "../imported-skills.ts";
import { setNativeSkillEnabled } from "../native-skill-choices.ts";
import { botSkillTemplateSchema } from "../new-bot-defaults.ts";
import { fetchSkillFromSource, skillImportToken } from "../skill-fetch.ts";
import { skillImportSummary } from "../skill-folder.ts";
import { installLibrarySkill, librarySkillOptOuts, listLibrarySkills, readLibrarySkillFile, readSkillLibraryIndex, setLibrarySkillEveryBot, setLibrarySkillOptOut, setLibrarySkillReviewState, skillsLibraryEnabled, unassignLibrarySkill } from "../skill-library.ts";
import {
  installSkill, listBotSkillsWithOrigin, listSkills, listStagedSkillWrites, parseSkillMd, removeSkill, scanSkillText, setSkillEnabled,
  type SkillListing, type StagedSkillWrite,
} from "../skills.ts";
import type { BotRecord, Store } from "../store.ts";
import { githubAudience } from "./github-sign-in.ts";
import { withAllBotsOffer } from "./skills-for-all-bots.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotSkillsRouteDeps {
  store: Store;
  cfg: AppConfig;
  listBotSkills(bot: BotRecord, threadId?: string): SkillListing[];
  readBotSkillFile(bot: BotRecord, name: string): string | null;
  stagedSkillListing(staged: StagedSkillWrite): Omit<StagedSkillWrite, "files" | "baseSha256" | "baseAppliedStageId">;
  team: boolean;
}

export function createBotSkillsRoutes(deps: BotSkillsRouteDeps): RouteHandler {
  const { store, cfg, listBotSkills, readBotSkillFile, stagedSkillListing, team } = deps;
  return async ({ req, res, url, path, method, json, readBody, auth }) => {
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
          skills: withAllBotsOffer(bot, auth, [...skills, ...listBotSkills(bot, threadId).filter((skill) => !names.has(skill.name))]),
          library,
          assignedSkills: store.bot(m[1])!.assignedSkills,
          staged: listStagedSkillWrites(m[1]).map(stagedSkillListing),
        });
      }
      return json(res, 200, {
        skills: withAllBotsOffer(bot, auth, listBotSkills(bot, threadId)),
        staged: listStagedSkillWrites(m[1]).map(stagedSkillListing),
      });
    }
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ source: z.string().min(1).max(2000) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "source must be a GitHub or skills.sh URL, or owner/repo" });
      const fetched = await fetchSkillFromSource(parsed.data.source, fetch, undefined, () => skillImportToken(githubAudience(auth, team)));
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
      const shown = bot ? listBotSkills(bot).find((skill) => skill.name === m![2]) : undefined;
      // A skill from this computer, listed or removed from this bot, that none of its own or library skills shadows.
      if (bot && (shown ? (shown as { origin?: string }).origin === "imported" : Boolean(readImportedSkills()[m![2]!]))) {
        const result = setImportedSkillEnabled(bot.id, m[2]!, parsed.data.enabled);
        if ("error" in result) return json(res, 409, { error: result.error });
        return json(res, 200, { skill: result });
      }
      if (bot && listBotSkills(bot).some((skill) => skill.name === m![2] && "origin" in skill && skill.origin === "native")) {
        const result = setNativeSkillEnabled(bot.id, m[2]!, parsed.data.enabled);
        if ("error" in result) return json(res, 409, { error: result.error });
        const skill = listBotSkills(bot).find((entry) => entry.name === m![2]);
        if (!skill) return json(res, 404, { error: "no such skill" });
        return json(res, 200, { skill });
      }
      const result = setSkillEnabled(m[1]!, m[2]!, parsed.data.enabled);
      if ("error" in result) return json(res, 404, { error: result.error });
      return json(res, 200, { skill: result });
    }
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]!);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const name = m[2]!;
      const removed = removeSkill(bot.id, name);
      if (!("error" in removed)) return json(res, 200, { ok: true });
      if (listSkills(bot.id).some((skill) => skill.name === name)) return json(res, 409, { error: removed.error });
      if (skillsLibraryEnabled(cfg)) {
        const unassigned = unassignLibrarySkill(bot.id, name, bot.assignedSkills);
        if ("unassigned" in unassigned) {
          if ("assignedSkills" in unassigned) store.patchBot(bot.id, { assignedSkills: unassigned.assignedSkills });
          return json(res, 200, { ok: true });
        }
      }
      const origin = (listBotSkills(bot).find((skill) => skill.name === name) as { origin?: string } | undefined)?.origin;
      if (origin === "imported") {
        const scope = url.searchParams.get("scope");
        if (scope !== null && scope !== "bot" && scope !== "all-bots") return json(res, 400, { error: "scope must be bot or all-bots" });
        if (scope === "all-bots") {
          const purged = purgeImportedSkill(name);
          if ("error" in purged) return json(res, 409, { error: purged.error });
          removeImportedSkillForBot(bot.id, name);
          return json(res, 200, { ok: true, scope: "all-bots", sourceFilesTouched: false });
        }
        const removedForBot = removeImportedSkillForBot(bot.id, name);
        if ("error" in removedForBot) return json(res, 404, { error: removedForBot.error });
        return json(res, 200, { ok: true, scope: "bot", sourceFilesTouched: false });
      }
      if (origin === "native") return json(res, 404, { error: `"${name}" comes from this bot's engine and can't be removed here.` });
      return json(res, 404, { error: removed.error });
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
            .filter((bot) => bot.assignedSkills?.includes(listing.name) || (index[listing.name]?.everyBot === true && !librarySkillOptOuts(bot.id).has(listing.name)))
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
      for (const name of names) setLibrarySkillOptOut(m[1]!, name, false);
      store.patchBot(m[1]!, { assignedSkills: names });
      return json(res, 200, { assignedSkills: names });
    }
    return PASS;
  };
}
