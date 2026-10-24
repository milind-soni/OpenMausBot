import type { WireBot } from "../../shared/wire.ts";
import { validateMascotProfile } from "../custom-mascot-validation.ts";
import { validateBotCwd } from "../bot-cwd.ts";
import { parseBotProfilePatch } from "../bot-profile.ts";
import { parseVisibility } from "../bot-visibility.ts";
import type { createCloudRoutineAuthors } from "../cloud-lending.ts";
import type { AppConfig } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import type { hostedModelPolicy } from "../hosted-models.ts";
import { MAX_MCP_SERVERS, mcpServerNameError } from "../mcp-registry.ts";
import { journalMemoryWrite } from "../memory-journal.ts";
import { resolveBotCreationDefaults } from "../new-bot-defaults.ts";
import { PRESET_UNAVAILABLE_MESSAGE, applyPresetToBot, presetOffered, type OrgInstallStatus, type PresetStore } from "../presets.ts";
import { clientBotPatchViolation, type RequestAuth } from "../request-auth.ts";
import type { RoutineManager } from "../routines.ts";
import { installOrgSkill, installSkill, parseSkillMd, setSkillEnabled } from "../skills.ts";
import type { BotRecord, Store } from "../store.ts";
import type { TeamPeople } from "../team-people.ts";
import { writeMemoryFile, writeMemoryTopic } from "../workspace.ts";
import { PASS, type RouteHandler } from "./table.ts";

export type ModelSelectionCheck = { ok: true; selection: ModelSelection } | { ok: false; status: number; error: string };

export interface BotCreateRouteDeps {
  store: Store;
  cfg: AppConfig;
  presetStore: Pick<PresetStore, "resolve">;
  orgInstallStatuses(): ReadonlyMap<string, OrgInstallStatus>;
  /** A hosted (company) workspace: Full access comes only from its policy. */
  hostedWorkspace: boolean;
  hostedFullAccessRefusal: string;
  desktopManaged: boolean;
  maxWorkspaceBots: number;
  cloudOwnerKey: string | null;
  hostedModels: ReturnType<typeof hostedModelPolicy>;
  cloudRoutineAuthors: ReturnType<typeof createCloudRoutineAuthors> | null;
  routines(): RoutineManager | null;
  storedAvatarExists(avatarUrl: string): boolean;
  defaultSelection(): Promise<ModelSelection>;
  checkedModelSelection(raw: unknown, current?: { selection: ModelSelection; busy: boolean }, requireAvailableModel?: boolean): ModelSelectionCheck;
  cloudOwnerSession(auth: RequestAuth): boolean;
  wireBot(bot: BotRecord): WireBot;
  /** A Team Cloud: a new bot records who created it, and may name who it reports to. */
  team?: { name: string; people: Pick<TeamPeople, "has"> } | null;
}

const OWN_ID = /^[\w-]{8,128}$/;

/** A bot sent from the person's other computer keeps its id and its conversation's, so later sends and Bring newer
 * chats find it. Only ids in the server's own form, and only while nothing here uses them. */
export function keptBotIds(body: Record<string, unknown>, store: Pick<Store, "bot" | "botByThread" | "groupByThread">): { id?: string; threadId?: string } | { error: string } {
  const { id, threadId } = body;
  if (id === undefined && threadId === undefined) return {};
  if (typeof id !== "string" || !OWN_ID.test(id) || (threadId !== undefined && (typeof threadId !== "string" || !OWN_ID.test(threadId)))) {
    return { error: "id and threadId must be ids of letters, digits, - and _ (8 to 128)" };
  }
  if (store.bot(id) || store.botByThread(id) || store.groupByThread(id)) return { error: "a bot with this id already exists here" };
  if (threadId !== undefined && (threadId === id || store.bot(threadId) || store.botByThread(threadId) || store.groupByThread(threadId))) {
    return { error: "this conversation id is already used here" };
  }
  return { id, ...(threadId === undefined ? {} : { threadId }) };
}

