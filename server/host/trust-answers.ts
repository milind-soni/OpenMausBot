import type { ServerResponse } from "node:http";

import { appendDecision } from "../decision-log.ts";
import { json } from "../harness/http.ts";
import type { EduCrew } from "../edu-crew.ts";
import type { EduProposals } from "../edu-proposals.ts";
import type { OutboundRequestService } from "../outbound-requests.ts";
import type { Store } from "../store.ts";

/** A proposal a person answers on a card, settled by its own service. */
interface Remembered {
  resolve(threadId: string, requestId: string, behavior: string): { ok: true; outcome: string; alreadySettled?: true } | null;
}

export interface TrustAnswerDeps {
  store: Pick<Store, "messagesFor" | "bot" | "botByThread" | "patchMessage">;
  dataDir: string;
  teamMemoryRequests: Remembered;
  outsideWrites: Remembered;
  eduProposals: Pick<EduProposals, "resolve">;
  eduCrew?: Pick<EduCrew, "resolve">;
  outboundRequests: OutboundRequestService;
}

/** The person's answer to a team-memory, outside-write, Edu proposal, Edu crew gate or "Send on your behalf?" card. */
export function createTrustAnswers(deps: TrustAnswerDeps) {
  const { store, teamMemoryRequests, outsideWrites, eduProposals, outboundRequests } = deps;
  const DATA_DIR = deps.dataDir;

  async function resolveAndSendTrust(res: ServerResponse, threadId: string, requestId: string, behavior: "allow" | "deny" | "answer"): Promise<boolean> {
    const remembered = teamMemoryRequests.resolve(threadId, requestId, behavior) ?? outsideWrites.resolve(threadId, requestId, behavior);
    if (remembered) {
      json(res, 200, remembered);
      return true;
    }
    const edu = await eduProposals.resolve(threadId, requestId, behavior) ?? await deps.eduCrew?.resolve(threadId, requestId, behavior);
    if (edu) {
      if (edu.ok) json(res, 200, edu);
      else json(res, edu.status, { error: edu.error });
      return true;
    }
    const outboundCard = store.messagesFor(threadId).find(
      (message) => message.card?.requestId === requestId && message.card.outboundRequest,
    );
    if (outboundCard?.card?.outboundRequest) {
      const outboundBot = outboundCard.from?.botId ? store.bot(outboundCard.from.botId) : store.botByThread(threadId);
      const result = outboundRequests.resolve({ threadId, requestId, behavior });
      if (!result.claimed) {
        if (!outboundCard.card.answered) {
          store.patchMessage(threadId, outboundCard.id, { card: { ...outboundCard.card, answered: "unavailable", dismissed: true } });
        }
        json(res, 200, { ok: true, outcome: "unavailable" });
        return true;
      }
      if (result.state === "already_settled") {
        json(res, 200, { ok: true, outcome: result.behavior === "allow" ? "allowed-once" : "rejected", alreadySettled: true });
        return true;
      }
      store.patchMessage(threadId, outboundCard.id, {
        card: { ...outboundCard.card, answered: result.state === "allowed" ? "allow" : "deny" },
      });
      appendDecision(DATA_DIR, {
        threadId, requestId, botId: outboundBot?.id, botName: outboundBot?.name,
        tool: outboundCard.card.tool, summary: outboundCard.card.subtitle,
        decision: result.state === "allowed" ? "user-approved" : "user-denied", source: "user",
      });
      json(res, 200, { ok: true, outcome: result.state === "allowed" ? "allowed-once" : "rejected" });
      return true;
    }
    return false;
  }

  return { resolveAndSendTrust };
}
