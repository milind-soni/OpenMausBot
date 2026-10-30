import { z } from "zod";
import { MAX_TEAM_BACKUP_BYTES } from "../../shared/team-backup.ts";
import type { BotVisibility, WireBot, WireGroup } from "../../shared/wire.ts";
import { validateBotCwd } from "../bot-cwd.ts";
import { fetchBotDirectory, matchDirectoryBots, type MatchedDirectoryBot } from "../bot-directory.ts";
import { isBotPackage, packageSummary, parsePackageDocument, renderBotPackageMarkdown, type PackageDocument } from "../bot-package.ts";
import { parseVisibility } from "../bot-visibility.ts";
import type { AppConfig } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import type { OrgLibrary } from "../org-library.ts";
import {
  TeamExportError,
  createBotPackageExport,
  createLibraryPackageExport,
  createTeamPackageExport,
  type ExportablePackageSkill,
  type TeamExportSkip,
} from "../package-export.ts";
import {
  PackageImportError,
  importPackageDocument,
  importTeamManifest,
  type PackageImportDeps,
  type PackageImportResult,
} from "../package-import.ts";
import { readPublishedLibrary, writePublishedLibrary, type DefaultsPreset } from "../presets.ts";
import { scoutProject, suggestTeam } from "../project-scout.ts";
import { readPublishedTeam, writePublishedTeam } from "../published-teams.ts";
import type { RoutineManager } from "../routines.ts";
import { readSectionContext } from "../section-context.ts";
import { sectionKey, type BotRecord, type GroupRecord, type Store } from "../store.ts";
import { createTeamBackup, importTeamBackup } from "../team-backup.ts";
import { fetchGithubTeam, fetchGrokTemplateCard, fetchLibraryTeam, fetchTeamCatalog } from "../team-library.ts";
import { createTeamManifest, parseTeamManifest } from "../team-manifest.ts";
import { CursorFallback, defaultCursorSession, type CursorSession } from "../cursor-session.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TeamRouteDeps {
  store: Store;
  cfg: Pick<AppConfig, "mcpServers">;
  /** The exporting person's name, as a package's author: the server's profile's, or on a Team Cloud the person's own. */
  authorName(auth: RequestAuth): string | undefined;
  routines(): RoutineManager | null;
  orgLibrary(): Pick<OrgLibrary, "list" | "preview" | "add" | "offeredSkills" | "addOfferedSkill"> | null;
  broadcast(payload: Record<string, unknown>): void;
  publicBot(bot: BotRecord): WireBot;
  publicGroupState(record: GroupRecord): WireGroup;
  groupWithThread(group: GroupRecord): WireGroup;
  defaultSelection(): Promise<ModelSelection>;
  defaultsPresetFor(body: Record<string, unknown>, includeNotes: boolean): { preset: DefaultsPreset | null; skipped: TeamExportSkip[] };
  packageImportDeps(selection: ModelSelection): PackageImportDeps;
  starterNotes(botId: string): Array<{ path: string; text: string }>;
  checkedExportSkillNames(value: unknown, bots: readonly BotRecord[]): { ok: true; names: string[] } | { ok: false; error: string };
  collectExportSkills(bots: readonly BotRecord[], names: readonly string[]): ReadonlyMap<string, readonly ExportablePackageSkill[]>;
  collectTeamSkills(bots: readonly BotRecord[], selection: unknown):
    | { ok: true; all: boolean; skillsByBot: Map<string, ExportablePackageSkill[]>; skipped: TeamExportSkip[]; available: string[] }
    | { ok: false; error: string; available: string[] };
  /** The optional Cursor sign-in behind the one-click Grok Bot import; the app's own by default. */
  cursor?: () => CursorSession;
  /** On a Team Cloud: false for someone else's private chat, which a team backup never carries. */
  threadShown?(auth: RequestAuth): (threadId: string) => boolean;
}

