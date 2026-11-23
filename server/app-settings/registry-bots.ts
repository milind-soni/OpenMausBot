// One bot's own settings, as its Settings panel edits them: each change applies with Undo on a card naming the bot and the
// exact effect, written through PATCH /api/bots/:id so that route's checks still run.
import { z } from "zod";

import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode.ts";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile.ts";
import { TOOL_GROUP_LABELS, TOOL_GROUPS, type ToolGroup } from "../../shared/tool-groups.ts";
import { EFFORT_LEVELS, MAUS_COLOR_NAMES } from "../../shared/wire.ts";
import type { BotRecord } from "../store.ts";
import { withoutKeys, type BatchWriteResult, type RegistryDeps, type SettingEntry, type WritableSpec } from "./registry.ts";

const botId = z.string().regex(/^[\w-]{1,120}$/);
const botIds = z.union([z.literal("all"), z.array(botId).min(1).max(200)]);
const forSingleBot = <S extends z.ZodRawShape>(shape: S) => withoutKeys(z.object({ botId, ...shape }).strict());
const forBot = <S extends z.ZodRawShape>(shape: S) => withoutKeys(
  z.object({ botId: botId.optional(), botIds: botIds.optional(), ...shape }).strict(),
).refine((value) => ((value as BotInput).botId !== undefined) !== ((value as BotInput).botIds !== undefined), 'name either botId or botIds (an array of ids or "all"), not both');

const APPROVAL: Record<Exclude<ApprovalMode, "custom">, { label: string; effect: (name: string) => string }> = {
  ask: { label: "Ask for approval", effect: (name) => `Make ${name} ask you before each command or file change` },
  edits: { label: "Auto-accept edits", effect: (name) => `Let ${name} edit files without asking; other actions still ask you` },
  auto: { label: "Approve for me", effect: (name) => `Let ${name}'s engine approve routine actions and ask you about the rest` },
  full: { label: "Full access", effect: (name) => `Let ${name} act without asking` },
};
const approvalName = (mode: ApprovalMode) => (mode === "custom" ? "Custom" : APPROVAL[mode].label);

const COMPUTER = {
  auto: "pick its own computer", cloud: "use a cloud desktop", vm: "use a private desktop on this computer",
  local: "use this computer's own desktop, as you", browser: "use only the built-in browser", off: "use no computer",
} as const;
const onOff = (on: boolean | null) => (on === null ? "follow the app's setting" : on ? "on" : "off");
const on = (field: boolean | undefined) => field !== false;
const set = (field: boolean | undefined) => field === true;
/** The other fields the bot panel edits that a loopback caller may set while a bot works; the route checks each one.
 * `was` reads the bot's value as it runs on, defaults included, for Undo. */
