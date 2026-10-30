// A bot carries on in one of its conversations from a line someone else sent there (a teammate's answer, passed back
// from their inbox): the line starts its turn now, or waits behind the one running there, as a person's message would.
import { admit, type AdmissionState } from "../admission.ts";
import { OUTSIDE, type WorkOrigin } from "../peer-provenance.ts";
import { queueSteeredMessage } from "../steer-queue.ts";
import type { Message, Store } from "../store.ts";
import { failedTurnTool } from "../../shared/failed-turn.ts";

type PeerAsk = NonNullable<Message["peerAsk"]>;
type Relay = NonNullable<Message["relay"]>;

export interface RelayedTurnDeps {
  store: Pick<Store, "appendMessage">;
  /** What admission reads for this conversation now. */
  state(botId: string, threadId: string): AdmissionState;
  startTurn(botId: string, text: string, opts: { threadId: string; peerAsk: PeerAsk; origin: WorkOrigin; userMessage: Message }): Promise<unknown>;
}

export function relayedTurn(deps: RelayedTurnDeps) {
  return (botId: string, threadId: string, text: string, from: { botId: string; name: string }, relay: Relay): void => {
    const peerAsk: PeerAsk = { botId: from.botId, name: from.name };
    const decision = admit("direct", {}, deps.state(botId, threadId));
    if (decision.action === "queue") {
      queueSteeredMessage(botId, threadId, text, { ...(decision.reason ? { reason: decision.reason } : {}), peerAsk, origin: OUTSIDE, relay });
      return;
    }
    const userMessage = deps.store.appendMessage(threadId, { role: "user", kind: "text", text, peerAsk, relay });
    void deps.startTurn(botId, text, { threadId, peerAsk, origin: OUTSIDE, userMessage }).catch((error: unknown) => {
      deps.store.appendMessage(threadId, { role: "bot", kind: "activity", tool: failedTurnTool(`this conversation could not carry on — ${error instanceof Error ? error.message : String(error)}`) });
    });
  };
}
