import type { IncomingMessage } from "node:http";
import { basename, isAbsolute, resolve } from "node:path";

import { z } from "zod";

import type { ProfileApplyResult, ProfileBotView, ProfilePlan, ProfilesStatus } from "../../shared/profile-plan.ts";
import type { ProfileSource } from "../../shared/wire.ts";
import type { RequestAuth } from "../request-auth.ts";
import { applyProfilePlan } from "../profiles/apply.ts";
import { gitCommitOf } from "../profiles/git-commit.ts";
import { loadProfileFolder, ProfileFolderError, type LoadedProfileFolder } from "../profiles/load.ts";
import { botSecretSlots, changedHereFields, planProfiles, type AppView, type PlanOutput } from "../profiles/plan.ts";
import { readProfilesState, writeProfilesState, type ProfilesState } from "../profiles/state.ts";
import { isInside, resolveThroughLinks } from "../sentinel/paths.ts";
import { callRoutes } from "./in-process.ts";
import { PASS, type RouteHandler } from "./table.ts";

type Rec = Record<string, any>;
const enc = encodeURIComponent;

export interface ProfilesRouteDeps {
  dataDir: string;
  desktopManaged: boolean;
  /** The app's routes, which plan and apply call in this process as the person who asked. */
  routes(): readonly RouteHandler[];
  mcpServerNames(): string[];
  stamp(botId: string, source: ProfileSource): void;
  audit(row: { action: string; target: { kind: string; name: string }; changed: string[]; after: Record<string, unknown> }, auth: RequestAuth, req: IncomingMessage): void;
}

/** Security: a profile folder is someone else's commit, so more access needs a person at the desktop app or an admin
 * session of a paired device; a loopback caller may be a bot's own shell. */
export const PROFILE_ACCESS_REFUSAL = "These changes give bots more access, so they have to be confirmed from the desktop app or a paired admin device.";

const folderField = z.string().trim().min(1).max(4096).refine((path) => isAbsolute(path) && !path.includes("\0"), "must be an absolute folder path");
const requestSchema = z.object({
  folder: folderField.optional(),
  choices: z.record(z.string().max(300), z.enum(["mine", "file"])).optional(),
  prune: z.boolean().optional(),
  giveAccess: z.boolean().optional(),
  expect: z.string().max(100).optional(),
}).strict();

/** Security: on Windows a profile folder is on a local drive (C:\...), never a network share (\\server\share), a device
 * path (\\?\..., \\.\...) or a path relative to the current drive (\folder, C:folder). */
export function windowsFolderRefusal(folder: string, platform: NodeJS.Platform = process.platform): string | null {
  return platform === "win32" && !/^[A-Za-z]:[\\/]/.test(folder) ? "A profile folder must be on a drive of this computer, such as C:\\Profiles." : null;
}

/** Security: a profile folder is never this app's data folder or inside it, judged by the path as given and where its
 * links lead, against the data folder as given and where its own links lead. */
export function insideDataFolder(paths: readonly string[], dataDir: string): boolean {
  const roots = [resolve(dataDir), resolveThroughLinks(dataDir)];
  return paths.some((path) => roots.some((root) => isInside(path, root)));
}

class RouteRefusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createProfilesRoutes(deps: ProfilesRouteDeps): RouteHandler {
  const status = (state: ProfilesState): ProfilesStatus => ({
    ...(state.folder ? { folder: state.folder } : {}),
    ...(state.applied ? { applied: state.applied } : {}),
    areas: Object.fromEntries(Object.entries(state.areas).map(([key, area]) => [key, { section: area.section }])),
  });

