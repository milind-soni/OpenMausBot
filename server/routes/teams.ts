import { z } from "zod";
import { MAX_TEAM_BACKUP_BYTES } from "../../shared/team-backup.ts";
import type { BotVisibility, WireBot, WireGroup } from "../../shared/wire.ts";
import { validateBotCwd } from "../bot-cwd.ts";
import { isBotPackage, parsePackageDocument, type PackageDocument } from "../bot-package.ts";
import { parseVisibility } from "../bot-visibility.ts";
import { teamCreator } from "../new-bot-sharing.ts";
import type { ModelSelection } from "../contracts.ts";
import type { OrgLibrary } from "../org-library.ts";
import {
  PackageImportError,
  importPackageDocument,
  importTeamManifest,
  type PackageImportDeps,
  type PackageImportResult,
} from "../package-import.ts";
import type { Routine, RoutineManager } from "../routines.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";
import { createTeamBackup, importTeamBackup } from "../team-backup.ts";
import { fetchGithubTeam, fetchLibraryTeam, fetchTeamCatalog } from "../team-library.ts";
import { parseTeamManifest } from "../team-manifest.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TeamRouteDeps {
  store: Store;
  /** The exporting person's name, as a package's author: the server's profile's, or on a Team Cloud the person's own. */
  authorName(auth: RequestAuth): string | undefined;
  routines(): RoutineManager | null;
  orgLibrary(): Pick<OrgLibrary, "list" | "preview" | "add" | "offeredSkills" | "addOfferedSkill"> | null;
  broadcast(payload: Record<string, unknown>): void;
  publicBot(bot: BotRecord): WireBot;
  publicGroupState(record: GroupRecord): WireGroup;
  groupWithThread(group: GroupRecord): WireGroup;
  defaultSelection(): Promise<ModelSelection>;
  packageImportDeps(selection: ModelSelection): PackageImportDeps;
  /** On a Team Cloud: false for someone else's private chat, which a team backup never carries. */
  threadShown?(auth: RequestAuth): (threadId: string) => boolean;
  /** On a Team Cloud: false for someone else's own MausBot, which no export carries. */
  botShown?(auth: RequestAuth): (botId: string) => boolean;
  /** On a Team Cloud: false for a routine that lives in someone else's private chat, which no export carries. */
  routineShown?(auth: RequestAuth): (routine: Routine) => boolean;
}

