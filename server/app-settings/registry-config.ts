// The server's own settings from the Settings pages, each applied with Undo. Writes go through PUT /api/config (or the one
// route the page itself calls), so that route's checks, side effects and broadcasts still run.
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { IMAGE_PROVIDERS } from "../../shared/image-generation.ts";
import { EFFORT_LEVELS } from "../../shared/wire.ts";
import { DEFAULT_WINDOW_MINUTES } from "../cache-keepwarm.ts";
import { botsTowardLimit } from "../../shared/bot-limit.ts";
import { parseSocks5Proxy } from "../browser/egress/policy.ts";
import { CONFIG_PATCH_FIELDS as F, MAX_THREAD_EVENT_LOG_BYTES, MIN_THREAD_EVENT_LOG_BYTES } from "../config.ts";
import { display, withoutKeys, type RegistryDeps, type SettingEntry, type Where, type WritableSpec } from "./registry.ts";

/** Security: what a bot or card reads of a section never carries a key, token, secret or password field. */
const visible = (value: unknown): unknown => (value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter(([field]) => !/key|token|secret|password/i.test(field)).map(([field, inner]) => [field, visible(inner)]))
  : value);
const fields = (value: object) => Object.entries(value).map(([field, inner]) => `${field} ${display(inner) || "cleared"}`).join(", ");
const quoted = (text: string) => `"${text.length > 160 ? `${text.slice(0, 160)}…` : text}"`;
const nonEmpty = <T extends z.ZodType<object>>(schema: T) => schema.refine((value) => Object.keys(value).length > 0, "name at least one field");
type BrowserProfileChange = { id?: string; name: string; browser?: "chrome" };
const imageSlot = z.object({ provider: z.enum(IMAGE_PROVIDERS), model: z.string().trim().max(200).optional() }).strict();

