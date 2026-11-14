// What either page says about the one-time move to My Cloud (electron/one-home.mjs), and what arrived, in words.
import type { BotMoveView, CloudSendCounts } from "../../electron/cloud-send.mjs";
import type { OneHomeCounts, OneHomeNotCarried, OneHomeStayed, OneHomeView } from "../../electron/one-home.mjs";
import type { TeamMoveRefusal, TeamMoveRefusalCode, TeamMoveView } from "../../electron/team-move.mjs";
import type { LocaleKey } from "@/locales";
import { activeLocale, t, tFromServer } from "@/lib/i18n";
import { serverErrorText } from "@/lib/server-error";

const counted = (count: number, one: LocaleKey, many: LocaleKey) => t(count === 1 ? one : many, { count });

export const listOf = (parts: string[]) => new Intl.ListFormat(activeLocale(), { type: "conjunction" }).format(parts);

/** Refusals the preload sends before main is asked: it has no catalog, so they come in English. */
const BRIDGE_REFUSALS: Readonly<Record<string, LocaleKey>> = {
  "Turn the switch to keep this computer's bots here.": "cloudAccount.keepHere.unclicked",
  "Choose Try again to move.": "cloudSend.move.unclicked",
  "Choose Move to move the bot.": "teamMove.unclicked",
  "Choose which bots move.": "cloudSend.choose.unclicked",
};

/** The words main threw, without Electron's "Error invoking remote method" wrapper; null when there are none. */
export function ipcErrorText(cause: unknown): string | null {
  const text = cause instanceof Error && cause.message ? cause.message.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/u, "") : null;
  return text !== null && Object.hasOwn(BRIDGE_REFUSALS, text) ? t(BRIDGE_REFUSALS[text]!) : text;
}

/** "12 bots, 3 skills, 2 logins, 1Password and 48 chats", from counts only. */
export function countedList(sent: CloudSendCounts): string[] {
  const chats = sent.chats;
  return [
    ...(sent.bots ? [counted(sent.bots, "cloudSend.list.botOne", "cloudSend.list.bots")] : []),
    ...(sent.updatedBots ? [counted(sent.updatedBots, "cloudSend.list.changedBotOne", "cloudSend.list.changedBots")] : []),
    ...(sent.skills ? [counted(sent.skills, "cloudSend.list.skillOne", "cloudSend.list.skills")] : []),
    ...(sent.logins ? [counted(sent.logins, "cloudSend.list.loginOne", "cloudSend.list.logins")] : []),
    ...(sent.secrets ? [counted(sent.secrets, "cloudSend.list.secretOne", "cloudSend.list.secrets")] : []),
    ...(sent.onePassword ? [t("cloudSend.list.onePassword")] : []),
    ...(sent.settings ? [t("cloudSend.list.settings")] : []),
    ...(chats?.conversations ? [counted(chats.conversations, "cloudSend.list.chatOne", "cloudSend.list.chats")]
      : chats?.messages ? [counted(chats.messages, "cloudSend.list.messageOne", "cloudSend.list.messages")] : []),
  ];
}

/** "4 bots, 2 skills, 2 logins, 1Password, 148 chats and 2 routines": what the move checked on both sides. */
export function arrivedList(counts: OneHomeCounts): string[] {
  return [
    ...(counts.bots ? [counted(counts.bots, "cloudSend.list.botOne", "cloudSend.list.bots")] : []),
    ...(counts.skills ? [counted(counts.skills, "cloudSend.list.skillOne", "cloudSend.list.skills")] : []),
    ...(counts.logins ? [counted(counts.logins, "cloudSend.list.loginOne", "cloudSend.list.logins")] : []),
    ...(counts.onePassword ? [t("cloudSend.list.onePassword")] : []),
    ...(counts.chats ? [counted(counts.chats, "cloudSend.list.chatOne", "cloudSend.list.chats")] : []),
    ...(counts.routines ? [counted(counts.routines, "cloudSend.list.routineOne", "cloudSend.list.routines")] : []),
  ];
}