export function createTeamRoutes(deps: TeamRouteDeps): RouteHandler {
  const routinesFor = (auth: RequestAuth): Routine[] => {
    const all = deps.routines()!.listRoutines();
    const shown = deps.routineShown?.(auth);
    return shown ? all.filter(shown) : all;
  };
  const { store, broadcast, publicBot, publicGroupState, groupWithThread, defaultSelection, packageImportDeps } = deps;
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    let m: RegExpMatchArray | null = null;
    const routines = deps.routines();
    const orgLibrary = deps.orgLibrary();
    if (method === "POST" && path === "/api/teams/export") {
      const body = await readBody(req, 8 * 1024 * 1024);
      if (body?.format !== "backup") return json(res, 400, { error: "Only backups are exported here. Share a bot or a department as a template instead." });
      const botShown = deps.botShown?.(auth), exportable = botShown ? store.bots.filter((bot) => botShown(bot.id)) : store.bots;
      const profileName = deps.authorName(auth);
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : profileName ? `${profileName}'s Team` : "My OpenMaus Team";
      if (exportable.length === 0) return json(res, 400, { error: "Create a bot before exporting your team" });
      try {
        return json(res, 200, createTeamBackup(store, routinesFor(auth), name, deps.threadShown?.(auth)));
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "Team could not be exported" });
      }
    }
    if (method === "GET" && path === "/api/team-library/catalog") {
      try {
        return json(res, 200, await fetchTeamCatalog());
      } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : "The team library is unavailable" });
      }
    }
    m = path.match(/^\/api\/team-library\/teams\/([a-z0-9][a-z0-9-]*)$/);
    if (m && method === "GET") {
      try {
        return json(res, 200, await fetchLibraryTeam(m[1]));
      } catch (error) {
        const status = (error as { status?: number }).status === 404 ? 404 : 502;
        return json(res, status, { error: error instanceof Error ? error.message : "The team could not be loaded" });
      }
    }
    if (method === "POST" && path === "/api/team-library/github") {
      const body = await readBody(req);
      if (typeof body.url !== "string" || !body.url.trim()) {
        return json(res, 400, { error: "A GitHub URL is required" });
      }
      try {
        return json(res, 200, await fetchGithubTeam(body.url));
      } catch (error) {
        const status = (error as { status?: number }).status === 404 ? 404 : 400;
        return json(res, status, { error: error instanceof Error ? error.message : "The GitHub team could not be loaded" });
      }
    }
    if (method === "GET" && path === "/api/org-library") {
      return json(res, 200, orgLibrary?.list() ?? { organization: null, packages: [] });
    }
    m = path.match(/^\/api\/org-library\/packages\/([a-f0-9-]{36})$/);
    if (m && method === "GET") {
      const outcome = orgLibrary?.preview(m[1]!);
      if (!outcome) return json(res, 404, { error: "This package is not in your organization's library.", code: "not_listed" });
      return outcome.ok ? json(res, 200, outcome.value) : json(res, outcome.status, { error: outcome.error, code: outcome.code });
    }
    if (method === "POST" && path === "/api/org-library/add") {
      const body = await readBody(req);
      const packageId = typeof body?.packageId === "string" && /^[a-f0-9-]{36}$/.test(body.packageId) ? body.packageId : null;
      if (!packageId) return json(res, 400, { error: "Choose a package from your organization's library." });
      if (!orgLibrary) return json(res, 404, { error: "This package is not in your organization's library.", code: "not_listed" });
      const outcome = orgLibrary.add(packageId, { ...packageImportDeps(await defaultSelection()), ...teamCreator(auth) });
      if (!outcome.ok) return json(res, outcome.status, { error: outcome.error, code: outcome.code });
      if (outcome.value.alreadyAdded) return json(res, 200, outcome.value);
      const imported = outcome.value.result;
      return json(res, 201, {
        alreadyAdded: false,
        installId: imported.installId,
        name: imported.name,
        section: imported.section,
        bots: imported.bots.map((bot) => publicBot(store.bot(bot.id) ?? bot)),
        groups: imported.groups.map((created) => ({ ...publicGroupState(store.group(created.id) ?? created), messages: [] })),
        routines: imported.routines,
        offeredSkills: imported.offeredSkills,
        connections: imported.connections,
        skipped: imported.skipped,
        brief: imported.brief,
        notes: imported.notes,
        presets: imported.presets ?? [],
      });
    }
    if (method === "GET" && path === "/api/org-library/skills") {
      const botId = url.searchParams.get("botId") ?? undefined;
      return json(res, 200, orgLibrary?.offeredSkills(botId) ?? { organization: null, skills: [] });
    }
    if (method === "POST" && path === "/api/org-library/skills") {
      const body = await readBody(req);
      const parsed = z.object({ botId: z.string().min(1).max(128), installId: z.string().regex(/^[a-f0-9]{32}$/), name: z.string().min(1).max(64) })
        .safeParse(body);
      if (!parsed.success) return json(res, 400, { error: "Choose a bot and a skill from your organization's library." });
      if (!orgLibrary) return json(res, 404, { error: "This package is not in your organization's library.", code: "not_listed" });
      const outcome = orgLibrary.addOfferedSkill(parsed.data.botId, parsed.data.installId, parsed.data.name);
      return outcome.ok ? json(res, 201, { skill: outcome.value }) : json(res, outcome.status, { error: outcome.error, code: outcome.code });
    }
    if (method === "POST" && path === "/api/teams/import") {
      // Additive-only: a manifest is untrusted, so every member becomes a NEW bot and none can name an existing bot or room.
      const importMode = url.searchParams.get("mode") ?? "add";
      if (importMode === "replace") {
        return json(res, 400, { error: "Replacing your team is no longer supported. Reopen Import in the updated app to add bots alongside your existing conversations." });
      }
      if (importMode !== "add" && importMode !== "project") {
        return json(res, 400, { error: "Team import mode must be add or project" });
      }
      // No format can point at an existing room or choose a folder: workspace access comes only from this parameter.
      let projectCwd: string | null = null;
      if (importMode === "project") {
        const requested = url.searchParams.get("cwd");
        if (requested !== null) {
          const validated = validateBotCwd(requested);
          if (!validated.ok) return json(res, 400, { error: validated.error });
          projectCwd = validated.cwd;
        }
      }
      // The admin's choice, never the file's.
      const rawVisibility = url.searchParams.get("visibility");
      let importVisibility: BotVisibility | undefined;
      if (rawVisibility !== null) {
        let value: unknown = rawVisibility;
        if (rawVisibility.trim().startsWith("{")) {
          try {
            value = JSON.parse(rawVisibility);
          } catch {
          }
        }
        const parsed = parseVisibility(value);
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        importVisibility = parsed.visibility;
      }
      const body = await readBody(req, MAX_TEAM_BACKUP_BYTES);
      if (body?.format === "openmaus.backup") {
        if (importMode !== "add") return json(res, 400, { error: "Import backups alongside your existing bots; project mode is only for templates" });
        try {
          const imported = importTeamBackup(store, routines!, body, await defaultSelection(), { visibility: importVisibility, ...teamCreator(auth) });
          // A restore writes transcripts without store events: these frames carry the restored pages to other clients.
          const bots = imported.bots.map((bot) => publicBot(bot));
          const groups = imported.groups.map((group) => groupWithThread(group));
          for (const bot of bots) broadcast({ kind: "bot", bot });
          for (const group of groups) broadcast({ kind: "group", group });
          return json(res, 201, { ...imported, bots, groups });
        } catch (error) {
          return json(res, 400, { error: error instanceof Error ? error.message : "Backup could not be imported" });
        }
      }
      // Read as a FILE: it cannot claim a publisher, its skills and routines arrive off; only the org library imports with trust "org".
      let packageDocument: PackageDocument | null = null;
      let manifest: ReturnType<typeof parseTeamManifest> | null = null;
      try {
        if (isBotPackage(body)) packageDocument = parsePackageDocument(body, { trust: "file" });
        else manifest = parseTeamManifest(body);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "Invalid bot package" });
      }
      const deps = { ...packageImportDeps(await defaultSelection()), ...teamCreator(auth) };
      const options = {
        mode: importMode as "add" | "project",
        cwd: projectCwd,
        room: url.searchParams.get("room") ?? undefined,
        ...(importVisibility ? { visibility: importVisibility } : {}),
      };
      let imported: PackageImportResult;
      try {
        const result = packageDocument
          ? importPackageDocument(packageDocument, { ...options, trust: "file" }, deps)
          : importTeamManifest(manifest!, options, deps);
        if (result.alreadyAdded) return json(res, 200, result);
        imported = result;
      } catch (error) {
        if (error instanceof PackageImportError) return json(res, error.status, { error: error.message, code: error.code });
        throw error;
      }
      return json(res, 201, {
        name: imported.name,
        section: imported.section,
        bots: imported.bots.map((bot) => publicBot(store.bot(bot.id) ?? bot)),
        group: imported.group,
        groups: imported.groups.map((created) => ({ ...created, messages: [] })),
        routines: imported.routines,
        offeredSkills: imported.offeredSkills,
        connections: imported.connections,
        skipped: imported.skipped,
        brief: imported.brief,
        notes: imported.notes,
        presets: imported.presets ?? [],
      });
    }
    return PASS;
  };
}
