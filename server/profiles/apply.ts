// Not atomic: each MCP server, department and bot is its own write. A refused write leaves that bot as it was and its stamp
// unchanged, so the next plan offers the same change again; a refused approval instead falls to a lower level, which the
// stamp records so the next plan explains it.
import { APPROVAL_MODES, approvalModeFor, approvalModeWidens, levelWithin, type ApprovalMode } from "../../shared/approval-mode.ts";
import type { ProfilePlanLine } from "../../shared/profile-plan.ts";
import type { ProfileSource } from "../../shared/wire.ts";
import { APPROVAL_LABEL, botPatch, type DesiredBot } from "../desired-bot.ts";
import type { McpServerAction } from "./mcp-plan.ts";
import { appHashes, approvalHash, approvalPhrase, type AreaAction, type BotAction, type PlanOutput } from "./plan.ts";
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
  mcpServers: ProfilesState["mcpServers"];
  /** Each MCP server written, by key. */
  servers: string[];
  /** Each bot written: its id in the app and the fields that changed, for the admin activity log. */
  bots: Array<{ id: string; botId: string; name: string; fields: string[] }>;
}

class Refused extends Error {}

type Change = BotAction["changes"][number];

/** Fields whose value bounds what a bot may do. Security: a bot from a profile never ends with more of these than its file
 * gives, so a refused change that would lower one is never left silently wider. */
const GUARDS = new Set(["approval", "tools", "toolsOff", "mcpServers", "connectors", "eduBrain", "eduCrew"]);
const narrows = (change: Change) => !change.access && GUARDS.has(change.field);

