// Room queue actions that talk to the server, kept out of the store file: cancelling a queued room message
// and steering the queue head into the running room turn. A quiet steer (Enter in a busy room) says nothing
// when it cannot steer: the message just stays queued.
import { t } from "../lib/i18n";

import { api } from "./api";
import type { Action } from "./store";

type Send = {
  /** Straight into the reducer, past this module's own actions. */
  dispatch: (action: Action) => void;
  /** Back through the wrapped dispatch, for notices. */
  notice: (action: Action) => void;
  showError: (error: unknown) => void;
};

export function cancelGroupQueued(
  action: Extract<Action, { type: "cancelGroupQueued" }>,
  send: Send,
): void {
  void api(`/api/groups/${action.groupId}/queue/${action.queueId}`, { method: "DELETE" })
    .then(() => {
      send.dispatch(action);
      action.onCancelled?.();
    })
    .catch(send.showError);
}

export function steerGroupQueued(
  action: Extract<Action, { type: "steerGroupQueued" }>,
  send: Send,
): void {
  void api(`/api/groups/${action.groupId}/queue/${action.queueId}/steer`, {
    method: "POST",
    body: JSON.stringify({ threadId: action.threadId }),
  })
    .then((body) => {
      if (body?.steered === true && Array.isArray(body.messages) && typeof body.threadId === "string") {
        for (const message of body.messages) {
          send.dispatch({ type: "messageAdded", threadId: body.threadId, message });
        }
        for (const queueId of body.queueIds ?? []) {
          send.dispatch({ type: "consumePendingQueued", threadId: body.threadId, queueId });
        }
      } else if (body?.queued === true && !action.quiet) {
        send.notice({ type: "notice", notice: body.blockedBy === "images" ? { kind: "steer-images", botName: null, threadId: body.threadId } : { kind: "note", botName: null, text: t("composer.queued.roomSteerHeld"), threadId: body.threadId } });
      }
      action.onSettled?.();
    })
    .catch((error) => {
      if (!action.quiet) send.showError(error);
      action.onError?.();
    });
}
