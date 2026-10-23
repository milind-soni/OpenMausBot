import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DEFAULT_BOT_COLOR, DEFAULT_BOT_NAME, defaultBotPerson } from "../shared/default-bot.ts";
import { takeImportName } from "../shared/import-name.ts";
import type { BotRecord, Message, Store } from "./store.ts";

export type DefaultBotStore = Pick<Store, "bots" | "bot" | "createBot" | "patchBot" | "appendMessage" | "messagesFor" | "createTask" | "setChiefOfStaff">;

/** Where each place (key "") and Team Cloud member (their email) is recorded as having had its MausBot, so one that is
 * gone is never made twice. */
const LEDGER = "default-bot.json";

/** The colour a new install gave its MausBot before Chrome, which an adopted MausBot trades for Chrome. */
const STARTER_COLOR = "silver";

export const HELPER_ASKS = ["What are my bots up to?", "Set up a bot for my inbox", "Make me a morning routine", "How do I connect my email?"];

export function defaultBotRefusal(name: string): string {
  return `${name} can't be deleted or archived. To take it off the sidebar, choose Hide in its menu, or turn off "Show ${name} in the sidebar" in Settings → General.`;
}

/** Why a PATCH may not change this bot so, or null. */
export function defaultBotPatchRefusal(bot: BotRecord | null, body: Record<string, unknown>): string | null {
  for (const key of ["sidebarHidden", "welcomed"]) if (body[key] !== undefined && typeof body[key] !== "boolean") return `${key} must be true or false`;
  if ((body.sidebarHidden !== undefined || body.welcomed !== undefined) && !bot?.defaultBot) return "Only MausBot is hidden this way; archive or delete other bots.";
  return body.hidden === true && bot?.defaultBot ? defaultBotRefusal(bot.name) : null;
}

export function ownsDefaultBot(bot: BotRecord | null | undefined, email: string | undefined): boolean {
  return Boolean(email && bot?.defaultBot && defaultBotPerson(bot) === email.trim().toLowerCase());
}

/** The English intro; clients that know `helperIntro` say it in the viewer's own language. */
export function helperIntroMessage(bot: Pick<BotRecord, "name" | "chiefOfStaff">, team?: string | null): Omit<Message, "id" | "at"> {
  const title = `Hi, I'm ${bot.name}, your helper for everything here.`;
  const subtitle = [
    "I know this app inside out, so ask me how to do anything. I can set up new bots, apps and routines with you, and tell you what your bots are up to.",
    bot.chiefOfStaff ? "As your Chief of Staff, I also keep an eye on your day and send you a short brief." : "",
    team ? `On ${team}, I'm here for you and look after your own bots.` : "",
    "Try one of these, or just say what you need.",
  ].filter(Boolean).join(" ");
  return { role: "bot", kind: "options", text: `${title} ${subtitle}`, helperIntro: true, card: { title, subtitle, options: [...HELPER_ASKS], fixedOptions: true } };
}

function ledger(dataDir: string): Record<string, string> {
  const file = join(dataDir, LEDGER);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { places?: unknown };
    return parsed.places && typeof parsed.places === "object" ? parsed.places as Record<string, string> : {};
  } catch {
    return {};
  }
}

function remember(dataDir: string, person: string, botId: string): void {
  const places = ledger(dataDir);
  if (places[person] === botId) return;
  writeFileAtomic(join(dataDir, LEDGER), JSON.stringify({ v: 1, places: { ...places, [person]: botId } }), { mode: 0o600 });
}

/** A new install's own MausBot from before it was marked: the place's oldest bot, still live, outside any department,
 * not installed from a package, and still named MausBot or still in the colour a new install gave it. */
export function seededMausBot(bots: readonly BotRecord[]): BotRecord | undefined {
  const oldest = bots.reduce<BotRecord | undefined>((first, bot) => !first || bot.createdAt < first.createdAt ? bot : first, undefined);
  if (!oldest || oldest.hidden || oldest.movedTo || oldest.section?.trim() || oldest.installedPackage) return undefined;
  return oldest.name === DEFAULT_BOT_NAME || oldest.color === STARTER_COLOR ? oldest : undefined;
}

/** Puts the intro where its person sees it next: in its open conversation while nobody has written there, else at the
 * top of a new one, so no earlier message moves. */
