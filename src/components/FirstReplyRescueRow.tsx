import { Info } from "lucide-react";
import { openBotSettings } from "@/components/bot-panel/panel-link";
import { requestAiSwitch, useAiSwitchRow } from "@/lib/ai-switch";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useLiveTurn } from "@/lib/stop-turn";
import { useStore } from "@/state/store";
import type { FirstReplyRescue } from "../../shared/first-reply-rescue";

const pill = "rounded-full border border-hairline/40 px-2.5 py-1 text-[13px] text-ink hover:bg-raised";

/** A first reply that has not come: who is waiting on which AI, and two ways out. A quiet notice, never an error; it
 * goes once the AI starts answering, and keeps no live buttons once its own turn is no longer the one running.
 * `text` is the row's stored sentence, for a bot this client no longer has; `at` is when the row was posted. */
export function FirstReplyRescueRow({ rescue, text, at }: { rescue: FirstReplyRescue; text: string; at: number }) {
  const { state, dispatch } = useStore();
  const advanced = useAdvancedMode();
  const seen = useLiveTurn(rescue.threadId);
  const bot = state.bots.find((candidate) => candidate.id === rescue.botId);
  const task = bot?.tasks?.find((candidate) => candidate.threadId === rescue.threadId);
  const group = rescue.groupId ? state.groups.find((candidate) => candidate.id === rescue.groupId) : undefined;
  const busy = rescue.groupId ? group?.busyBotId === rescue.botId : Boolean(task ? task.busy : bot?.threadId === rescue.threadId && bot.busy);
  const startedAt = rescue.groupId ? group?.turnStartedAt : task?.turnStartedAt;
  // The row's own turn: the one this client saw start, or (it saw none, as after a reload) one running since before the row.
  const live = !rescue.settled && !rescue.over && busy && (seen !== undefined ? seen === rescue.turnId : startedAt == null || startedAt <= at);
  useAiSwitchRow({ threadId: rescue.threadId, turnId: rescue.turnId, live });
  if (rescue.settled) return null;
  const ai = state.instances.find((instance) => instance.instanceId === rescue.instanceId)?.displayName || rescue.ai;
  // Where this bot's AI is chosen: the bot panel in Simple mode, the chat header in Advanced. A room's header and a
  // remote client's Advanced header have no model chip.
  const remote = window.ogb?.remoteClient?.active === true;
  const canSwitch = live && !rescue.groupId && !(advanced && remote);
  const switchAi = () => {
    requestAiSwitch({ botId: rescue.botId, threadId: rescue.threadId, turnId: rescue.turnId, requestMessageId: rescue.requestMessageId, place: advanced ? "header" : "panel" });
    if (!advanced) openBotSettings(dispatch, "model", { botId: rescue.botId });
  };
  return (
    <div role="status" data-first-reply-rescue className="flex w-fit max-w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink-secondary">
      <span className="flex min-w-0 items-start gap-2">
        <Info size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">{bot ? t(rescue.over ? "chat.rescue.over" : "chat.rescue.waiting", { bot: bot.name, ai }) : text}</span>
      </span>
      {live && (
        <span className="flex flex-wrap items-center gap-2">
          {canSwitch && (
            <button type="button" className={pill} title={t("chat.rescue.switchAiHint", { bot: bot?.name ?? "" })} onClick={switchAi}>
              {t("chat.rescue.switchAi")}
            </button>
          )}
          <button type="button" className={pill} title={t("chat.rescue.connectHint")}
            onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "engines" })}>
            {t("chat.rescue.connect")}
          </button>
        </span>
      )}
    </div>
  );
}
