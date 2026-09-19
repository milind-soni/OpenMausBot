// The checked-input validators — extracted verbatim from index.ts. The pure
// validators (package-export skill lists, the group default-responder shape,
// channel member rosters) depend only on imports and are plain exports. The
// model-selection pair additionally reads the live providerInstancesChanging
// set and the hoisted activeGroupTurnForBot helper, so it is created by
// createCheckedInputs; index.ts wires that factory near the top of the file,
// before createDesktopApproval consumes checkedTaskModelSwitch, with a thunk
// for the providerInstancesChanging const it declares much later.
// askBotAndWait stayed in index.ts: it orchestrates whole turns over the
// module-level bus and the late-bound startTurn const.
import { approvalModeFor, modelSwitchNeedsAsk } from "../shared/approval-mode.ts";
import { isEffortLevel } from "../shared/wire.ts";
import { BOT_PACKAGE_MAX_SKILLS } from "./bot-package.ts";
import { isModelVariant, type ModelSelection } from "./contracts.ts";
import type { ExportablePackageSkill } from "./package-export.ts";
import { registry, store } from "./runtime.ts";
import { isSkillName, listSkills, readSkillFile } from "./skills.ts";
import type { BotRecord, GroupDefaultResponder, GroupRecord } from "./store.ts";
import { threadBusy } from "./turn-admission.ts";

export function checkedExportSkillNames(
  value: unknown,
  bots: readonly BotRecord[],
): { ok: true; names: string[] } | { ok: false; error: string } {
  // Sharing instructions is explicit: ordinary package exports include none.
  if (value === undefined) return { ok: true, names: [] };
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !isSkillName(name))) {
    return { ok: false, error: "skillIds must be a list of exact imported skill names" };
  }
  const names = [...value] as string[];
  if (new Set(names).size !== names.length) return { ok: false, error: "skillIds must not contain duplicates" };
  if (names.length > BOT_PACKAGE_MAX_SKILLS) return { ok: false, error: `skillIds must contain at most ${BOT_PACKAGE_MAX_SKILLS} names` };
  const available = new Set(bots.flatMap((bot) => listSkills(bot.id).map((skill) => skill.name)));
  const unknown = names.find((name) => !available.has(name));
  if (unknown) return { ok: false, error: `skillIds contains unknown imported skill "${unknown}"` };
  return { ok: true, names };
}

export function collectExportSkills(
  bots: readonly BotRecord[],
  names: readonly string[],
): ReadonlyMap<string, readonly ExportablePackageSkill[]> {
  const selected = new Set(names);
  const byBot = new Map<string, ExportablePackageSkill[]>();
  if (!selected.size) return byBot;
  for (const bot of bots) {
    const assigned: ExportablePackageSkill[] = [];
    for (const listing of listSkills(bot.id)) {
      if (!selected.has(listing.name)) continue;
      const instructions = readSkillFile(bot.id, listing.name);
      if (instructions === null) {
        throw new Error(`Skill "${listing.name}" changed or is unavailable and cannot be exported safely`);
      }
      const skill: ExportablePackageSkill = {
        name: listing.name,
        description: listing.description,
        ...(listing.source ? { source: listing.source } : {}),
        ...(listing.license ? { license: listing.license } : {}),
        ...(listing.compatibility ? { compatibility: listing.compatibility } : {}),
        instructions,
      };
      // The shared exporter validates duplicate bytes and metadata together.
      assigned.push(skill);
    }
    if (assigned.length) byBot.set(bot.id, assigned);
  }
  return byBot;
}

export function checkedGroupResponder(value: unknown, memberIds: string[]): GroupDefaultResponder | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const responder = value as { kind?: unknown; botId?: unknown };
  if (responder.kind === "everyone") return { kind: "everyone" };
  if (responder.kind === "mentions") return { kind: "mentions" };
  if (
    responder.kind === "member" &&
    typeof responder.botId === "string" &&
    memberIds.includes(responder.botId)
  ) {
    return { kind: "member", botId: responder.botId };
  }
  return null;
}

export function checkedMemberIds(value: unknown): { ok: true; memberIds: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "memberIds must be a list of bot IDs" };
  const invalidIndex = value.findIndex(
    (id) => typeof id !== "string" || !id.trim() || !store.bot(id),
  );
  if (invalidIndex !== -1) {
    return { ok: false, error: `unknown channel member: ${String(value[invalidIndex])}` };
  }
  const memberIds = [...new Set(value as string[])];
  if (!memberIds.length) return { ok: false, error: "a channel needs at least one bot" };
  // A room whose every member is archived accepts messages and answers none of
  // them — the failure only surfaces later, as "… is archived and can't
  // respond" on the first turn. Refuse it here, where the mistake is made.
  if (memberIds.every((id) => store.bot(id)?.hidden)) {
    return {
      ok: false,
      error: "a channel needs at least one active bot — every member given is archived",
    };
  }
  return { ok: true, memberIds };
}

/** Everything the model-selection validators read from their host.
 * providerInstancesChanging is a thunk because index.ts declares that const
 * after this factory is wired; activeGroupTurnForBot is a hoisted function
 * declaration there, safe to pass by value. */