/** The levels to try for `target`, highest first: the target, then each lower level that is not above `current`. */
function approvalLadder(target: ApprovalMode, current: ApprovalMode): ApprovalMode[] {
  const lower = [...APPROVAL_MODES].reverse().filter((mode) => mode !== target && levelWithin(mode, target) && !approvalModeWidens(current, mode));
  return [target, ...lower];
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

/** Makes the bot at the level its plan gives; when the app refuses that level, at Ask, the lowest. */
async function createBot(action: BotAction, write: (method: string, path: string, body?: unknown) => Promise<Rec>): Promise<{ bot: Rec; refused?: { level: ApprovalMode; why: string } }> {
  try {
    return { bot: (await write("POST", "/api/bots", action.create)).bot };
  } catch (error) {
    const level = action.create?.settings?.approvalMode as ApprovalMode | undefined;
    if (!level || level === "ask") throw error;
    let made: Rec;
    try {
      made = await write("POST", "/api/bots", { ...action.create, settings: { ...action.create!.settings, approvalMode: "ask" } });
    } catch {
      throw error;
    }
    return { bot: made.bot, refused: { level, why: (error as Error).message } };
  }
}

export async function applyProfilePlan(planned: PlanOutput, previous: ProfilesState["areas"], port: ProfileAppPort, options: ApplyOptions): Promise<ApplyOutcome> {
  const outcome: ApplyOutcome = { applied: [], skipped: [], areas: { ...previous }, mcpServers: { ...planned.mcpServers }, servers: [], bots: [] };
  for (const key of planned.goneAreas) delete outcome.areas[key];
  const skip = (line: ProfilePlanLine, why: string) => outcome.skipped.push({ ...line, reason: why });
  const write = async (method: string, path: string, body?: unknown) => {
    const result = await port.call(method, path, body);
    if (result.status >= 400) throw new Refused(reason(result));
    return result.body;
  };

  for (const action of planned.actions.filter((candidate): candidate is McpServerAction => candidate.kind === "mcp-server")) {
    if (action.access && !options.giveAccess) {
      skip(action.line, "gives more access; confirm it from the desktop app or a paired admin device");
      continue;
    }
    const route = `/api/mcp/servers/${enc(action.key)}`;
    try {
      if (action.op === "remove") {
        await write("DELETE", route);
        delete outcome.mcpServers[action.key];
      } else {
        const body = { ...action.keep, ...action.spec, ...(action.enabled === undefined ? {} : { enabled: action.enabled }), vaultKeys: action.vaultKeys };
        if (action.op === "add") await write("POST", "/api/mcp/servers", { name: action.key, ...body });
        else await write("PUT", route, body);
        outcome.mcpServers[action.key] = action.state!;
      }
      outcome.applied.push(action.line);
      outcome.servers.push(action.key);
    } catch (error) {
      skip(action.line, (error as Error).message);
      continue;
    }
    if (action.op !== "add" || !action.enabled) continue;
    try {
      await write("PATCH", route, { enabled: true });
    } catch (error) {
      skip({ ...action.line, kind: "note", text: `MCP server ${action.key} was added, but this app did not turn it on; turn it on in Apps → MCP servers` }, (error as Error).message);
    }
  }

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
    const made = !action.botId;
    const record = (change: Change, hash: string | null = change.hash) => {
      if (hash === null) delete hashes[change.field];
      else hashes[change.field] = hash;
      fields.push(change.field);
    };
    let botId = action.botId!;
    let echo = action.echo;
    const madeLines: ProfilePlanLine[] = [];
    if (made) {
      try {
        const created = await createBot(action, write);
        botId = String(created.bot.id);
        echo = created.bot;
        Object.assign(hashes, appHashes(action.unmanaged, echo));
        madeLines.push(action.createLine!);
        if (created.refused) {
          hashes.approval = approvalHash(action.approval ?? created.refused.level, "ask");
          madeLines.push({ ...action.createLine!, field: "approval",
            text: `${action.name}: this app refused ${APPROVAL_LABEL[created.refused.level]} for it (${created.refused.why}), so it starts at Ask for approval` });
        }
      } catch (error) {
        skip(action.createLine!, (error as Error).message);
        for (const change of taking) skip(change.line, "the bot could not be made");
        continue;
      }
    }

    /** Security: a new bot that would keep more access than its file gives is removed again. */
    const unmake = async (change: Change, why: string): Promise<boolean> => {
      if (!made) return false;
      try {
        await write("DELETE", `/api/bots/${enc(botId)}`);
      } catch {
        return false;
      }
      const skipped = new Set(outcome.skipped.map((entry) => entry.text));
      skip(action.createLine!, `${why}, so ${action.name} was not made: it would have had more access than its file gives`);
      for (const other of taking) if (other !== change && !skipped.has(other.line.text)) skip(other.line, "the bot could not be made");
      skip(change.line, why);
      return true;
    };
    const tooWide = (why: string) => `${why}, so ${action.name} still has more access than its file gives; narrow it in the bot's settings`;

    /** Security: a refused approval falls to the highest lower level the app takes, never above the bot's current one. */
    const setApproval = async (change: Change): Promise<"done" | "unmade"> => {
      const target = change.set!.approval!;
      const current = approvalModeFor(echo);
      let why: string | undefined;
      let at: ApprovalMode | undefined;
      for (const level of approvalLadder(target, current)) {
        if (level !== target && level === current) { at = level; break; }
        try {
          echo = (await write("PATCH", `/api/bots/${enc(botId)}`, { approvalMode: level, applyToAllThreads: true })).bot ?? echo;
          at = level;
          break;
        } catch (error) {
          why ??= (error as Error).message;
        }
      }
      if (at === target) {
        record(change);
        if (!made) outcome.applied.push(change.line);
        return "done";
      }
      if (at === undefined) {
        if (await unmake(change, why!)) return "unmade";
        skip(change.line, tooWide(why!));
        return "done";
      }
      record(change, approvalHash(action.approval ?? target, at));
      const how = made ? "starts at" : at === current ? "stays at" : "goes to";
      const line = { ...change.line, kind: "change" as const, text: `${action.name}: this app refused ${APPROVAL_LABEL[target]} for it (${why}), so it ${how} ${approvalPhrase(at)}` };
      (made ? madeLines : outcome.applied).push(line);
      return "done";
    };

    const applyGroup = async (group: readonly Change[]) => {
      const patch = groupPatch(group, echo);
      try {
        if (Object.keys(patch).length) echo = (await write("PATCH", `/api/bots/${enc(botId)}`, patch)).bot ?? echo;
        for (const change of group) {
          record(change);
          if (!made || change.access) outcome.applied.push(change.line);
        }
      } catch (error) {
        for (const change of group) skip(change.line, (error as Error).message);
      }
    };
    const patchChanges = taking.filter((change) => !change.skill && change.chief !== true && !narrows(change));
    const plain = patchChanges.filter((change) => !change.access);
    if (plain.length) await applyGroup(plain);
    let unmade = false;
    for (const change of taking.filter(narrows)) {
      if (change.field === "approval") {
        unmade = (await setApproval(change)) === "unmade";
        if (unmade) break;
        continue;
      }
      try {
        const patch = groupPatch([change], echo);
        if (Object.keys(patch).length) echo = (await write("PATCH", `/api/bots/${enc(botId)}`, patch)).bot ?? echo;
        record(change);
        if (!made) outcome.applied.push(change.line);
      } catch (error) {
        const why = (error as Error).message;
        unmade = await unmake(change, why);
        if (unmade) break;
        skip(change.line, tooWide(why));
      }
    }
    if (unmade) continue;
    outcome.applied.push(...madeLines);

    for (const change of patchChanges.filter((candidate) => candidate.access)) await applyGroup([change]);
    for (const change of taking.filter((candidate) => candidate.skill)) {
      const op = change.skill!;
      const template = () => ({ name: op.name, description: op.description, warnings: [], source: `profile ${options.folderName}: ${op.file}`, text: op.text, enabled: op.enabled });
      try {
        if (op.op === "remove" || op.op === "replace") await write("DELETE", `/api/bots/${enc(botId)}/skills/${enc(op.name)}`);
        if (op.op === "add" || op.op === "replace") await write("POST", `/api/bots/${enc(botId)}/skill-template`, template());
        if (op.op === "toggle") await write("PATCH", `/api/bots/${enc(botId)}/skills/${enc(op.name)}`, { enabled: op.enabled });
        record(change);
        if (!made) outcome.applied.push(change.line);
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