/** How long after the move is done the corner cards that sell or ask for something still wait. */
export const MOVE_QUIET_MS = 5 * 60_000;

/** Until when the corner cards that sell or ask for something (Product Hunt, the star, Cloud offers) wait for the
 * one-time move: for good while it goes or brings things home (Infinity), and MOVE_QUIET_MS after it is done. */
export function moveQuietUntil(move: OneHomeView | null | undefined): number {
  if (!move || move.phase === "choose") return 0;
  if (move.phase === "done") return move.at ? move.at + MOVE_QUIET_MS : 0;
  return Infinity;
}

/** What a move could not carry, one line each: its name, then why. */
const notCarried = (items: OneHomeNotCarried[] | undefined) => (items ?? []).map((item) => `${item.label}: ${item.error}`);
/** What stayed on this computer because it only works here, one line each. */
const stayedHere = (items: OneHomeStayed[] | undefined) => (items ?? []).map((item) => (item.needs
  ? t("cloudSend.move.stayedNeeds", { name: item.name, program: item.needs })
  : t("cloudSend.move.stayedHere", { name: item.name })));

const atTime = (at: number) => new Intl.DateTimeFormat(activeLocale(), { timeStyle: "short" }).format(at);
const percent = (done: number, total: number) => Math.min(100, Math.floor((done / Math.max(1, total)) * 100));

/** What a move that is under way waits for or checks now, when it says: My Cloud slow to answer, another computer moving
 * into it first, or how far the check of what arrived is; null when it says none of that. */
function underWayLine(move: OneHomeView, place?: string): string | null {
  const slow = "slow" in move ? move.slow : undefined;
  if (slow) return place ? t("cloudSend.move.slowNamed", { place, time: atTime(slow.until) }) : t("cloudSend.move.slow", { time: atTime(slow.until) });
  const queued = "queued" in move ? move.queued : undefined;
  if (queued && !place) return queued.name ? t("cloudSend.move.queued", { name: queued.name }) : t("cloudSend.move.queuedAny");
  const checking = move.phase === "finishing" ? move.checking : undefined;
  if (!checking) return null;
  const share = percent(checking.done, checking.total);
  if (place) return checking.step === "chats" && checking.total ? t("cloudSend.move.checkingChatsNamed", { place, bots: checking.bots, percent: share }) : t("cloudSend.move.checkingNamed", { place });
  if (checking.step === "chats" && checking.total) return checking.bots === 1 ? t("cloudSend.move.checkingChatsOne", { percent: share }) : t("cloudSend.move.checkingChats", { bots: checking.bots, percent: share });
  if (checking.step === "files" && checking.total) return t("cloudSend.move.checkingFiles", { percent: share });
  if (checking.step === "attachments" && checking.total) return t("cloudSend.move.checkingAttachments", { percent: share });
  return t("cloudSend.move.checking");
}

/** The one-time move's line on either page: on its way (with progress, or who it waits for), almost done, failing for a
 * day (with Try again), what arrived (on My Cloud's page, once), coming home, where the bots came home instead, or this
 * computer's bots on their way home and home because the person keeps them here.
 * `page`: which page shows it; `reason`: why a failing move failed, in main's words, when it said. */
