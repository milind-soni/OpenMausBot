// What moves into a message's "more" menu, built the same way for 1:1 chats
// and rooms, bot answers and the person's own bubbles.
import { Code, Copy, Eye, Pencil, Pin, PinOff, RefreshCw, Square, Volume2 } from "lucide-react";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import type { ConfigStatus } from "@/state/store";
import { ACTION_ICON, type MessageMenuItem } from "@/components/MessageActions";
import { useSpeakAction } from "@/components/SpeakButton";

export type PinAction = { pinned: boolean; onToggle: () => void; hint?: string };

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

/** A bot answer: read aloud, raw markdown, regenerate, pin, copy its id. */
export function useBotMessageMenu({
  text,
  botId,
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
  items.push(...pinItem(pin), idItem(messageId));
  return items;
}

/** The person's own message: edit, pin, copy its id. */
export function userMessageMenu({ messageId, onEdit, pin }: { messageId: string; onEdit?: () => void; pin?: PinAction }): MessageMenuItem[] {
  return [
    ...(onEdit ? [{ key: "edit", icon: <Pencil {...ACTION_ICON} />, label: t("chat.editMessage"), onSelect: onEdit }] : []),
    ...pinItem(pin),
    idItem(messageId),
  ];
}
