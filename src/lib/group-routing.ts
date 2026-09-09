import type { Bot, Group, GroupDefaultResponder } from "@/state/store";
import { t } from "./i18n";

/** Be defensive around rooms loaded while an older server is still running,
 * and around a lead removed by another client before the group patch arrives. */
export function effectiveDefaultResponder(
  group: Pick<Group, "defaultResponder">,
  members: Array<{ id: string }>,
): GroupDefaultResponder {
  const value = group.defaultResponder;
  if (value?.kind === "everyone" || value?.kind === "mentions") return value;
  if (value?.kind === "member" && members.some((member) => member.id === value.botId)) return value;
  return members[0] ? { kind: "member", botId: members[0].id } : { kind: "mentions" };
}

export function defaultResponderName(group: Group, members: Bot[]): string | null {
  const value = effectiveDefaultResponder(group, members);
  if (value.kind !== "member") return null;
  return members.find((member) => member.id === value.botId)?.name ?? null;
}

export function groupResponseHint(group: Group, members: Bot[]): string {
  if (group.dm) return t("room.hint.dm");
  const value = effectiveDefaultResponder(group, members);
  if (value.kind === "everyone") return t("room.hint.everyone");
  if (value.kind === "mentions") return t("room.hint.mentions");
  const name = defaultResponderName(group, members) ?? t("room.hint.leadFallback");
  return t("room.hint.lead", { name });
}

export function groupComposerHint(group: Group, members: Bot[]): string {
  if (group.dm) return t("composer.hint.dm");
  const value = effectiveDefaultResponder(group, members);
  if (value.kind === "everyone") return t("composer.hint.everyone");
  if (value.kind === "mentions") return t("composer.hint.mentions");
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
  if (/(?:^|\s)@everyone\b/i.test(text)) return available;
  const mentioned = mentionedMembers(text, available);
  if (mentioned.length) return mentioned;
  const fallback = effectiveDefaultResponder(group, available);
  if (fallback.kind === "everyone") return available;
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
  if (configuredResponder?.kind === "member") {
    const configured = available.find((member) => member.id === configuredResponder.botId);
    if (configured) return configured;
  }
  return available.find((member) => member.chiefOfStaff) ?? available[0] ?? null;
}

function mentionedMembers<T extends { name: string; hidden?: boolean }>(text: string, peers: T[]): T[] {
  const candidates = peers
    .filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  const found: T[] = [];
  let at = -1;
  while ((at = lower.indexOf("@", at + 1)) !== -1) {
    if (at > 0 && !/\s/.test(text[at - 1])) continue;
    const rest = lower.slice(at + 1);
    const hit = candidates.find((p) => {
      const name = p.name.toLowerCase();
      if (!rest.startsWith(name)) return false;
      const after = rest[name.length];
      return after === undefined || !/[a-z0-9]/i.test(after);
    });
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}
