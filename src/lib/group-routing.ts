import type { Bot, ConfigStatus, Group, GroupDefaultResponder } from "@/state/store";
import { isMentionBoundary, isMentionNameContinuation } from "../../shared/mention-boundary";
import { resolveMentions } from "../../shared/room-mentions";
import { t } from "./i18n";

export function jevRoomRoutingOn(config: ConfigStatus | null | undefined): boolean {
  return Boolean(config?.decider?.enabled && config.decider.jobs.roomRouting);
}

export function effectiveDefaultResponder(
  group: Pick<Group, "defaultResponder">,
  members: Array<{ id: string }>,
): GroupDefaultResponder {
  const value = group.defaultResponder;
  if (value?.kind === "everyone" || value?.kind === "mentions") return value;
  if (value?.kind === "member" && members.some((member) => member.id === value.botId)) return value;
  if (value?.kind === "auto") {
    return value.fallbackBotId && members.some((member) => member.id === value.fallbackBotId) ? value : { kind: "auto" };
  }
  return members[0] ? { kind: "member", botId: members[0].id } : { kind: "mentions" };
}

export function defaultResponderName(group: Group, members: Bot[]): string | null {
  const value = effectiveDefaultResponder(group, members);
  if (value.kind === "auto") return (members.find((member) => member.id === value.fallbackBotId) ?? members[0])?.name ?? null;
  if (value.kind !== "member") return null;
  return members.find((member) => member.id === value.botId)?.name ?? null;
}

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

export function openTaskWorking(group: Pick<Group, "threadId" | "working" | "tasks">): boolean {
  const task = group.tasks?.find((candidate) => candidate.threadId === group.threadId);
  return task ? Boolean(task.working) : Boolean(group.working);
}

/** Who answers this line, as the room reads it. `ambiguous`: it @-tags a name several members share and none of them
 * was picked from the @ list, so the room refuses it and nobody answers. */
export function roomRouteForComposer<T extends { id: string; name: string; hidden?: boolean }>(
  text: string,
  members: T[],
  group: Pick<Group, "defaultResponder">,
  picked: readonly string[] = [],
): { responders: T[]; ambiguous: boolean } {
  const available = members.filter((member) => !member.hidden);
  const everyone = "everyone";
  let everyoneAt = -1;
  while ((everyoneAt = text.indexOf("@", everyoneAt + 1)) !== -1) {
    if (
      isMentionBoundary(text, everyoneAt)
      && text.slice(everyoneAt + 1, everyoneAt + 1 + everyone.length).toLowerCase() === everyone
      && !isMentionNameContinuation(text.slice(everyoneAt + 1 + everyone.length))
    ) {
      return { responders: available, ambiguous: false };
    }
  }
  const mentioned = resolveMentions(text, available, picked);
  if (mentioned.ambiguous.length) return { responders: [], ambiguous: true };
  if (mentioned.bots.length) return { responders: mentioned.bots, ambiguous: false };
  const fallback = effectiveDefaultResponder(group, available);
  if (fallback.kind === "everyone" || fallback.kind === "auto") return { responders: available, ambiguous: false };
  const lead = fallback.kind === "member" ? available.find((member) => member.id === fallback.botId) : undefined;
  return { responders: lead ? [lead] : [], ambiguous: false };
}

export function roomRespondersForComposer<T extends { id: string; name: string; hidden?: boolean }>(
  text: string,
  members: T[],
  group: Pick<Group, "defaultResponder">,
  picked: readonly string[] = [],
): T[] {
  return roomRouteForComposer(text, members, group, picked).responders;
}

export function goalCoordinatorForComposer<
  T extends { id: string; name: string; hidden?: boolean; chiefOfStaff?: boolean },
>(
  text: string,
  members: T[],
  group: Pick<Group, "defaultResponder">,
  picked: readonly string[] = [],
): T | null {
  const available = members.filter((member) => !member.hidden);
  const explicitlyMentioned = roomRespondersForComposer(
    text,
    available,
    { defaultResponder: { kind: "mentions" } },
    picked,
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
