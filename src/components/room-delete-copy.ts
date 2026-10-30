// What deleting a room asks first: a chat with one bot, or a channel.
import { t } from "@/lib/i18n";
import type { Group } from "@/state/store";

export function roomDeleteCopy(group: Pick<Group, "name" | "dm">) {
  const isBotChat = Boolean(group.dm);
  return {
    title: t("sidebar.room.deleteConfirmTitle", { name: group.name }),
    body: isBotChat
      ? t("sidebar.room.deleteChatBody", { name: group.name })
      : t("sidebar.room.deleteChannelBody", { name: group.name }),
    confirmLabel: isBotChat ? t("sidebar.room.deleteChat") : t("sidebar.room.deleteChannel"),
    tone: "danger" as const,
  };
}
