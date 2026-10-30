import { z } from "zod";

import type { WireBot } from "../../shared/wire.ts";
import type { BotRecord, Store } from "../store.ts";
import type { TeamComputers } from "../team-computers.ts";
import { USER_ERROR, userError, type UserErrorKey } from "../user-errors.ts";
import { PASS, type RouteHandler } from "./table.ts";

const STORE_REFUSALS: readonly UserErrorKey[] = ["serverError.department.notFound", "serverError.department.nameRule",
  "serverError.department.duplicate", "serverError.department.renameBusy", "serverError.department.emptyFirst", "serverError.department.deleteBusy", "serverError.department.generalChief"];

export function storeRefusal(error: string): { error: string; errorKey?: UserErrorKey } {
  const key = STORE_REFUSALS.find((candidate) => USER_ERROR[candidate] === error);
  return key ? userError(key) : { error };
}

export interface SidebarSectionRouteDeps {
  store: Store;
  teamComputers: TeamComputers;
  maxBots: number;
  assertTeamComputerChangeIdle(before: BotRecord, after: BotRecord): void;
  wireBot(bot: BotRecord): WireBot;
}

export function createSidebarSectionRoutes(deps: SidebarSectionRouteDeps): RouteHandler {
  const { store, teamComputers, assertTeamComputerChangeIdle, wireBot } = deps;
  const MAX_WORKSPACE_BOTS = deps.maxBots;
  const createSidebarSectionSchema = z.object({
    name: z.string(),
    botIds: z.array(z.string().regex(/^[\w-]+$/)).max(MAX_WORKSPACE_BOTS).default([]),
  }).strict();

  return async ({ req, res, url, path, method, json, readBody }) => {
    if (path === "/api/sidebar-sections" && method === "GET") {
      return json(res, 200, { sections: store.sections });
    }
    if (path === "/api/sidebar-sections" && (method === "PATCH" || method === "DELETE")) {
      const section = url.searchParams.get("section")?.trim();
      if (!section) return json(res, 400, { error: "Choose a named department" });
      if (method === "DELETE" && teamComputers.forSection(section)) return json(res, 409, userError("serverError.department.unassignComputer"));
      let nextName: string | null = null;
      if (method === "PATCH") {
        const parsed = z.object({ name: z.string().trim().min(1).max(60) }).strict().safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, userError("serverError.department.nameLength"));
        nextName = parsed.data.name;
      }
      const error = nextName === null ? store.deleteSection(section) : store.renameSection(section, nextName, teamComputers);
      if (error) return json(res, error === "No such department" ? 404 : 409, storeRefusal(error));
      return json(res, 200, { sections: store.sections });
    }
    if (method === "PUT" && path === "/api/sidebar-sections") {
      const section = url.searchParams.get("section")?.trim();
      if (!section || !store.sections.includes(section)) return json(res, 404, userError("serverError.department.notFound"));
      const ids = z.array(z.string().regex(/^[\w-]+$/)).max(MAX_WORKSPACE_BOTS);
      const parsed = z.object({ addBotIds: ids, removeBotIds: ids }).strict().safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "Provide addBotIds and removeBotIds" });
      for (const [botIds, destination] of [[parsed.data.addBotIds, section], [parsed.data.removeBotIds, undefined]] as const) {
        for (const id of botIds) {
          const bot = store.bot(id);
          if (bot) assertTeamComputerChangeIdle(bot, { ...bot, section: destination });
        }
      }
      const result = store.updateTeamMembers(section, parsed.data.addBotIds, parsed.data.removeBotIds);
      if (!result.ok) return json(res, result.reason === "unavailable" ? 404 : 409, result.reason === "chief-conflict" ? userError("serverError.department.moveChiefConflict")
          : result.reason === "membership-changed" ? userError("serverError.department.membershipChanged")
          : { error: "One or more bots are unavailable" });
      return json(res, 200, { sections: store.sections, bots: result.bots.map(wireBot) });
    }
    if (method === "POST" && path === "/api/sidebar-sections") {
      const parsed = createSidebarSectionSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: "Provide a department name and up to 100 valid botIds" });
      }
      const name = parsed.data.name.trim();
      if (name.length > 60) {
        return json(res, 400, { error: "name must be at most 60 characters" });
      }
      const botIds = [...new Set(parsed.data.botIds)];
      if (!name && !botIds.length) return json(res, 400, { error: "Department name is required" });
      for (const botId of botIds) {
        const bot = store.bot(botId);
        if (bot) assertTeamComputerChangeIdle(bot, { ...bot, section: name || undefined });
      }
      const result = store.setBotsSection(botIds, name);
      if (!result.ok) {
        if (result.reason === "chief-conflict") {
          return json(res, 409, {
            ...userError("serverError.department.oneChief"),
          });
        }
        return json(res, 404, { error: "one or more bots are unavailable" });
      }
      return json(res, 200, { section: name, sections: store.sections, bots: result.bots.map(wireBot) });
    }
    return PASS;
  };
}