const OTHER = {
  title: { label: "title", value: z.string().max(BOT_PROFILE_LIMITS.title), shown: (text: unknown) => `"${String(text)}"`, was: (one: BotRecord) => one.title ?? "" },
  description: { label: "description", value: z.string().max(BOT_PROFILE_LIMITS.description), shown: (text: unknown) => `"${String(text)}"`, was: (one: BotRecord) => one.description ?? "" },
  soul: { label: "instructions", value: z.string().max(4000), shown: (text: unknown) => `"${String(text).slice(0, 120)}${String(text).length > 120 ? "…" : ""}"`, was: (one: BotRecord) => one.soul ?? "" },
  notifications: { label: "notifications", value: z.boolean(), shown: onOff, was: (one: BotRecord) => on(one.notifications) },
  speakReplies: { label: "spoken replies", value: z.boolean(), shown: onOff, was: (one: BotRecord) => set(one.speakReplies) },
  replyStyle: { label: "reply style", value: z.enum(["default", "conversational"]), shown: String, was: (one: BotRecord) => one.replyStyle ?? "default" },
  voice: { label: "voice", value: z.string().max(BOT_PROFILE_LIMITS.voice), shown: String, was: (one: BotRecord) => one.voice ?? "" },
  voiceNotes: { label: "voice notes", value: z.boolean(), shown: onOff, was: (one: BotRecord) => on(one.voiceNotes) },
  voiceNoteEveryReply: { label: "a voice note with every reply", value: z.boolean().nullable(), shown: onOff, was: (one: BotRecord) => one.voiceNoteEveryReply ?? null },
  memoryEnabled: { label: "memory", value: z.boolean(), shown: onOff, was: (one: BotRecord) => on(one.memoryEnabled) },
  memoryUpkeep: { label: "memory upkeep", value: z.boolean(), shown: onOff, was: (one: BotRecord) => on(one.memoryUpkeep) },
  helperModel: { label: "helper model", value: z.boolean(), shown: onOff, was: (one: BotRecord) => on(one.helperModel) },
  browser: { label: "built-in browser", value: z.boolean(), shown: onOff, was: (one: BotRecord) => on(one.browser) },
  recordBrowserSteps: { label: "saving browser steps", value: z.boolean(), shown: onOff, was: (one: BotRecord) => set(one.recordBrowserSteps) },
  composio: { label: "connected apps", value: z.boolean(), shown: onOff, was: (one: BotRecord) => on(one.composio) },
  xResearch: { label: "X research", value: z.boolean(), shown: onOff, was: (one: BotRecord) => set(one.xResearch) },
  parkDirectMessages: { label: "holding direct messages behind delegated work", value: z.boolean(), shown: onOff, was: (one: BotRecord) => set(one.parkDirectMessages) },
  cacheKeepWarm: { label: "keeping its cache warm", value: z.boolean().nullable(), shown: onOff, was: (one: BotRecord) => one.cacheKeepWarm ?? null },
  autoStartVps: { label: "starting its own server", value: z.boolean(), shown: onOff, was: (one: BotRecord) => set(one.autoStartVps) },
  computer: { label: "computer", value: z.enum(["auto", "cloud", "vm", "local", "browser", "off"]), shown: (kind: unknown) => COMPUTER[kind as keyof typeof COMPUTER], was: (one: BotRecord) => one.computer ?? "auto" },
} as const;
type OtherField = keyof typeof OTHER;
const toolGroups = z.array(z.enum(TOOL_GROUPS)).max(TOOL_GROUPS.length).optional();
const offNow = (one: BotRecord): ToolGroup[] => TOOL_GROUPS.filter((group) => one.toolsOff?.includes(group));
const groupNames = (groups: readonly ToolGroup[]) => groups.map((group) => TOOL_GROUP_LABELS[group]).join(", ");
const formatBots = (bots: readonly BotRecord[]) => (
  bots.length <= 3
    ? `${bots.length} bots (${bots.map((one) => one.name).join(", ")})`
    : `${bots.length} bots`
);
const otherChanges = (value: Record<string, unknown>) =>
  (Object.keys(value) as string[])
    .filter((field): field is OtherField => field !== "botId" && field !== "botIds" && field in OTHER)
    .map((field) => `${OTHER[field].label} ${OTHER[field].shown(value[field] as never)}`)
    .join("; ");
const capitalize = (line: string) => (line ? `${line[0]!.toUpperCase()}${line.slice(1)}` : line);
const BOT_TARGET = '"botId" or "botIds":[...]|"all"';

type BotInput = { botId?: string; botIds?: "all" | string[] };
type SingleTarget<V extends BotInput> = Omit<V, "botId" | "botIds"> & { botId: string };
const stripTarget = <V extends BotInput>(value: V, id: string): SingleTarget<V> => {
  const { botId: _id, botIds: _ids, ...rest } = value;
  return { ...rest, botId: id } as SingleTarget<V>;
};
const isRestore = <V extends BotInput>(value: unknown): value is { restore: Array<SingleTarget<V>> } =>
  Boolean(value && typeof value === "object" && "restore" in value && Array.isArray((value as { restore?: unknown }).restore));

