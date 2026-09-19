// Routine request public types — option cards, the narrow store surface,
// service options/results, and the error class.

import type { RoutineManager } from "../routines.ts";
import type {
  RoutineRequestCardData,
  RoutineRequestOperation,
} from "../../shared/routine-request.ts";

export interface RoutineRequestOptionCard {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  requestId?: string;
  tool?: string;
  held?: string;
  routineRequest?: RoutineRequestCardData;
}

export interface RoutineRequestMessage {
  id: string;
  card?: RoutineRequestOptionCard;
}

/** Kept narrow so the domain can be tested without constructing the full app store. */
export interface RoutineRequestStore {
  messagesFor(threadId: string): RoutineRequestMessage[];
  appendMessage(
    threadId: string,
    message: {
      role: "bot";
      kind: "options";
      card: RoutineRequestOptionCard;
      from?: { botId: string; name: string; color: string };
    },
  ): RoutineRequestMessage;
  patchMessage(
    threadId: string,
    messageId: string,
    patch: { card: RoutineRequestOptionCard },
  ): RoutineRequestMessage | null;
}

export interface RoutineRequestServiceOptions {
  store: RoutineRequestStore;
  routines: RoutineManager;
  now?: () => number;
  timeZone?: () => string;
  /** Server-owned effective mode of the source conversation, never request input. */
  autoApply?: (botId: string, threadId: string) => boolean;
  /** Harness-owned readiness check for proposals that would execute in cloud. */
  cloudReady?: () => Promise<{ ready: boolean; reason?: string }>;
  /** Revalidates conversation ownership and capacity synchronously, directly
   * before the card append. This closes races across an async cloud probe. */
  canPersist?: (
    botId: string,
    threadId: string,
  ) => { ok: true } | { ok: false; status: number; error: string };
  /** Re-authorizes a cross-bot target (the card can sit open while the target
   * bot is deleted or moved to another section). Returns the sentence to
   * refuse with, or null to allow. Checked at propose AND confirm time. */
  validateTarget?: (proposerBotId: string, target: { botId: string; name: string }) => string | null;
}

export interface ProposeRoutineRequestArgs {
  botId: string;
  threadId: string;
  /** Untrusted model output; normalized by routineProposalSchema in propose(). */
  proposal: unknown;
  /** Room cards retain the member attribution used by every other bot message. */
  from?: { botId: string; name: string; color: string };
  /** Exact caller/turn lease checked synchronously after any readiness await
   * and immediately before the durable card append. */
  canCommit?: () => boolean;
}

export interface RoutineProposalResult {
  requestId: string;
  messageId: string;
  title: string;
  /** Short response returned to the proposing agent. */
  summary: string;
  /** Exact approval text persisted in the card. */
  detail: string;
  nextRunAt: number | null;
  timeZone: string;
}
export type ResolveRoutineRequestResult =
  | { claimed: false; state: "not_found" }
  | { claimed: true; state: "invalid"; error: string; status: number }
  | { claimed: true; state: "already_settled"; behavior: string }
  | { claimed: true; state: "denied" }
  | {
      claimed: true;
      state: "applied";
      action: RoutineRequestOperation["action"];
      resultId: string;
      settlementPending?: true;
      message?: string;
    };

export class RoutineRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "RoutineRequestError";
    this.status = status;
  }
}
