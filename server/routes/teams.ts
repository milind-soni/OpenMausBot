// The team export/import and channel-creation HTTP routes (create a
// channel, export the team as manifest/package/backup, the team-library
// dispatch, the project scout and its community directory, and team
// import), extracted verbatim from index.ts's dispatch chain. Path
// matching, methods, and status codes are unchanged; the handler returns
// false for anything it does not own so the chain falls through in the
// same order. The channel/group views and the pagination helper are
// index-local and cross via deps; routines is a late-bound thunk over
// index.ts's let; store/cfg/defaultSelection are live bindings from
// ../runtime.ts; everything else is imported from its source module. The
// handleTeamLibrary dispatch line sits inside this span and moves with it,
// exactly as messages.ts carried handleSearch.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, readJsonValue, type RouteContext } from "./http.ts";
import { handleTeamLibrary } from "./team-library.ts";
import type { createEventsRoutes } from "./events.ts";
import { cfg, defaultSelection, store } from "../runtime.ts";
import { validateBotCwd } from "../bot-cwd.ts";
import { fetchBotDirectory, matchDirectoryBots, type MatchedDirectoryBot } from "../bot-directory.ts";
import { scoutProject, suggestTeam } from "../project-scout.ts";
import { isBotPackage, packageAgentAsMember, parseBotPackage, renderBotPackageMarkdown } from "../bot-package.ts";
import { createTeamManifest, importedMemberProfile, parseTeamManifest } from "../team-manifest.ts";
import { takeImportName } from "../../shared/import-name.ts";
import { createBotPackageExport } from "../package-export.ts";
import { createTeamBackup, importTeamBackup } from "../team-backup.ts";
import { MAX_TEAM_BACKUP_BYTES } from "../../shared/team-backup.ts";
import { checkedExportSkillNames, collectExportSkills } from "../checked-inputs.ts";
import { installSkill } from "../skills.ts";
import type { GroupRecord, Message } from "../store.ts";
import type { WireGroup } from "../../shared/wire.ts";
import type { RoutineManager } from "../routines.ts";
import type { createBotViews } from "../bot-views.ts";

type BotViews = ReturnType<typeof createBotViews>;