  const load = (folder: string | undefined, state: ProfilesState): LoadedProfileFolder => {
    const chosen = folder ?? state.folder;
    if (!chosen) throw new RouteRefusal(400, "Choose a profile folder first.");
    const refusal = windowsFolderRefusal(chosen);
    if (refusal) throw new RouteRefusal(400, refusal);
    const inside = () => new RouteRefusal(400, "A profile folder cannot be inside this app's data folder.");
    if (insideDataFolder([resolve(chosen), resolveThroughLinks(chosen)], deps.dataDir)) throw inside();
    let loaded: LoadedProfileFolder;
    try {
      loaded = loadProfileFolder(chosen);
    } catch (error) {
      if (error instanceof ProfileFolderError) throw new RouteRefusal(400, error.message);
      throw error;
    }
    const linked = windowsFolderRefusal(loaded.root);
    if (linked) throw new RouteRefusal(400, linked);
    if (insideDataFolder([loaded.root], deps.dataDir)) throw inside();
    return loaded;
  };

  const view = async (call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Rec }>, folder: LoadedProfileFolder,
    state: ProfilesState): Promise<AppView> => {
    const read = async (path: string) => {
      const result = await call("GET", path);
      if (result.status >= 400) throw new RouteRefusal(result.status, String(result.body.error ?? `could not read ${path}`));
      return result.body;
    };
    const bots: Rec[] = (await read("/api/bots?messages=0")).bots ?? [];
    const sections: string[] = (await read("/api/sidebar-sections")).sections ?? [];
    const wanted = new Set<string>();
    for (const area of folder.areas) {
      for (const name of [state.areas[area.key]?.section, area.name]) {
        const section = name && sections.find((candidate) => candidate.trim().toLowerCase() === name.trim().toLowerCase());
        if (section) wanted.add(section);
      }
    }
    const briefs: Record<string, string> = {};
    for (const section of wanted) briefs[section] = String((await read(`/api/section-context?section=${enc(section)}`)).text ?? "");
    const skills: AppView["skills"] = {};
    for (const bot of bots.filter((candidate) => candidate.profileSource)) skills[bot.id] = (await read(`/api/bots/${enc(bot.id)}/skills`)).skills ?? [];
    const instances = ((await read("/api/instances")).instances ?? []).map((instance: Rec) => ({
      instanceId: String(instance.instanceId),
      ...(typeof instance.driverKind === "string" ? { driverKind: instance.driverKind } : {}),
      models: [instance.models?.default, ...(instance.models?.options ?? []).map((option: Rec) => option.id)].filter((id): id is string => typeof id === "string"),
    }));
    return { bots, sections, briefs, skills, instances, mcpServers: deps.mcpServerNames() };
  };

  const plan = async (req: IncomingMessage, auth: RequestAuth, body: z.infer<typeof requestSchema>): Promise<{ planned: PlanOutput; folder: LoadedProfileFolder; state: ProfilesState }> => {
    const state = readProfilesState(deps.dataDir);
    const folder = load(body.folder, state);
    const commit = gitCommitOf(folder.root);
    const call = (method: string, path: string, payload?: unknown) => callRoutes(deps.routes(), req, auth, method, path, payload);
    const app = await view(call, folder, state);
    const planned = planProfiles({ folder, ...(commit ? { commit } : {}), app, state, choices: body.choices ?? {}, prune: body.prune === true });
    return { planned, folder, state };
  };

  const mayGiveAccess = (auth: RequestAuth, req: IncomingMessage) =>
    req.headers["x-openmausbot-companion"] !== "1" && (auth.kind === "session" ? auth.scopes.includes("admin") : auth.trust !== "service" && deps.desktopManaged);

  let applying = false;

  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/profiles")) return PASS;
    try {
      if (method === "GET" && path === "/api/profiles") return json(res, 200, status(readProfilesState(deps.dataDir)));
      const botView = method === "GET" ? /^\/api\/profiles\/bots\/([^/]+)$/.exec(path) : null;
      if (botView) return json(res, 200, await profileBot(req, auth, decodeURIComponent(botView[1]!)));
      if (method === "PUT" && path === "/api/profiles/folder") {
        const parsed = z.object({ folder: folderField }).strict().safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "folder must be an absolute folder path" });
        const state = readProfilesState(deps.dataDir);
        const folder = load(parsed.data.folder, state);
        const next = { ...state, folder: folder.root };
        writeProfilesState(deps.dataDir, next);
        return json(res, 200, status(next));
      }
      if (method === "POST" && (path === "/api/profiles/plan" || path === "/api/profiles/apply")) {
        const parsed = requestSchema.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid request" });
        if (path === "/api/profiles/plan") return json(res, 200, (await plan(req, auth, parsed.data)).planned.plan satisfies ProfilePlan);
        if (applying) return json(res, 409, { error: "Profiles are being applied already; plan again once that is done." });
        applying = true;
        try {
          const body = parsed.data;
          const { planned, folder, state } = await plan(req, auth, body);
          if (body.expect !== undefined && body.expect !== planned.plan.digest) {
            return json(res, 409, { error: "The profiles or this app changed since that plan; look at the new plan and apply it.", plan: planned.plan });
          }
          const accessLines = planned.plan.lines.filter((line) => line.kind === "access");
          if (body.giveAccess === true && accessLines.length && !mayGiveAccess(auth, req)) {
            return json(res, 403, { error: PROFILE_ACCESS_REFUSAL, lines: accessLines });
          }
          return json(res, 200, await applyNow(req, auth, body, planned, folder, state));
        } finally {
          applying = false;
        }
      }
      return PASS;
    } catch (error) {
      if (error instanceof RouteRefusal) return json(res, error.status, { error: error.message });
      throw error;
    }
  };

  /** Secret slots are read from the chosen folder when it still loads; without it the bot shows its changes alone. */
  async function profileBot(req: IncomingMessage, auth: RequestAuth, botId: string): Promise<ProfileBotView> {
    const answer = await callRoutes(deps.routes(), req, auth, "GET", "/api/bots?messages=0");
    if (answer.status >= 400) throw new RouteRefusal(answer.status, String(answer.body.error ?? "could not read the bots"));
    const echo = ((answer.body.bots ?? []) as Rec[]).find((bot) => bot.id === botId);
    const source = echo?.profileSource as ProfileSource | undefined;
    if (!echo || !source) throw new RouteRefusal(404, "This bot did not come from a profile.");
    const state = readProfilesState(deps.dataDir);
    let folder: LoadedProfileFolder | undefined;
    try {
      folder = state.folder ? load(undefined, state) : undefined;
    } catch {
      folder = undefined;
    }
    const bot = folder?.bots.find((candidate) => candidate.area === source.area && candidate.key === source.key);
    return { changedHere: changedHereFields(source.hashes ?? {}, echo, bot), secrets: bot ? botSecretSlots(bot, folder!.mcpServers) : [] };
  }

  async function applyNow(req: IncomingMessage, auth: RequestAuth, body: z.infer<typeof requestSchema>, planned: PlanOutput, folder: LoadedProfileFolder,
    state: ProfilesState): Promise<ProfileApplyResult> {
    const commit = planned.plan.commit;
    const now = Date.now();
    const call = (method: string, route: string, payload?: unknown) => callRoutes(deps.routes(), req, auth, method, route, payload);
    const outcome = await applyProfilePlan(planned, state.areas, { call, stamp: deps.stamp },
      { giveAccess: body.giveAccess === true, ...(commit ? { commit } : {}), now, folderName: basename(folder.root) });
    writeProfilesState(deps.dataDir, {
      ...readProfilesState(deps.dataDir), folder: folder.root, areas: outcome.areas,
      applied: { at: now, ...(commit ? { commit } : {}), digest: planned.plan.digest, folder: folder.root },
    });
    if (outcome.applied.length) {
      deps.audit({
        action: "profile.apply", target: { kind: "profile-folder", name: folder.root },
        changed: outcome.bots.flatMap((bot) => bot.fields.map((field) => `${bot.id}.${field}`)),
        after: { folder: folder.root, ...(commit ? { commit } : {}), bots: outcome.bots.filter((bot) => bot.fields.length).map((bot) => ({ profile: bot.id, id: bot.botId, name: bot.name, fields: bot.fields })),
          areas: Object.keys(outcome.areas), lines: outcome.applied.map((line) => line.text) },
      }, auth, req);
    }
    return { ...planned.plan, applied: { lines: outcome.applied, skipped: outcome.skipped } };
  }
}
