import { t } from "@/lib/i18n";

export type SidebarAttentionBot = {
  unread?: boolean;
  busy?: boolean;
  activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
};

export type SidebarAttentionGroup = {
  unread?: boolean;
  busyBotId?: string | null;
};

export type SidebarSectionAttention = {
  unread: number;
  waiting: number;
  working: number;
};

/** Summarize signals that would otherwise disappear when a section closes. */
export function sidebarSectionAttention(
  bots: SidebarAttentionBot[],
  groups: SidebarAttentionGroup[],
): SidebarSectionAttention {
  return {
    unread:
      bots.filter((bot) => Boolean(bot.unread)).length +
      groups.filter((group) => Boolean(group.unread)).length,
    waiting: bots.filter((bot) => bot.activity === "waiting-on-you").length,
    working:
      bots.filter(
        (bot) =>
          bot.activity === "working" ||
          (Boolean(bot.busy) && bot.activity !== "waiting-on-you"),
      ).length + groups.filter((group) => Boolean(group.busyBotId)).length,
  };
}

export function sidebarAttentionLabel(attention: SidebarSectionAttention): string {
  const parts: string[] = [];
  if (attention.waiting > 0) {
    parts.push(t("sidebar.attention.waiting", { count: attention.waiting }));
  }
  if (attention.unread > 0) {
    parts.push(t("sidebar.attention.unread", { count: attention.unread }));
  }
  if (attention.working > 0) {
    parts.push(t("sidebar.attention.working", { count: attention.working }));
  }
  return parts.join(", ");
}