export function createBotCreateRoutes(deps: BotCreateRouteDeps): RouteHandler {
  const {
    store, cfg, presetStore, orgInstallStatuses,
    hostedWorkspace: HOSTED_WORKSPACE, hostedFullAccessRefusal: HOSTED_FULL_ACCESS_REFUSAL, desktopManaged: DESKTOP_MANAGED,
    maxWorkspaceBots: MAX_WORKSPACE_BOTS, cloudOwnerKey: CLOUD_OWNER_KEY,
    hostedModels, cloudRoutineAuthors,
    storedAvatarExists, defaultSelection, checkedModelSelection, cloudOwnerSession, wireBot,
  } = deps;
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const routines = deps.routines();
    if (method === "POST" && path === "/api/bots") {
      let body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "bot must be a JSON object" });
      }
      const kept = keptBotIds(body, store);
      if ("error" in kept) return json(res, kept.error.includes("already") ? 409 : 400, { error: kept.error });
      const { id: _id, threadId: _threadId, ...rest } = body;
      body = rest;
      let mascotProfile: ReturnType<typeof validateMascotProfile> | undefined;
      if (body.mascotProfile !== undefined) {
        try {
          mascotProfile = validateMascotProfile(body.mascotProfile);
        } catch (error) {
          return json(res, 400, { error: error instanceof Error ? error.message : "mascotProfile is invalid" });
        }
      }
      const template = resolveBotCreationDefaults(cfg.newBotDefaults, body);
      const settings = template.profile;
      if (auth.kind === "session" && !auth.scopes.includes("admin")) {
        const field = clientBotPatchViolation(settings);
        if (field || body.preset !== undefined || template.skills.length || template.routines.length || Object.keys(template.memory).length) {
          return json(res, 403, { error: "Creating a bot with these defaults needs the admin scope" });
        }
      }
      if (body.preset !== undefined && (typeof body.preset !== "string" || !/^[\w-]{1,64}$/.test(body.preset))) {
        return json(res, 400, { error: "preset must be a preset id from New bot" });
      }
      const resolvedPreset = typeof body.preset === "string" ? presetStore.resolve(body.preset) : null;
      const preset = resolvedPreset && presetOffered(resolvedPreset.row, orgInstallStatuses()) ? resolvedPreset : null;
      if (body.preset !== undefined && !preset) return json(res, 404, { error: PRESET_UNAVAILABLE_MESSAGE });
      body = { ...body, ...settings, name: settings.name };
      // Custom comes only through the desktop's private channel.
      if (settings.approvalMode === "custom") {
        return json(res, 403, { error: "Custom approval requires the desktop permission flow. Use the bot creation dialog or choose another level for API creation." });
      }
      if (settings.approvalMode === "full" && HOSTED_WORKSPACE) return json(res, 403, { error: HOSTED_FULL_ACCESS_REFUSAL });
      if (settings.computer === "local" && settings.approvalMode === "auto" && body.acknowledgeLocalAuto !== true) {
        return json(res, 400, { error: "Auto mode on this computer requires confirming the warning first (acknowledgeLocalAuto)" });
      }
      if (settings.avatarUrl && !storedAvatarExists(settings.avatarUrl)) {
        return json(res, 400, { error: "avatarUrl must reference an existing stored image" });
      }
      if (settings.browserProfile && settings.browserProfile !== "guest" && !(cfg.browserProfiles ?? []).some(profile => profile.id === settings.browserProfile)) {
        return json(res, 400, { error: "browserProfile must name an existing browser profile" });
      }
      if (settings.mcpServers?.some(name => mcpServerNameError(name) !== null) || (settings.mcpServers?.length ?? 0) > MAX_MCP_SERVERS) {
        return json(res, 400, { error: "Invalid MCP server selection" });
      }
      if (settings.managedSections?.length) {
        if (!settings.chiefOfStaff || settings.managedSections.some(name => name !== "" && !store.sections.includes(name))) {
          return json(res, 400, { error: "Only a Chief may manage existing additional departments" });
        }
        if (body.acknowledgePeerScope !== true) return json(res, 400, { error: "Confirm additional department access (acknowledgePeerScope)" });
        if (auth.kind === "loopback" && !DESKTOP_MANAGED && store.bots.some(bot => bot.busy)) {
          return json(res, 409, { error: "Stop running bots before granting access to another department" });
        }
      }
      const checkedCwd = validateBotCwd(settings.cwd ?? null);
      if (!checkedCwd.ok) return json(res, 400, { error: checkedCwd.error });
      if (body.requireAvailableModel !== undefined && typeof body.requireAvailableModel !== "boolean") {
        return json(res, 400, { error: "requireAvailableModel must be true or false" });
      }
      if (body.requireAvailableModel === true && body.modelSelection === undefined) {
        return json(res, 400, { error: "requireAvailableModel requires modelSelection" });
      }
      const profileInput = Object.fromEntries(
        ["name", "title", "description"]
          .filter((key) => body[key] !== undefined)
          .map((key) => [key, body[key]]),
      );
      const profile = parseBotProfilePatch(profileInput, true);
      if (!profile.ok) return json(res, 400, { error: profile.error });
      let section: string | undefined;
      if (body.section !== undefined && body.section !== null) {
        if (typeof body.section !== "string") return json(res, 400, { error: "section must be a string" });
        section = body.section.trim() || undefined;
        if (section && section.length > 60) {
          return json(res, 400, { error: "section must be at most 60 characters" });
        }
      }
      const creator = auth.kind === "session" && auth.session.membershipAuthority === "team" ? auth.session.email : undefined;
      let reportsTo: string | undefined;
      if (body.reportsTo !== undefined && body.reportsTo !== null) {
        if (!deps.team) return json(res, 400, { error: "Only a team's bots report to someone." });
        if (typeof body.reportsTo !== "string" || !body.reportsTo.trim()) return json(res, 400, { error: "reportsTo must be an email" });
        const email = body.reportsTo.trim().toLowerCase();
        if (email !== creator?.toLowerCase() && !deps.team.people.has(email)) return json(res, 400, { error: `Choose someone in ${deps.team.name}.` });
        reportsTo = email;
      }
      let selection: ModelSelection;
      if (body.modelSelection === undefined) {
        selection = await defaultSelection();
      } else {
        const checked = checkedModelSelection(body.modelSelection, undefined, body.requireAvailableModel === true);
        if (!checked.ok) return json(res, checked.status, { error: checked.error });
        selection = checked.selection;
      }
      if (hostedModels && !hostedModels.allows(selection)) return json(res, 400, { error: hostedModels.error() });
      // The capacity check sits beside the synchronous write, after every await.
      if (store.bots.length >= MAX_WORKSPACE_BOTS) {
        return json(res, 409, { error: `this workspace is limited to ${MAX_WORKSPACE_BOTS} bots` });
      }
      // Apply the audience before creation can announce the bot to members.
      const created = body.visibility === undefined ? null : parseVisibility(body.visibility);
      if (created && !created.ok) return json(res, 400, { error: created.error });
      // Checked again beside the synchronous write: an await above let another request take the same id.
      if (kept.id && "error" in keptBotIds(kept, store)) return json(res, 409, { error: "a bot with this id already exists here" });
      const bot = store.createBot({ ...profile.patch, soul: settings.soul, section, modelSelection: selection,
        ...(mascotProfile ? { mascotProfile } : {}),
        toolScope: settings.toolScope ?? undefined,
        ...(deps.team && creator ? { createdBy: creator } : {}), ...(reportsTo ? { reportsTo } : {}),
        ...(created?.ok ? { visibility: created.visibility } : {}) }, kept.id ? { ...kept, seedMessages: false } : {});
      const createdRoutines: Array<{ id: string; enabled: boolean }> = [];
      try {
        const { chiefOfStaff: _chief, managedSections: _managed, toolScope: _toolScope, ...ordinary } = settings;
        if (mascotProfile) delete ordinary.mascotBody;
        store.patchBot(bot.id, {
          // Store creation completed the workspace defaults (effort included): the rest of the template must not undo them.
          ...ordinary, name: bot.name, section, modelSelection: bot.modelSelection,
          mascotExpression: ordinary.mascotExpression ?? undefined,
          avatarUrl: ordinary.avatarUrl || undefined,
          computer: ordinary.computer ?? undefined, cwd: checkedCwd.cwd ?? undefined,
          peers: ordinary.peers ?? undefined, mcpServers: ordinary.mcpServers ?? undefined,
          browserProfile: ordinary.browserProfile || undefined,
          autoApprove: ordinary.approvalMode === "auto",
        });
        const presetSkills = new Set(preset?.preset.skills ?? []);
        const presetNotes = new Set(Object.keys(preset?.preset.seed?.memory ?? {}));
        for (const [file, text] of Object.entries(template.memory)) {
          if (presetNotes.has(file)) continue;
          journalMemoryWrite(bot.id, file, text, { actor: "person", via: "api" });
        }
        if (preset) {
          applyPresetToBot(bot.id, preset, {
            store,
            skills: { install: installSkill, setEnabled: setSkillEnabled, installOrg: installOrgSkill },
            memory: { writeIndex: writeMemoryFile, writeTopic: writeMemoryTopic },
          });
        }
        for (const skill of template.skills) {
          if (presetSkills.has(skill.name)) continue;
          const parsed = parseSkillMd(skill.text);
          if ("error" in parsed || parsed.name !== skill.name) throw Object.assign(new Error("Skill name does not match its contents"), { status: 400 });
          const installed = installSkill(bot.id, skill.source, [{ path: "SKILL.md", content: skill.text }]);
          if ("error" in installed) throw Object.assign(new Error(installed.error), { status: 422 });
          if (skill.enabled) {
            const enabled = setSkillEnabled(bot.id, skill.name, true);
            if ("error" in enabled) throw Object.assign(new Error(enabled.error), { status: 422 });
          }
        }
        // On a Cloud home only the owner's devices create bots: its routines are theirs.
        const ownersRoutines = CLOUD_OWNER_KEY && auth.kind === "session" && cloudOwnerSession(auth) ? CLOUD_OWNER_KEY : null;
        for (const routine of template.routines) {
          const created = routines!.create({ ...routine, botId: bot.id, enabled: false });
          createdRoutines.push({ id: created.id, enabled: routine.enabled !== false });
          if (ownersRoutines) cloudRoutineAuthors?.wrote(created.id, ownersRoutines);
        }
      } catch (error) {
        for (const routine of createdRoutines) routines!.remove(routine.id);
        store.deleteBot(bot.id);
        throw error;
      }
      // Creation is complete: activation errors must not invite a duplicate retry or delete a bot whose routine may have run.
      const warnings: string[] = [];
      if (settings.chiefOfStaff) {
        try {
          store.patchBot(bot.id, { managedSections: settings.managedSections ?? [] });
          store.setChiefOfStaff(bot.id);
        } catch {
          warnings.push("Bot created; review its Chief of Staff setting before delegating work.");
        }
      }
      for (const routine of createdRoutines) if (routine.enabled) {
        try { routines!.update(routine.id, { enabled: true }); }
        catch { warnings.push(`Bot created; routine ${routine.id} could not be activated.`); }
      }
      return json(res, 201, {
        ...(warnings.length ? { warnings } : {}),
        bot: {
          ...wireBot(bot),
          messages: store.messagesFor(bot.threadId),
          activeLeafId: store.activeLeaf(bot.threadId),
        },
      });
    }
    return PASS;
  };
}
