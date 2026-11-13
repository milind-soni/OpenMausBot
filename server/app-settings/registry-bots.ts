// One bot's own settings, as its Settings panel edits them: every change is a Change/Cancel card naming the bot and the
// exact effect, written through PATCH /api/bots/:id so that route's checks still run.
import { z } from "zod";

import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode.ts";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile.ts";
import { EFFORT_LEVELS, MAUS_COLOR_NAMES } from "../../shared/wire.ts";
import type { BotRecord } from "../store.ts";
import { withoutKeys, type RegistryDeps, type SettingEntry, type WritableSpec } from "./registry.ts";

const botId = z.string().regex(/^[\w-]{1,120}$/);
const forBot = <S extends z.ZodRawShape>(shape: S) => withoutKeys(z.object({ botId, ...shape }).strict());

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
/** The other fields the bot panel edits that a loopback caller may set while a bot works; the route checks each one. */
const OTHER = {
  title: { label: "title", value: z.string().max(BOT_PROFILE_LIMITS.title), shown: (text: unknown) => `"${String(text)}"` },
  description: { label: "description", value: z.string().max(BOT_PROFILE_LIMITS.description), shown: (text: unknown) => `"${String(text)}"` },
  soul: { label: "instructions", value: z.string().max(4000), shown: (text: unknown) => `"${String(text).slice(0, 120)}${String(text).length > 120 ? "…" : ""}"` },
  notifications: { label: "notifications", value: z.boolean(), shown: onOff },
  speakReplies: { label: "spoken replies", value: z.boolean(), shown: onOff },
  replyStyle: { label: "reply style", value: z.enum(["default", "conversational"]), shown: String },
  voice: { label: "voice", value: z.string().max(BOT_PROFILE_LIMITS.voice), shown: String },
  voiceNotes: { label: "voice notes", value: z.boolean(), shown: onOff },
  voiceNoteEveryReply: { label: "a voice note with every reply", value: z.boolean().nullable(), shown: onOff },
  memoryEnabled: { label: "memory", value: z.boolean(), shown: onOff },
  memoryUpkeep: { label: "memory upkeep", value: z.boolean(), shown: onOff },
  helperModel: { label: "helper model", value: z.boolean(), shown: onOff },
  browser: { label: "built-in browser", value: z.boolean(), shown: onOff },
  recordBrowserSteps: { label: "saving browser steps", value: z.boolean(), shown: onOff },
  composio: { label: "Composio apps", value: z.boolean(), shown: onOff },
  xResearch: { label: "X research", value: z.boolean(), shown: onOff },
  parkDirectMessages: { label: "holding direct messages behind delegated work", value: z.boolean(), shown: onOff },
  cacheKeepWarm: { label: "keeping its cache warm", value: z.boolean().nullable(), shown: onOff },
  autoStartVps: { label: "starting its own server", value: z.boolean(), shown: onOff },
  computer: { label: "computer", value: z.enum(["auto", "cloud", "vm", "local", "browser", "off"]), shown: (kind: unknown) => COMPUTER[kind as keyof typeof COMPUTER] },
} as const;
type OtherField = keyof typeof OTHER;

