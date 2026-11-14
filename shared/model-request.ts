/**
 * Durable payload carried by a default-model confirmation card (propose_model).
 * "before" is the exact selection the user was shown; a confirmation fails
 * closed if the target's default moved since.
 */
import type { ModelSelection } from "./wire.ts";

export interface ModelRequestCardData {
  version: 1;
  requestId: string;
  /** The proposing conversation; authority is fixed here. */
  botId: string;
  threadId: string;
  /** Whose default model changes: the proposer, or a section peer named by a Chief. */
  targetBotId: string;
  targetName: string;
  createdAt: number;
  reason: string;
  selection: ModelSelection;
  before: ModelSelection;
  appliedAt?: number;
}
