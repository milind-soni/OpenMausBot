// The app_settings tool for one turn: find, get and set over the registry, where the entry's tier is the whole policy.
// Writes happen only in the owner's own turn and apply at once with Undo, a secret never passes through the bot, and an
// owner-only setting is only explained.
import { randomUUID } from "node:crypto";

import { isSettingsCardId, SETTINGS_CARD_IDS, type AppSettingRequest, type SettingsCardId } from "../../shared/app-settings.ts";
import { appendDecision } from "../decision-log.ts";
import { UNDO_STALE } from "../direct-apply.ts";
import type { TurnOwnerRefusal } from "../host/phones.ts";
import { serverLine } from "../server-lines.ts";
import type { BotRecord, GroupRecord, Store } from "../store.ts";
import type { ThemeTool } from "../themes/tool.ts";
import { cardElsewhere, cardNotInRoom, cardShownStatus, SETTINGS_CARDS } from "./cards.ts";
import type { TakenPicture } from "./picture-file.ts";
import { advancedOnlyPlace, findPlaces, placePath, placesList } from "./places.ts";
import { findSettings, personOnly, type SettingEntry, type WritableEntry } from "./registry.ts";

export const TOOL = "app_settings";
export const WRITE_BUDGET = 10;
const THEME_ACTIONS: readonly string[] = ["theme", "set_theme", "add_theme_asset", "theme_history", "undo_theme"];
const FIND_LIMIT = 8;
const NOT_SET = "not set";
const text = (value: string) => value || NOT_SET;
/** What a card and the bot see of a change: before → after, or, with no `before`, one line saying what it does. */
interface Shown {
  before?: string;
  after: string;
}
const said = ({ before, after }: Shown) => (before === undefined ? after : `${text(before)} → ${text(after)}`);

/** The tool sends every value as text so strict-schema providers accept it; numbers, true/false and JSON are read back
 * from it when the text alone does not fit the setting. A JSON object or list is judged as itself. */
function parseValue(entry: WritableEntry, value: unknown) {
  const direct = entry.value.safeParse(value);
  if (direct.success || typeof value !== "string") return direct;
  try {
    const json: unknown = JSON.parse(value);
    const read = entry.value.safeParse(json);
    return read.success || (typeof json === "object" && json !== null) ? read : direct;
  } catch {
    return direct;
  }
}

export interface Turn {
  botId: string;
  threadId: string;
  generation: string;
}

/** `before`: what Undo writes back; `after`: what the setting read as once applied, so Undo can tell it changed since. */
interface Undoable {
  entry: WritableEntry;
  before: unknown;
  after: string;
}

export type UndoResult =
  | { claimed: false }
  | { claimed: true; state: "already_undone" | "undone" }
  | { claimed: true; state: "invalid"; error: string; status: number; stale?: true };