export function botEntries(deps: Pick<RegistryDeps, "bots" | "engines" | "patchBot">, writable: (spec: WritableSpec) => SettingEntry): SettingEntry[] {
  const bot = (id: string) => deps.bots().find((candidate) => candidate.id === id);
  const missing = (id: string) => ({ refusal: `No bot has the id ${id}. Use list_bots for the ids.` });
  const everyBot = (line: (one: BotRecord) => string) => () => deps.bots().map((one) => `${one.name}: ${line(one)}`).join("; ");
  const resolveTargets = (value: BotInput): { bots: BotRecord[] } | { refusal: string } => {
    if (value.botIds === "all") {
      const all = deps.bots();
      return all.length ? { bots: all } : { refusal: "There are no bots to change." };
    }
    const found: BotRecord[] = [];
    for (const id of new Set(value.botIds)) {
      const one = bot(id);
      if (!one) return missing(id);
      found.push(one);
    }
    return { bots: found };
  };
  const dedupRefusals = (reasons: readonly string[]) => [...new Set(reasons)].join(" ");

  /** A per-bot entry: `effect` names the change for the card, or refuses it, once the bot is known to exist; `was` is the
   * same bot's value before it, for Undo. Entries with `bulkEffect` also accept `botIds` (`["id", ...]` or `"all"`). */
  const perBot = <V extends BotInput>(spec: Omit<WritableSpec, "current" | "write" | "writeBatch" | "describe" | "value"> & {
    value: z.ZodType<V>;
    effect(one: BotRecord, value: SingleTarget<V>): { change: string } | { refusal: string };
    bulkEffect?(bots: BotRecord[], value: Omit<V, "botId" | "botIds">): string;
    was(one: BotRecord, value: SingleTarget<V>): SingleTarget<V>;
    patch(one: BotRecord, value: SingleTarget<V>): Record<string, unknown>;
  }) => {
    const singleOutcome = (one: BotRecord, value: V) => spec.effect(one, stripTarget(value, one.id));
    const singleChange = (one: BotRecord, value: V) => {
      const outcome = singleOutcome(one, value);
      return "change" in outcome ? outcome.change : one.name;
    };
    const writeBatch = spec.bulkEffect
      ? async (value: V): Promise<BatchWriteResult> => {
          const resolved = resolveTargets(value);
          if ("refusal" in resolved) return { refusal: resolved.refusal, change: "", before: undefined };
          const applied: Array<{ snapshot: BotRecord; singleText: string }> = [];
          const restores: Array<SingleTarget<V>> = [];
          const skipped: Array<{ botId: string; name: string; reason: string }> = [];
          for (const one of resolved.bots) {
            const single = stripTarget(value, one.id);
            const checked = spec.effect(one, single);
            if ("refusal" in checked) {
              skipped.push({ botId: one.id, name: one.name, reason: checked.refusal });
              continue;
            }
            const snapshot = { ...one };
            const prior = spec.was(one, single);
            const refusal = await deps.patchBot(one.id, spec.patch(one, single));
            if (refusal) {
              skipped.push({ botId: one.id, name: one.name, reason: refusal });
              continue;
            }
            applied.push({ snapshot, singleText: checked.change });
            restores.push(prior);
          }
          if (!applied.length) return { refusal: dedupRefusals(skipped.map((item) => item.reason)), change: "", before: undefined };
          const change = applied.length === 1
            ? applied[0]!.singleText
            : spec.bulkEffect!(applied.map((item) => item.snapshot), value);
          return { change, before: { restore: restores }, ...(skipped.length ? { skipped } : {}) };
        }
      : undefined;

    return writable({
      ...spec,
      current: (value: V) => {
        if (value.botId === undefined) return undefined;
        const one = bot(value.botId);
        return one ? spec.was(one, stripTarget(value, one.id)) : undefined;
      },
      describe: (value: V) => {
        if (value.botId !== undefined) {
          const one = bot(value.botId);
          return one ? singleOutcome(one, value) : missing(value.botId);
        }
        const resolved = resolveTargets(value);
        if ("refusal" in resolved) return resolved;
        const passing: BotRecord[] = [];
        const reasons: string[] = [];
        for (const one of resolved.bots) {
          const checked = singleOutcome(one, value);
          if ("refusal" in checked) reasons.push(checked.refusal);
          else passing.push(one);
        }
        if (!passing.length) return { refusal: dedupRefusals(reasons) };
        if (passing.length === 1) return { change: singleChange(passing[0]!, value) };
        return { change: spec.bulkEffect ? spec.bulkEffect(passing, value) : `Update ${formatBots(passing)}` };
      },
      write: async (value: V | { restore: Array<SingleTarget<V>> }) => {
        if (isRestore(value)) {
          const errors: string[] = [];
          const remaining: Array<SingleTarget<V>> = [];
          for (const item of value.restore) {
            const one = bot(item.botId);
            const refusal = one ? await deps.patchBot(one.id, spec.patch(one, item)) : missing(item.botId).refusal;
            if (refusal) {
              errors.push(refusal);
              remaining.push(item);
            }
          }
          value.restore.splice(0, value.restore.length, ...remaining);
          return errors.length ? dedupRefusals(errors) : null;
        }
        const one = value.botId === undefined ? undefined : bot(value.botId);
        return one ? deps.patchBot(one.id, spec.patch(one, stripTarget(value, one.id))) : missing(value.botId ?? "").refusal;
      },
      ...(writeBatch ? { writeBatch } : {}),
    });
  };

  return [
    perBot({
      id: "bots.approvalModes", label: "Approval mode", help: "What one or more bots may do without asking you, on every one of their conversations.", where: "bot-settings",
      synonyms: ["permissions", "full access", "approve", "ask", "approval", "autonomy", "approve for me", "auto-accept edits"],
      value: forBot({ mode: z.enum(["ask", "edits", "auto", "full"]) }),
      allowed: `{${BOT_TARGET},"mode"} with mode ask (Ask for approval), edits (Auto-accept edits), auto (Approve for me) or full (Full access). Custom is chosen only in the desktop app`,
      read: everyBot((one) => approvalName(approvalModeFor(one))),
      effect: (one, { mode }) => {
        if (approvalModeFor(one) === "custom") return { refusal: `${one.name} is on Custom approval, which is changed only in the desktop app, in ${one.name}'s Settings. Tell the user where.` };
        // The route takes Approve for me on this computer's own desktop only with the warning its Settings dialog shows.
        if (mode === "auto" && one.computer === "local") return { refusal: `Approve for me while ${one.name} uses this computer's own desktop needs a warning only ${one.name}'s Settings shows. Tell the user to choose it there.` };
        return { change: `${APPROVAL[mode].effect(one.name)} (${APPROVAL[mode].label})` };
      },
      bulkEffect: (bots, { mode }) => `Set approval mode to ${APPROVAL[mode].label} for ${formatBots(bots)}`,
      was: (one, { botId }) => ({ botId, mode: approvalModeFor(one) as Exclude<ApprovalMode, "custom"> }),
      patch: (_one, { mode }) => ({ approvalMode: mode, applyToAllThreads: true }),
    }),
    perBot({
      id: "bots.name", label: "Bot name", help: "A bot's name, as the sidebar and chats show it.", where: "bot-settings", synonyms: ["rename", "name", "call", "bot name"],
      value: forSingleBot({ name: z.string().trim().min(1).max(BOT_PROFILE_LIMITS.name) }), allowed: '{"botId","name"}', read: everyBot((one) => one.name),
      effect: (one, { name }) => ({ change: `Rename ${one.name} to "${name}"` }), was: (one, { botId }) => ({ botId, name: one.name }), patch: (_one, { name }) => ({ name }),
    }),
    perBot({
      id: "bots.color", label: "Bot colour", help: "A bot's colour in the sidebar and its chat, for one or more bots.", where: "bot-settings", synonyms: ["color", "colour", "tint", "bot color"],
      value: forBot({ color: z.enum(MAUS_COLOR_NAMES) }), allowed: `{${BOT_TARGET},"color"} with color one of ${MAUS_COLOR_NAMES.join(", ")}`, read: everyBot((one) => one.color),
      effect: (one, { color }) => ({ change: `Make ${one.name} ${color}` }), bulkEffect: (bots, { color }) => `Make ${formatBots(bots)} ${color}`, was: (one, { botId }) => ({ botId, color: one.color }), patch: (_one, { color }) => ({ color }),
    }),
    perBot({
      id: "bots.model", label: "Bot model", help: "The engine and model one or more bots run on, for their conversations. Ids come from list_models.", where: "bot-settings",
      synonyms: ["model", "engine", "switch model", "change model", "effort", "reasoning"],
      value: forBot({ instanceId: z.string().min(1).max(120), model: z.string().min(1).max(200), effort: z.enum(EFFORT_LEVELS).optional() }),
      allowed: `{${BOT_TARGET},"instanceId","model","effort"?} from list_models`, read: everyBot((one) => `${one.modelSelection.instanceId} / ${one.modelSelection.model}`),
      effect: (one, { instanceId, model, effort }) => {
        const engine = deps.engines().find((candidate) => candidate.instanceId === instanceId);
        if (!engine) return { refusal: `No engine has the id ${instanceId}. Use list_models for engine and model ids.` };
        return { change: `Move ${one.name} to ${engine.name}, model ${model}${effort ? `, ${effort} effort` : ""}` };
      },
      bulkEffect: (bots, { instanceId, model, effort }) => {
        const engineName = deps.engines().find((candidate) => candidate.instanceId === instanceId)?.name ?? instanceId;
        return `Move ${formatBots(bots)} to ${engineName}, model ${model}${effort ? `, ${effort} effort` : ""}`;
      },
      was: (one, { botId }) => ({ botId, instanceId: one.modelSelection.instanceId, model: one.modelSelection.model, ...(one.modelSelection.effort ? { effort: one.modelSelection.effort } : {}) }),
      patch: (_one, { instanceId, model, effort }) => ({ modelSelection: { instanceId, model, ...(effort ? { effort } : {}) }, requireAvailableModel: true }),
    }),
    perBot({
      id: "bots.archived", label: "Archived bots", help: "Archive one or more bots to take them out of the sidebar, keeping their chats; false brings them back.", where: "sidebar",
      synonyms: ["archive", "unarchive", "restore bot", "hide bot", "show bot", "hidden"],
      value: forBot({ archived: z.boolean() }), allowed: `{${BOT_TARGET},"archived":true|false}`, read: () => deps.bots().filter((one) => one.hidden).map((one) => one.name).join(", "),
      effect: (one, { archived }) => one.defaultBot && archived ? { refusal: `${one.name} is this place's own bot and is never archived. To take it out of the sidebar use sidebar.showHelper.` }
        : { change: archived ? `Archive ${one.name}: it leaves the sidebar and keeps its chats${one.chiefOfStaff ? ", and stops being Chief of Staff" : ""}` : `Bring ${one.name} back to the sidebar` },
      bulkEffect: (bots, { archived }) => {
        const chiefs = archived ? bots.filter((one) => one.chiefOfStaff).map((one) => one.name) : [];
        return archived
          ? `Archive ${formatBots(bots)}: they leave the sidebar and keep their chats${chiefs.length ? `; ${chiefs.join(", ")} stops being Chief of Staff` : ""}`
          : `Bring ${formatBots(bots)} back to the sidebar`;
      },
      was: (one, { botId }) => ({ botId, archived: one.hidden === true }),
      patch: (one, { archived }) => ({ hidden: archived, ...(archived && one.chiefOfStaff ? { chiefOfStaff: false } : {}) }),
    }),
    writable({
      id: "sidebar.showHelper", label: "Show MausBot in the sidebar", help: "Whether this place's own bot, MausBot, has a row in the sidebar; it keeps working either way.", where: "show-helper",
      synonyms: ["helper", "starter", "default bot", "mausbot", "show helper"], value: z.boolean(), allowed: "true or false",
      current: () => { const helper = deps.bots().find((one) => one.defaultBot); return helper ? !helper.sidebarHidden : undefined; },
      describe: (show: boolean) => (deps.bots().some((one) => one.defaultBot) ? { change: show ? "Show MausBot in the sidebar" : "Take MausBot out of the sidebar; it keeps working" } : { refusal: "This place has no MausBot of its own." }),
      write: (show: boolean) => { const helper = deps.bots().find((one) => one.defaultBot); return helper ? deps.patchBot(helper.id, { sidebarHidden: !show }) : Promise.resolve("This place has no MausBot of its own."); },
    }),
    perBot({
      id: "bots.tools", label: "Bot tool groups", where: "bot-settings",
      help: `Turn groups of one or more bots' built-in tools off to make every request smaller, or back on: ${TOOL_GROUPS.map((group) => `${group} (${TOOL_GROUP_LABELS[group]})`).join(", ")}. Memory, X research, the browser and connected apps have their own settings.`,
      synonyms: ["tools", "tool groups", "turn off tools", "meetings", "data", "pages", "publish", "images", "email", "tokens", "smaller requests"],
      value: forBot({ turnOff: toolGroups, turnOn: toolGroups })
        .refine((value) => Boolean(value.turnOff?.length || value.turnOn?.length), "name a group in turnOff or turnOn")
        .refine((value) => !value.turnOff?.some((group) => value.turnOn?.includes(group)), "a group can't be in both turnOff and turnOn"),
      allowed: `{${BOT_TARGET},"turnOff"?:[...],"turnOn"?:[...]} with groups from ${TOOL_GROUPS.join(", ")}`,
      read: everyBot((one) => (offNow(one).length ? `off: ${groupNames(offNow(one))}` : "all on")),
      effect: (one, { turnOff = [], turnOn = [] }) => ({ change: `${one.name}: ${[turnOff.length ? `turn off ${groupNames(turnOff)}` : "", turnOn.length ? `turn on ${groupNames(turnOn)}` : ""].filter(Boolean).join("; ")}` }),
      bulkEffect: (bots, { turnOff = [], turnOn = [] }) => `${[turnOff.length ? `Turn off ${groupNames(turnOff)}` : "", turnOn.length ? `Turn on ${groupNames(turnOn)}` : ""].filter(Boolean).join("; ")} for ${formatBots(bots)}`,
      was: (one, { botId }) => ({ botId, turnOff: offNow(one), turnOn: TOOL_GROUPS.filter((group) => !offNow(one).includes(group)) }),
      patch: (one, { turnOff = [], turnOn = [] }) => ({ toolsOff: TOOL_GROUPS.filter((group) => turnOff.includes(group) || (offNow(one).includes(group) && !turnOn.includes(group))) }),
    }),
    perBot({
      id: "bots.settings", label: "Other bot settings", help: `More of one or more bots' own settings: ${Object.values(OTHER).map((field) => field.label).join(", ")}.`, where: "bot-settings",
      synonyms: ["voice", "voice notes", "memory", "notifications", "browser", "instructions", "soul", "title", "description", "reply style", "computer", "desktop", "composio", "x research", "keep warm"],
      value: forBot(Object.fromEntries(Object.entries(OTHER).map(([field, spec]) => [field, spec.value.optional()])) as { [F in OtherField]: z.ZodOptional<(typeof OTHER)[F]["value"]> })
        .refine((value) => Object.keys(value).some((field) => field !== "botId" && field !== "botIds"), "name at least one setting besides botId or botIds"),
      allowed: `{${BOT_TARGET}, ...one or more of ${(Object.keys(OTHER) as OtherField[]).join(", ")}}`,
      read: () => "use get on a bot's own fields through list_bots",
      effect: (one, value) => ({ change: `${one.name}: ${otherChanges(value)}` }),
      bulkEffect: (bots, value) => `${capitalize(otherChanges(value))} for ${formatBots(bots)}`,
      was: (one, value) => ({ botId: one.id, ...Object.fromEntries(Object.keys(value).filter((field) => field !== "botId" && field !== "botIds").map((field) => [field, OTHER[field as OtherField].was(one)])) }),
      undoTag: (before) => {
        const items = isRestore(before)
          ? before.restore
          : before && typeof before === "object" && "botId" in before
            ? [before as Record<string, unknown>]
            : [];
        return JSON.stringify(items.map((item) => {
          const one = bot(String(item.botId));
          if (!one) return [item.botId, null];
          return [
            item.botId,
            Object.keys(item)
              .filter((field) => field in OTHER)
              .sort()
              .map((field) => [field, OTHER[field as OtherField].was(one)]),
          ];
        }));
      },
      patch: (_one, { botId: _id, computer, ...rest }) => ({ ...rest, ...(computer ? { computer: computer === "auto" ? null : computer } : {}) }),
    }),
  ];
}
