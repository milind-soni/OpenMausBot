import type { Bot, ConfigStatus, Group, GroupDefaultResponder } from "@/state/store";
import { isMentionBoundary, isMentionNameContinuation } from "../../shared/mention-boundary";
import { t } from "./i18n";

/** Whether an Auto room asks the decision model right now: the master switch
 * (off while no key is saved) and the room job both on. */
export function jevRoomRoutingOn(config: ConfigStatus | null | undefined): boolean {
  return Boolean(config?.decider?.enabled && config.decider.jobs.roomRouting);
}

/** Be defensive around rooms loaded while an older server is still running,
 * and around a lead removed by another client before the group patch arrives. */
export function effectiveDefaultResponder(
  group: Pick<Group, "defaultResponder">,
  members: Array<{ id: string }>,
): GroupDefaultResponder {
  const value = group.defaultResponder;
  if (value?.kind === "everyone" || value?.kind === "mentions") return value;
  if (value?.kind === "member" && members.some((member) => member.id === value.botId)) return value;
  // Auto keeps its fallback only while that bot is still in the room.
  if (value?.kind === "auto") {
    return value.fallbackBotId && members.some((member) => member.id === value.fallbackBotId) ? value : { kind: "auto" };
  }
  return members[0] ? { kind: "member", botId: members[0].id } : { kind: "mentions" };
}

/** The member who answers a plain message: the lead, or an Auto room's
 * fallback (its chosen fallback, else the first member). */
export function defaultResponderName(group: Group, members: Bot[]): string | null {
  const value = effectiveDefaultResponder(group, members);
  if (value.kind === "auto") return (members.find((member) => member.id === value.fallbackBotId) ?? members[0])?.name ?? null;
  if (value.kind !== "member") return null;
  return members.find((member) => member.id === value.botId)?.name ?? null;
}

/** `jevOn`: whether the decision model is on for rooms. An Auto room with it
 * off answers exactly like lead mode, so it reads like lead mode. */
export function groupResponseHint(group: Group, members: Bot[], { jevOn = true }: { jevOn?: boolean } = {}): string {
  if (group.dm) return t("room.hint.dm");
  const value = effectiveDefaultResponder(group, members);
  if (value.kind === "everyone") return t("room.hint.everyone");
  if (value.kind === "mentions") return t("room.hint.mentions");
  if (value.kind === "auto" && jevOn) return t("room.hint.auto");
  const name = defaultResponderName(group, members) ?? t("room.hint.leadFallback");
  return t("room.hint.lead", { name });
}

export function groupComposerHint(group: Group, members: Bot[], { jevOn = true }: { jevOn?: boolean } = {}): string {
  if (group.dm) return t("composer.hint.dm");
  const value = effectiveDefaultResponder(group, members);
  if (value.kind === "everyone") return t("composer.hint.everyone");
  if (value.kind === "mentions") return t("composer.hint.mentions");
  if (value.kind === "auto" && jevOn) return t("composer.hint.auto");
  return t("composer.hint.responder", {
    name: defaultResponderName(group, members) ?? t("composer.hint.lead"),
  });
}

/** Same routing sendGroup uses: explicit @mentions win, otherwise the
 * room's default responder. Keep this aligned with server/store.ts
 * `roomResponders` / `mentionedBots`. */
export function roomRespondersForComposer<T extends { id: string; name: string; hidden?: boolean }>(
  text: string,
  members: T[],
  group: Pick<Group, "defaultResponder">,
): T[] {
  const available = members.filter((member) => !member.hidden);
  const everyone = "everyone";
  let everyoneAt = -1;
  while ((everyoneAt = text.indexOf("@", everyoneAt + 1)) !== -1) {
    if (
      isMentionBoundary(text, everyoneAt)
      && text.slice(everyoneAt + 1, everyoneAt + 1 + everyone.length).toLowerCase() === everyone
      && !isMentionNameContinuation(text.slice(everyoneAt + 1 + everyone.length))
    ) {
      return available;
    }
  }
  const mentioned = mentionedMembers(text, available);
  if (mentioned.length) return mentioned;
  const fallback = effectiveDefaultResponder(group, available);
  if (fallback.kind === "everyone") return available;
  // Any member may be picked, so image support is judged for all of them.
  if (fallback.kind === "auto") return available;
  if (fallback.kind === "member") {
    const lead = available.find((member) => member.id === fallback.botId);
    return lead ? [lead] : [];
  }
  return [];
}

/** Goal mode always starts with one coordinator: an explicit mention, the
 * configured lead, an in-room Chief, or the first active member. Keep this
 * aligned with the server's selectGroupGoalCoordinator path. */
export function goalCoordinatorForComposer<
  T extends { id: string; name: string; hidden?: boolean; chiefOfStaff?: boolean },
>(
  text: string,
  members: T[],
  group: Pick<Group, "defaultResponder">,
): T | null {
  const available = members.filter((member) => !member.hidden);
  const explicitlyMentioned = roomRespondersForComposer(
    text,
    available,
    { defaultResponder: { kind: "mentions" } },
  )[0];
  if (explicitlyMentioned) return explicitlyMentioned;
  const configuredResponder = group.defaultResponder;
  const lead = configuredResponder?.kind === "member" ? configuredResponder.botId
    : configuredResponder?.kind === "auto" ? configuredResponder.fallbackBotId : undefined;
  if (lead) {
    const configured = available.find((member) => member.id === lead);
    if (configured) return configured;
  }
  return available.find((member) => member.chiefOfStaff) ?? available[0] ?? null;
}

function mentionedMembers<T extends { name: string; hidden?: boolean }>(text: string, peers: T[]): T[] {
  const candidates = peers
    .filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const found: T[] = [];
  let at = -1;
  while ((at = text.indexOf("@", at + 1)) !== -1) {
    if (!isMentionBoundary(text, at)) continue;
    const hit = candidates.find((p) => {
      const name = p.name.toLowerCase();
      if (text.slice(at + 1, at + 1 + p.name.length).toLowerCase() !== name) return false;
      return !isMentionNameContinuation(text.slice(at + 1 + p.name.length));
    });
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}
