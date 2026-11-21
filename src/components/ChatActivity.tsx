import { useMemo, useState, type CSSProperties } from "react";
import { List } from "lucide-react";
import { Switch } from "./SettingsPrimitives";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { useStoreDispatch } from "@/state/store-select";

/** Advanced mode's "Chat activity": whether routine updates and finished tool entries show in the chat, kept on this device. */
export interface ChatActivity {
  routines: boolean;
  tools: boolean;
  toggleRoutines(): void;
  toggleTools(): void;
}

function useVisibility(key: string) {
  const [visible, setVisible] = useState(() => {
    try { return localStorage.getItem(key) !== "hide"; }
    catch { return true; }
  });
  const toggle = () => {
    setVisible(!visible);
    try { localStorage.setItem(key, visible ? "hide" : "show"); }
    catch { /* Keep the preference for this visit. */ }
  };
  return [visible, toggle] as const;
}

export function useChatActivity(): ChatActivity {
  const [routines, toggleRoutines] = useVisibility("omb-advanced-chat-automation");
  const [tools, toggleTools] = useVisibility("omb-advanced-chat-tools");
  // One object per pair of choices, so the chat's filtered list changes only when a switch does.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- each toggle is fresh exactly when its value changes
  return useMemo(() => ({ routines, tools, toggleRoutines, toggleTools }), [routines, tools]);
}

/** The messages the chat draws: everything outside Advanced mode; there, without what the person hid. Anything that
 * still needs the person (a pending approval, a waiting or failed run) always stays. */
export function chatActivityMessages(messages: Message[], advanced: boolean, activity: ChatActivity, pinnedMessageId?: string): Message[] {
  if (!advanced || (activity.routines && activity.tools)) return messages;
  return messages.filter((message) => {
    if (message.role !== "bot" || message.id === pinnedMessageId) return true;
    const approval = message.kind === "options" && message.card?.requestId && message.card.tool ? message.card : undefined;
    if (approval && !approval.answered && !approval.dismissed && !approval.expired) return true;
    if (approval && !activity.tools) return false;
    if (activity.routines) return true;
    if (message.kind === "routine.run") return message.routineRun?.status === "waiting" || message.routineRun?.status === "failed";
    return !message.automation || Boolean(message.automation.needsYou || message.automation.failed || message.automation.partial || message.automation.copyOf);
  });
}

/** The chat header's Chat activity button and, once opened, its two switches and the way to the bot's run history. */
export function ChatActivityControls({ activity, botId, style }: { activity: ChatActivity; botId: string; style?: CSSProperties }) {
  const dispatch = useStoreDispatch();
  const [open, setOpen] = useState(false);
  return (
    <section aria-label={t("chat.automation.activity")} className="flex min-w-0 flex-wrap items-center gap-1.5" style={style}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className="ui-pill shrink-0"
      ><List size={14} aria-hidden="true" />{t("chat.automation.activity")}</button>
      {open && (
        <section className="chat-run-log-actions flex min-w-0 flex-wrap items-center gap-1.5">
          <label className="ui-pill shrink-0">
            {t("chat.automation.showInChat")}
            <Switch compact aria-label={t("chat.automation.showInChat")} checked={activity.routines} onClick={activity.toggleRoutines} />
          </label>
          <label className="ui-pill shrink-0">
            {t("chat.automation.showTools")}
            <Switch compact aria-label={t("chat.automation.showTools")} checked={activity.tools} onClick={activity.toggleTools} />
          </label>
          <button type="button" className="ui-pill" onClick={() => dispatch({ type: "showRoutines", section: "logs", botId })}>
            {t("chat.automation.openLogs")}
          </button>
        </section>
      )}
    </section>
  );
}