export function moveLine(move: OneHomeView, page: "local" | "cloud"): { kind: "sending" | "failed" | "done"; text: string; extra: string[]; phone?: true; retry?: true; reason?: string; place?: string } | null {
  if (move.phase === "choose") return null;
  if (move.place) return ownMoveLine(move, move.place, page);
  if (move.phase === "done") {
    if (page !== "cloud") return null;
    const list = move.counts ? arrivedList(move.counts) : [];
    const text = move.left?.length || move.stayed?.length ? t("cloudSend.move.doneLeft") : list.length ? t("cloudSend.move.done", { list: listOf(list) }) : t("cloudSend.move.doneAll");
    return { kind: "done", text, extra: [...notCarried(move.left), ...stayedHere(move.stayed), ...move.held.map((key) => t("cloudSend.result.held", { key }))], ...(move.phone ? { phone: true as const } : {}) };
  }
  if (move.phase === "keeping") return { kind: "sending", text: t(move.updating ? "cloudSend.move.keepingUpdating" : "cloudSend.move.keeping"), extra: [] };
  if (move.phase === "home-again" || move.phase === "back") {
    if (page !== "local") return null;
    if (move.phase === "back" && move.kept) return { kind: "done", text: t("cloudSend.move.kept"), extra: [] };
    if (move.phase === "back" && move.gone) return { kind: "done", text: t("cloudSend.move.backGone"), extra: [] };
    const elsewhere = move.phase === "back" ? move.elsewhere : undefined;
    if (elsewhere) {
      return { kind: "done", extra: [], text: elsewhere.since
        ? t("cloudSend.move.elsewhere", { name: elsewhere.name, date: new Intl.DateTimeFormat(activeLocale(), { dateStyle: "long" }).format(elsewhere.since) })
        : t("cloudSend.move.elsewhereEmpty", { name: elsewhere.name }) };
    }
    return { kind: "done", text: t(move.phase === "home-again" ? "cloudSend.move.homeAgain" : move.lost ? "cloudSend.move.backLost" : "cloudSend.move.back"), extra: [] };
  }
  if (move.phase === "copy" && move.updating) return { kind: "sending", text: t("cloudSend.move.updating"), extra: [] };
  const failing = "failing" in move ? move.failing : undefined;
  if (failing) {
    const extra = notCarried(failing.items);
    return failing.error ? { kind: "failed", text: t("cloudSend.move.failing", { error: serverErrorText(failing, failing.error) }), extra, retry: true, reason: serverErrorText(failing, failing.error) }
      : { kind: "failed", text: t("cloudSend.move.failingPlain"), extra, retry: true };
  }
  const underWay = underWayLine(move);
  if (underWay) return { kind: "sending", text: underWay, extra: [] };
  if (move.phase === "finishing") return { kind: "sending", text: t("cloudSend.move.finishing"), extra: [] };
  // Who holds the move, by name, or what it is; nothing is claimed while it only waits for a quiet moment.
  if (move.phase === "wait" && move.waitingFor !== undefined) {
    const text = move.waitingFor ? t("cloudSend.move.waiting", { name: move.waitingFor })
      : move.waitingWhat === "sign-in" ? t("cloudSend.move.waitingSignIn") : t("cloudSend.move.waitingAny");
    return { kind: "sending", text, extra: [] };
  }
  const chats = move.phase === "copy" ? move.chats : undefined;
  const key = page === "cloud" ? (chats ? "cloudSend.move.bringingChats" : "cloudSend.move.bringing") : (chats ? "cloudSend.move.copyChats" : "cloudSend.move.copy");
  return { kind: "sending", text: t(key, chats ? { done: chats.done, total: chats.total } : {}), extra: [] };
}

/** The move to a server of the person's own, named `place`, on this computer's page: on its way, almost done, waiting for
 * that server's update, or failing for a day with Try again. Once done the window shows that server, which says nothing
 * of it here. */