export interface AppSettingsDeps {
  store: Pick<Store, "appendMessage" | "bot" | "messagesFor" | "patchMessage">;
  dataDir: string;
  entries: readonly SettingEntry[];
  /** Non-null when the turn is the owner's own (phones.turnOwner); null on a Team Cloud or hosted workspace. */
  turnOwner(turn: Turn): string | null;
  /** Why turnOwner is null (phones.turnOwnerRefusal), for the refusal's words only; turnOwner stays the guard. */
  ownerRefusal?(turn: Turn): TurnOwnerRefusal | null;
  guestDriven(threadId: string): boolean;
  /** The turn answers a routine, webhook or other automation, owner-written ones included: no lasting move onto this computer. */
  automated?(turn: Turn): boolean;
  /** The secret card, as request_credential posts it. */
  requestCredential(bot: BotRecord, threadId: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
  connectorThread(botId: string, threadId: string): { group?: GroupRecord } | null;
  language(threadId: string): string | undefined;
  /** The person's own themes; absent where the server offers none. */
  themes?: ThemeTool;
  /** For a setting that takes a picture file: stores the file the bot names, or says why not. */
  pictures?: { take(turn: Turn, path: string): Promise<TakenPicture>; discard(avatarUrl: string): void };
  /** Settings cards: whether a card's control exists on this server's own computer, and whether its setting is known to be on (null when the server cannot tell). Absent: no cards here. */
  cards?: { here(id: SettingsCardId): boolean; on(id: SettingsCardId): true | null };
}

export function createAppSettings(deps: AppSettingsDeps) {
  const { store, entries } = deps;
  const undoable = new Map<string, Undoable>();
  const writes = new Map<string, number>();
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  const reply = (status: number, body: Record<string, unknown>) => ({ status, body });
  const refuse = (status: number, error: string) => reply(status, { error });
  const describe = (entry: SettingEntry) => ({ id: entry.id, label: entry.label, tier: entry.tier, value: text(entry.read()), where: placePath(entry.where),
    ...(entry.tier !== "owner-only" && advancedOnlyPlace(entry.where) ? { inSimple: "set it as usual; never switch modes for it" } : {}) });
  /** Null when the turn is the owner's own; otherwise why not, so the refusal can say what the person can do instead. */
  const notOwners = (turn: Turn): NotOwners | null =>
    deps.guestDriven(turn.threadId) ? "guest" : deps.turnOwner(turn) !== null ? null : (deps.ownerRefusal?.(turn) ?? "unknown");
  const from = (bot: BotRecord, threadId: string) => (deps.connectorThread(bot.id, threadId)?.group ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {});
  const spendWrite = (turn: Turn): string | null => {
    const spent = writes.get(turn.generation) ?? 0;
    if (spent >= WRITE_BUDGET) return `This turn has already changed ${WRITE_BUDGET} settings. Ask the user to send a new message before changing more.`;
    writes.set(turn.generation, spent + 1);
    if (writes.size > 200) writes.delete(writes.keys().next().value!);
    return null;
  };
  const releaseWrite = (turn: Turn): void => {
    const spent = writes.get(turn.generation) ?? 0;
    if (spent <= 1) writes.delete(turn.generation);
    else writes.set(turn.generation, spent - 1);
  };

  const isBatchValue = (value: unknown): value is { botIds: unknown } =>
    Boolean(value && typeof value === "object" && "botIds" in value && (value as { botIds?: unknown }).botIds !== undefined);

  /** Applies the change, posts its applied card with Undo, and logs it in the decision log. */
  async function apply(turn: Turn, bot: BotRecord, entry: WritableEntry, value: unknown, change?: string) {
    let before: unknown;
    let was = "";
    let shownChange = change;
    let skipped: Array<{ botId: string; name: string; reason: string }> = [];
    if (entry.writeBatch && isBatchValue(value)) {
      const batch = await entry.writeBatch(value);
      if (batch.refusal) {
        releaseWrite(turn);
        return refuse(409, batch.refusal);
      }
      before = batch.before;
      shownChange = batch.change;
      skipped = batch.skipped ?? [];
    } else {
      before = await entry.current(value);
      was = entry.read();
      const refusal = await entry.write(value);
      if (refusal) return refuse(409, refusal);
    }
    const afterRead = entry.read();
    const after = entry.undoTag ? entry.undoTag(before) : afterRead;
    const shown: Shown = shownChange === undefined ? { before: was, after: afterRead } : { after: shownChange };
    const requestId = randomUUID();
    const language = deps.language(turn.threadId);
    const notSet = (value: string) => value || serverLine(language, "server.appSettings.notSet");
    const appSettingRequest: AppSettingRequest = { settingId: entry.id, label: entry.label, ...(shown.before === undefined ? {} : { before: shown.before }), after: shown.after, tier: entry.tier };
    store.appendMessage(turn.threadId, {
      role: "bot", kind: "options", ...from(bot, turn.threadId),
      card: { title: serverLine(language, "server.appSettings.changed", { label: entry.label }), subtitle: shown.before === undefined ? shown.after : `${notSet(shown.before)} → ${notSet(shown.after)}`,
        options: [], requestId, tool: TOOL, fixedOptions: true, appSettingRequest, answered: "allow", dismissed: true, autoApplied: true },
    });
    undoable.set(requestId, { entry, before, after });
    appendDecision(deps.dataDir, { threadId: turn.threadId, requestId, botId: turn.botId, botName: bot.name, tool: TOOL, summary: `${entry.id}: ${said(shown)}`, decision: "auto-approved", source: "app-settings" });
    const done = shownChange === undefined ? `Changed ${entry.label} from ${text(was)} to ${text(afterRead)}.` : `Done: ${shownChange}. ${entry.label} now: ${text(afterRead)}.`;
    const skippedNote = skipped.length
      ? ` Skipped ${skipped.length} ${skipped.length === 1 ? "bot" : "bots"}: ${skipped.map((item) => `${item.name} (${item.reason})`).join("; ")}${skipped.at(-1)!.reason.endsWith(".") ? "" : "."}`
      : "";
    return reply(200, { text: `${done}${skippedNote} The user can undo it from the card in the conversation.` });
  }

  async function set(turn: Turn, body: Record<string, unknown>) {
    const entry = typeof body.id === "string" ? byId.get(body.id) : undefined;
    if (!entry) return refuse(404, `No setting with id ${JSON.stringify(body.id ?? null)}. Use action find first.`);
    const bot = store.bot(turn.botId);
    if (!bot) return refuse(404, "This bot no longer exists.");
    if (entry.tier === "owner-only") return refuse(403, personOnly(entry.label, entry.where));
    const notOwner = notOwners(turn);
    if (notOwner) return refuse(403, `Settings change only in the owner's own conversation. Nothing changed; you may still read settings. ${whyNotOwners(notOwner, placePath(entry.where))}`);
    if (entry.tier === "secret") {
      if (body.value !== undefined) return refuse(400, `Never send a key or token as a value. Call set on ${entry.id} with no value: a secure card asks the user for it, and you never see it.`);
      const budget = spendWrite(turn);
      if (budget) return refuse(429, budget);
      const posted = await deps.requestCredential(bot, turn.threadId, { credentialId: entry.credentialId, reason: typeof body.reason === "string" ? body.reason : undefined });
      if (!posted.body.error && posted.body.alreadyConfigured === true) return reply(200, { text: `${entry.label} is already set. To replace it, the user changes it in ${placePath(entry.where)}.` });
      if (posted.status >= 300) return refuse(posted.status, String(posted.body.error ?? "The secure card could not be shown."));
      return reply(200, { text: `A secure card for ${entry.label} is ready in MausBot. End this turn now and say in one line that you are waiting for it; MausBot resumes you when the user saves it or declines. You never see the key.` });
    }
    const parsed = parseValue(entry, body.value);
    if (!parsed.success) return refuse(400, `${entry.label} takes ${entry.allowed}. ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    if (entry.id === "bots.settings" && (parsed.data as { computer?: unknown }).computer === "local" && deps.automated?.(turn)) {
      return refuse(403, `A routine or automation can't keep a bot on this computer. Nothing changed: say in one line that the person can choose This computer under “Where ${bot.name} works” in Bot's screen, or ask you in their own chat.`);
    }
    const described = entry.describe?.(parsed.data);
    if (described && "refusal" in described) return refuse(409, described.refusal);
    const budget = spendWrite(turn);
    if (budget) return refuse(429, budget);
    const picture = entry.fromFile ? await takePicture(turn, parsed.data) : { value: parsed.data };
    if ("refusal" in picture) return refuse(400, picture.refusal);
    const applied = await apply(turn, bot, entry, picture.value, described?.change);
    if (picture.stored && applied.status >= 300) deps.pictures?.discard(picture.stored);
    return applied;
  }

  /** A value naming a picture file by `path` goes on as the stored picture's `avatarUrl`; an empty path stays, to remove it. */
  async function takePicture(turn: Turn, value: unknown): Promise<{ value: unknown; stored?: string } | { refusal: string }> {
    const { path, ...rest } = value as { path?: unknown };
    if (typeof path !== "string" || !path) return { value };
    if (!deps.pictures) return { refusal: "Pictures can't be set from a file here." };
    const taken = await deps.pictures.take(turn, path);
    return "refusal" in taken ? taken : { value: { ...rest, avatarUrl: taken.avatarUrl }, stored: taken.avatarUrl };
  }

  /** A theme is the person's whose own message began the work, never a teammate's or a guest's. */
  async function theme(turn: Turn, body: Record<string, unknown>) {
    const themes = deps.themes;
    if (!themes) return refuse(404, "Themes are not available on this server.");
    const bot = store.bot(turn.botId);
    if (!bot) return refuse(404, "This bot no longer exists.");
    const person = deps.guestDriven(turn.threadId) ? null : themes.person(turn);
    if (!person) return refuse(403, "A theme changes only for the person who asked, in their own conversation. This turn was not started by them here, so nothing changed.");
    if (body.action === "theme") return themes.overview(person, body.id);
    if (body.action === "theme_history") return themes.history(person);
    const asked = body.action === "set_theme" ? themes.wanted(person, body) : body.action === "undo_theme" ? themes.undo(person, body) : null;
    if (asked && "error" in asked) return refuse(400, asked.error);
    const budget = spendWrite(turn);
    if (budget) return refuse(429, budget);
    return asked ? apply(turn, bot, themes.entry(person), asked.wear, asked.change) : themes.addAsset(turn, person, body);
  }

  /** Shows a setting's own control in the conversation. Security invariant: the reply and the row carry fixed words and
   * the card's id only; the control's code, link and address never pass through here. */
  function showCard(turn: Turn, body: Record<string, unknown>) {
    if (!isSettingsCardId(body.card)) return refuse(404, `No settings card ${JSON.stringify(body.card ?? null)}. Cards: ${SETTINGS_CARD_IDS.join(", ")}.`);
    const card = SETTINGS_CARDS[body.card];
    const bot = store.bot(turn.botId);
    if (!bot) return refuse(404, "This bot no longer exists.");
    const notOwner = notOwners(turn);
    if (notOwner) return refuse(403, `A settings card shows only in the owner's own conversation, when they asked. Nothing was shown. ${whyNotOwners(notOwner, "Settings")}`);
    if (!deps.cards?.here(body.card)) return reply(200, { text: cardElsewhere(card) });
    if (deps.connectorThread(bot.id, turn.threadId)?.group) return reply(200, { text: cardNotInRoom(card) });
    const budget = spendWrite(turn);
    if (budget) return refuse(429, budget);
    store.appendMessage(turn.threadId, { role: "bot", kind: "text", text: card.text, settingsCard: { id: body.card } });
    return reply(200, { text: cardShownStatus(card, deps.cards.on(body.card)) });
  }

  return {
    async handle(body: Record<string, unknown>, turn: Turn): Promise<{ status: number; body: Record<string, unknown> }> {
      if (body.action === "find") {
        const query = typeof body.query === "string" ? body.query : "";
        const hits = findSettings(entries, query, FIND_LIMIT).map(describe);
        if (hits.length) return reply(200, { text: JSON.stringify(hits) });
        const places = findPlaces(query);
        return reply(200, { text: `No setting you can change matches ${JSON.stringify(query)}.${places.length ? ` Where the person finds it in the app: ${places.join("; ")}.` : " Try other words, or use action places."}` });
      }
      if (body.action === "places") {
        const query = typeof body.query === "string" ? body.query.trim() : "";
        const places = query ? findPlaces(query) : [];
        return reply(200, { text: query ? (places.length ? places.join("\n") : `No place in the app matches ${JSON.stringify(query)}. Here is every place:\n${placesList()}`) : placesList() });
      }
      if (body.action === "get") {
        const entry = typeof body.id === "string" ? byId.get(body.id) : undefined;
        if (!entry) return refuse(404, `No setting with id ${JSON.stringify(body.id ?? null)}. Use action find first.`);
        return reply(200, { text: JSON.stringify({ ...describe(entry), help: entry.help, ...("allowed" in entry ? { allowed: entry.allowed } : {}),
          change: entry.tier === "owner-only" ? `only the person, in ${placePath(entry.where)}` : entry.tier === "secret" ? "set with no value opens a secure card" : "set applies at once, with Undo on the card" }) });
      }
      if (body.action === "set") return set(turn, body);
      if (body.action === "show_card") return showCard(turn, body);
      if (typeof body.action === "string" && THEME_ACTIONS.includes(body.action)) return theme(turn, body);
      return refuse(400, `action must be find, get, set, show_card, places, ${THEME_ACTIONS.join(", ")}.`);
    },

    /** Undo on an applied card: restores the value read before the change, unless it changed since. */
    async undo(args: { threadId: string; requestId: string }): Promise<UndoResult> {
      const message = store.messagesFor(args.threadId).find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.appSettingRequest);
      const current = message?.card;
      if (!message || !current) return { claimed: false };
      if (current.undone) return { claimed: true, state: "already_undone" };
      const change = undoable.get(args.requestId);
      if (!change || current.answered !== "allow") return { claimed: true, state: "invalid", error: "This change can't be undone here.", status: 409 };
      const currentTag = change.entry.undoTag ? change.entry.undoTag(change.before) : change.entry.read();
      if (currentTag !== change.after) return { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
      const refusal = change.before === undefined ? "The earlier value is not one that can be set back." : await change.entry.write(change.before);
      if (refusal) {
        if (change.before !== undefined) change.after = change.entry.undoTag ? change.entry.undoTag(change.before) : change.entry.read();
        return { claimed: true, state: "invalid", error: refusal, status: 409 };
      }
      undoable.delete(args.requestId);
      store.patchMessage(args.threadId, message.id, { card: { ...current, undone: true } });
      return { claimed: true, state: "undone" };
    },
  };
}

type NotOwners = TurnOwnerRefusal | "guest" | "unknown";

/** Why a turn is not the owner's own, and what the person can do instead, in words the bot can pass on. */
export function whyNotOwners(why: NotOwners, where: string): string {
  const themselves = `The person can change it themselves in ${where}.`;
  const fresh = "Or they ask again in a new conversation with this bot that only they write in.";
  switch (why) {
    case "shared": return `Several people share this server, so bots never change its settings. ${themselves}`;
    case "service": return `This server is set up as a shared or hosted server, so bots never change its settings. ${themselves}`;
    case "guest": return `A guest writes in this conversation, so it is not the owner's own. ${themselves}`;
    case "someone-else": return `Someone else wrote or answered in this conversation, or a bot opened it, so asking again here won't work. ${themselves} ${fresh}`;
    case "not-owner": return `This turn was started by someone other than the owner, or by a routine, webhook or app the owner didn't write. ${themselves} ${fresh}`;
    case "memory-changed":
    case "memory-changed-here": return `This bot's memory was changed in a conversation the owner didn't write. ${themselves} Or, in this bot's settings, they open Memory, check what changed, tap Mark reviewed and ask again.`;
    case "unproven":
    case "unknown": return `This turn can't be tied to a message the owner sent here (it was stopped, or started another way). ${themselves} Or they send the request again.`;
  }
}