function introduce(store: DefaultBotStore, bot: BotRecord, team?: string | null): void {
  const untouched = !store.messagesFor(bot.threadId).some((message) => message.role === "user");
  const threadId = untouched ? bot.threadId : store.createTask(bot.id, `What ${bot.name} can do`)?.threadId;
  if (threadId) store.appendMessage(threadId, helperIntroMessage(bot, team));
}

/** A new MausBot, with its intro as its first message. On a Team Cloud it is its member's alone. */
export function createDefaultBot(store: DefaultBotStore, options: { person?: string; team?: string | null; chief?: (id: string) => void } = {}): BotRecord {
  const person = options.person?.trim().toLowerCase() ?? "";
  const taken = new Set(person ? [] : store.bots.map((bot) => bot.name.trim().toLowerCase()));
  const created = store.createBot({
    name: takeImportName(DEFAULT_BOT_NAME, taken),
    color: DEFAULT_BOT_COLOR,
    ...(person ? { visibility: { people: [person] } } : {}),
  }, { seedMessages: false });
  options.chief?.(created.id);
  const bot = store.patchBot(created.id, { defaultBot: person ? { person } : {} }) ?? created;
  store.appendMessage(bot.threadId, helperIntroMessage(bot, options.team));
  return bot;
}

/** Makes sure this place (no `person`) or this Team Cloud member has had its MausBot once: the one it has, the new
 * install's own adopted, or a new one. A MausBot that is gone is never made again. Two marked ones keep the oldest. A
 * place with no Chief of Staff at all gets MausBot as its Chief, so someone keeps an eye on the day; one that has a
 * Chief keeps it. */
export function ensureDefaultBot(store: DefaultBotStore, options: { dataDir: string; person?: string; team?: string | null }): BotRecord | null {
  const person = options.person?.trim().toLowerCase() ?? "";
  const marked = store.bots.filter((bot) => bot.defaultBot && defaultBotPerson(bot) === person)
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const extra of marked.slice(1)) store.patchBot(extra.id, { defaultBot: undefined, sidebarHidden: undefined });
  if (marked[0]) {
    remember(options.dataDir, person, marked[0].id);
    return marked[0];
  }
  if (Object.hasOwn(ledger(options.dataDir), person)) return null;
  const adoptable = person ? undefined : seededMausBot(store.bots);
  const chief = !person && !store.bots.some((bot) => bot.chiefOfStaff && !bot.hidden) ? (id: string) => store.setChiefOfStaff(id) : undefined;
  let bot: BotRecord;
  if (adoptable) {
    bot = store.patchBot(adoptable.id, { defaultBot: {}, ...(adoptable.color === STARTER_COLOR ? { color: DEFAULT_BOT_COLOR } : {}) }) ?? adoptable;
    chief?.(bot.id);
    introduce(store, bot, options.team);
  } else {
    bot = createDefaultBot(store, { person, team: options.team, chief });
  }
  remember(options.dataDir, person, bot.id);
  return bot;
}

/** A move brought this place's MausBot from another computer: it becomes the one MausBot here, and the one this place
 * had becomes an ordinary bot (retireUnusedStarter archives it when nobody used it). */
export function takeArrivingDefaultBot(store: Pick<Store, "bots" | "patchBot">, id: string): void {
  const arriving = store.bots.find((bot) => bot.id === id);
  if (!arriving) return;
  for (const bot of store.bots) {
    if (bot.id !== id && bot.defaultBot && !defaultBotPerson(bot)) store.patchBot(bot.id, { defaultBot: undefined, sidebarHidden: undefined });
  }
  if (!arriving.defaultBot || defaultBotPerson(arriving)) store.patchBot(id, { defaultBot: {} });
}

/** After a bot arrives by a move: the MausBot this place made for itself (by id, from the ledger), once it is neither
 * the MausBot nor the Chief and nobody has used it, is archived, so the move leaves one MausBot and nothing of the
 * person's is lost. */
export function retireUnusedStarter(store: Pick<Store, "bot" | "patchBot" | "messagesFor">, dataDir: string): void {
  const own = ledger(dataDir)[""];
  const seed = own ? store.bot(own) : null;
  if (!seed || seed.defaultBot || seed.chiefOfStaff || seed.hidden) return;
  if (seed.soul?.trim() || seed.title || seed.description || seed.avatarUrl || (seed.tasks?.length ?? 1) > 1) return;
  if (store.messagesFor(seed.threadId).some((message) => message.role === "user")) return;
  store.patchBot(seed.id, { hidden: true, pinned: undefined });
}