export function createTeamRoutes(deps: TeamRouteDeps): RouteHandler {
  const {
    store, cfg, broadcast, publicBot, publicGroupState, groupWithThread, defaultSelection, defaultsPresetFor,
    packageImportDeps, starterNotes, checkedExportSkillNames, collectExportSkills, collectTeamSkills,
  } = deps;
  const cursorSession = deps.cursor ?? defaultCursorSession;
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    let m: RegExpMatchArray | null = null;
    const routines = deps.routines();
    const orgLibrary = deps.orgLibrary();
    if (method === "POST" && path === "/api/teams/export") {
      const body = await readBody(req, 8 * 1024 * 1024);
      const profileName = deps.authorName(auth);
      if (body.format === "package" && body.version === 2 && body.kind === "library") {
        const optional = (value: unknown) => (typeof value === "string" ? value : undefined);
        const built = defaultsPresetFor(body, body.includeMemory === true);
        try {
          const exported = createLibraryPackageExport({
            name: optional(body.name),
            tagline: optional(body.tagline),
            summary: optional(body.summary),
            release: optional(body.release),
            notes: optional(body.notes),
            authorName: profileName,
            published: readPublishedLibrary(),
            preset: built.preset,
            skipped: built.skipped,
          });
          if (body.dryRun !== true) writePublishedLibrary(exported.published);
          return json(res, 200, {
            document: exported.document,
            filename: exported.filename,
            redacted: exported.redacted,
            skipped: exported.skipped,
            summary: packageSummary(exported.document),
          });
        } catch (error) {
          if (error instanceof TeamExportError) return json(res, error.status, { error: error.message });
          throw error;
        }
      }
      if (body.format === "package" && body.version === 2) {
        if (typeof body.team !== "string") return json(res, 400, { error: "Choose a team to share." });
        const team = body.team.trim();
        if (team && !store.sections.includes(team) && !store.bots.some((bot) => sectionKey(bot.section) === team)) {
          return json(res, 404, { error: "That team no longer exists." });
        }
        const optional = (value: unknown) => (typeof value === "string" ? value : undefined);
        const teamBots = store.bots.filter((bot) => !bot.hidden && sectionKey(bot.section) === team);
        const skills = collectTeamSkills(teamBots, body.skills);
        if (!skills.ok) return json(res, 400, { error: skills.error, choices: { skills: skills.available } });
        const avatars = body.avatars && typeof body.avatars === "object" && !Array.isArray(body.avatars)
          ? body.avatars as Record<string, unknown>
          : undefined;
        const defaults = body.includeDefaultsPreset === true ? defaultsPresetFor(body, body.includeMemory === true) : null;
        try {
          const exported = createTeamPackageExport({
            team,
            name: optional(body.name),
            tagline: optional(body.tagline),
            summary: optional(body.summary),
            release: optional(body.release),
            notes: optional(body.notes),
            authorName: profileName,
            bots: store.bots,
            groups: store.groups,
            routines: routines!.listRoutines(),
            brief: readSectionContext(team)?.text,
            published: readPublishedTeam(team),
            skillsByBot: skills.skillsByBot,
            skillSelection: skills.all ? "all" : "chosen",
            memoryByBot: body.includeMemory === true ? new Map(teamBots.map((bot) => [bot.id, starterNotes(bot.id)])) : undefined,
            avatars,
            mcpServers: cfg.mcpServers ?? {},
            skipped: [...skills.skipped, ...(defaults?.skipped ?? [])],
            preset: defaults?.preset ?? null,
          });
          if (body.dryRun !== true) writePublishedTeam(team, exported.published);
          return json(res, 200, {
            document: exported.document,
            filename: exported.filename,
            redacted: exported.redacted,
            skipped: exported.skipped,
            summary: packageSummary(exported.document),
            choices: { skills: skills.available },
          });
        } catch (error) {
          if (error instanceof TeamExportError) return json(res, error.status, { error: error.message, choices: { skills: skills.available } });
          throw error;
        }
      }
      const name =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : profileName
            ? `${profileName}'s Team`
            : "My OpenMaus Team";
      const memberIds = store.bots.filter((bot) => !bot.hidden).map((bot) => bot.id);
      if ((body.format === "backup" ? store.bots.length : memberIds.length) === 0) return json(res, 400, { error: "Create a bot before exporting your team" });
      try {
        if (body.format === "backup") {
          return json(res, 200, createTeamBackup(store, routines!.listRoutines(), name, deps.threadShown?.(auth)));
        }
        if (body.format === "package") {
          const selectedBots = store.bots.filter((bot) => !bot.hidden);
          const skillNames = checkedExportSkillNames(body.skillIds, selectedBots);
          if (!skillNames.ok) return json(res, 400, { error: skillNames.error });
          const document = createBotPackageExport({
            name,
            authorName: profileName,
            bots: selectedBots,
            groups: store.groups,
            routines: routines!.listRoutines(),
            skillsByBot: collectExportSkills(selectedBots, skillNames.names),
          });
          return json(res, 200, {
            name: document.package.name,
            members: document.package.agents.length,
            markdown: renderBotPackageMarkdown(document),
          });
        }
        return json(
          res,
          200,
          createTeamManifest(
            {
              name,
              memberIds,
            },
            store.bots,
          ),
        );
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
    if (method === "POST" && path === "/api/team-library/grok") {
      // The public card only (name, creator, description): the full setup comes from the person's own Grok Bot.
      const body = await readBody(req);
      if (typeof body.url !== "string" || !body.url.trim()) {
        return json(res, 400, { error: "A Grok Bot share link is required" });
      }
      let card: Awaited<ReturnType<typeof fetchGrokTemplateCard>>;
      try {
        card = await fetchGrokTemplateCard(body.url);
      } catch (error) {
        const status = (error as { status?: number }).status;
        return json(res, status === 400 || status === 404 ? status : 502, {
          error: error instanceof Error ? error.message : "The Grok Bot could not be loaded",
        });
      }
      // Signed in to Cursor: the full setup too. Any failure keeps the card and the copy-paste export, with one line why.
      const session = cursorSession();
      if (!(await session.status()).signedIn) return json(res, 200, card);
      try {
        return json(res, 200, { ...card, export: await session.fetchTemplate(card) });
      } catch (error) {
        return json(res, 200, { ...card, exportNote: error instanceof CursorFallback ? error.message : "Cursor could not share this template's setup." });
      }
    }
    if (method === "GET" && path === "/api/team-library/cursor") {
      res.setHeader("cache-control", "no-store");
      return json(res, 200, await cursorSession().status());
    }
    if (method === "POST" && path === "/api/team-library/cursor/sign-in") {
      res.setHeader("cache-control", "no-store");
      return json(res, 200, cursorSession().startSignIn());
    }
    if (method === "POST" && path === "/api/team-library/cursor/sign-out") {
      cursorSession().signOut();
      return json(res, 200, await cursorSession().status());
    }
    if (method === "GET" && path === "/api/teams/scout") {
      // Creates nothing: bots exist only once the person sends the manifest to /api/teams/import.
      const validated = validateBotCwd(url.searchParams.get("cwd"));
      if (!validated.ok) return json(res, 400, { error: validated.error });
      if (!validated.cwd) return json(res, 400, { error: "scout needs a folder to read" });
      const profile = scoutProject(validated.cwd);
      return json(res, 200, { profile, suggestion: suggestTeam(profile) });
    }
    if (method === "GET" && path === "/api/teams/scout/directory") {
      const validated = validateBotCwd(url.searchParams.get("cwd"));
      if (!validated.ok) return json(res, 400, { error: validated.error });
      if (!validated.cwd) return json(res, 400, { error: "scout needs a folder to read" });
      let directory: MatchedDirectoryBot[] = [];
      try {
        directory = matchDirectoryBots(scoutProject(validated.cwd), await fetchBotDirectory());
      } catch (error) {
        console.warn("bot directory lookup failed:", error instanceof Error ? error.message : String(error));
      }
      return json(res, 200, { directory });
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
      const outcome = orgLibrary.add(packageId, packageImportDeps(await defaultSelection()));
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
          const imported = importTeamBackup(store, routines!, body, await defaultSelection(), { visibility: importVisibility });
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
      const deps = packageImportDeps(await defaultSelection());
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