export function botEntries(deps: Pick<RegistryDeps, "bots" | "engines" | "patchBot">, writable: (spec: WritableSpec) => SettingEntry): SettingEntry[] {
  const bot = (id: string) => deps.bots().find((candidate) => candidate.id === id);
  const missing = (id: string) => ({ refusal: `No bot has the id ${id}. Use list_bots for the ids.` });
  const everyBot = (line: (one: BotRecord) => string) => () => deps.bots().map((one) => `${one.name}: ${line(one)}`).join("; ");
  /** A per-bot entry: `effect` names the change for the card, or refuses it, once the bot is known to exist. */
  const perBot = <V extends { botId: string }>(spec: Omit<WritableSpec, "tier" | "current" | "write" | "describe" | "value"> & {
    value: z.ZodType<V>; effect(one: BotRecord, value: V): { change: string } | { refusal: string }; patch(one: BotRecord, value: V): Record<string, unknown>;
  }) => writable({
    ...spec, tier: "confirm", current: () => undefined,
    describe: (value: V) => { const one = bot(value.botId); return one ? spec.effect(one, value) : missing(value.botId); },
    write: (value: V) => { const one = bot(value.botId); return one ? deps.patchBot(one.id, spec.patch(one, value)) : Promise.resolve(missing(value.botId).refusal); },
  });

  return [
    perBot({
      id: "bots.approvalModes", label: "Approval mode", help: "What one bot may do without asking you, on every one of its conversations.", where: "a bot's Settings",
      synonyms: ["permissions", "full access", "approve", "ask", "approval", "autonomy", "approve for me", "auto-accept edits"],
      value: forBot({ mode: z.enum(["ask", "edits", "auto", "full"]) }),
      allowed: '{"botId","mode"} with mode ask (Ask for approval), edits (Auto-accept edits), auto (Approve for me) or full (Full access). Custom is chosen only in the desktop app',
      read: everyBot((one) => approvalName(approvalModeFor(one))),
      effect: (one, { mode }) => {
        if (approvalModeFor(one) === "custom") return { refusal: `${one.name} is on Custom approval, which is changed only in the desktop app, in ${one.name}'s Settings. Tell the user where.` };
        // The route takes Approve for me on this computer's own desktop only with the warning its Settings dialog shows.
        if (mode === "auto" && one.computer === "local") return { refusal: `Approve for me while ${one.name} uses this computer's own desktop needs a warning only ${one.name}'s Settings shows. Tell the user to choose it there.` };
        return { change: `${APPROVAL[mode].effect(one.name)} (${APPROVAL[mode].label})` };
      },
      patch: (_one, { mode }) => ({ approvalMode: mode, applyToAllThreads: true }),
    }),
    perBot({
      id: "bots.name", label: "Bot name", help: "A bot's name, as the sidebar and chats show it.", where: "a bot's Settings", synonyms: ["rename", "name", "call", "bot name"],
      value: forBot({ name: z.string().trim().min(1).max(BOT_PROFILE_LIMITS.name) }), allowed: '{"botId","name"}', read: everyBot((one) => one.name),
      effect: (one, { name }) => ({ change: `Rename ${one.name} to "${name}"` }), patch: (_one, { name }) => ({ name }),
    }),
    perBot({
      id: "bots.color", label: "Bot colour", help: "A bot's colour in the sidebar and its chat.", where: "a bot's Settings", synonyms: ["color", "colour", "tint", "bot color"],
      value: forBot({ color: z.enum(MAUS_COLOR_NAMES) }), allowed: `{"botId","color"} with color one of ${MAUS_COLOR_NAMES.join(", ")}`, read: everyBot((one) => one.color),
      effect: (one, { color }) => ({ change: `Make ${one.name} ${color}` }), patch: (_one, { color }) => ({ color }),
    }),
    perBot({
      id: "bots.model", label: "Bot model", help: "The engine and model one bot runs on, for its conversations. Ids come from list_models.", where: "a bot's Settings",
      synonyms: ["model", "engine", "switch model", "change model", "effort", "reasoning"],
      value: forBot({ instanceId: z.string().min(1).max(120), model: z.string().min(1).max(200), effort: z.enum(EFFORT_LEVELS).optional() }),
      allowed: '{"botId","instanceId","model","effort"?} from list_models', read: everyBot((one) => `${one.modelSelection.instanceId} / ${one.modelSelection.model}`),
      effect: (one, { instanceId, model, effort }) => {
        const engine = deps.engines().find((candidate) => candidate.instanceId === instanceId);
        if (!engine) return { refusal: `No engine has the id ${instanceId}. Use list_models for engine and model ids.` };
        return { change: `Move ${one.name} to ${engine.name}, model ${model}${effort ? `, ${effort} effort` : ""}` };
      },
      patch: (_one, { instanceId, model, effort }) => ({ modelSelection: { instanceId, model, ...(effort ? { effort } : {}) }, requireAvailableModel: true }),
    }),
    perBot({
      id: "bots.archived", label: "Archived bots", help: "Archive a bot to take it out of the sidebar, keeping its chats; false brings it back.", where: "the sidebar",
      synonyms: ["archive", "unarchive", "restore bot", "hide bot", "show bot", "hidden"],
      value: forBot({ archived: z.boolean() }), allowed: '{"botId","archived":true|false}', read: () => deps.bots().filter((one) => one.hidden).map((one) => one.name).join(", "),
      effect: (one, { archived }) => one.defaultBot && archived ? { refusal: `${one.name} is this place's own bot and is never archived. To take it out of the sidebar use sidebar.showHelper.` }
        : { change: archived ? `Archive ${one.name}: it leaves the sidebar and keeps its chats${one.chiefOfStaff ? ", and stops being Chief of Staff" : ""}` : `Bring ${one.name} back to the sidebar` },
      patch: (one, { archived }) => ({ hidden: archived, ...(archived && one.chiefOfStaff ? { chiefOfStaff: false } : {}) }),
    }),
    writable({
      id: "sidebar.showHelper", label: "Show MausBot in the sidebar", help: "Whether this place's own bot, MausBot, has a row in the sidebar; it keeps working either way.", where: "Settings → Overview",
      synonyms: ["helper", "starter", "default bot", "mausbot", "show helper"], tier: "confirm", value: z.boolean(), allowed: "true or false",
      current: () => { const helper = deps.bots().find((one) => one.defaultBot); return helper ? !helper.sidebarHidden : undefined; },
      describe: (show: boolean) => (deps.bots().some((one) => one.defaultBot) ? { change: show ? "Show MausBot in the sidebar" : "Take MausBot out of the sidebar; it keeps working" } : { refusal: "This place has no MausBot of its own." }),
      write: (show: boolean) => { const helper = deps.bots().find((one) => one.defaultBot); return helper ? deps.patchBot(helper.id, { sidebarHidden: !show }) : Promise.resolve("This place has no MausBot of its own."); },
    }),
    perBot({
      id: "bots.settings", label: "Other bot settings", help: `More of one bot's own settings: ${Object.values(OTHER).map((field) => field.label).join(", ")}.`, where: "a bot's Settings",
      synonyms: ["voice", "voice notes", "memory", "notifications", "browser", "instructions", "soul", "title", "description", "reply style", "computer", "desktop", "composio", "x research", "keep warm"],
      value: forBot(Object.fromEntries(Object.entries(OTHER).map(([field, spec]) => [field, spec.value.optional()])) as { [F in OtherField]: z.ZodOptional<(typeof OTHER)[F]["value"]> })
        .refine((value) => Object.keys(value).length > 1, "name at least one setting besides botId"),
      allowed: `{"botId", ...one or more of ${(Object.keys(OTHER) as OtherField[]).join(", ")}}`,
      read: () => "use get on a bot's own fields through list_bots",
      effect: (one, value) => ({ change: `${one.name}: ${(Object.keys(value) as Array<OtherField | "botId">).filter((field) => field !== "botId")
        .map((field) => `${OTHER[field as OtherField].label} ${OTHER[field as OtherField].shown(value[field as OtherField] as never)}`).join("; ")}` }),
      patch: (_one, { botId: _id, computer, ...rest }) => ({ ...rest, ...(computer ? { computer: computer === "auto" ? null : computer } : {}) }),
    }),
  ];
}