export interface CheckedInputsDeps {
  lateBound: {
    providerInstancesChanging(): Set<string>;
  };
  helpers: {
    activeGroupTurnForBot(botId: string): { group: GroupRecord; threadId: string } | null;
  };
}

export function createCheckedInputs(deps: CheckedInputsDeps) {
  const { providerInstancesChanging } = deps.lateBound;
  const { activeGroupTurnForBot } = deps.helpers;
function checkedModelSelection(
  raw: unknown,
  current?: { selection: ModelSelection; busy: boolean },
  requireAvailableModel = false,
): { ok: true; selection: ModelSelection } | { ok: false; status: number; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 400, error: "modelSelection must be an object" };
  }
  const value = raw as { instanceId?: unknown; model?: unknown; effort?: unknown; variant?: unknown };
  if (typeof value.instanceId !== "string" || !value.instanceId.trim()) {
    return { ok: false, status: 400, error: "modelSelection.instanceId is required" };
  }
  if (typeof value.model !== "string" || !value.model.trim()) {
    return { ok: false, status: 400, error: "modelSelection.model is required" };
  }
  const selection: ModelSelection = {
    instanceId: value.instanceId.trim(),
    model: value.model.trim(),
  };
  if (value.effort !== undefined) {
    if (!isEffortLevel(value.effort)) {
      return { ok: false, status: 400, error: `effort "${String(value.effort)}" is not recognized` };
    }
    selection.effort = value.effort;
  }
  if (value.variant !== undefined) {
    if (!isModelVariant(value.variant)) {
      return { ok: false, status: 400, error: "variant must be a non-empty model variant ID" };
    }
    if (value.effort !== undefined) {
      return { ok: false, status: 400, error: "choose either a model variant or an effort level" };
    }
    selection.variant = value.variant;
  }
  const changed = current && (
    selection.instanceId !== current.selection.instanceId ||
    selection.model !== current.selection.model ||
    selection.effort !== current.selection.effort ||
    selection.variant !== current.selection.variant
  );
  if (current?.busy && changed) {
    return { ok: false, status: 409, error: "the bot is working — stop it before changing models" };
  }
  const target = registry.get(selection.instanceId);
  if (providerInstancesChanging().has(selection.instanceId)) {
    return { ok: false, status: 409, error: "this provider account is being updated — try again shortly" };
  }
  // Model IDs remain free-form at the app's general API boundary. Custom
  // engines can accept IDs that are not in their discovery catalog, and
  // several drivers only learn the final catalog when a turn starts. The
  // MCP tool applies a stricter discovered-model policy for its own calls.
  if (requireAvailableModel) {
    if (!target) {
      return { ok: false, status: 400, error: `model instance "${selection.instanceId}" is unavailable` };
    }
    const offered =
      selection.model === target.models.default ||
      target.models.options.some((option) => option.id === selection.model);
    if (!offered) {
      return {
        ok: false,
        status: 400,
        error: `model "${selection.model}" is not offered by instance "${selection.instanceId}"`,
      };
    }
  }
  const allowed: readonly string[] = target?.adapter.capabilities.effortLevels ?? [];
  if (target && selection.effort !== undefined && !allowed.includes(selection.effort)) {
    return { ok: false, status: 400, error: `effort "${selection.effort}" is not offered by this bot's engine` };
  }
  if (target && selection.variant !== undefined && !target.adapter.capabilities.modelVariants) {
    return { ok: false, status: 400, error: "model variants are not offered by this bot's engine" };
  }
  return { ok: true, selection };
}

function checkedTaskModelSwitch(current: BotRecord, raw: unknown, updateBotDefault: boolean,
  resetApprovalToAsk: boolean, requireAvailableModel = false, trusted = false) {
  if (current.approvalGrant) return { ok: false as const, status: 409, error: "Wait for the approval change to finish before switching models" };
  const checked = checkedModelSelection(raw, {
    selection: current.modelSelection, busy: threadBusy(current.id, current.threadId),
  }, requireAvailableModel);
  if (!checked.ok) return checked;
  const profile = store.bot(current.id)!;
  if (updateBotDefault) {
    const defaults = checkedModelSelection(checked.selection, {
      selection: profile.modelSelection, busy: Boolean(activeGroupTurnForBot(current.id)),
    });
    if (!defaults.ok) return defaults;
  }
  for (const target of updateBotDefault ? [current, profile] : [current]) {
    const mode = approvalModeFor(target);
    if (resetApprovalToAsk && mode === "custom" && !trusted) {
      return { ok: false as const, status: 403, error: "Leaving Custom approval requires confirmation in the packaged desktop app" };
    }
    if (!resetApprovalToAsk && modelSwitchNeedsAsk(mode,
      registry.cliTarget(target.modelSelection.instanceId)?.driverKind,
      registry.cliTarget(checked.selection.instanceId)?.driverKind)) {
      return { ok: false as const, status: 400, error: "Confirm switching this model with Ask permissions first (resetApprovalToAsk)" };
    }
  }
  if (resetApprovalToAsk && (threadBusy(current.id, current.threadId) ||
    (updateBotDefault && activeGroupTurnForBot(current.id)))) {
    return { ok: false as const, status: 409, error: "Stop work in the selected scope before switching its permissions" };
  }
  return checked;
}

return { checkedModelSelection, checkedTaskModelSwitch };
}
