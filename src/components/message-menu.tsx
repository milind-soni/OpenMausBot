import { BookmarkPlus, Code, Copy, Eye, Pencil, Pin, PinOff, RefreshCw, Square, Volume2 } from "lucide-react";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { useContext } from "react";
import type { ConfigStatus, Group, Message, useStore } from "@/state/store";
import { ACTION_ICON, type MessageMenuItem } from "@/components/MessageActions";
import { useSpeakAction } from "@/components/SpeakButton";
import { openConversationDialog, TEAM_MEMORY_ITEM, TeamMemorySavesContext } from "@/components/conversation-share/conversation-share";

export type PinAction = { pinned: boolean; onToggle: () => void; hint?: string };

export function roomPin(group: Group, message: Message, dispatch: ReturnType<typeof useStore>["dispatch"]): PinAction | undefined {
  if (window.ogb?.remoteClient?.active) return undefined;
  const pinned = group.pinnedMessageId === message.id;
  return {
    pinned,
    hint: t("room.pinHint"),
    onToggle: () => dispatch({ type: "patchGroup", groupId: group.id, patch: { pinnedMessageId: pinned ? "" : message.id } }),
  };
}

function pinItem(pin: PinAction | undefined): MessageMenuItem[] {
  if (!pin) return [];
  return [{
    key: "pin",
    icon: pin.pinned ? <PinOff {...ACTION_ICON} /> : <Pin {...ACTION_ICON} />,
    label: pin.pinned ? t("chat.unpinMessage") : t("chat.pinMessage"),
    title: pin.pinned ? t("chat.unpinHint") : pin.hint ?? t("chat.pinHint"),
    onSelect: pin.onToggle,
  }];
}

function idItem(messageId: string): MessageMenuItem {
  return { key: "copy-id", icon: <Copy {...ACTION_ICON} />, label: t("chat.copyMessageId"), onSelect: () => { void copyText(messageId); } };
}

/** "Save to team memory" on a message of a team bot's conversation; nothing in a group chat or off a team. */
function useTeamMemoryItem(text: string, messageId: string, botId?: string, threadId?: string): MessageMenuItem[] {
  const offered = useContext(TeamMemorySavesContext);
  if (!offered || !botId || !threadId || !text.trim() || messageId.startsWith("optimistic-")) return [];
  return [{ key: TEAM_MEMORY_ITEM, icon: <BookmarkPlus {...ACTION_ICON} />, label: t("teamMemorySave.menu"),
    onSelect: () => openConversationDialog({ kind: "memory", botId, threadId, messageId, text }) }];
}

export function useBotMessageMenu({
  text,
  botId,
  threadId,
  messageId,
  voiceId,
  tts,
  localVoice,
  canSpeak,
  viewRaw,
  onToggleRaw,
  onRegenerate,
  pin,
}: {
  text: string;
  botId?: string;
  /** The bot's conversation the message is in; a group chat names none. */
  threadId?: string;
  messageId: string;
  voiceId?: string;
  tts: ConfigStatus["tts"];
  localVoice: boolean;
  canSpeak: boolean;
  viewRaw: boolean;
  onToggleRaw: () => void;
  onRegenerate?: () => void;
  pin?: PinAction;
}): MessageMenuItem[] {
  const speak = useSpeakAction({ text, botId, messageId, voiceId, tts, localVoice });
  const teamMemory = useTeamMemoryItem(text, messageId, botId, threadId);
  const items: MessageMenuItem[] = [];
  if (canSpeak && text) {
    items.push({
      key: "speak",
      icon: speak.mine ? <Square {...ACTION_ICON} /> : <Volume2 {...ACTION_ICON} />,
      label: speak.mine ? t("chat.speak.stop") : t("chat.speak.read"),
      title: speak.label,
      disabled: !speak.ready,
      onSelect: speak.toggle,
    });
  }
  if (text) {
    items.push({
      key: "raw",
      icon: viewRaw ? <Eye {...ACTION_ICON} /> : <Code {...ACTION_ICON} />,
      label: t(viewRaw ? "chat.showRenderedMarkdown" : "chat.showRawMarkdown"),
      onSelect: onToggleRaw,
    });
  }
  if (onRegenerate) items.push({ key: "regenerate", icon: <RefreshCw {...ACTION_ICON} />, label: t("chat.regenerate"), onSelect: onRegenerate });
  items.push(...teamMemory, ...pinItem(pin), idItem(messageId));
  return items;
}

/** `save`: the message's "Save to team memory", as the bot menu's hook made it. */
export function userMessageMenu({ messageId, onEdit, pin, save = [] }: { messageId: string; onEdit?: () => void; pin?: PinAction; save?: MessageMenuItem[] }): MessageMenuItem[] {
  return [
    ...(onEdit ? [{ key: "edit", icon: <Pencil {...ACTION_ICON} />, label: t("chat.editMessage"), onSelect: onEdit, idleOnly: true }] : []),
    ...save,
    ...pinItem(pin),
    idItem(messageId),
  ];
}
