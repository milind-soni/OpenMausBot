// Display only: the room card never changes a plan or a limit. The Admin decides when a Cloud is short on room and which
// plan fixes it (the session's `cloud.room`); its Upgrade goes through the usual preview and confirmation.
import type { CloudRoom, CloudUsage } from "../../electron/cloud-home.mjs";
import { cloudPlanLabel, usd } from "@/lib/cloud-plan";
import { activeLocale, t } from "@/lib/i18n";
import { TEAM_TIERS } from "@/lib/usage-meter";

export interface RoomCardView {
  id: string;
  kind: "memory" | "disk";
  title: string;
  /** What ran short, in the person's own numbers. */
  cause: string;
  /** The plan that fixes it, what it gives and its price; null on the top plan, which has a tip instead. */
  offer: { tier: string; text: string; price: string } | null;
  tip: string | null;
}

const count = (value: number, one: Parameters<typeof t>[0], many: Parameters<typeof t>[0]) => value === 1 ? t(one) : t(many, { count: String(value) });
const gb = (value: number) => new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 1 }).format(value);

export function roomCauseText(cause: CloudRoom["cause"]): string {
  if (cause.kind === "disk") return t("roomCard.cause.disk", { used: gb(cause.usedGb), cap: gb(cause.capGb) });
  // A wait that began before the day counts its minutes but not its start.
  const waits = Math.max(cause.waits, cause.waitMinutes > 0 ? 1 : 0), tasks = count(waits, "roomCard.tasks.one", "roomCard.tasks.many");
  const waited = waits === 0 ? null : cause.waitMinutes > 0
    ? t("roomCard.cause.waited", { tasks, minutes: count(cause.waitMinutes, "roomCard.minutes.one", "roomCard.minutes.many") })
    : t("roomCard.cause.waitedBriefly", { tasks });
  const stopped = cause.stopped === 0 ? null : count(cause.stopped, "roomCard.cause.stopped.one", "roomCard.cause.stopped.many");
  return [waited, stopped].filter(Boolean).join(" ");
}

function offerText(plan: NonNullable<CloudRoom["plan"]>, kind: RoomCardView["kind"]): string {
  const name = cloudPlanLabel(plan.tier);
  if (kind === "disk") return t("roomCard.offer.disk", { plan: name, gb: gb(plan.diskGb) });
  const times = plan.fromMemoryMb > 0 ? plan.memoryMb / plan.fromMemoryMb : 0;
  if (times === 2) return t("roomCard.offer.memoryTwice", { plan: name });
  if (Number.isInteger(times) && times > 2) return t("roomCard.offer.memoryTimes", { plan: name, times: String(times) });
  return t("roomCard.offer.memoryMore", { plan: name, gb: gb(plan.memoryMb / 1024) });
}

/**
 * The card, or null while there is nothing to show now: no offer, a turn running anywhere (never shown mid-turn), the person
 * said Not now to this very offer here, the usage meter's card is showing (one card at a time), or this is a team's Cloud and
 * the offer is about the person's own plan's Cloud, not the team's.
 */
export function roomCardView(input: { room: CloudRoom | null | undefined; usage: CloudUsage | null; busy: boolean; hidden: string | null; usageCardShown: boolean;
  teamHome?: boolean }): RoomCardView | null {
  const { room } = input;
  if (!room || input.busy || input.hidden === room.id || input.usageCardShown) return null;
  if (input.teamHome && !TEAM_TIERS.includes(input.usage?.tier ?? "")) return null;
  // Its Upgrade moves only to a plan the session's usage lists (main refuses any other), as the Admin makes it.
  if (room.plan && !input.usage?.upgrades.some((option) => option.tier === room.plan!.tier)) return null;
  const kind = room.cause.kind;
  const offer = room.plan ? {
    tier: room.plan.tier, text: offerText(room.plan, kind),
    price: t(input.usage?.trialEndsAt ? "roomCard.priceTrial" : "roomCard.price", { price: usd(room.plan.amount / 100) }),
  } : null;
  return { id: room.id, kind, title: t(kind === "disk" ? "roomCard.title.disk" : "roomCard.title.memory"), cause: roomCauseText(room.cause), offer,
    tip: offer ? null : t(kind === "disk" ? "roomCard.tip.disk" : "roomCard.tip.memory") };
}

const HIDDEN_KEY = "openmausbot.roomCard.hidden.v1";
export function readRoomCardHidden(): string | null {
  try { return globalThis.localStorage?.getItem(HIDDEN_KEY) ?? null; } catch { return null; }
}
export function rememberRoomCardHidden(id: string): void {
  try { globalThis.localStorage?.setItem(HIDDEN_KEY, id); } catch { /* Hidden only until reload; the Admin holds it back anyway. */ }
}