export function configEntries(deps: Pick<RegistryDeps, "cfg" | "saveConfig" | "bots" | "call" | "read" | "paused">, writable: (spec: WritableSpec) => SettingEntry): SettingEntry[] {
  const cfg = deps.cfg;
  /** A setting saved with PUT /api/config; `says` is the applied card's line, else it shows before → after. */
  const section = <V,>(spec: { id: string; label: string; help: string; where: Where; synonyms: string[]; value: z.ZodType<V>; allowed: string;
    current(): unknown; patch(value: V): Record<string, unknown>; says?(value: V): string; read?(): string }) => writable({
    id: spec.id, label: spec.label, help: spec.help, where: spec.where, synonyms: spec.synonyms, value: spec.value, allowed: spec.allowed,
    current: spec.current, read: spec.read ?? (() => display(visible(spec.current()))), write: (value: V) => deps.saveConfig(spec.patch(value)),
    ...(spec.says ? { describe: (value: V) => ({ change: spec.says!(value) }) } : {}),
  });
  const feature = (id: string, label: string, help: string, where: Where, synonyms: string[], field: string, onUnlessFalse: boolean, yes: string, no: string) => section({
    id, label, help, where, synonyms, value: z.boolean(), allowed: "true or false",
    current: () => { const set = (cfg().features as Record<string, unknown> | undefined)?.[field]; return onUnlessFalse ? set !== false : set === true; },
    patch: (on: boolean) => ({ features: { [field]: on } }), says: (on: boolean) => (on ? yes : no),
  });
  const libraryList = async () => ((await deps.read("skills", "/api/skills-library"))?.skills ?? []) as Array<{ name: string; enabled: boolean; everyBot: boolean }>;
  /** The bots a Starter Cloud's limit counts that are awake now, as POST /api/starter/awake takes them. */
  const awakeNow = () => { const paused = deps.paused(); return deps.bots().filter((bot) => botsTowardLimit([bot]) === 1 && !bot.chiefOfStaff && !paused.includes(bot.id)).map((bot) => bot.id); };
  const botName = (id: string) => deps.bots().find((bot) => bot.id === id)?.name;

  return [
    section({
      id: "ai.backupModel", label: "Automatic recovery", help: "When a bot's engine fails before any work starts, try once more on a backup model.", where: "Settings → AI",
      synonyms: ["backup model", "fallback", "recovery", "automatic recovery"], value: F.automaticRecovery.unwrap(), allowed: '{"enabled":false} or {"enabled":true,"backup":{"instanceId","model"}} from list_models',
      current: () => cfg().automaticRecovery ?? { enabled: false }, patch: (automaticRecovery) => ({ automaticRecovery }),
      says: ({ enabled, backup }) => (enabled && backup ? `Turn on automatic recovery: a bot whose engine fails before any work starts tries once more on ${backup.instanceId} / ${backup.model}` : "Turn off automatic recovery"),
    }),
    section({
      id: "ai.routing", label: "Decision and extraction", help: "The small model that decides who answers in rooms and sorts the inbox (Jev or OpenRouter). Its keys are set with keys.* or in Settings.", where: "Settings → AI",
      synonyms: ["decision", "extraction", "routing", "who answers", "jev", "openrouter", "workers ai", "cloudflare"],
      value: nonEmpty(withoutKeys(F.decider.unwrap().omit({ key: true, openrouterKey: true, workersAiToken: true }).strict())),
      allowed: '{"enabled"?,"provider"?:"jev"|"openrouter"|"off","openrouterModel"?,"openrouterApi"?:"chat"|"decisions","jobs"?:{"roomRouting"?,"inboxTriage"?},"workersAiAccountId"?, addresses?}',
      current: () => cfg().decider ?? {}, patch: (decider) => ({ decider }),
      says: (decider) => `Decision and extraction: ${fields(decider)}. Decisions send conversation text to the chosen provider, off this computer`,
    }),
    section({
      id: "ai.images", label: "Image generation", help: "Which provider and model make images, a fallback, and how many images one turn may make. Keys are set with keys.* or in Settings.", where: "Settings → AI",
      synonyms: ["images", "image generation", "picture", "generate"],
      value: nonEmpty(withoutKeys(z.object({ primary: imageSlot.optional(), fallback: imageSlot.nullable().optional(), maxPerTurn: z.number().int().min(1).max(10).optional(), customUrl: z.string().trim().max(2048).optional() }).strict())),
      allowed: `{"primary"?:{"provider","model"?},"fallback"?:{...}|null,"maxPerTurn"?:1-10,"customUrl"?} with provider one of ${IMAGE_PROVIDERS.join(", ")}`,
      current: () => cfg().imageGen ?? {}, patch: (imageGen) => ({ imageGen }),
      says: (imageGen) => `Image generation: ${fields(imageGen)}. Image prompts go to the chosen provider, off this computer`,
    }),
    section({
      id: "profile.name", label: "Your name", help: "What bots call you.", where: "Settings → You and your bots", synonyms: ["my name", "name", "profile", "about me"],
      value: z.string().trim().max(200), allowed: "your name, or empty to clear", current: () => cfg().profile?.name ?? "", patch: (name) => ({ profile: { name } }),
    }),
    section({
      id: "profile.email", label: "Your email", help: "Your email address, for bots that write on your behalf. It stays on this computer.", where: "Settings → You and your bots", synonyms: ["email", "my email", "profile"],
      value: z.union([z.literal(""), z.string().trim().email().max(320)]), allowed: "an email address, or empty to clear", current: () => cfg().profile?.email ?? "", patch: (email) => ({ profile: { email } }),
    }),
    section({
      id: "profile.aboutMe", label: "About you", help: "What every bot knows about you.", where: "Settings → You and your bots", synonyms: ["about me", "about you", "profile", "bio"],
      value: z.string().max(4000), allowed: "text up to 4000 characters, or empty to clear", current: () => cfg().profile?.aboutMe ?? "", read: () => cfg().profile?.aboutMe ?? "",
      patch: (aboutMe) => ({ profile: { aboutMe } }), says: (text) => (text ? `Tell every bot this about you: ${quoted(text)}` : "Clear what every bot knows about you"),
    }),
    section({
      id: "bots.everyBotRules", label: "Rules for every bot", help: "Instructions every bot follows, ahead of its own.", where: "Settings → You and your bots", synonyms: ["rules", "rules for every bot", "instructions", "every bot"],
      value: z.string().max(4000), allowed: "text up to 4000 characters, or empty to clear", current: () => cfg().everyBotRules ?? "", read: () => cfg().everyBotRules ?? "",
      patch: (everyBotRules) => ({ everyBotRules }), says: (text) => (text ? `Make every bot follow: ${quoted(text)}` : "Clear the rules every bot follows"),
    }),
    section({
      id: "bots.newBotEffort", label: "Effort for new bots", help: "The reasoning effort a new bot starts with when its model names none; null uses the engine's own.", where: "Settings → You and your bots",
      synonyms: ["effort", "reasoning", "new bots", "thinking"], value: z.enum(EFFORT_LEVELS).nullable(), allowed: `${EFFORT_LEVELS.join(", ")}, or null`,
      current: () => cfg().newBots?.effort ?? null, patch: (effort) => ({ newBots: { effort } }),
    }),
    section({
      id: "bots.newBotTemplate", label: "New-bot template", help: "Everything a new bot starts with (profile, model, approval level, skills), as the new-bot dialog saves it. get shows the current template.", where: "Settings → You and your bots",
      synonyms: ["new bots", "defaults", "template", "preset"], value: withoutKeys(F.newBotDefaults.unwrap()), allowed: "the whole template object, as get shows it",
      current: () => cfg().newBotDefaults, patch: (newBotDefaults) => ({ newBotDefaults }),
      says: (template) => `Replace the template every new bot starts from with: ${display(visible(template)).slice(0, 400)}`,
    }),
    section({
      id: "bots.keepWarm", label: "Keep caches warm", help: "After a turn, keep each bot's prompt cache warm so its next reply is faster and cheaper; it costs a few tokens.", where: "Settings → You and your bots",
      synonyms: ["keep warm", "cache", "prompt cache"], value: F.cacheKeepWarm.unwrap(), allowed: '{"enabled":true|false,"windowMinutes"?:15-1440}',
      current: () => cfg().cacheKeepWarm ?? { enabled: false }, patch: (cacheKeepWarm) => ({ cacheKeepWarm }),
      says: ({ enabled, windowMinutes }) => (enabled ? `Keep prompt caches warm for ${windowMinutes ?? DEFAULT_WINDOW_MINUTES} minutes after each turn (spends tokens)` : "Stop keeping prompt caches warm"),
    }),
    feature("bots.skillAuthoring", "Bots write their own skills", "Bots may draft skills for your review.", "Settings → You and your bots", ["skills", "write skills", "early", "experimental"], "skillAuthoring", true,
      "Let bots draft skills for your review", "Stop bots drafting skills"),
    section({
      id: "bots.skillReview", label: "Skill review", help: "The bot's engine reviews long conversations and updates its learned skills, every so many tool steps.", where: "Settings → You and your bots",
      synonyms: ["skill review", "learned skills", "early"], value: z.object({ enabled: z.boolean(), steps: z.number().int().min(3).max(100).optional() }).strict(), allowed: '{"enabled":true|false,"steps"?:3-100}',
      current: () => ({ enabled: cfg().features?.skillReview === true, ...(cfg().features?.skillReviewSteps ? { steps: cfg().features?.skillReviewSteps } : {}) }),
      patch: ({ enabled, steps }) => ({ features: { skillReview: enabled, ...(steps ? { skillReviewSteps: steps } : {}) } }),
      says: ({ enabled, steps }) => (enabled ? `Let each bot's engine review long conversations${steps ? ` every ${steps} tool steps` : ""} and update its skills` : "Stop reviewing conversations for skills"),
    }),
    section({
      id: "bots.shareLearnedSkills", label: "Share learned skills", help: "Whether a skill one bot learns goes to the shared library: off, ask you first, or automatically.", where: "Settings → You and your bots",
      synonyms: ["share skills", "skills library", "learned skills"], value: z.enum(["off", "ask", "auto"]), allowed: "off, ask or auto",
      current: () => cfg().features?.shareLearnedSkills ?? "off", patch: (shareLearnedSkills) => ({ features: { shareLearnedSkills } }),
    }),
    section({
      id: "threads.eventLogMaxBytes", label: "Thread log size limit", help: "The most bytes each conversation's event log keeps; null keeps it all.", where: "Settings → Data",
      synonyms: ["log size", "storage", "event log", "cleanup"], value: z.number().int().min(MIN_THREAD_EVENT_LOG_BYTES).max(MAX_THREAD_EVENT_LOG_BYTES).nullable(),
      allowed: `${MIN_THREAD_EVENT_LOG_BYTES} to ${MAX_THREAD_EVENT_LOG_BYTES} bytes, or null for no limit`,
      current: () => cfg().threads?.eventLogMaxBytes ?? null, read: () => display(cfg().threads?.eventLogMaxBytes ?? "no limit"), patch: (eventLogMaxBytes) => ({ threads: { eventLogMaxBytes } }),
    }),
    feature("appearance.toolCalls", "Show tool calls", "Show each tool a bot runs in the conversation.", "Settings → Appearance", ["tool calls", "tools", "show tools"], "showToolCalls", false,
      "Show each tool a bot runs in its conversation", "Hide tool runs from conversations"),
    feature("desktops.browser", "Built-in browser", "Bots may use the built-in browser; each bot also has its own switch.", "Settings → Desktops & browser", ["browser", "built-in browser"], "browser", true,
      "Let bots use the built-in browser", "Turn off the built-in browser for every bot"),
    section({
      id: "desktops.browserLocalNetwork", label: "Browser on your local network", help: "Whether bots' browsers may open sites on this computer's local network.", where: "Settings → Desktops & browser",
      synonyms: ["local network", "lan", "browser sites", "intranet"], value: z.boolean(), allowed: "true or false",
      current: () => cfg().browserEngine?.egress?.localNetwork === true, patch: (localNetwork) => ({ browserEngine: { egress: { localNetwork } } }),
      says: (on) => (on ? "Let bots' browsers open sites on your local network" : "Keep bots' browsers off your local network"),
    }),
    section({
      id: "desktops.browserProxy", label: "Browser proxy", help: "An unauthenticated SOCKS5 proxy bots' browsers reach public sites through; empty sends them direct. Its address is never shown, only whether one is set.",
      where: "Settings → Desktops & browser", synonyms: ["proxy", "socks", "socks5", "browser proxy"],
      value: z.string().trim().max(512).refine((text) => text === "" || parseSocks5Proxy(text) !== null, "an unauthenticated socks5://host:port address, or empty"),
      allowed: 'an unauthenticated "socks5://host:port", or "" for no proxy', current: () => cfg().browserEngine?.egress?.proxy ?? "",
      read: () => (cfg().browserEngine?.egress?.proxy ? "set" : ""), patch: (proxy) => ({ browserEngine: { egress: { proxy } } }),
      says: (proxy) => (proxy ? "Send bots' browsers to public sites through the SOCKS5 proxy you named" : "Send bots' browsers to public sites directly, with no proxy"),
    }),
    section({
      id: "desktops.browserEngine", label: "Browser engine", help: "What runs bots' browsers: agent-browser (the default) or MausBot's own Chrome driver (early).", where: "Settings → Desktops & browser",
      synonyms: ["browser engine", "chrome", "new browser", "agent-browser"], value: z.enum(["agent-browser", "chrome"]), allowed: "agent-browser or chrome",
      current: () => cfg().browserEngine?.engine ?? "agent-browser", patch: (engine) => ({ browserEngine: { engine } }),
    }),
    feature("desktops.savedSteps", "Saved steps", "Bots may repeat saved browser steps without AI.", "Settings → Desktops & browser", ["saved steps", "repeat", "without ai"], "savedSteps", true,
      "Let bots repeat saved steps without AI", "Turn off saved steps"),
    section({
      id: "desktops.privateDesktop", label: "Private desktops", help: "How bots share private desktops on this computer: one shared, one per bot, or a pool; how many; and minutes before an idle one stops.", where: "Settings → Desktops & browser",
      synonyms: ["private desktop", "vm", "docker", "podman", "container", "sandbox"],
      value: nonEmpty(F.localVm.unwrap().pick({ mode: true, maxInstances: true, idleTimeoutMinutes: true }).strict()), allowed: '{"mode"?:"shared"|"per-bot"|"pool","maxInstances"?,"idleTimeoutMinutes"?}',
      current: () => cfg().localVm ?? {}, patch: (localVm) => ({ localVm }), says: (localVm) => `Private desktops: ${fields(localVm)}`,
    }),
    feature("computer.sharing", "Computer sharing", "Whether every paired device may lend its computer to bots here. Each lent folder or app is still picked and confirmed on that device.", "Settings → Desktops & browser",
      ["share computer", "shared computers", "lend", "lending"], "sharedComputers", false,
      "Let every paired device lend its computer to bots here, not only your own. A lent folder can be used to reach a shell", "Stop every device, your own included, lending its computer to bots here"),
    writable({
      id: "desktops.browserProfiles", label: "Browser profiles", help: "Named browser profiles bots use, each keeping its own logins. Send the full list; leave out id for a new one. Removing one deletes its logins, so only the user does that.",
      where: "Settings → Desktops & browser", synonyms: ["browser profiles", "profiles", "my chrome", "logins"],
      value: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,80}$/).optional(), name: z.string().trim().min(1).max(40), browser: z.literal("chrome").optional() }).strict()).max(20),
      allowed: '[{"id"?,"name","browser"?:"chrome"}]; "chrome" uses your own running Chrome',
      current: () => (cfg().browserProfiles ?? []).map(({ id, name, browser }) => ({ id, name, ...(browser ? { browser } : {}) })),
      read: () => (cfg().browserProfiles ?? []).map((profile) => `${profile.id}: ${profile.name}${profile.browser ? " (your Chrome)" : ""}`).join("; "),
      describe: (next: BrowserProfileChange[]) => {
        const current = cfg().browserProfiles ?? [];
        const gone = current.find((profile) => !next.some((wanted) => wanted.id === profile.id));
        if (gone) return { refusal: `Removing the browser profile "${gone.name}" deletes its saved logins, so only the user does that, in Settings → Desktops & browser. Send every current profile.` };
        const unknown = next.find((wanted) => wanted.id && !current.some((profile) => profile.id === wanted.id));
        if (unknown) return { refusal: `No browser profile has the id ${unknown.id}. Leave out id for a new profile.` };
        const where = (profile: BrowserProfileChange) => (profile.browser ? "your own running Chrome, with its logins" : "the built-in browser");
        const lines = next.flatMap((wanted) => {
          const before = current.find((profile) => profile.id === wanted.id);
          if (!before) return [`add the profile "${wanted.name}" on ${where(wanted)}`];
          return [...(before.name !== wanted.name ? [`rename "${before.name}" to "${wanted.name}"`] : []), ...(Boolean(before.browser) !== Boolean(wanted.browser) ? [`move "${wanted.name}" to ${where(wanted)}`] : [])];
        });
        return lines.length ? { change: `Browser profiles: ${lines.join("; ")}` } : { refusal: "That list is the same as the current one." };
      },
      write: (next: BrowserProfileChange[]) => {
        const current = (cfg().browserProfiles ?? []).map(({ id, name, browser }) => ({ id, name, ...(browser ? { browser } : {}) }));
        const browserProfiles = next.map((profile) => ({ ...profile, id: profile.id ?? `profile-${randomUUID().replaceAll("-", "")}` }));
        return deps.saveConfig({ browserProfiles, expectedBrowserProfiles: current });
      },
    }),
    writable({
      id: "bots.awake", label: "Bots kept awake", help: "On a Starter Cloud, which bots stay awake past the plan's limit; the rest pause. Send exactly as many as the plan keeps.", where: "Settings → You and your bots",
      synonyms: ["awake", "paused bots", "starter", "limit"], value: z.array(z.string().regex(/^[\w-]{1,120}$/)).min(1).max(100), allowed: "a list of bot ids",
      current: awakeNow, read: () => (deps.paused().length ? `awake: ${awakeNow().map(botName).join(", ")}` : ""), describe: (ids: string[]) => { const missing = ids.find((id) => !botName(id)); return missing ? { refusal: `No bot has the id ${missing}. Use list_bots for the ids.` } : { change: `Keep ${ids.map(botName).join(", ")} awake; your other bots pause` }; },
      write: (awake: string[]) => deps.call("starterAwake", "POST", "/api/starter/awake", { awake }),
    }),
    writable({
      id: "skills.library", label: "Skills library", help: "Turn a library skill on or off, or give it to every bot. Library skills are listed in Settings.", where: "Settings → You and your bots",
      synonyms: ["skills", "skill library", "library", "every bot skill"],
      value: z.object({ name: z.string().regex(/^[a-z0-9-]{1,64}$/), enabled: z.boolean().optional(), everyBot: z.boolean().optional() }).strict().refine((value) => (value.enabled === undefined) !== (value.everyBot === undefined), "send enabled or everyBot, one of them"),
      allowed: '{"name","enabled":true|false} or {"name","everyBot":true|false}', read: () => "",
      current: async ({ name, enabled }: { name: string; enabled?: boolean }) => {
        const skill = (await libraryList()).find((one) => one.name === name);
        return skill ? (enabled !== undefined ? { name, enabled: skill.enabled } : { name, everyBot: skill.everyBot }) : undefined;
      },
      describe: ({ name, enabled, everyBot }: { name: string; enabled?: boolean; everyBot?: boolean }) => ({ change: enabled !== undefined ? `${enabled ? "Turn on" : "Turn off"} the library skill ${name}` : `${everyBot ? "Give" : "Stop giving"} the library skill ${name} to every bot` }),
      write: ({ name, ...change }: { name: string; enabled?: boolean; everyBot?: boolean }) => deps.call("skills", "PATCH", `/api/skills-library/${name}`, change),
    }),
    writable({
      id: "bots.skills", label: "A bot's library skills", help: "Which library skills one bot uses. Send the full list.", where: "a bot's Settings", synonyms: ["skills", "assign skills", "bot skills"],
      value: z.object({ botId: z.string().regex(/^[\w-]{1,120}$/), skills: z.array(z.string().min(1).max(64)).max(200) }).strict(), allowed: '{"botId","skills":[names]}', read: () => "",
      current: ({ botId }: { botId: string }) => { const bot = deps.bots().find((one) => one.id === botId); return bot ? { botId, skills: bot.assignedSkills ?? [] } : undefined; },
      describe: ({ botId, skills }: { botId: string; skills: string[] }) => { const name = botName(botId); return name ? { change: skills.length ? `Give ${name} the library skills ${skills.join(", ")}` : `Take every library skill from ${name}` } : { refusal: `No bot has the id ${botId}. Use list_bots for the ids.` }; },
      write: ({ botId, skills }: { botId: string; skills: string[] }) => deps.call("skills", "PUT", `/api/bots/${encodeURIComponent(botId)}/skills-library`, { skills }),
    }),
  ];
}
