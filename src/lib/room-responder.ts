import type { Bot, Group, GroupDefaultResponder } from "@/state/store";
import { defaultResponderName, effectiveDefaultResponder } from "./group-routing";
import { t } from "./i18n";

export type ResponderChoice = `member:${string}` | "auto" | "everyone" | "mentions";

export function responderChoice(responder: GroupDefaultResponder): ResponderChoice {
  return responder.kind === "member" ? `member:${responder.botId}` : responder.kind;
}

export function chosenResponder(choice: string, current: GroupDefaultResponder): GroupDefaultResponder {
  if (choice === "everyone") return { kind: "everyone" };
  if (choice === "mentions") return { kind: "mentions" };
  if (choice === "auto") return current.kind === "member" ? { kind: "auto", fallbackBotId: current.botId } : { kind: "auto" };
  return { kind: "member", botId: choice.slice("member:".length) };
}

export function responderTitle(group: Group, members: Bot[], jevOn: boolean): string {
  const responder = effectiveDefaultResponder(group, members);
  const lead = responder.kind === "member" ? members.find((member) => member.id === responder.botId) : undefined;
  return responder.kind === "everyone"
    ? t("room.responder.everyone")
    : responder.kind === "mentions"
      ? t("room.responder.mentions")
      : responder.kind === "auto"
        ? jevOn
          ? t("room.responder.auto")
          : t("room.responder.autoOff", { name: defaultResponderName(group, members) ?? t("room.responder.leadFallback") })
        : t("room.responder.lead", { name: lead?.name ?? t("room.responder.leadFallback") });
}

export function responderShortLabel(group: Group, members: Bot[]): string {
  const responder = effectiveDefaultResponder(group, members);
  if (responder.kind === "everyone") return t("room.panel.responder.everyone");
  if (responder.kind === "mentions") return t("room.panel.responder.mentions");
  if (responder.kind === "auto") return t("room.panel.responder.auto");
  return members.find((member) => member.id === responder.botId)?.name ?? t("room.responder.leadFallback");
}
