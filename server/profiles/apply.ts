// Not atomic: each department and bot is its own write. A refused write leaves that bot as it was and its stamp
// unchanged, so the next plan offers the same change again.
import type { ProfilePlanLine } from "../../shared/profile-plan.ts";
import type { ProfileSource } from "../../shared/wire.ts";
import { botPatch, type DesiredBot } from "../desired-bot.ts";
import { appHashes, type AreaAction, type BotAction, type PlanOutput } from "./plan.ts";
import type { ProfilesState } from "./state.ts";

type Rec = Record<string, any>;
const enc = encodeURIComponent;

/** How apply reaches the app: its own routes, called as the person who asked for the apply. */
export interface ProfileAppPort {
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Rec }>;
  stamp(botId: string, source: ProfileSource): void;
}

export interface ApplyOptions {
  giveAccess: boolean;
  commit?: string;
  now: number;
  /** Names the skills' source: `profile <folder name>: <file>`. */
  folderName: string;
}

export interface ApplyOutcome {
  applied: ProfilePlanLine[];
  skipped: Array<ProfilePlanLine & { reason: string }>;
  areas: ProfilesState["areas"];
  /** Each bot written: its id in the app and the fields that changed, for the admin activity log. */
  bots: Array<{ id: string; botId: string; name: string; fields: string[] }>;
}

class Refused extends Error {}

type Change = BotAction["changes"][number];

/** The plain changes in one PATCH, then approval and each access change alone: a refusal of one never drops the others. */
function patchGroups(changes: readonly Change[]): Change[][] {
  const alone = (change: Change) => change.access || change.field === "approval";
  return [changes.filter((change) => !alone(change)), ...changes.filter(alone).map((change) => [change])].filter((group) => group.length);
}

function groupPatch(group: readonly Change[], echo: Rec): Rec {
  const desired: DesiredBot = { name: echo.name, manages: [], skills: [] };
  for (const change of group) Object.assign(desired, change.set ?? {});
  const { patch } = botPatch(desired, echo, undefined);
  // Security: a profile is someone else's commit, never the confirmation Auto on this computer needs.
  delete patch.acknowledgeLocalAuto;
  const section = group.find((change) => change.section !== undefined)?.section;
  if (section !== undefined && (echo.section ?? "").trim().toLowerCase() !== section.trim().toLowerCase()) patch.section = section;
  if (group.some((change) => change.chief === false) && echo.chiefOfStaff === true) patch.chiefOfStaff = false;
  return patch;
}

const reason = (result: { status: number; body: Rec }) => String(result.body?.error ?? result.body?.message ?? `refused (${result.status})`);