function ownMoveLine(move: OneHomeView, place: string, page: "local" | "cloud"): ReturnType<typeof moveLine> {
  // What that server refused for good is said there, where the window opens once the move is done.
  if (move.phase === "done" && page === "cloud" && (move.left?.length || move.stayed?.length)) return { kind: "done", text: t("cloudSend.move.doneLeft"), extra: [...notCarried(move.left), ...stayedHere(move.stayed)], place };
  if (page !== "local" || !["copy", "wait", "finishing"].includes(move.phase)) return null;
  const line = (kind: "sending" | "failed", text: string, more: { retry?: true; reason?: string; extra?: string[] } = {}) => ({ kind, text, extra: [], place, ...more });
  const failing = "failing" in move ? move.failing : undefined;
  if (failing) {
    const extra = notCarried(failing.items);
    return failing.error ? line("failed", t("cloudSend.move.failingNamed", { place, error: serverErrorText(failing, failing.error) }), { retry: true, reason: serverErrorText(failing, failing.error), extra })
      : line("failed", t("cloudSend.move.failingPlainNamed", { place }), { retry: true, extra });
  }
  if (move.phase === "copy" && move.updating) return line("sending", t("cloudSend.move.updatingNamed", { place }));
  const underWay = underWayLine(move, place);
  if (underWay) return line("sending", underWay);
  if (move.phase === "finishing") return line("sending", t("cloudSend.move.finishingNamed", { place }));
  if (move.phase === "wait" && move.waitingFor !== undefined) {
    return line("sending", move.waitingFor ? t("cloudSend.move.waitingNamed", { place, name: move.waitingFor })
      : t(move.waitingWhat === "sign-in" ? "cloudSend.move.waitingSignInNamed" : "cloudSend.move.waitingAnyNamed", { place }));
  }
  const chats = move.phase === "copy" ? move.chats : undefined;
  return line("sending", chats ? t("cloudSend.move.copyChatsNamed", { place, done: chats.done, total: chats.total }) : t("cloudSend.move.copyNamed", { place }));
}

/** The "team" a bot that moved from this computer to My Cloud is held for (electron/bot-move-main.mjs). */
export const MY_CLOUD_TEAM = "my-cloud";
/** How many of the choice the list shows at a time, however many bots there are. */
export const CHOOSER_PAGE = 200;
/** The bots whose names hold every word of `query`. */
export function filterBots<T extends { name: string }>(bots: readonly T[], query: string): readonly T[] {
  const words = query.trim().toLocaleLowerCase(activeLocale()).split(/\s+/u).filter(Boolean);
  if (!words.length) return bots;
  return bots.filter((bot) => { const name = bot.name.toLocaleLowerCase(activeLocale()); return words.every((word) => name.includes(word)); });
}

/** Some of this computer's bots moving to My Cloud, on this computer's page. */
export function botMoveLine(move: BotMoveView): { kind: "sending" | "failed" | "done"; text: string } {
  const count = move.bots ?? 1, many = count > 1;
  const params: Record<string, string | number> = many ? { count } : { bot: move.bot.name };
  if (move.phase === "done") return { kind: "done", text: t(many ? "cloudSend.botMove.doneMany" : "cloudSend.botMove.done", params) };
  if (move.phase === "failed") return { kind: "failed", text: t(many ? "cloudSend.botMove.failedMany" : "cloudSend.botMove.failed", params) };
  return { kind: "sending", text: t(many ? "cloudSend.botMove.movingMany" : "cloudSend.botMove.moving", params) };
}

/** A bot moving from My Cloud into a team, on My Cloud's page: on its way, failed (it is still here, unchanged), or done. */
export function teamMoveLine(move: TeamMoveView): { kind: "sending" | "failed" | "done"; text: string } {
  const names = { bot: move.bot.name, team: move.team.name };
  if (move.phase === "done") return { kind: "done", text: t("teamMove.done", names) };
  if (move.phase === "failed") return { kind: "failed", text: t("teamMove.failed", names) };
  return { kind: "sending", text: t("teamMove.moving", names) };
}

const TEAM_MOVE_REFUSALS: Record<TeamMoveRefusalCode, LocaleKey> = {
  notInTeam: "teamMove.refused.notInTeam",
  notABot: "teamMove.refused.notABot",
  movingElsewhere: "teamMove.refused.movingElsewhere",
};

export function teamMoveRefusalText(refused: TeamMoveRefusal): string {
  const params = Object.fromEntries(Object.entries(Object(refused.params)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return Object.hasOwn(TEAM_MOVE_REFUSALS, refused.code) ? tFromServer(TEAM_MOVE_REFUSALS[refused.code as TeamMoveRefusalCode], refused.message, params) : refused.message;
}
