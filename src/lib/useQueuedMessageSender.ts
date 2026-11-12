import { useEffect, useSyncExternalStore } from "react";
import { useStore } from "@/state/store";
import { track } from "@/lib/analytics";
import { subscribeQueue, takeReadyQueued, type DraftTarget } from "@/lib/composerDrafts";

let version = 0;
const subscribeVersion = (listener: () => void) =>
  subscribeQueue(() => {
    version += 1;
    listener();
  });
const getVersion = () => version;

/** Sends each queued composer message once its bot or room is free, whether
 * or not that conversation is on screen. Mounted once, in the app shell. */
export function useQueuedMessageSender(): void {
  const { state, dispatch } = useStore();
  const queueVersion = useSyncExternalStore(subscribeVersion, getVersion);

  useEffect(() => {
    const find = (target: DraftTarget) =>
      "groupId" in target
        ? { exists: state.groups.some((g) => g.id === target.groupId), busy: Boolean(state.groups.find((g) => g.id === target.groupId)?.busyBotId) }
        : { exists: state.bots.some((b) => b.id === target.botId), busy: Boolean(state.bots.find((b) => b.id === target.botId)?.busy) };
    // a deleted target is "ready" too, so its message is dropped, not kept forever
    for (const { target, message } of takeReadyQueued((target) => !find(target).busy)) {
      if (!find(target).exists) continue;
      const attachments = message.attachments.length > 0 ? message.attachments : undefined;
      if ("groupId" in target) dispatch({ type: "sendGroup", groupId: target.groupId, text: message.text, attachments });
      else dispatch({ type: "send", botId: target.botId, text: message.text, attachments });
      track("message_sent", { queued: true });
    }
  }, [state.bots, state.groups, queueVersion, dispatch]);
}