export async function applyProfilePlan(planned: PlanOutput, previous: ProfilesState["areas"], port: ProfileAppPort, options: ApplyOptions): Promise<ApplyOutcome> {
  const outcome: ApplyOutcome = { applied: [], skipped: [], areas: { ...previous }, bots: [] };
  for (const key of planned.goneAreas) delete outcome.areas[key];
  const skip = (line: ProfilePlanLine, why: string) => outcome.skipped.push({ ...line, reason: why });
  const write = async (method: string, path: string, body?: unknown) => {
    const result = await port.call(method, path, body);
    if (result.status >= 400) throw new Refused(reason(result));
    return result.body;
  };

  for (const action of planned.actions.filter((candidate): candidate is AreaAction => candidate.kind === "area")) {
    const hashes = { ...action.hashes };
    let section = action.renameFrom ?? action.section;
    try {
      if (action.create) await write("POST", "/api/sidebar-sections", { name: action.section, botIds: [] });
      if (action.renameFrom) await write("PATCH", `/api/sidebar-sections?section=${enc(action.renameFrom)}`, { name: action.section });
      section = action.section;
      hashes.name = action.nameHash;
      if (action.nameLine) outcome.applied.push(action.nameLine);
    } catch (error) {
      if (action.nameLine) skip(action.nameLine, (error as Error).message);
      if (action.create) {
        if (action.brief) skip(action.brief.line, "its department could not be made");
        continue;
      }
    }
    if (action.brief) {
      try {
        await write("PUT", `/api/section-context?section=${enc(section)}`, { text: action.brief.text });
        hashes.brief = action.brief.hash;
        outcome.applied.push(action.brief.line);
      } catch (error) {
        skip(action.brief.line, (error as Error).message);
      }
    }
    outcome.areas[action.area] = { section, hashes };
  }

  const chiefs: Array<{ action: BotAction; botId: string; change: BotAction["changes"][number] }> = [];
  const stamps: Array<{ botId: string; action: BotAction; hashes: Record<string, string> }> = [];
  for (const action of planned.actions.filter((candidate): candidate is BotAction => candidate.kind === "bot")) {
    const taking = action.changes.filter((change) => !change.access || options.giveAccess);
    for (const change of action.changes.filter((candidate) => candidate.access && !options.giveAccess)) {
      skip(change.line, "gives more access; confirm it from the desktop app or a paired admin device");
    }
    const hashes = { ...action.hashes };
    const fields: string[] = [];
    let botId = action.botId;
    let echo = action.echo;
    try {
      if (!botId) {
        const made = await write("POST", "/api/bots", action.create);
        botId = String(made.bot.id);
        echo = made.bot;
        Object.assign(hashes, appHashes(action.unmanaged, echo));
        outcome.applied.push(action.createLine!);
      }
    } catch (error) {
      skip(action.createLine!, (error as Error).message);
      for (const change of taking) skip(change.line, "the bot could not be made");
      continue;
    }
    const patchChanges = taking.filter((change) => !change.skill && change.chief !== true);
    for (const group of patchGroups(patchChanges)) {
      const patch = groupPatch(group, echo);
      try {
        if (Object.keys(patch).length) echo = (await write("PATCH", `/api/bots/${enc(botId)}`, patch)).bot ?? echo;
        for (const change of group) {
          if (change.hash === null) delete hashes[change.field];
          else hashes[change.field] = change.hash;
          fields.push(change.field);
          if (action.botId || change.access) outcome.applied.push(change.line);
        }
      } catch (error) {
        for (const change of group) skip(change.line, (error as Error).message);
      }
    }
    for (const change of taking.filter((candidate) => candidate.skill)) {
      const op = change.skill!;
      const template = () => ({ name: op.name, description: op.description, warnings: [], source: `profile ${options.folderName}: ${op.file}`, text: op.text, enabled: op.enabled });
      try {
        if (op.op === "remove" || op.op === "replace") await write("DELETE", `/api/bots/${enc(botId)}/skills/${enc(op.name)}`);
        if (op.op === "add" || op.op === "replace") await write("POST", `/api/bots/${enc(botId)}/skill-template`, template());
        if (op.op === "toggle") await write("PATCH", `/api/bots/${enc(botId)}/skills/${enc(op.name)}`, { enabled: op.enabled });
        if (change.hash === null) delete hashes[change.field];
        else hashes[change.field] = change.hash;
        fields.push(change.field);
        if (action.botId) outcome.applied.push(change.line);
      } catch (error) {
        skip(change.line, (error as Error).message);
      }
    }
    for (const change of taking.filter((candidate) => candidate.chief === true)) chiefs.push({ action, botId, change });
    stamps.push({ botId, action, hashes });
    outcome.bots.push({ id: action.id, botId, name: action.name, fields });
  }

  for (const { action, botId, change } of chiefs) {
    const stamp = stamps.find((entry) => entry.botId === botId)!;
    try {
      await write("PATCH", `/api/bots/${enc(botId)}`, { chiefOfStaff: true });
      stamp.hashes[change.field] = change.hash!;
      outcome.bots.find((bot) => bot.botId === botId)!.fields.push(change.field);
      if (action.botId) outcome.applied.push(change.line);
    } catch (error) {
      skip(change.line, (error as Error).message);
    }
  }

  for (const { botId, action, hashes } of stamps) {
    port.stamp(botId, { area: action.area, key: action.key, file: action.file, ...(options.commit ? { commit: options.commit } : {}), appliedAt: options.now, hashes });
  }

  for (const action of planned.actions) {
    if (action.kind !== "remove") continue;
    try {
      await write("DELETE", `/api/bots/${enc(action.botId)}`);
      outcome.applied.push(action.line);
    } catch (error) {
      skip(action.line, (error as Error).message);
    }
  }
  return outcome;
}
