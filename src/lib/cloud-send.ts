// What either page says about the one-time move to My Cloud (electron/one-home.mjs), and what arrived, in words.
import type { CloudSendCounts } from "../../electron/cloud-send.mjs";
import type { OneHomeCounts, OneHomeView } from "../../electron/one-home.mjs";
import type { TeamMoveView } from "../../electron/team-move.mjs";
import type { LocaleKey } from "@/locales";
import { activeLocale, t } from "@/lib/i18n";

const counted = (count: number, one: LocaleKey, many: LocaleKey) => t(count === 1 ? one : many, { count });

export const listOf = (parts: string[]) => new Intl.ListFormat(activeLocale(), { type: "conjunction" }).format(parts);

/** The words main threw, without Electron's "Error invoking remote method" wrapper; null when there are none. */
export function ipcErrorText(cause: unknown): string | null {
  return cause instanceof Error && cause.message ? cause.message.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/u, "") : null;
}

/** "12 bots, 3 skills, 2 logins, 1Password and 48 chats", from counts only. */
export function countedList(sent: CloudSendCounts): string[] {
  const chats = sent.chats;
  return [
    ...(sent.bots ? [counted(sent.bots, "cloudSend.list.botOne", "cloudSend.list.bots")] : []),
    ...(sent.updatedBots ? [counted(sent.updatedBots, "cloudSend.list.changedBotOne", "cloudSend.list.changedBots")] : []),
    ...(sent.skills ? [counted(sent.skills, "cloudSend.list.skillOne", "cloudSend.list.skills")] : []),
    ...(sent.logins ? [counted(sent.logins, "cloudSend.list.loginOne", "cloudSend.list.logins")] : []),
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
  if (!move) return 0;
  if (move.phase === "done") return move.at ? move.at + MOVE_QUIET_MS : 0;
  return Infinity;
}

/** The one-time move's line on either page: on its way (with progress, or who it waits for), almost done, failing for a
 * day (with Try again), what arrived (on My Cloud's page, once), coming home, where the bots came home instead, or this
 * computer's bots on their way home and home because the person keeps them here.
 * `page`: which page shows it; `reason`: why a failing move failed, in main's words, when it said. */
export function moveLine(move: OneHomeView, page: "local" | "cloud"): { kind: "sending" | "failed" | "done"; text: string; extra: string[]; phone?: true; retry?: true; reason?: string } | null {
  if (move.phase === "done") {
    if (page !== "cloud") return null;
    const list = move.counts ? arrivedList(move.counts) : [];
    return { kind: "done", text: list.length ? t("cloudSend.move.done", { list: listOf(list) }) : t("cloudSend.move.doneAll"),
      extra: move.held.map((key) => t("cloudSend.result.held", { key })), ...(move.phone ? { phone: true as const } : {}) };
  }
  if (move.phase === "keeping") return { kind: "sending", text: t(move.updating ? "cloudSend.move.keepingUpdating" : "cloudSend.move.keeping"), extra: [] };
  if (move.phase === "home-again" || move.phase === "back") {
    if (page !== "local") return null;
    if (move.phase === "back" && move.kept) return { kind: "done", text: t("cloudSend.move.kept"), extra: [] };
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
    return failing.error ? { kind: "failed", text: t("cloudSend.move.failing", { error: failing.error }), extra: [], retry: true, reason: failing.error }
      : { kind: "failed", text: t("cloudSend.move.failingPlain"), extra: [], retry: true };
  }
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

/** A bot moving from My Cloud into a team, on My Cloud's page: on its way, failed (it is still here, unchanged), or done. */
export function teamMoveLine(move: TeamMoveView): { kind: "sending" | "failed" | "done"; text: string } {
  const names = { bot: move.bot.name, team: move.team.name };
  if (move.phase === "done") return { kind: "done", text: t("teamMove.done", names) };
  if (move.phase === "failed") return { kind: "failed", text: t("teamMove.failed", names) };
  return { kind: "sending", text: t("teamMove.moving", names) };
}
