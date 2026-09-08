/**
 * Durable payload carried by a playbook confirmation card (propose_playbook).
 *
 * A playbook is process guidance mounted only when one of its triggers matches
 * the job (see server/installed-playbooks.ts). Until now playbooks could only
 * arrive with a package import, so a bot's process guidance was frozen at
 * install time while its SOUL.md — the stronger, always-mounted instruction —
 * stayed proposable. This payload closes that gap through the same
 * confirmation-card path: nothing changes until the user approves the card.
 *
 * The limits mirror the package schema's playbook block exactly
 * (server/bot-package.ts), so a proposal can never produce a playbook an
 * imported package could not have produced.
 */
export const PLAYBOOK_LIMITS = {
  key: 64,
  name: 100,
  summary: 300,
  trigger: 100,
  triggers: 30,
  instructions: 24_000,
  /** Ceiling on a bot's whole set, matching the package schema's `playbooks` cap. */
  perBot: 80,
} as const;

/** Same shape the package schema accepts, and the same slug rule. */
export const PLAYBOOK_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export interface PlaybookRequestPlaybook {
  key: string;
  name: string;
  summary: string;
  triggers: string[];
  instructions: string;
}

/** Add a playbook, replace one with the same key, or take one away. */
export type PlaybookRequestChange =
  | { action: "upsert"; playbook: PlaybookRequestPlaybook }
  | { action: "remove"; key: string };

export interface PlaybookRequestCardData {
  version: 1;
  requestId: string;
  /** The proposing conversation; authority is fixed here. */
  botId: string;
  threadId: string;
  /** Whose playbooks change: the proposer, or a section peer named by a Chief. */
  targetBotId: string;
  targetName: string;
  createdAt: number;
  reason: string;
  change: PlaybookRequestChange;
  /** The playbook this key held when the card was written, if any. */
  before?: PlaybookRequestPlaybook;
  /** Hash of the target's whole playbook set, so a confirmation fails closed if anything moved. */
  expectedRevision: string;
  appliedAt?: number;
}