export function createTeamRoutes(deps: {
  createChannel: (value: unknown) => GroupRecord;
  publicGroupState: (group: GroupRecord) => WireGroup;
  publicBot: BotViews["publicBot"];
  messagePage: (
    threadId: string,
    limit: number | undefined,
    before?: string | null,
  ) => {
    messages: (Message | Record<string, unknown>)[];
    hasMore?: boolean;
    activeLeafId?: string | null;
  };
  broadcast: ReturnType<typeof createEventsRoutes>["broadcast"];
  routines: () => RoutineManager | null;
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, url } = rctx;
    const { createChannel, publicGroupState, publicBot, messagePage, broadcast, routines } = deps;
    // ── channels (persisted internally as groups) ───────────────────────
    if (method === "POST" && path === "/api/groups") {
      const group = createChannel(await readBody(req));
      json(res, 201, { group: { ...publicGroupState(group), messages: [] } });
      return true;
    }
    if (method === "POST" && path === "/api/teams/export") {
      const body = await readBody(req);
      const profileName = cfg.profile?.name?.trim();
      const name =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : profileName
            ? `${profileName}'s Team`
            : "My OpenMaus Team";
      const memberIds = store.bots.filter((bot) => !bot.hidden).map((bot) => bot.id);
      if ((body.format === "backup" ? store.bots.length : memberIds.length) === 0) {
        json(res, 400, { error: "Create a bot before exporting your team" });
        return true;
      }
      try {
        if (body.format === "backup") {
          json(res, 200, createTeamBackup(store, routines()!.listRoutines(), name));
          return true;
        }
        if (body.format === "package") {
          const selectedBots = store.bots.filter((bot) => !bot.hidden);
          const skillNames = checkedExportSkillNames(body.skillIds, selectedBots);
          if (!skillNames.ok) {
            json(res, 400, { error: skillNames.error });
            return true;
          }
          const document = createBotPackageExport({
            name,
            authorName: profileName,
            bots: selectedBots,
            groups: store.groups,
            routines: routines()!.listRoutines(),
            skillsByBot: collectExportSkills(selectedBots, skillNames.names),
          });
          json(res, 200, {
            name: document.package.name,
            members: document.package.agents.length,
            markdown: renderBotPackageMarkdown(document),
          });
          return true;
        }
        json(
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
        return true;
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : "Team could not be exported" });
        return true;
      }
    }
    if (await handleTeamLibrary(req, res, rctx)) return true;
    if (method === "GET" && path === "/api/teams/scout") {
      // The scout reads a folder and answers with a suggestion — it creates
      // nothing. Bots and the room come into being only when the human sends
      // the suggested manifest through /api/teams/import, so "the agent
      // proposes, the person imports" is enforced by the route split itself.
      // The folder is whatever validateBotCwd accepts: the same local-user
      // trust boundary as pointing any bot's working folder at a path.
      // Deliberately offline — the community directory lives on its own
      // route below, so a slow network can never delay the suggestion.
      const validated = validateBotCwd(url.searchParams.get("cwd"));
      if (!validated.ok) {
        json(res, 400, { error: validated.error });
        return true;
      }
      if (!validated.cwd) {
        json(res, 400, { error: "scout needs a folder to read" });
        return true;
      }
      const profile = scoutProject(validated.cwd);
      json(res, 200, { profile, suggestion: suggestTeam(profile) });
      return true;
    }
    if (method === "GET" && path === "/api/teams/scout/directory") {
      // Community bots that fit the scouted folder — a separate, lazy call
      // so an unreachable directory degrades to "no extra candidates", never
      // to a broken scout.
      const validated = validateBotCwd(url.searchParams.get("cwd"));
      if (!validated.ok) {
        json(res, 400, { error: validated.error });
        return true;
      }
      if (!validated.cwd) {
        json(res, 400, { error: "scout needs a folder to read" });
        return true;
      }
      let directory: MatchedDirectoryBot[] = [];
      try {
        directory = matchDirectoryBots(scoutProject(validated.cwd), await fetchBotDirectory());
      } catch (error) {
        // an unreachable directory is a fact of life, not an error — but an
        // empty section should still be diagnosable from the server log
        console.warn("bot directory lookup failed:", error instanceof Error ? error.message : String(error));
      }
      json(res, 200, { directory });
      return true;
    }
    if (method === "POST" && path === "/api/teams/import") {
      // Import is additive-only. A manifest is untrusted input (catalog,
      // GitHub, a shared file), so it must be structurally unable to reach
      // records the user already has: every member becomes a NEW bot with a
      // fresh id — a manifest cannot name, update, or merge into an existing
      // bot or room. Repeated imports create freshly numbered copies.
      const importMode = url.searchParams.get("mode") ?? "add";
      if (importMode === "replace") {
        json(res, 400, { error: "Replacing your team is no longer supported. Reopen Import in the updated app to add bots alongside your existing conversations." });
        return true;
      }
      if (importMode !== "add" && importMode !== "project") {
        json(res, 400, { error: "Team import mode must be add or project" });
        return true;
      }
      // `project` adds the team AND opens a caller-owned room on a folder.
      // Legacy team manifests remain people-only. Full bot packages may add
      // their own new rooms, but neither format can point at an existing room
      // or choose a local folder; workspace access always comes from this
      // explicit caller parameter.
      let projectCwd: string | null = null;
      if (importMode === "project") {
        const requested = url.searchParams.get("cwd");
        if (requested !== null) {
          const validated = validateBotCwd(requested);
          if (!validated.ok) {
            json(res, 400, { error: validated.error });
            return true;
          }
          projectCwd = validated.cwd;
        }
      }
      const body = await readJsonValue(req, MAX_TEAM_BACKUP_BYTES);
      if (body?.format === "openmaus.backup") {
        if (importMode !== "add") {
          json(res, 400, { error: "Import backups alongside your existing bots; project mode is only for templates" });
          return true;
        }
        try {
          const imported = importTeamBackup(store, routines()!, body, await defaultSelection());
          const bots = imported.bots.map((bot) => publicBot(bot));
          const groups = imported.groups.map((group) => ({ ...publicGroupState(group), ...messagePage(group.threadId, undefined) }));
          for (const bot of bots) broadcast({ kind: "bot", bot });
          for (const group of groups) broadcast({ kind: "group", group });
          json(res, 201, { ...imported, bots, groups });
          return true;
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : "Backup could not be imported" });
          return true;
        }
      }
      let packageDocument: ReturnType<typeof parseBotPackage> | null = null;
      let manifest: ReturnType<typeof parseTeamManifest> | null = null;
      try {
        if (isBotPackage(body)) packageDocument = parseBotPackage(body);
        else manifest = parseTeamManifest(body);
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : "Invalid bot package" });
        return true;
      }
      const pkg = packageDocument?.package;
      const importName = pkg?.name ?? manifest!.team.name;
      const sourceMembers = pkg
        ? pkg.agents.map((agent) => ({ member: packageAgentAsMember(agent), playbookKeys: agent.playbooks ?? [], skillNames: agent.skills ?? [] }))
        : manifest!.team.members.map((member) => ({ member, playbookKeys: [] as string[], skillNames: [] as string[] }));

      const importedBots: ReturnType<typeof store.createBot>[] = [];
      const createdGroups: GroupRecord[] = [];
      const createdRoutineIds: string[] = [];
      // Names already in use, hidden bots included: an archived bot can be
      // un-archived later, and a revived duplicate would be just as
      // ambiguous then.
      const takenNames = new Set(store.bots.map((bot) => bot.name.trim().toLowerCase()));
      const memberIds = new Map<string, string>();
      let group: GroupRecord | undefined;
      let importSection: string | undefined;
      try {
        const selection = await defaultSelection();
        const existingSections = new Set(
          [...store.sections, ...store.bots.map((bot) => bot.section), ...store.groups.map((candidate) => candidate.section)]
            .filter((section): section is string => Boolean(section?.trim()))
            .map((section) => section.trim().toLowerCase()),
        );
        // Every template gets its own section, including legacy teams and
        // project imports. Never merge into an existing section (or replace
        // its Chief). Keep the name editable through the 60-character API.
        importSection = takeImportName(importName, existingSections, 60);
        const playbookByKey = new Map((pkg?.playbooks ?? []).map((playbook) => [playbook.key, playbook]));
        const packageSkillByName = new Map((pkg?.skills?.entries ?? []).map((skill) => [skill.name, skill]));
        for (const source of sourceMembers) {
          const member = source.member;
          // importedMemberProfile is the authority boundary: persona fields
          // only, colliding names numbered. seedMessages: false — an
          // imported bot must not open by greeting the user as though it
          // were new. composio: false — a shared persona never starts with
          // reach into the user's connected apps (absence would mean
          // allowed); the user can switch it on per bot after reading who
          // they got.
          const created = store.createBot(
            {
              ...importedMemberProfile(member, takenNames),
              modelSelection: selection,
              section: importSection,
            },
            { seedMessages: false },
          );
          importedBots.push(created);
          const installedPlaybooks = source.playbookKeys.flatMap((key) => {
            const playbook = playbookByKey.get(key);
            return playbook ? [{ ...playbook }] : [];
          });
          store.patchBot(created.id, {
            composio: false,
            ...(installedPlaybooks.length ? { playbooks: installedPlaybooks } : {}),
            ...(pkg
              ? {
                  installedPackage: {
                    id: pkg.id,
                    name: pkg.name,
                    release: pkg.release,
                    requiredApps: pkg.requirements.apps.map((app) => ({ ...app })),
                  },
                }
              : {}),
          });
          for (const skillName of source.skillNames) {
            const skill = packageSkillByName.get(skillName);
            if (!skill) throw new Error(`Package skill "${skillName}" is unavailable`);
            const installed = installSkill(created.id, skill.source ?? `package:${pkg!.id}`, [
              { path: "SKILL.md", content: skill.instructions },
            ]);
            if ("error" in installed) {
              throw new Error(`Package skill "${skillName}" could not be imported: ${installed.error}`);
            }
          }
          memberIds.set(member.key, created.id);
        }

        // A package is an explicit structure import: its rooms are created
        // from package-local keys only, then normalized to fresh bot ids.
        for (const room of pkg?.rooms ?? []) {
          const ids = room.members.map((key) => memberIds.get(key)!);
          let created = store.createGroup(room.name, ids, false, importSection);
          createdGroups.push(created);
          const defaultResponder = room.defaultResponder.kind === "agent"
            ? { kind: "member" as const, botId: memberIds.get(room.defaultResponder.agent)! }
            : { kind: room.defaultResponder.kind } as const;
          created = store.patchGroup(created.id, {
            bulletin: room.bulletin ?? "",
            defaultResponder,
            setupCompletedAt: Date.now(),
          }) ?? created;
        }

        for (const routine of pkg?.routines ?? []) {
          const created = routines()!.create({
            name: routine.name,
            prompt: routine.prompt,
            botId: memberIds.get(routine.agent)!,
            runOn: routine.runOn,
            enabled: false,
            schedule: routine.schedule,
            durationMinutes: routine.durationMinutes,
            ...(routine.timeoutMinutes === undefined ? {} : { timeoutMinutes: routine.timeoutMinutes }),
          });
          createdRoutineIds.push(created.id);
        }

        if (pkg?.chiefOfStaff) {
          store.setChiefOfStaff(memberIds.get(pkg.chiefOfStaff)!);
        }

        // The room is created last, so a failure anywhere above leaves no
        // half-built project behind — the catch below deletes the bots and
        // there is no room pointing at them.
        if (!pkg && importMode === "project" && importedBots.length > 0) {
          const roomName = url.searchParams.get("room")?.trim() || manifest!.team.name;
          group = store.createGroup(roomName, importedBots.map((bot) => bot.id), false, importSection);
          createdGroups.push(group);
          if (projectCwd) {
            // `cwd` is the folder the room WANTS; the store pins it on the
            // first turn (pinGroupCwd). Setting the pin here would decide it
            // before anyone has worked, which is the store's call, not ours.
            group = store.patchGroup(group.id, { cwd: projectCwd }) ?? group;
          }
          broadcast({ kind: "group", group: publicGroupState(group) });
        }

        const publicBots = importedBots.map((bot) => publicBot(store.bot(bot.id)!));
        for (const bot of publicBots) broadcast({ kind: "bot", bot });

        json(res, 201, {
          name: importName,
          bots: publicBots,
          group,
          groups: createdGroups.map((created) => ({ ...created, messages: [] })),
          routines: createdRoutineIds.flatMap((id) => routines()!.listRoutines().filter((routine) => routine.id === id)),
        });
        return true;
      } catch (error) {
        // A room of deleted members must not survive either — patchGroup can
        // throw (disk) after createGroup already saved.
        for (const routineId of createdRoutineIds) routines()!.remove(routineId);
        for (const created of createdGroups) store.deleteGroup(created.id);
        for (const bot of importedBots) store.deleteBot(bot.id);
        // Empty teams are now durable too. This import allocated a fresh
        // identity, so its failed installation must retire that identity.
        if (importSection && store.sections.includes(importSection)) store.changeEmptySection(importSection, null);
        throw error;
      }
    }
    return false;
  };
}
